//! Each accepted record and its projections commit together. Remote input never
//! supplies executable paths, SQL or serialized projections.
use anyhow::{Result, anyhow, bail, ensure};
use harakiri_protocol::{Event, EventBody, Identity, MissionDefinition, Payload, limits};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path, time::Duration};

pub struct Store {
    pub(crate) artifact_cache:
        std::cell::RefCell<BTreeMap<String, std::sync::Arc<crate::artifacts::Records>>>,
    pub(crate) work_cache:
        std::cell::RefCell<BTreeMap<String, std::sync::Arc<crate::work::Records>>>,
    pub(crate) connection: Connection,
    pub(crate) control_cache:
        std::cell::RefCell<BTreeMap<String, std::sync::Arc<harakiri_protocol::lifecycle::History>>>,
    pub(crate) agent_cache:
        std::cell::RefCell<BTreeMap<String, std::sync::Arc<crate::agents::Records>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Head {
    pub author: String,
    pub sequence: u64,
    pub id: String,
}

#[derive(Debug, Default, Serialize)]
pub struct ImportResult {
    pub inserted: usize,
    pub duplicates: usize,
    pub forks: usize,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct MissionView {
    pub id: String,
    pub owner: String,
    pub definition: MissionDefinition,
    pub state: &'static str,
    pub conflicted: bool,
    pub event_count: u64,
    pub coordinator_node: Option<String>,
    pub lifecycle: harakiri_protocol::lifecycle::LifecycleView,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct MessageView {
    pub work: Option<harakiri_protocol::work::WorkLink>,
    pub audience: String,
    pub to: Option<String>,
    pub thread: Option<String>,
    pub replies: u32,
    pub unread: bool,
    pub author_label: Option<String>,
    pub author_agent: Option<String>,
    pub kind: &'static str,
    pub agent_registration: Option<String>,
    pub provisional: bool,
    pub id: String,
    pub author: String,
    pub text: String,
    pub created_at_ms: Option<u64>,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct MessagePage {
    pub items: Vec<MessageView>,
    pub before: Option<String>,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct MissionPage {
    pub items: Vec<MissionView>,
    pub before: Option<String>,
}

// JSON escaping can expand signed text. Bound the encoded page as well as the
// row count, so a valid history can never exhaust the native response frame.
const PAGE_BYTES: usize = 1024 * 1024;

pub(crate) fn now() -> Result<u64> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis()
        .try_into()?)
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(2))?;
        let version: u32 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
        ensure!(
            version <= 14,
            "unsupported node database version; preserve this profile"
        );
        connection.pragma_update(None, "foreign_keys", true)?;
        connection.pragma_update(None, "trusted_schema", false)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        if version == 0 {
            connection.execute_batch("BEGIN IMMEDIATE;
                CREATE TABLE missions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, genesis BLOB NOT NULL);
                CREATE TABLE events(
                  id TEXT PRIMARY KEY, mission TEXT NOT NULL REFERENCES missions(id),
                  author TEXT NOT NULL, sequence INTEGER NOT NULL, bytes BLOB NOT NULL,
                  fork INTEGER NOT NULL DEFAULT 0);
                CREATE INDEX writer_history ON events(mission, author, sequence);
                CREATE TABLE members(
                  mission TEXT NOT NULL REFERENCES missions(id), author TEXT NOT NULL,
                  endpoint TEXT NOT NULL, authority TEXT NOT NULL,
                  PRIMARY KEY(mission, author));
                CREATE INDEX member_endpoint ON members(endpoint, mission);
                CREATE TABLE files(
                  mission TEXT NOT NULL REFERENCES missions(id), event TEXT NOT NULL REFERENCES events(id),
                  hash TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(event, hash));
                CREATE INDEX accessible_files ON files(hash, mission);
                PRAGMA user_version=1;
                COMMIT;")?;
        }
        if version < 2 {
            // Projections are disposable indexes over signed records. Migration
            // failure rolls back the schema and leaves all original bytes intact.
            let tx = connection.transaction()?;
            tx.execute_batch(
                "CREATE TABLE messages(event TEXT PRIMARY KEY REFERENCES events(id));",
            )?;
            {
                let mut query = tx.prepare("SELECT id,bytes FROM events WHERE fork=0")?;
                let rows = query.query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
                })?;
                for row in rows {
                    let (id, bytes) = row?;
                    let event = Event::verify(&bytes)?;
                    ensure!(event.id == id, "invalid stored event identity");
                    if matches!(event.body.payload, Payload::MessagePosted { .. }) {
                        tx.execute("INSERT INTO messages(event) VALUES(?1)", [id])?;
                    }
                }
            }
            tx.pragma_update(None, "user_version", 2)?;
            tx.commit()?;
        }
        if version < 3 {
            let tx = connection.transaction()?;
            tx.execute_batch("ALTER TABLE events ADD COLUMN audience TEXT NOT NULL DEFAULT 'main';
                DROP INDEX writer_history;
                CREATE INDEX writer_history ON events(mission,audience,author,sequence);
                CREATE TABLE audiences(mission TEXT NOT NULL, id TEXT NOT NULL, root TEXT NOT NULL REFERENCES events(id), creator TEXT NOT NULL, PRIMARY KEY(mission,id));
                CREATE TABLE audience_readers(mission TEXT NOT NULL,audience TEXT NOT NULL,author TEXT NOT NULL, PRIMARY KEY(mission,audience,author));
                CREATE TABLE revocations(mission TEXT NOT NULL,member TEXT NOT NULL,event TEXT NOT NULL REFERENCES events(id),accepted TEXT,PRIMARY KEY(mission,member));
                CREATE TABLE audience_cuts(mission TEXT NOT NULL,audience TEXT NOT NULL,member TEXT NOT NULL,event TEXT NOT NULL REFERENCES events(id),accepted TEXT,PRIMARY KEY(mission,audience,member));
                CREATE TABLE delivery(mission TEXT NOT NULL,audience TEXT NOT NULL,endpoint TEXT NOT NULL,dirty INTEGER NOT NULL DEFAULT 1,acknowledged TEXT NOT NULL DEFAULT '[]',last_success_ms INTEGER,last_error TEXT,PRIMARY KEY(mission,audience,endpoint));
                INSERT INTO delivery(mission,audience,endpoint) SELECT mission,'main',endpoint FROM members GROUP BY mission,endpoint;
                PRAGMA user_version=3;")?;
            tx.commit()?;
        }
        if version < 4 {
            let tx = connection.transaction()?;
            tx.execute_batch("CREATE TABLE invitations(id TEXT PRIMARY KEY,mission TEXT NOT NULL,expires_ms INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE join_requests(mission TEXT NOT NULL,author TEXT NOT NULL,endpoint TEXT NOT NULL,offer TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',PRIMARY KEY(mission,author));
                CREATE TABLE contacts(mission TEXT NOT NULL,author TEXT NOT NULL,signed TEXT NOT NULL,expires_ms INTEGER NOT NULL,PRIMARY KEY(mission,author));
                CREATE TABLE local_joins(mission TEXT PRIMARY KEY,ticket TEXT NOT NULL,genesis BLOB NOT NULL,status TEXT NOT NULL DEFAULT 'pending');
                CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                PRAGMA user_version=4;")?;
            tx.commit()?;
        }
        if version < 5 {
            connection.execute_batch("CREATE TABLE revocation_notices(mission TEXT NOT NULL,member TEXT NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(mission,member)); PRAGMA user_version=5;")?;
        }
        if version < 6 {
            let tx = connection.transaction()?;
            tx.execute_batch("CREATE TABLE advertisements(publisher TEXT NOT NULL,mission TEXT NOT NULL,revision INTEGER NOT NULL,expires_ms INTEGER NOT NULL,reference TEXT NOT NULL,owned INTEGER NOT NULL DEFAULT 0,conflict INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(publisher,mission));
                CREATE TABLE withdrawals(mission TEXT NOT NULL,author TEXT NOT NULL,endpoint TEXT NOT NULL,signed TEXT NOT NULL,accepted TEXT,PRIMARY KEY(mission,author));
                CREATE TABLE local_withdrawals(mission TEXT PRIMARY KEY,notice TEXT NOT NULL,targets TEXT NOT NULL);
                PRAGMA user_version=6;")?;
            tx.commit()?;
        }
        if version < 7 {
            let tx = connection.transaction()?;
            tx.execute_batch(
                "CREATE TABLE control_records(event TEXT PRIMARY KEY REFERENCES events(id));
                 CREATE TABLE join_reviews(mission TEXT PRIMARY KEY REFERENCES local_joins(mission),proof TEXT NOT NULL);
                 UPDATE local_joins SET status='review_required' WHERE status='pending';
                 UPDATE join_requests SET status='review_required' WHERE status='pending';",
            )?;
            {
                let mut q = tx.prepare("SELECT id,bytes FROM events")?;
                let rows = q.query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
                })?;
                for row in rows {
                    let (id, bytes) = row?;
                    let e = Event::verify(&bytes)?;
                    ensure!(id == e.id, "invalid stored control identity");
                    if crate::lifecycle::is_control(&e.body.payload) {
                        tx.execute("INSERT INTO control_records(event) VALUES(?1)", [&id])?;
                        if crate::lifecycle::activity(&e.body.payload).is_some() {
                            tx.execute("INSERT OR IGNORE INTO messages(event) VALUES(?1)", [&id])?;
                        }
                    }
                }
            }
            tx.pragma_update(None, "user_version", 7)?;
            tx.commit()?;
        }
        if version < 8 {
            let tx = connection.transaction()?;
            tx.execute_batch(
                "CREATE TABLE agent_records(event TEXT PRIMARY KEY REFERENCES events(id));",
            )?;
            {
                let mut q = tx.prepare("SELECT id,bytes FROM events")?;
                let rows = q.query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
                })?;
                for row in rows {
                    let (id, bytes) = row?;
                    let e = Event::verify(&bytes)?;
                    ensure!(id == e.id, "invalid stored agent identity");
                    if crate::agents::is_agent_record(&e.body.payload) {
                        tx.execute("INSERT INTO agent_records(event) VALUES(?1)", [&id])?;
                        tx.execute("INSERT OR IGNORE INTO messages(event) VALUES(?1)", [&id])?;
                    }
                }
            }
            tx.pragma_update(None, "user_version", 8)?;
            tx.commit()?;
        }
        if version < 9 {
            let tx = connection.transaction()?;
            tx.execute_batch("CREATE TABLE agent_registry(mission TEXT NOT NULL,registration TEXT PRIMARY KEY REFERENCES events(id),author TEXT NOT NULL,contributor TEXT NOT NULL);
                CREATE INDEX agent_authors ON agent_registry(mission,author);
                CREATE TABLE message_details(event TEXT PRIMARY KEY REFERENCES events(id),recipient TEXT,thread TEXT,text TEXT NOT NULL,kind TEXT NOT NULL);
                CREATE INDEX message_recipient ON message_details(recipient,event);
                CREATE INDEX message_thread ON message_details(thread,event);
                CREATE TABLE message_reads(event TEXT NOT NULL REFERENCES events(id),reader TEXT NOT NULL,PRIMARY KEY(event,reader));")?;
            {
                let mut q = tx.prepare("SELECT id,bytes,fork FROM events ORDER BY rowid")?;
                let rows = q.query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Vec<u8>>(1)?,
                        r.get::<_, bool>(2)?,
                    ))
                })?;
                for row in rows {
                    let (id, bytes, fork) = row?;
                    let e = Event::verify(&bytes)?;
                    ensure!(id == e.id, "invalid stored communication identity");
                    crate::communication::project(&tx, &e, fork)?;
                }
            }
            tx.pragma_update(None, "user_version", 9)?;
            tx.commit()?;
        }
        if version < 10 {
            let tx = connection.transaction()?;
            tx.execute_batch(
                "CREATE TABLE work_records(event TEXT PRIMARY KEY REFERENCES events(id));
                ALTER TABLE message_details ADD COLUMN channel TEXT NOT NULL DEFAULT 'main';
                UPDATE message_details SET channel=(SELECT audience FROM events WHERE id=event);
                CREATE INDEX message_channel ON message_details(channel,event);",
            )?;
            {
                let mut q = tx.prepare("SELECT id,bytes FROM events")?;
                let rows = q.query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
                })?;
                for row in rows {
                    let (id, bytes) = row?;
                    let e = Event::verify(&bytes)?;
                    ensure!(id == e.id, "invalid stored work identity");
                    if matches!(e.body.payload, Payload::WorkRecorded { .. }) {
                        tx.execute("INSERT INTO work_records(event) VALUES(?1)", [&id])?;
                    }
                    tx.execute(
                        "UPDATE message_details SET channel=?1 WHERE event=?2",
                        params![crate::work::channel(&e), id],
                    )?;
                }
            }
            tx.pragma_update(None, "user_version", 10)?;
            tx.commit()?;
        }
        if version < 11 {
            let tx = connection.transaction()?;
            tx.execute_batch("CREATE TABLE artifact_records(event TEXT PRIMARY KEY REFERENCES events(id));
                CREATE TABLE available_files(event TEXT NOT NULL REFERENCES events(id),hash TEXT NOT NULL,PRIMARY KEY(event,hash));")?;
            {
                let mut q = tx.prepare("SELECT id,bytes FROM events")?;
                for row in q.query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
                })? {
                    let (id, bytes) = row?;
                    let e = Event::verify(&bytes)?;
                    ensure!(id == e.id, "invalid stored artifact identity");
                    if crate::artifacts::is_record(&e.body.payload) {
                        tx.execute("INSERT INTO artifact_records(event) VALUES(?1)", [&id])?;
                    }
                }
            }
            tx.pragma_update(None, "user_version", 11)?;
            tx.commit()?;
        }
        if version < 12 {
            let tx = connection.transaction()?;
            tx.execute_batch(
                "CREATE TABLE governance_records(event TEXT PRIMARY KEY REFERENCES events(id));",
            )?;
            {
                let mut q = tx.prepare("SELECT id,bytes FROM events")?;
                for row in q.query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
                })? {
                    let (id, bytes) = row?;
                    let e = Event::verify(&bytes)?;
                    ensure!(id == e.id, "invalid stored governance identity");
                    if matches!(e.body.payload, Payload::GovernanceRecorded { .. }) {
                        tx.execute("INSERT INTO governance_records(event) VALUES(?1)", [&id])?;
                    }
                }
            }
            tx.pragma_update(None, "user_version", 12)?;
            tx.commit()?;
        }
        // v9 permission purpose changes authority semantics. Refuse reopening
        // with a v8 binary even though the disposable SQL indexes are unchanged.
        if version < 13 {
            connection.pragma_update(None, "user_version", 13)?;
        }
        // Scoped reviews need protocol v10. No table or signed-byte rewrite is
        // needed, but old executables must refuse this profile before writing.
        if version < 14 {
            connection.pragma_update(None, "user_version", 14)?;
        }
        Ok(Self {
            artifact_cache: Default::default(),
            work_cache: Default::default(),
            connection,
            control_cache: Default::default(),
            agent_cache: Default::default(),
        })
    }

    pub fn create(
        &mut self,
        identity: &Identity,
        endpoint: String,
        definition: MissionDefinition,
    ) -> Result<Event> {
        let event = identity.sign(EventBody {
            version: limits::VERSION,
            mission: None,
            author: identity.public_key(),
            audience: "main".into(),
            sequence: 0,
            previous: None,
            authority: None,
            created_at_ms: Some(now()?),
            payload: Payload::MissionCreated {
                definition,
                endpoint,
                nonce: hex::encode(rand::random::<[u8; 32]>()),
            },
        })?;
        self.import(&[event.bytes().to_vec()])?;
        Ok(event)
    }

    pub fn append(
        &mut self,
        identity: &Identity,
        mission: &str,
        payload: Payload,
    ) -> Result<Event> {
        self.append_to(identity, mission, "main", payload)
    }

    pub fn append_to(
        &mut self,
        identity: &Identity,
        mission: &str,
        audience: &str,
        payload: Payload,
    ) -> Result<Event> {
        ensure!(
            harakiri_protocol::event::is_audience(audience),
            "invalid audience"
        );
        ensure!(
            !self.is_revoked(mission, &identity.public_key())?
                && !self.locally_withdrawn(mission)?,
            "membership revoked"
        );
        ensure!(
            !self.conflicted_scope(mission, audience)?,
            "mission has conflicting signed history"
        );
        let phase = self.control_state(mission)?.lifecycle.phase;
        let recovery = matches!(
            payload,
            Payload::MemberRevoked { .. }
                | Payload::AudienceFrontier { .. }
                | Payload::AgentWithdrawn { .. }
                | Payload::GovernanceRecorded {
                    action: harakiri_protocol::governance::GovernanceAction::RetireGrant { .. }
                        | harakiri_protocol::governance::GovernanceAction::Receipt { .. }
                        | harakiri_protocol::governance::GovernanceAction::Resolve { .. }
                        | harakiri_protocol::governance::GovernanceAction::SealGrant { .. }
                        | harakiri_protocol::governance::GovernanceAction::SealAllocation { .. }
                        | harakiri_protocol::governance::GovernanceAction::Reclaim { .. },
                    ..
                }
        );
        ensure!(
            phase != harakiri_protocol::lifecycle::MissionPhase::Archived
                || recovery
                || matches!(
                    payload,
                    Payload::MissionControlled {
                        action: harakiri_protocol::lifecycle::ControlAction::Restore {},
                        ..
                    }
                ),
            "archived mission is read only"
        );
        let author = identity.public_key();
        let coordinator_control = match &payload {
            Payload::CoordinatorPlanArtifact { control, .. }
            | Payload::CoordinatorPlanned { control, .. }
            | Payload::CoordinatorReadied { control, .. } => Some(control),
            Payload::AgentDirected { control, .. } if self.owner(mission)? != author => {
                Some(control)
            }
            _ => None,
        };
        let authority: String = if let Some(control) = coordinator_control {
            let state = self.control_state(mission)?;
            ensure!(
                &state.lifecycle.revision == control,
                "control revision changed"
            );
            let c = state
                .lifecycle
                .coordinator
                .ok_or_else(|| anyhow!("no Coordinator"))?;
            ensure!(
                c.identity.author == author,
                "appointed Coordinator required"
            );
            c.appointment
        } else if let Some(registration) = self.agent_registration(mission, &author)? {
            self.communicative_agent(mission, &registration)?;
            registration
        } else {
            self.connection.query_row(
                "SELECT authority FROM members WHERE mission=?1 AND author=?2",
                params![mission, author],
                |r| r.get(0),
            )?
        };
        let authority = if audience != "main"
            && !matches!(
                payload,
                Payload::AudienceCreated { .. } | Payload::AgentConversationCreated { .. }
            ) {
            let root = self
                .audience_root(mission, audience)?
                .ok_or_else(|| anyhow!("unknown audience"))?;
            ensure!(
                self.audience_has(mission, audience, &author)?,
                "not an audience participant"
            );
            root.id
        } else {
            authority
        };
        let head = self.head_in(mission, audience, &author)?;
        let event = identity.sign(EventBody {
            version: limits::VERSION,
            mission: Some(mission.into()),
            author,
            audience: audience.into(),
            sequence: head.as_ref().map_or(0, |h| h.sequence + 1),
            previous: head.map(|h| h.id),
            authority: Some(authority),
            created_at_ms: Some(now()?),
            payload,
        })?;
        self.import(&[event.bytes().to_vec()])?;
        Ok(event)
    }

    /// Each record commits atomically. A batch may have already committed valid
    /// predecessors when an invalid child is rejected; retrying is idempotent.
    pub fn import(&mut self, bytes: &[Vec<u8>]) -> Result<ImportResult> {
        ensure!(
            bytes.len() <= limits::MAX_PENDING_EVENTS,
            "too many pending events"
        );
        let mut pending = bytes
            .iter()
            .map(|b| Event::verify(b))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut result = ImportResult::default();
        while !pending.is_empty() {
            let mut next = Vec::new();
            let before = pending.len();
            for event in pending {
                if self.event(&event.id)?.is_some() {
                    result.duplicates += 1;
                    continue;
                }
                match self.insert(&event)? {
                    Some(fork) => {
                        result.inserted += 1;
                        result.forks += usize::from(fork);
                    }
                    None => next.push(event),
                }
            }
            ensure!(
                next.len() < before,
                "missing causal history; fetch predecessors before retrying"
            );
            pending = next;
        }
        Ok(result)
    }

    /// None means dependency missing, rather than authority denied.
    fn insert(&mut self, event: &Event) -> Result<Option<bool>> {
        let body = &event.body;
        let mission = event.mission_id();
        let genesis = matches!(body.payload, Payload::MissionCreated { .. });
        if !genesis {
            let Some(root) = self.event(mission)? else {
                return Ok(None);
            };
            ensure!(
                matches!(root.body.payload, Payload::MissionCreated { .. }),
                "invalid mission root"
            );
            if let Some(previous) = &body.previous {
                let Some(parent) = self.event(previous)? else {
                    return Ok(None);
                };
                ensure!(
                    parent.mission_id() == mission
                        && parent.body.audience == body.audience
                        && parent.body.author == body.author
                        && parent.body.sequence + 1 == body.sequence,
                    "invalid writer predecessor"
                );
            }
            let authority = body
                .authority
                .as_deref()
                .ok_or_else(|| anyhow!("missing authority"))?;
            let Some(grant) = self.event(authority)? else {
                return Ok(None);
            };
            ensure!(
                grant.mission_id() == mission,
                "authority belongs to another mission"
            );
            let authorized = match &grant.body.payload {
                Payload::MissionCreated { .. } => {
                    body.author == root.body.author
                        && grant.id == mission
                        && (body.audience == "main"
                            || matches!(
                                body.payload,
                                Payload::AudienceCreated { .. }
                                    | Payload::AgentConversationCreated { .. }
                            ))
                }
                Payload::MemberAdmitted { member, .. } => {
                    member == &body.author
                        && grant.body.author == root.body.author
                        && grant.body.audience == "main"
                        && (body.audience == "main"
                            || matches!(
                                body.payload,
                                Payload::AudienceCreated { .. }
                                    | Payload::AgentConversationCreated { .. }
                            ))
                }
                Payload::AgentOffered { identity, .. } => {
                    identity.author == body.author
                        && body.audience == "main"
                        && matches!(
                            body.payload,
                            Payload::MessageSent { .. }
                                | Payload::AgentAcknowledged { .. }
                                | Payload::GovernanceRecorded { .. }
                                | Payload::WorkRecorded { .. }
                                | Payload::WorkstreamMessage { .. }
                                | Payload::ArtifactPublished { .. }
                                | Payload::ArtifactRecorded { .. }
                        )
                }
                Payload::AgentConversationCreated { registration } => {
                    let offer = self.offer(mission, registration)?;
                    let Payload::AgentOffered { identity, .. } = &offer.body.payload else {
                        unreachable!()
                    };
                    (body.author == grant.body.author || body.author == identity.author)
                        && grant.body.audience == body.audience
                        && self
                            .audience_root(mission, &body.audience)?
                            .is_some_and(|r| r.id == grant.id)
                        && matches!(
                            body.payload,
                            Payload::MessageSent { .. }
                                | Payload::ArtifactRecorded { .. }
                                | Payload::AudienceFrontier { .. }
                        )
                }
                Payload::AudienceCreated { readers } => {
                    readers.contains(&body.author)
                        && grant.body.audience == body.audience
                        && self
                            .audience_root(mission, &body.audience)?
                            .is_some_and(|r| r.id == grant.id)
                }
                Payload::MissionControlled {
                    action:
                        harakiri_protocol::lifecycle::ControlAction::Handover { coordinator: c, .. },
                    ..
                } => {
                    body.author == c.author
                        && grant.body.author == root.body.author
                        && body.audience == "main"
                        && matches!(
                            body.payload,
                            Payload::CoordinatorPlanned { .. }
                                | Payload::CoordinatorPlanArtifact { .. }
                                | Payload::CoordinatorReadied { .. }
                                | Payload::AgentDirected { .. }
                        )
                }
                Payload::MissionControlled {
                    action:
                        harakiri_protocol::lifecycle::ControlAction::SetCoordination {
                            coordinator: Some(c),
                            ..
                        },
                    ..
                } => {
                    body.author == c.author
                        && grant.body.author == root.body.author
                        && body.audience == "main"
                        && grant.body.audience == "main"
                        && matches!(
                            body.payload,
                            Payload::CoordinatorPlanArtifact { .. }
                                | Payload::CoordinatorPlanned { .. }
                                | Payload::CoordinatorReadied { .. }
                                | Payload::AgentDirected { .. }
                        )
                }
                _ => false,
            };
            ensure!(authorized, "author is not admitted");
            ensure!(
                !body.payload.owner_only() || body.author == root.body.author,
                "owner authority required"
            );
        }
        if !self.validate_control(event)?
            || !self.validate_scoped(event)?
            || !self.validate_agent_record(event)?
            || !self.validate_communication(event)?
            || !self.validate_work(event)?
            || !self.validate_artifact(event)?
            || !self.validate_governance(event)?
        {
            return Ok(None);
        }
        let count: i64 = self.connection.query_row(
            "SELECT count(*) FROM events WHERE mission=?1",
            [mission],
            |r| r.get(0),
        )?;
        ensure!(
            count < limits::MAX_HISTORY_EVENTS as i64,
            "mission history limit reached"
        );
        let sibling: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM events WHERE mission=?1 AND author=?2 AND sequence=?3 AND audience=?4)",
            params![mission, body.author, body.sequence as i64, body.audience],
            |r| r.get(0),
        )?;
        let frozen = self.conflicted_scope(mission, &body.audience)?;
        // Keep a signed fork as evidence. It cannot change any projection.
        ensure!(!frozen || sibling, "mission has conflicting signed history");
        let tx = self.connection.transaction()?;
        if genesis {
            tx.execute(
                "INSERT INTO missions(id,owner,genesis) VALUES(?1,?2,?3)",
                params![mission, body.author, event.bytes()],
            )?;
        }
        tx.execute(
            "INSERT INTO events(id,mission,author,sequence,bytes,fork,audience) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                event.id,
                mission,
                body.author,
                body.sequence as i64,
                event.bytes(),
                sibling,
                body.audience
            ],
        )?;
        if !sibling {
            match &body.payload {
                Payload::MissionCreated { endpoint, .. } => {
                    tx.execute("INSERT INTO members(mission,author,endpoint,authority) VALUES(?1,?2,?3,?4)",
                        params![mission, body.author, endpoint, event.id])?;
                }
                Payload::MemberAdmitted { member, endpoint } => {
                    // Updating/revoking an identity is a separate future control operation.
                    tx.execute("INSERT INTO members(mission,author,endpoint,authority) VALUES(?1,?2,?3,?4)",
                        params![mission, member, endpoint, event.id])?;
                }
                Payload::ArtifactPublished { files, .. }
                | Payload::ArtifactRecorded {
                    action:
                        harakiri_protocol::artifacts::ArtifactAction::Publish {
                            document: harakiri_protocol::artifacts::ArtifactDocument { files, .. },
                            ..
                        },
                    ..
                } => {
                    for file in files {
                        tx.execute("INSERT OR IGNORE INTO files(mission,event,hash,size) VALUES(?1,?2,?3,?4)",
                            params![mission, event.id, file.hash, file.size as i64])?;
                    }
                }
                _ if crate::lifecycle::activity(&body.payload).is_some() => {
                    tx.execute("INSERT INTO messages(event) VALUES(?1)", [&event.id])?;
                }
                _ => {}
            }
        }
        crate::communication::project(&tx, event, sibling)?;
        if crate::artifacts::is_record(&body.payload) {
            tx.execute(
                "INSERT INTO artifact_records(event) VALUES(?1)",
                [&event.id],
            )?;
        }
        tx.execute(
            "UPDATE message_details SET channel=?1 WHERE event=?2",
            params![crate::work::channel(event), event.id],
        )?;
        if matches!(body.payload, Payload::GovernanceRecorded { .. }) {
            tx.execute(
                "INSERT INTO governance_records(event) VALUES(?1)",
                [&event.id],
            )?;
        }
        if matches!(body.payload, Payload::WorkRecorded { .. }) {
            tx.execute("INSERT INTO work_records(event) VALUES(?1)", [&event.id])?;
        }
        crate::scope::project(&tx, event, sibling)?;
        if crate::lifecycle::is_control(&body.payload) {
            tx.execute("INSERT INTO control_records(event) VALUES(?1)", [&event.id])?;
        }
        if crate::agents::is_agent_record(&body.payload) {
            tx.execute("INSERT INTO agent_records(event) VALUES(?1)", [&event.id])?;
        }
        tx.execute(
            "UPDATE delivery SET dirty=1 WHERE mission=?1 AND audience=?2",
            params![mission, body.audience],
        )?;
        tx.commit()?;
        self.work_cache.borrow_mut().remove(mission);
        self.artifact_cache.borrow_mut().remove(mission);
        if crate::agents::is_agent_record(&body.payload)
            && let Some(records) = self.agent_cache.borrow_mut().get_mut(mission)
        {
            std::sync::Arc::make_mut(records).insert(event.id.clone(), event.clone());
        }
        if crate::lifecycle::is_control(&body.payload)
            && let Some(history) = self.control_cache.borrow_mut().get_mut(mission)
        {
            // This record was verified and committed above. Preserve the
            // verified prefix instead of re-verifying all signatures per post.
            std::sync::Arc::make_mut(history)
                .records
                .insert(event.id.clone(), event.clone());
        }
        Ok(Some(sibling))
    }

    pub fn event(&self, id: &str) -> Result<Option<Event>> {
        let bytes: Option<Vec<u8>> = self
            .connection
            .query_row("SELECT bytes FROM events WHERE id=?1", [id], |r| r.get(0))
            .optional()?;
        bytes
            .map(|bytes| Event::verify(&bytes).map_err(Into::into))
            .transpose()
    }

    pub fn conflicted(&self, mission: &str) -> Result<bool> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM events WHERE mission=?1 AND audience='main' AND fork=1)",
            [mission],
            |r| r.get(0),
        )?)
    }

    pub fn head(&self, mission: &str, author: &str) -> Result<Option<Head>> {
        self.head_in(mission, "main", author)
    }
    pub fn head_in(&self, mission: &str, audience: &str, author: &str) -> Result<Option<Head>> {
        Ok(self.connection.query_row("SELECT sequence,id FROM events WHERE mission=?1 AND author=?2 AND audience=?3 ORDER BY sequence DESC,id LIMIT 1",
            params![mission, author, audience], |r| Ok(Head { author: author.into(), sequence: positive_integer(r, 0)?, id: r.get(1)? })).optional()?)
    }

    pub fn heads(&self, mission: &str) -> Result<Vec<Head>> {
        self.heads_in(mission, "main")
    }
    pub fn heads_in(&self, mission: &str, audience: &str) -> Result<Vec<Head>> {
        let mut stmt = self.connection.prepare(
            "SELECT DISTINCT author FROM events WHERE mission=?1 AND audience=?2 ORDER BY author",
        )?;
        let authors = stmt
            .query_map(params![mission, audience], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(authors.len() <= 1024, "writer limit reached");
        authors
            .into_iter()
            .map(|author| {
                self.head_in(mission, audience, &author)?
                    .ok_or_else(|| anyhow!("missing writer"))
            })
            .collect()
    }

    pub fn delta(&self, mission: &str, heads: &[Head]) -> Result<Vec<Vec<u8>>> {
        self.delta_in(mission, "main", heads)
    }
    pub fn delta_in(&self, mission: &str, audience: &str, heads: &[Head]) -> Result<Vec<Vec<u8>>> {
        ensure!(heads.len() <= 1024, "too many writer heads");
        let mut known = BTreeMap::new();
        let mut authors = std::collections::BTreeSet::new();
        for head in heads {
            ensure!(
                harakiri_protocol::event::is_hash(&head.author)
                    && harakiri_protocol::event::is_hash(&head.id)
                    && head.sequence <= 9_007_199_254_740_991,
                "invalid writer head"
            );
            ensure!(authors.insert(&head.author), "duplicate writer head");
            // Verify each supplied head once, rather than re-verifying the same
            // signature for every row in a large history.
            if let Some(event) = self.event(&head.id)?
                && event.mission_id() == mission
                && event.body.audience == audience
                && event.body.author == head.author
                && event.body.sequence == head.sequence
            {
                known.insert(&head.author, head);
            }
        }
        let mut stmt = self.connection.prepare(
            "SELECT author,sequence,id,bytes,fork FROM events WHERE mission=?1 AND audience=?2 ORDER BY rowid",
        )?;
        let mut rows = stmt.query(params![mission, audience])?;
        let mut output = Vec::new();
        let mut size = 0;
        while let Some(row) = rows.next()? {
            let author: String = row.get(0)?;
            let sequence = positive_integer(row, 1)?;
            let id: String = row.get(2)?;
            let fork: bool = row.get(4)?;
            // Unknown/mismatching heads cause a replay, never skipped history.
            if !fork
                && let Some(head) = known.get(&author)
                && (sequence < head.sequence || (sequence == head.sequence && id == head.id))
            {
                continue;
            }
            let bytes: Vec<u8> = row.get(3)?;
            size += bytes.len() * 2 + 4; // JSON hex wire envelope
            if size > limits::MAX_FRAME_BYTES / 2 || output.len() == limits::MAX_BATCH_EVENTS {
                break;
            }
            output.push(bytes);
        }
        Ok(output)
    }

    pub fn can_read(&self, mission: &str, endpoint: &str) -> Result<bool> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM members JOIN events AS admission ON admission.id=members.authority
             WHERE members.mission=?1 AND endpoint=?2
             AND NOT EXISTS(SELECT 1 FROM revocations WHERE revocations.mission=members.mission AND revocations.member=members.author)
             AND NOT EXISTS(SELECT 1 FROM revocation_notices WHERE revocation_notices.mission=members.mission AND member=members.author)
             AND NOT EXISTS(SELECT 1 FROM withdrawals WHERE withdrawals.mission=members.mission AND withdrawals.author=members.author)
             AND NOT EXISTS(SELECT 1 FROM local_withdrawals WHERE local_withdrawals.mission=members.mission)
             AND NOT EXISTS(SELECT 1 FROM events AS conflict
               WHERE conflict.mission=members.mission AND conflict.author=admission.author AND conflict.audience='main'
               AND conflict.fork=1 AND conflict.sequence<=admission.sequence))",
            params![mission, endpoint],
            |r| r.get(0),
        )?)
    }

    pub fn can_read_blob(&self, endpoint: &str, hash: &str) -> Result<bool> {
        let mut query = self.connection.prepare("SELECT events.id,events.mission,events.audience FROM files JOIN events ON events.id=files.event JOIN available_files ON available_files.event=files.event AND available_files.hash=files.hash WHERE files.hash=?1")?;
        for row in query.query_map([hash], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })? {
            let (id, mission, audience) = row?;
            if self.can_read_scope(&mission, &audience, endpoint)?
                && !self.conflicted_scope(&mission, &audience)?
                && !self.provisional(&id)?
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn known_endpoint(&self, endpoint: &str) -> Result<bool> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM members WHERE endpoint=?1)",
            [endpoint],
            |r| r.get(0),
        )?)
    }

    pub fn missions(&self) -> Result<Vec<MissionView>> {
        self.mission_rows(None, 1000)
    }

    pub fn mission_page(&self, before: Option<String>) -> Result<MissionPage> {
        let rows = self.mission_rows(before, 101)?;
        let mut items = Vec::new();
        let mut bytes = 0;
        let mut before = None;
        for row in rows {
            bytes += serde_json::to_vec(&row)?.len();
            if items.len() >= 100 || (bytes > PAGE_BYTES && !items.is_empty()) {
                before = items.last().map(|m: &MissionView| m.id.clone());
                break;
            }
            items.push(row);
        }
        Ok(MissionPage { items, before })
    }

    fn mission_rows(&self, before: Option<String>, count: u32) -> Result<Vec<MissionView>> {
        let cursor = if let Some(id) = before {
            self.connection
                .query_row("SELECT rowid FROM missions WHERE id=?1", [id], |r| {
                    r.get::<_, i64>(0)
                })?
        } else {
            i64::MAX
        };
        let mut stmt = self.connection.prepare(
            "SELECT id,owner,genesis FROM missions WHERE rowid<?1 ORDER BY rowid DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![cursor, count], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Vec<u8>>(2)?,
            ))
        })?;
        rows.map(|row| {
            let (id, owner, bytes) = row?;
            let event = Event::verify(&bytes)?;
            let Payload::MissionCreated { endpoint, .. } = event.body.payload else {
                bail!("invalid stored genesis")
            };
            let conflicted = self.conflicted(&id)?;
            let projection = self.control_state(&id)?;
            let definition = projection.definition;
            let event_count = self.connection.query_row(
                "SELECT count(*) FROM events WHERE mission=?1 AND audience='main'",
                [&id],
                |r| positive_integer(r, 0),
            )?;
            Ok(MissionView {
                coordinator_node: definition.policy.as_ref().and_then(|p| {
                    matches!(
                        p.coordination,
                        harakiri_protocol::policy::Coordination::Coordinated
                    )
                    .then_some(endpoint)
                }),
                id,
                owner,
                definition,
                state: projection.lifecycle.phase.as_str(),
                lifecycle: projection.lifecycle,
                conflicted,
                event_count,
            })
        })
        .collect()
    }

    pub fn messages(&self, mission: &str, before: Option<String>) -> Result<MessagePage> {
        self.messages_in(mission, "main", before)
    }
    pub fn messages_in(
        &self,
        mission: &str,
        audience: &str,
        before: Option<String>,
    ) -> Result<MessagePage> {
        self.message_query(
            mission,
            None,
            crate::communication::MessageQuery::conversation(audience, before),
        )
    }
}

fn positive_integer(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}
