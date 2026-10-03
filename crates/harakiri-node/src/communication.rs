//! Communication is a scoped capability, not authority to launch work. The
//! host binds it to a prepared contribution; peers verify the agent signature.
use crate::store::{MessagePage, MessageView, Store};
use anyhow::{Result, anyhow, bail, ensure};
use harakiri_protocol::{
    Event, Identity, Payload,
    agents::{AgentRole, AgentStatus, AgentView},
    lifecycle::{ControlAction, MissionPhase},
    policy::Coordination,
};
use rusqlite::{Transaction, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum MessageFeed {
    Conversation,
    Inbox,
    Sent,
}

#[derive(Debug, Clone, Deserialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct MessageQuery {
    pub view: MessageFeed,
    pub audience: Option<String>,
    pub thread: Option<String>,
    pub before: Option<String>,
    pub anchor: Option<String>,
    pub search: Option<String>,
}
impl MessageQuery {
    pub fn conversation(audience: &str, before: Option<String>) -> Self {
        Self {
            view: MessageFeed::Conversation,
            audience: Some(audience.into()),
            thread: None,
            before,
            anchor: None,
            search: None,
        }
    }
}

/// No mission, identity, credential, path or execution operation is accepted
/// from the caller. Those are bound by the trusted host, outside this enum.
#[derive(Debug, Deserialize, ts_rs::TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentOperation {
    Governance {},
    Criterion {
        control: String,
        index: u16,
        wording: String,
        met: bool,
        summary: String,
        evidence: Vec<String>,
    },
    PlanArtifact {
        control: String,
        revision: String,
    },
    Artifacts {
        query: harakiri_protocol::artifacts::ArtifactQuery,
    },
    ArtifactDetail {
        revision: String,
    },
    ArtifactAction {
        control: String,
        conversation: String,
        action: harakiri_protocol::artifacts::ArtifactAction,
    },
    ArtifactTransfer {
        transfer: harakiri_protocol::artifacts::ArtifactTransfer,
    },
    Context {},
    Workstreams {},
    Tasks {
        query: harakiri_protocol::work::TaskQuery,
    },
    Work {
        control: String,
        action: harakiri_protocol::work::WorkAction,
    },
    Messages {
        query: MessageQuery,
    },
    Post {
        audience: String,
        text: String,
        to: Option<String>,
        thread: Option<String>,
    },
    Acknowledge {
        control: String,
        direction: String,
    },
    Plan {
        control: String,
        text: String,
    },
    Ready {
        control: String,
        plan: String,
    },
    Direct {
        control: String,
        registration: String,
        text: String,
    },
}

#[derive(Serialize, ts_rs::TS)]
pub struct AgentContext {
    pub definition: harakiri_protocol::MissionDefinition,
    pub lifecycle: harakiri_protocol::lifecycle::LifecycleView,
    pub agent: AgentView,
    pub conversations: Vec<crate::scope::AudienceView>,
    pub execution: &'static str,
}

