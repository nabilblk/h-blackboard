//! A shared roster records offered contributions and assigned direction. It
//! never grants execution, changes local consent or claims runtime liveness.
use crate::store::Store;
use anyhow::{Result, anyhow, ensure};
use harakiri_protocol::{
    Event, Identity, Payload,
    agents::{AgentIdentity, AgentPage, AgentRole, AgentStatus, AgentView, DirectionView},
    lifecycle::{ControlAction, MissionPhase},
    limits,
    policy::Coordination,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

pub type Records = BTreeMap<String, Event>;
pub fn is_agent_record(p: &Payload) -> bool {
    matches!(
        p,
        Payload::AgentOffered { .. }
            | Payload::AgentWithdrawn { .. }
            | Payload::AgentDirected { .. }
            | Payload::AgentAcknowledged { .. }
    )
}

impl Store {
    pub(crate) fn agent_records(&self, mission: &str) -> Result<Arc<Records>> {
        if let Some(records) = self.agent_cache.borrow().get(mission) {
            return Ok(records.clone());
        }
        let mut q = self.connection.prepare("SELECT bytes FROM events JOIN agent_records ON agent_records.event=events.id WHERE mission=?1 ORDER BY id LIMIT 4097")?;
        let rows = q
            .query_map([mission], |r| r.get::<_, Vec<u8>>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(
            rows.len() <= limits::MAX_AGENT_RECORDS,
            "agent history limit"
        );
        let mut records = BTreeMap::new();
        for bytes in rows {
            let e = Event::verify(&bytes)?;
            records.insert(e.id.clone(), e);
        }
        let records = Arc::new(records);
        let mut cache = self.agent_cache.borrow_mut();
        // Independently bounded from the mission control cache.
        if cache.len() >= 4
            && let Some(first) = cache.keys().next().cloned()
        {
            cache.remove(&first);
        }
        cache.insert(mission.into(), records.clone());
        Ok(records)
    }

    pub fn offer_agent(
        &mut self,
        owner: &Identity,
        mission: &str,
        terms: &str,
        identity: AgentIdentity,
    ) -> Result<Event> {
        let current = self.control_state(mission)?;
        ensure!(
            current.lifecycle.terms_revision == terms,
            "mission terms changed"
        );
        // A retry after a lost IPC response must not create another identity.
        let records = self.agent_records(mission)?;
        if let Some(existing) = records.values().find(|e| {
            matches!(&e.body.payload,
            Payload::AgentOffered { identity: i, .. } if i.author == identity.author)
        }) {
            let Payload::AgentOffered {
                identity: old,
                control,
            } = &existing.body.payload
            else {
                unreachable!()
            };
            ensure!(
                existing.body.author == owner.public_key()
                    && old == &identity
                    && self
                        .control_history(mission)?
                        .at(control)?
                        .lifecycle
                        .terms_revision
                        == terms,
                "agent already registered with different terms"
            );
            ensure!(!records.values().any(|e| matches!(&e.body.payload, Payload::AgentWithdrawn { registration } if registration == &existing.id)), "agent withdrawn");
            return Ok(existing.clone());
        }
        self.append(
            owner,
            mission,
            Payload::AgentOffered {
                control: current.lifecycle.revision,
                identity,
            },
        )
    }

    pub fn withdraw_agent(
        &mut self,
        owner: &Identity,
        mission: &str,
        registration: &str,
    ) -> Result<Event> {
        let records = self.agent_records(mission)?;
        let offer = records
            .get(registration)
            .ok_or_else(|| anyhow!("unknown agent"))?;
        ensure!(
            offer.body.author == owner.public_key(),
            "only the contributor can withdraw an agent"
        );
        if let Some(existing) = records.values().find(|e| {
            matches!(&e.body.payload,
            Payload::AgentWithdrawn { registration: id } if id == registration)
        }) {
            return Ok(existing.clone());
        }
        self.append(
            owner,
            mission,
            Payload::AgentWithdrawn {
                registration: registration.into(),
            },
        )
    }

    pub fn direct_agent(
        &mut self,
        author: &Identity,
        mission: &str,
        revision: &str,
        registration: &str,
        text: String,
    ) -> Result<Event> {
        let current = self.control_state(mission)?;
        ensure!(
            current.lifecycle.revision == revision
                && current.lifecycle.phase == MissionPhase::Active,
            "mission direction changed"
        );
        let view = self
            .agent_views(mission)?
            .into_iter()
            .find(|v| v.id == registration)
            .ok_or_else(|| anyhow!("unknown agent"))?;
        ensure!(
            matches!(
                view.status,
                AgentStatus::WaitingForDirection | AgentStatus::DirectionAssigned
            ),
            "agent cannot receive a direction"
        );
        let key = author.public_key();
        ensure!(
            key == self.owner(mission)?
                || current
                    .lifecycle
                    .coordinator
                    .as_ref()
                    .is_some_and(|c| c.identity.author == key),
            "mission owner or current Coordinator required"
        );
        // Retrying the exact current instruction must not invalidate a running
        // permission or its acknowledgment. Different scope still creates a
        // new signed direction and requires fresh execution consent.
        if let Some(direction) = &view.direction
            && direction.source == "individual"
            && direction.author == key
            && direction.text == text
            && let Some(event) = self.event(&direction.id)?
            && matches!(&event.body.payload, Payload::AgentDirected { control, .. } if control == revision)
        {
            return Ok(event);
        }
        self.append(
            author,
            mission,
            Payload::AgentDirected {
                registration: registration.into(),
                control: revision.into(),
                text,
            },
        )
    }

    pub fn start_participants(&self, mission: &str) -> Result<Vec<String>> {
        Ok(self
            .agent_views(mission)?
            .into_iter()
            .filter(|v| {
                matches!(
                    v.status,
                    AgentStatus::WaitingForStart
                        | AgentStatus::Paused
                        | AgentStatus::DirectionAssigned
                        | AgentStatus::WaitingForDirection
                )
            })
            .map(|v| v.id)
            .collect())
    }

    pub fn agent_page(&self, mission: &str, after: Option<String>) -> Result<AgentPage> {
        ensure!(
            after
                .as_deref()
                .is_none_or(harakiri_protocol::event::is_hash),
            "invalid agent cursor"
        );
        let views = self.agent_views(mission)?;
        let total = views.len();
        let mut items: Vec<_> = views
            .into_iter()
            .filter(|v| after.as_ref().is_none_or(|id| &v.id > id))
            .take(65)
            .collect();
        let after = if items.len() > 64 {
            items.pop();
            items.last().map(|v| v.id.clone())
        } else {
            None
        };
        Ok(AgentPage {
            items,
            after,
            total,
        })
    }

    pub fn agent_views(&self, mission: &str) -> Result<Vec<AgentView>> {
        let records = self.agent_records(mission)?;
        let control = self.control_history(mission)?;
        let state = self.control_state(mission)?;
        let frozen = self.conflicted(mission)?;
        let owner = self.owner(mission)?;
        let started = control.get(&state.lifecycle.revision)?;
        let participants = match &started.body.payload {
            Payload::MissionControlled {
                action: ControlAction::Start { participants, .. },
                ..
            } => participants.as_slice(),
            _ => &[],
        };
        let peer = state
            .definition
            .policy
            .as_ref()
            .is_some_and(|p| p.coordination == Coordination::Peer);
        let mut identities = BTreeMap::<&str, usize>::new();
        let mut withdrawn = BTreeSet::new();
        let mut directions = BTreeMap::<&str, &Event>::new();
        let revoked: BTreeSet<_> = self
            .members(mission)?
            .into_iter()
            .filter(|m| m.revoked)
            .map(|m| m.author)
            .collect();
        let mut terms_by_control = BTreeMap::new();
        for e in records.values() {
            match &e.body.payload {
                Payload::AgentOffered {
                    identity,
                    control: reviewed,
                } => {
                    *identities.entry(&identity.author).or_default() += 1;
                    if !terms_by_control.contains_key(reviewed) {
                        terms_by_control.insert(
                            reviewed.clone(),
                            control.at(reviewed)?.lifecycle.terms_revision,
                        );
                    }
                }
                Payload::AgentWithdrawn { registration } => {
                    withdrawn.insert(registration);
                }
                Payload::AgentDirected {
                    registration,
                    control,
                    ..
                } if control == &state.lifecycle.revision => {
                    let rank = |r: &Event| (r.body.author == owner, r.body.sequence);
                    if directions
                        .get(registration.as_str())
                        .is_none_or(|r| rank(e) > rank(r))
                    {
                        directions.insert(registration, e);
                    }
                }
                _ => {}
            }
        }
        let assignments = self.work_assignments(mission)?;
        let mut views = Vec::new();
        for e in records.values() {
            let Payload::AgentOffered {
                control: reviewed,
                identity,
            } = &e.body.payload
            else {
                continue;
            };
            let terms = terms_by_control[reviewed].clone();
            let mut direction = None;
            let status = if frozen || identities[identity.author.as_str()] > 1 {
                AgentStatus::Conflict
            } else if revoked.contains(&e.body.author) {
                AgentStatus::Revoked
            } else if withdrawn.contains(&e.id) {
                AgentStatus::Withdrawn
            } else if terms != state.lifecycle.terms_revision {
                AgentStatus::ReviewRequired
            } else if identity.role == AgentRole::Coordinator
                && state
                    .lifecycle
                    .coordinator
                    .as_ref()
                    .is_none_or(|c| c.identity.author != identity.author)
            {
                AgentStatus::WaitingForAppointment
            } else if matches!(
                state.lifecycle.phase,
                MissionPhase::Paused | MissionPhase::Closed | MissionPhase::Archived
            ) {
                AgentStatus::Paused
            } else if state.lifecycle.phase == MissionPhase::Preparing {
                AgentStatus::WaitingForStart
            } else {
                // Human direction wins over Coordinator direction for this
                // exact control revision. Writer sequence, never wall clocks,
                // orders edits from the same authority.
                let assignment = assignments.get(&e.id);
                let direct = directions.get(e.id.as_str());
                let assigned_wins = if let Some(a) = assignment {
                    let record = self
                        .event(&a.id)?
                        .ok_or_else(|| anyhow!("missing assignment"))?;
                    let assignment_control = crate::work::action(&record)
                        .ok_or_else(|| anyhow!("invalid assignment record"))?
                        .0;
                    direct.is_none_or(|d| {
                        (
                            a.author == owner,
                            control
                                .get(assignment_control)
                                .map_or(0, |r| r.body.sequence),
                            record.body.sequence,
                        ) > (
                            d.body.author == owner,
                            started.body.sequence,
                            d.body.sequence,
                        )
                    })
                } else {
                    false
                };
                if assigned_wins {
                    if let Some(a) = assignment.filter(|a| !a.stale) {
                        direction = Some(DirectionView {
                            id: a.id.clone(),
                            author: a.author.clone(),
                            text: a.direction.clone(),
                            source: "workstream".into(),
                        });
                    }
                } else if let Some(record) = direct {
                    let Payload::AgentDirected { text, .. } = &record.body.payload else {
                        unreachable!()
                    };
                    direction = Some(DirectionView {
                        id: record.id.clone(),
                        author: record.body.author.clone(),
                        text: text.clone(),
                        source: "individual".into(),
                    });
                } else if peer || participants.contains(&e.id) {
                    direction = Some(DirectionView {
                        id: started.id.clone(),
                        author: owner.clone(),
                        text: if peer {
                            "Contribute to the mission objective in Main.".into()
                        } else {
                            "Follow the current shared plan in Main.".into()
                        },
                        source: if peer {
                            "peer".into()
                        } else {
                            "mission_start".into()
                        },
                    });
                }
                if direction.is_some() {
                    AgentStatus::DirectionAssigned
                } else {
                    AgentStatus::WaitingForDirection
                }
            };
            let acknowledgment = direction.as_ref().and_then(|d| records.values().find(|r| {
                r.body.author == identity.author && matches!(&r.body.payload,
                    Payload::AgentAcknowledged { registration, control, direction } if registration == &e.id && control == &state.lifecycle.revision && direction == &d.id)
            }).map(|r| r.id.clone()));
            views.push(AgentView {
                id: e.id.clone(),
                identity: identity.clone(),
                contributor: e.body.author.clone(),
                terms_revision: terms,
                status,
                direction,
                acknowledgment,
                assignment: assignments.get(&e.id).cloned(),
            });
        }
        Ok(views)
    }

    pub(crate) fn validate_agent_record(&self, e: &Event) -> Result<bool> {
        let mission = e.mission_id();
        // Start records explicitly name the offers observed before release.
        if let Payload::MissionControlled {
            previous,
            action: ControlAction::Start { participants, .. },
        } = &e.body.payload
        {
            let p = self.control_history(mission)?.at(previous)?;
            for id in participants {
                let Some(offer) = self.event(id)? else {
                    return Ok(false);
                };
                let Payload::AgentOffered { control, .. } = &offer.body.payload else {
                    anyhow::bail!("start requires agent registrations")
                };
                ensure!(
                    offer.mission_id() == mission
                        && self
                            .control_history(mission)?
                            .at(control)?
                            .lifecycle
                            .terms_revision
                            == p.lifecycle.terms_revision,
                    "start includes stale or foreign contribution"
                );
            }
        }
        if !is_agent_record(&e.body.payload) {
            return Ok(true);
        }
        let records = self.agent_records(mission)?;
        ensure!(
            records.len() < limits::MAX_AGENT_RECORDS,
            "agent history limit"
        );
        // Directions cannot consume the withdrawal reserve.
        if !matches!(e.body.payload, Payload::AgentWithdrawn { .. }) {
            ensure!(
                records.len() < limits::MAX_AGENT_RECORDS - limits::MAX_AGENTS,
                "agent history reserved for withdrawal"
            );
        }
        let history = self.control_history(mission)?;
        match &e.body.payload {
            Payload::AgentOffered { control, identity } => {
                if self.event(control)?.is_none() {
                    return Ok(false);
                }
                let p = history.at(control)?;
                ensure!(p.definition.policy.is_some(), "mission policy required");
                ensure!(
                    records
                        .values()
                        .filter(|r| matches!(r.body.payload, Payload::AgentOffered { .. }))
                        .count()
                        < limits::MAX_AGENTS,
                    "agent limit"
                );
                ensure!(
                    identity.author != e.body.author
                        && !self
                            .members(mission)?
                            .iter()
                            .any(|m| m.author == identity.author),
                    "agent identity must be separate from human identity"
                );
            }
            Payload::AgentWithdrawn { registration }
            | Payload::AgentDirected { registration, .. } => {
                let Some(offer) = self.event(registration)? else {
                    return Ok(false);
                };
                let Payload::AgentOffered {
                    control: reviewed, ..
                } = &offer.body.payload
                else {
                    anyhow::bail!("agent registration required")
                };
                ensure!(offer.mission_id() == mission, "foreign contribution");
                if let Payload::AgentDirected { control, .. } = &e.body.payload {
                    if self.event(control)?.is_none() {
                        return Ok(false);
                    }
                    let p = history.at(control)?;
                    ensure!(
                        p.lifecycle.phase == MissionPhase::Active
                            && history.at(reviewed)?.lifecycle.terms_revision
                                == p.lifecycle.terms_revision,
                        "direction requires current active mission terms"
                    );
                    ensure!(
                        e.body.author == history.root.body.author
                            || p.lifecycle
                                .coordinator
                                .as_ref()
                                .is_some_and(|c| c.identity.author == e.body.author
                                    && e.body.authority.as_ref() == Some(&c.appointment)),
                        "mission owner or current Coordinator required"
                    );
                } else {
                    ensure!(
                        e.body.author == offer.body.author,
                        "contributor withdrawal authority required"
                    );
                    ensure!(!records.values().any(|r| matches!(&r.body.payload, Payload::AgentWithdrawn { registration: prior } if prior == registration) && r.body.sequence != e.body.sequence), "already withdrawn");
                }
            }
            _ => {}
        }
        Ok(true)
    }
}