impl Store {
    pub(crate) fn offer(&self, mission: &str, registration: &str) -> Result<Event> {
        let e = self
            .event(registration)?
            .ok_or_else(|| anyhow!("unknown agent"))?;
        ensure!(
            e.mission_id() == mission && matches!(e.body.payload, Payload::AgentOffered { .. }),
            "invalid agent registration"
        );
        Ok(e)
    }
    pub fn communicative_agent(&self, mission: &str, registration: &str) -> Result<AgentView> {
        let a = self
            .agent_views(mission)?
            .into_iter()
            .find(|a| a.id == registration)
            .ok_or_else(|| anyhow!("unknown agent"))?;
        ensure!(
            !matches!(
                a.status,
                AgentStatus::Conflict
                    | AgentStatus::Withdrawn
                    | AgentStatus::Revoked
                    | AgentStatus::ReviewRequired
            ),
            "agent communication unavailable"
        );
        ensure!(!self.locally_withdrawn(mission)?, "node withdrawn");
        Ok(a)
    }
    pub(crate) fn agent_registration(&self, mission: &str, author: &str) -> Result<Option<String>> {
        let mut q = self.connection.prepare(
            "SELECT registration FROM agent_registry WHERE mission=?1 AND author=?2 LIMIT 2",
        )?;
        let ids = q
            .query_map(params![mission, author], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(ids.len() < 2, "agent identity conflict");
        Ok(ids.into_iter().next())
    }
    pub(crate) fn known_participant(&self, mission: &str, author: &str) -> Result<bool> {
        Ok(self.connection.query_row("SELECT EXISTS(SELECT 1 FROM members WHERE mission=?1 AND author=?2) OR EXISTS(SELECT 1 FROM agent_registry WHERE mission=?1 AND author=?2)", params![mission,author], |r| r.get(0))?)
    }
    /// Saved human history survives withdrawal; an agent capability does not.
    pub fn readable_by(&self, mission: &str, audience: &str, viewer: &str) -> Result<bool> {
        if !self.known_participant(mission, viewer)? {
            return Ok(false);
        }
        if let Some(stream) = audience.strip_prefix("workstream:") {
            return Ok(self.event(stream)?.is_some_and(|e| {
                e.mission_id() == mission
                    && matches!(
                        crate::work::action(&e),
                        Some((
                            _,
                            harakiri_protocol::work::WorkAction::CreateWorkstream { .. }
                        ))
                    )
            }));
        }
        Ok(audience == "main" || self.audience_has(mission, audience, viewer)?)
    }
    pub fn send_message(
        &mut self,
        identity: &Identity,
        mission: &str,
        audience: &str,
        text: String,
        to: Option<String>,
        thread: Option<String>,
    ) -> Result<Event> {
        ensure!(
            self.readable_by(mission, audience, &identity.public_key())?,
            "conversation unavailable"
        );
        if let Some(registration) = self.agent_registration(mission, &identity.public_key())? {
            self.communicative_agent(mission, &registration)?;
        }
        if let Some(root) = self.audience_root(mission, audience)?
            && let Payload::AgentConversationCreated { registration } = &root.body.payload
        {
            self.communicative_agent(mission, registration)?;
        }
        if let Some(workstream) = audience.strip_prefix("workstream:") {
            self.append(
                identity,
                mission,
                Payload::WorkstreamMessage {
                    workstream: workstream.into(),
                    text,
                    to,
                    thread,
                },
            )
        } else {
            self.append_to(
                identity,
                mission,
                audience,
                Payload::MessageSent { text, to, thread },
            )
        }
    }
    pub fn open_agent_conversation(
        &mut self,
        human: &Identity,
        mission: &str,
        registration: &str,
    ) -> Result<String> {
        let author = human.public_key();
        ensure!(
            self.members(mission)?
                .iter()
                .any(|m| m.author == author && !m.revoked),
            "human participant required"
        );
        // Retry/reopen preserves the original conversation and history.
        if let Some(existing) = self
            .local_audiences(mission, &author)?
            .into_iter()
            .find(|a| a.agent_registration.as_deref() == Some(registration))
        {
            return Ok(existing.id);
        }
        self.communicative_agent(mission, registration)?;
        let audience = format!("private:{}", hex::encode(rand::random::<[u8; 32]>()));
        self.append_to(
            human,
            mission,
            &audience,
            Payload::AgentConversationCreated {
                registration: registration.into(),
            },
        )?;
        Ok(audience)
    }
    pub fn agent_request(
        &mut self,
        human: &Identity,
        mission: &str,
        contribution: &str,
        registration: &str,
        operation: AgentOperation,
    ) -> Result<serde_json::Value> {
        let identity = self.bound_agent_identity(human, mission, contribution, registration)?;
        let a = self.communicative_agent(mission, registration)?;
        ensure!(
            a.contributor == human.public_key() && a.identity.author == identity.public_key(),
            "contribution binding mismatch"
        );
        let state = self.control_state(mission)?;
        if matches!(
            &operation,
            AgentOperation::PlanArtifact { .. }
                | AgentOperation::Criterion { .. }
                | AgentOperation::Plan { .. }
                | AgentOperation::Ready { .. }
                | AgentOperation::Direct { .. }
        ) {
            ensure!(
                a.identity.role == AgentRole::Coordinator,
                "contribution was not offered as a Coordinator"
            );
        }
        let event = match operation {
            AgentOperation::Governance {} => {
                return Ok(serde_json::to_value(
                    self.governance(mission, &identity.public_key())?,
                )?);
            }
            AgentOperation::Criterion {
                control,
                index,
                wording,
                met,
                summary,
                evidence,
            } => self.govern(
                &identity,
                mission,
                &control,
                harakiri_protocol::governance::GovernanceAction::Criterion {
                    index,
                    wording,
                    met,
                    summary,
                    evidence,
                },
            )?,
            AgentOperation::PlanArtifact { control, revision } => {
                self.check_plan_artifact(mission, &revision, true)?;
                self.append(
                    &identity,
                    mission,
                    Payload::CoordinatorPlanArtifact { control, revision },
                )?
            }
            AgentOperation::Artifacts { query } => {
                return Ok(serde_json::to_value(self.artifacts(
                    mission,
                    &identity.public_key(),
                    query,
                )?)?);
            }
            AgentOperation::ArtifactDetail { revision } => {
                return Ok(serde_json::to_value(self.artifact_detail(
                    mission,
                    &identity.public_key(),
                    &revision,
                )?)?);
            }
            AgentOperation::ArtifactAction {
                control,
                conversation,
                action,
            } => {
                ensure!(
                    !matches!(
                        action,
                        harakiri_protocol::artifacts::ArtifactAction::Publish { .. }
                    ),
                    "publication requires file transfer"
                );
                self.artifact_action(&identity, mission, &control, &conversation, action)?
            }
            AgentOperation::ArtifactTransfer { .. } => {
                bail!("file transfer requires native service")
            }
            AgentOperation::Workstreams {} => {
                return Ok(serde_json::to_value(
                    self.workstreams(mission, &identity.public_key())?,
                )?);
            }
            AgentOperation::Tasks { query } => {
                return Ok(serde_json::to_value(self.tasks(
                    mission,
                    &identity.public_key(),
                    query,
                )?)?);
            }
            AgentOperation::Work { control, action } => {
                self.work(&identity, mission, &control, action)?
            }
            AgentOperation::Context {} => {
                return Ok(serde_json::to_value(AgentContext {
                    definition: state.definition,
                    lifecycle: state.lifecycle,
                    conversations: self.local_audiences(mission, &a.identity.author)?,
                    agent: a,
                    execution: "unavailable",
                })?);
            }
            AgentOperation::Messages { query } => {
                return Ok(serde_json::to_value(self.query_messages(
                    mission,
                    &identity.public_key(),
                    query,
                )?)?);
            }
            AgentOperation::Post {
                audience,
                text,
                to,
                thread,
            } => self.send_message(&identity, mission, &audience, text, to, thread)?,
            AgentOperation::Acknowledge { control, direction } => {
                ensure!(
                    state.lifecycle.revision == control
                        && a.direction.as_ref().is_some_and(|d| d.id == direction),
                    "direction changed; read context again"
                );
                if let Some(id) = a.acknowledgment {
                    return Ok(serde_json::json!({"event":id}));
                }
                self.append(
                    &identity,
                    mission,
                    Payload::AgentAcknowledged {
                        registration: registration.into(),
                        control,
                        direction,
                    },
                )?
            }
            AgentOperation::Plan { control, text } => self.append(
                &identity,
                mission,
                Payload::CoordinatorPlanned { control, text },
            )?,
            AgentOperation::Ready { control, plan } => {
                if let Some(id) = state
                    .lifecycle
                    .plan
                    .as_ref()
                    .and_then(|p| p.artifact.as_ref())
                {
                    self.check_plan_artifact(mission, id, true)?;
                }
                self.append(
                    &identity,
                    mission,
                    Payload::CoordinatorReadied { control, plan },
                )?
            }
            AgentOperation::Direct {
                control,
                registration,
                text,
            } => self.direct_agent(&identity, mission, &control, &registration, text)?,
        };
        Ok(serde_json::json!({"event":event.id}))
    }
    pub(crate) fn validate_communication(&self, e: &Event) -> Result<bool> {
        let mission = e.mission_id();
        match &e.body.payload {
            Payload::MessageSent { to, thread, .. }
            | Payload::WorkstreamMessage { to, thread, .. } => {
                if let Some(to) = to {
                    if !self.known_participant(mission, to)? {
                        return Ok(false);
                    }
                    ensure!(
                        self.readable_by(mission, &e.body.audience, to)?,
                        "recipient outside conversation"
                    );
                }
                if let Some(thread) = thread {
                    let Some(root) = self.event(thread)? else {
                        return Ok(false);
                    };
                    ensure!(
                        root.mission_id() == mission
                            && crate::work::channel(&root) == crate::work::channel(e)
                            && crate::lifecycle::activity(&root.body.payload).is_some()
                            && !matches!(
                                root.body.payload,
                                Payload::MessageSent {
                                    thread: Some(_),
                                    ..
                                } | Payload::WorkstreamMessage {
                                    thread: Some(_),
                                    ..
                                }
                            ),
                        "thread must reference a root in the same conversation"
                    );
                }
            }
            Payload::AgentConversationCreated { registration } => {
                let Some(offer) = self.event(registration)? else {
                    return Ok(false);
                };
                ensure!(
                    offer.mission_id() == mission
                        && matches!(offer.body.payload, Payload::AgentOffered { .. }),
                    "invalid private participant"
                );
                ensure!(
                    self.members(mission)?
                        .iter()
                        .any(|m| m.author == e.body.author),
                    "human conversation creator required"
                );
                if let Some(root) = self.audience_root(mission, &e.body.audience)? {
                    ensure!(
                        root.body.author == e.body.author,
                        "audience identity collision"
                    );
                }
                let count: u32 = self.connection.query_row(
                    "SELECT count(*) FROM audiences WHERE mission=?1",
                    [mission],
                    |r| r.get(0),
                )?;
                ensure!(
                    count < harakiri_protocol::limits::MAX_AUDIENCES as u32,
                    "audience limit"
                );
            }
            Payload::AgentAcknowledged {
                registration,
                control,
                direction,
            } => {
                let Some(offer) = self.event(registration)? else {
                    return Ok(false);
                };
                let Payload::AgentOffered {
                    control: reviewed,
                    identity,
                } = &offer.body.payload
                else {
                    bail!("agent registration required")
                };
                ensure!(
                    offer.mission_id() == mission
                        && identity.author == e.body.author
                        && e.body.authority.as_deref() == Some(registration),
                    "agent acknowledgment authority required"
                );
                if self.event(control)?.is_none() {
                    return Ok(false);
                }
                let history = self.control_history(mission)?;
                let state = history.at(control)?;
                ensure!(
                    state.lifecycle.phase == MissionPhase::Active
                        && history.at(reviewed)?.lifecycle.terms_revision
                            == state.lifecycle.terms_revision,
                    "invalid acknowledgment terms"
                );
                let Some(d) = self.event(direction)? else {
                    return Ok(false);
                };
                ensure!(
                    d.mission_id() == mission && d.body.audience == "main",
                    "foreign direction"
                );
                let valid = match &d.body.payload {
                    Payload::WorkRecorded {
                        control: assigned_control,
                        authorization: _,
                        action:
                            harakiri_protocol::work::WorkAction::AssignWorkstream {
                                registration: r,
                                ..
                            },
                    } => {
                        r == registration
                            && history.at(assigned_control)?.lifecycle.terms_revision
                                == state.lifecycle.terms_revision
                    }
                    Payload::AgentDirected {
                        registration: r,
                        control: c,
                        ..
                    } => r == registration && c == control,
                    Payload::MissionControlled {
                        action: ControlAction::Start { participants, .. },
                        ..
                    } => {
                        d.id == *control
                            && (participants.contains(registration)
                                || state
                                    .definition
                                    .policy
                                    .as_ref()
                                    .is_some_and(|p| p.coordination == Coordination::Peer))
                    }
                    _ => false,
                };
                ensure!(valid, "acknowledgment must name the assigned direction");
            }
            _ => {}
        }
        Ok(true)
    }
}

/// Disposable indexes, rebuilt from verified signed records at migration.
pub(crate) fn project(tx: &Transaction<'_>, e: &Event, fork: bool) -> Result<()> {
    if fork {
        return Ok(());
    }
    if let Payload::AgentOffered { identity, .. } = &e.body.payload {
        tx.execute("INSERT INTO agent_registry(mission,registration,author,contributor) VALUES(?1,?2,?3,?4)",params![e.mission_id(),e.id,identity.author,e.body.author])?;
    }
    if let Some((kind, text)) = crate::lifecycle::activity(&e.body.payload) {
        let (to, thread) = match &e.body.payload {
            Payload::MessageSent { to, thread, .. }
            | Payload::WorkstreamMessage { to, thread, .. } => (to.as_deref(), thread.as_deref()),
            _ => (None, None),
        };
        tx.execute(
            "INSERT INTO message_details(event,recipient,thread,text,kind) VALUES(?1,?2,?3,?4,?5)",
            params![e.id, to, thread, text, kind],
        )?;
    }
    Ok(())
}

impl Store {
    pub(crate) fn bound_agent_identity(
        &self,
        human: &Identity,
        mission: &str,
        contribution: &str,
        registration: &str,
    ) -> Result<Identity> {
        let identity = human.coordinator_identity(mission, contribution)?;
        let a = self.communicative_agent(mission, registration)?;
        ensure!(
            a.contributor == human.public_key() && a.identity.author == identity.public_key(),
            "contribution binding mismatch"
        );
        Ok(identity)
    }
    pub fn query_messages(
        &self,
        mission: &str,
        viewer: &str,
        query: MessageQuery,
    ) -> Result<MessagePage> {
        ensure!(
            self.known_participant(mission, viewer)?,
            "conversation unavailable"
        );
        self.message_query(mission, Some(viewer), query)
    }
    pub(crate) fn message_query(
        &self,
        mission: &str,
        viewer: Option<&str>,
        query: MessageQuery,
    ) -> Result<MessagePage> {
        ensure!(
            harakiri_protocol::event::is_hash(mission),
            "invalid mission"
        );
        let audience = query.audience.as_deref().unwrap_or("main");
        ensure!(
            harakiri_protocol::event::is_audience(audience)
                || audience
                    .strip_prefix("workstream:")
                    .is_some_and(harakiri_protocol::event::is_hash),
            "invalid audience"
        );
        let conversation = matches!(query.view, MessageFeed::Conversation);
        ensure!(
            conversation || (query.thread.is_none() && query.anchor.is_none()),
            "invalid feed query"
        );
        if conversation && let Some(viewer) = viewer {
            ensure!(
                self.readable_by(mission, audience, viewer)?,
                "conversation unavailable"
            );
        }
        let search = query.search.as_deref().unwrap_or("");
        ensure!(
            search.len() <= 512 && !search.contains('\0'),
            "invalid search"
        );
        for id in [
            query.before.as_deref(),
            query.anchor.as_deref(),
            query.thread.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            ensure!(
                harakiri_protocol::event::is_hash(id),
                "invalid message cursor"
            );
            let e = self
                .event(id)?
                .ok_or_else(|| anyhow!("message unavailable"))?;
            ensure!(
                e.mission_id() == mission
                    && crate::lifecycle::activity(&e.body.payload).is_some()
                    && (!conversation || crate::work::channel(&e) == audience),
                "message unavailable"
            );
            if let Some(viewer) = viewer {
                ensure!(
                    self.readable_by(mission, &e.body.audience, viewer)?,
                    "message unavailable"
                );
            }
        }
        if let Some(thread) = &query.thread {
            ensure!(
                !matches!(
                    self.event(thread)?
                        .ok_or_else(|| anyhow!("thread unavailable"))?
                        .body
                        .payload,
                    Payload::MessageSent {
                        thread: Some(_),
                        ..
                    } | Payload::WorkstreamMessage {
                        thread: Some(_),
                        ..
                    }
                ),
                "root message required"
            );
        }
        let position = |id: &str| -> Result<i64> {
            Ok(self
                .connection
                .query_row("SELECT rowid FROM events WHERE id=?1", [id], |r| r.get(0))?)
        };
        let cursor = query
            .before
            .as_deref()
            .map(position)
            .transpose()?
            .unwrap_or(i64::MAX);
        let anchor = query
            .anchor
            .as_deref()
            .map(position)
            .transpose()?
            .unwrap_or(i64::MAX);
        let feed = match query.view {
            MessageFeed::Conversation => "conversation",
            MessageFeed::Inbox => "inbox",
            MessageFeed::Sent => "sent",
        };
        let mut q = self.connection.prepare("SELECT e.bytes,EXISTS(SELECT 1 FROM message_reads WHERE event=e.id AND reader=?2),
            (SELECT count(*) FROM message_details replies JOIN events re ON re.id=replies.event WHERE replies.thread=e.id AND re.fork=0)
            FROM events e JOIN message_details d ON d.event=e.id LEFT JOIN events parent ON parent.id=d.thread
            WHERE e.mission=?1 AND e.fork=0 AND e.rowid<?3 AND e.rowid<=?4
              AND (?2 IS NULL OR e.audience='main' OR EXISTS(SELECT 1 FROM audience_readers ar WHERE ar.mission=e.mission AND ar.audience=e.audience AND ar.author=?2))
              AND ((?5='conversation' AND d.channel=?6 AND ((?7 IS NULL AND (d.thread IS NULL OR ?8<>'')) OR d.thread=?7 OR e.id=?7))
                OR (?5='sent' AND e.author=?2 AND d.kind='message')
                OR (?5='inbox' AND e.author<>?2 AND d.kind='message' AND (e.audience<>'main' OR d.recipient=?2 OR parent.author=?2)))
              AND (?8='' OR instr(lower(d.text),lower(?8))>0)
            ORDER BY e.rowid DESC LIMIT 201")?;
        let rows = q.query_map(
            params![
                mission,
                viewer,
                cursor,
                anchor,
                feed,
                audience,
                query.thread,
                search
            ],
            |r| {
                Ok((
                    r.get::<_, Vec<u8>>(0)?,
                    r.get::<_, bool>(1)?,
                    r.get::<_, u32>(2)?,
                ))
            },
        )?;
        let agents = self.agent_views(mission)?;
        let mut items = Vec::new();
        let mut bytes_used = 0;
        let mut before = None;
        for row in rows {
            let (bytes, read, replies) = row?;
            let e = Event::verify(&bytes)?;
            let Some((kind, mut text)) = crate::lifecycle::activity(&e.body.payload) else {
                continue;
            };
            let agent_registration = match &e.body.payload {
                Payload::AgentOffered { .. } => Some(e.id.clone()),
                Payload::AgentDirected { registration, .. }
                | Payload::AgentWithdrawn { registration }
                | Payload::AgentAcknowledged { registration, .. } => Some(registration.clone()),
                _ => None,
            };
            if let Some(target) = agent_registration
                .as_ref()
                .and_then(|id| agents.iter().find(|a| &a.id == id))
            {
                match &e.body.payload {
                    Payload::AgentDirected {
                        text: direction, ..
                    } => {
                        text = format!(
                            "Direction for {} in Main:\n\n{}",
                            target.identity.label, direction
                        )
                    }
                    Payload::AgentWithdrawn { .. } => {
                        text = format!(
                            "{} withdrawn by its contributor. Previous work remains available.",
                            target.identity.label
                        )
                    }
                    _ => {}
                }
            }
            let author_agent = agents.iter().find(|a| a.identity.author == e.body.author);
            let provisional = if let Some(a) = author_agent {
                matches!(
                    a.status,
                    AgentStatus::Conflict | AgentStatus::ReviewRequired
                ) || (matches!(a.status, AgentStatus::Revoked | AgentStatus::Withdrawn)
                    && !self.accepted_private_record(&e)?)
            } else {
                self.provisional(&e.id)?
            };
            let (to, thread) = match &e.body.payload {
                Payload::MessageSent { to, thread, .. }
                | Payload::WorkstreamMessage { to, thread, .. } => (to.clone(), thread.clone()),
                _ => (None, None),
            };
            let m = MessageView {
                work: crate::work::link(&e),
                kind,
                agent_registration,
                provisional,
                unread: !read && viewer.is_some_and(|v| v != e.body.author),
                audience: crate::work::channel(&e),
                to,
                thread,
                replies,
                author_label: author_agent.map(|a| a.identity.label.clone()),
                author_agent: author_agent.map(|a| a.id.clone()),
                id: e.id,
                author: e.body.author,
                text,
                created_at_ms: e.body.created_at_ms,
            };
            bytes_used += serde_json::to_vec(&m)?.len();
            if items.len() >= 200 || (bytes_used > 1024 * 1024 && !items.is_empty()) {
                before = items.last().map(|m: &MessageView| m.id.clone());
                break;
            }
            items.push(m);
        }
        items.reverse();
        Ok(MessagePage { items, before })
    }
    pub fn mark_messages_read(
        &mut self,
        mission: &str,
        viewer: &str,
        ids: &[String],
    ) -> Result<()> {
        ensure!(
            ids.len() <= 200 && self.known_participant(mission, viewer)?,
            "invalid read batch"
        );
        for id in ids {
            let e = self
                .event(id)?
                .ok_or_else(|| anyhow!("message unavailable"))?;
            ensure!(
                e.mission_id() == mission
                    && crate::lifecycle::activity(&e.body.payload).is_some()
                    && self.readable_by(mission, &e.body.audience, viewer)?,
                "message unavailable"
            );
        }
        let tx = self.connection.transaction()?;
        for id in ids {
            tx.execute(
                "INSERT OR IGNORE INTO message_reads(event,reader) VALUES(?1,?2)",
                params![id, viewer],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}
