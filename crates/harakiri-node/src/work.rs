//! Public workstreams and optional tasks share Main's signed replication log.
//! Conversation placement is not an access boundary. Concurrent revisions and
//! parallel attempts remain separate; wall clocks never resolve disagreement.
use crate::store::Store;
use anyhow::{Result, anyhow, bail, ensure};
use harakiri_protocol::{
    Event, Identity, Payload,
    agents::{AgentRole, AgentStatus},
    artifacts::ArtifactStage,
    lifecycle::MissionPhase,
    limits,
    policy::Coordination,
    work::*,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

pub type Records = BTreeMap<String, Event>;
pub fn action(e: &Event) -> Option<(&str, &WorkAction)> {
    if let Payload::WorkRecorded {
        control, action, ..
    } = &e.body.payload
    {
        Some((control, action))
    } else {
        None
    }
}
pub fn link(e: &Event) -> Option<WorkLink> {
    if let Payload::ArtifactRecorded { action, .. } = &e.body.payload {
        let id = match action {
            harakiri_protocol::artifacts::ArtifactAction::Publish { .. } => &e.id,
            harakiri_protocol::artifacts::ArtifactAction::Review { revision, .. }
            | harakiri_protocol::artifacts::ArtifactAction::Accept { revision, .. }
            | harakiri_protocol::artifacts::ArtifactAction::Highlight { revision, .. } => revision,
        };
        return Some(WorkLink {
            kind: "artifact".into(),
            id: id.clone(),
        });
    }
    let (_, a) = action(e)?;
    let (kind, id) = match a {
        WorkAction::CreateWorkstream { .. } => ("workstream", &e.id),
        WorkAction::ReviseWorkstream { workstream, .. }
        | WorkAction::AssignWorkstream {
            workstream: Some(workstream),
            ..
        } => ("workstream", workstream),
        WorkAction::CreateTask { .. } => ("task", &e.id),
        WorkAction::ReviseTask { task, .. }
        | WorkAction::AssignTask { task, .. }
        | WorkAction::ReportAttempt { task, .. } => ("task", task),
        _ => return None,
    };
    Some(WorkLink {
        kind: kind.into(),
        id: id.clone(),
    })
}
pub fn channel(e: &Event) -> String {
    match &e.body.payload {
        Payload::ArtifactRecorded { conversation, .. } => conversation.clone(),
        Payload::WorkstreamMessage { workstream, .. } => format!("workstream:{workstream}"),
        _ => e.body.audience.clone(),
    }
}
pub fn stream_revision(e: &Event, root: &str) -> Option<WorkstreamRevision> {
    let (_, a) = action(e)?;
    let (name, goal) = match a {
        WorkAction::CreateWorkstream { name, goal } if e.id == root => (name, goal),
        WorkAction::ReviseWorkstream {
            workstream,
            name,
            goal,
            ..
        } if workstream == root => (name, goal),
        _ => return None,
    };
    Some(WorkstreamRevision {
        id: e.id.clone(),
        author: e.body.author.clone(),
        name: name.clone(),
        goal: goal.clone(),
    })
}
pub(crate) fn task_revision(e: &Event, root: &str) -> Option<TaskRevision> {
    let (_, a) = action(e)?;
    let definition = match a {
        WorkAction::CreateTask { definition, .. } if e.id == root => definition,
        WorkAction::ReviseTask {
            task, definition, ..
        } if task == root => definition,
        _ => return None,
    };
    Some(TaskRevision {
        id: e.id.clone(),
        author: e.body.author.clone(),
        definition: definition.clone(),
    })
}
fn bases(a: &WorkAction) -> &[String] {
    match a {
        WorkAction::ReviseWorkstream { bases, .. }
        | WorkAction::ReviseTask { bases, .. }
        | WorkAction::ReportAttempt { bases, .. } => bases,
        _ => &[],
    }
}
pub(crate) fn heads<'a>(records: impl Iterator<Item = &'a Event>) -> Vec<&'a Event> {
    let records: Vec<_> = records.collect();
    let superseded: BTreeSet<_> = records
        .iter()
        .flat_map(|e| bases(action(e).expect("filtered work record").1))
        .collect();
    records
        .into_iter()
        .filter(|e| !superseded.contains(&e.id))
        .collect()
}
fn equal_ids(expected: &[String], actual: impl Iterator<Item = String>) -> bool {
    expected.iter().cloned().collect::<BTreeSet<_>>() == actual.collect::<BTreeSet<_>>()
}
fn allocated(e: &Event, task: &str, registration: &str) -> bool {
    match action(e).map(|(_, a)| a) {
        Some(WorkAction::CreateTask { assignees, .. }) => {
            e.id == task && assignees.iter().any(|s| s == registration)
        }
        Some(WorkAction::AssignTask {
            task: t,
            registration: r,
            ..
        }) => t == task && r == registration,
        _ => false,
    }
}

impl Store {
    pub(crate) fn work_records(&self, mission: &str) -> Result<Arc<Records>> {
        if let Some(r) = self.work_cache.borrow().get(mission) {
            return Ok(r.clone());
        }
        let mut q = self.connection.prepare("SELECT bytes FROM events JOIN work_records ON event=id WHERE mission=?1 AND fork=0 ORDER BY id LIMIT 8193")?;
        let bytes = q
            .query_map([mission], |r| r.get::<_, Vec<u8>>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(
            bytes.len() <= limits::MAX_WORK_RECORDS,
            "work history limit"
        );
        let mut records = Records::new();
        for bytes in bytes {
            let e = Event::verify(&bytes)?;
            records.insert(e.id.clone(), e);
        }
        let records = Arc::new(records);
        let mut cache = self.work_cache.borrow_mut();
        if cache.len() >= 4
            && let Some(key) = cache.keys().next().cloned()
        {
            cache.remove(&key);
        }
        cache.insert(mission.into(), records.clone());
        Ok(records)
    }
    pub fn work(
        &mut self,
        identity: &Identity,
        mission: &str,
        control: &str,
        mut change: WorkAction,
    ) -> Result<Event> {
        let current = self.control_state(mission)?;
        ensure!(
            !self.conflicted(mission)? && current.lifecycle.revision == control,
            "mission changed; refresh work"
        );
        let actor = identity.public_key();
        if let Some(reg) = self.agent_registration(mission, &actor)? {
            let a = self.communicative_agent(mission, &reg)?;
            if a.identity.role == AgentRole::Agent {
                ensure!(
                    a.status == AgentStatus::DirectionAssigned,
                    "wait for mission Start and direction"
                );
            }
            if let WorkAction::CreateTask {
                definition,
                assignees,
            } = &mut change
            {
                if assignees.is_empty() {
                    assignees.push(reg.clone());
                }
                if definition.workstream.is_none() {
                    definition.workstream = self
                        .work_assignments(mission)?
                        .get(&reg)
                        .and_then(|a| a.workstream.clone());
                }
            }
        }
        if let WorkAction::ReportAttempt {
            status: AttemptStatus::Complete,
            evidence,
            ..
        } = &change
            && self.agent_registration(mission, &actor)?.is_some()
        {
            for id in evidence {
                ensure!(
                    !self.artifact_evidence_stale(mission, id)?,
                    "artifact evidence changed; review it before reporting completion"
                );
            }
        }
        match &change {
            WorkAction::CreateTask { assignees, .. } => {
                for id in assignees {
                    self.communicative_agent(mission, id)?;
                }
            }
            WorkAction::AssignTask {
                registration, task, ..
            } => {
                self.communicative_agent(mission, registration)?;
                let t = self
                    .tasks(
                        mission,
                        &actor,
                        TaskQuery {
                            task: Some(task.clone()),
                            ..Default::default()
                        },
                    )?
                    .items
                    .into_iter()
                    .next()
                    .ok_or_else(|| anyhow!("task unavailable"))?;
                ensure!(
                    !t.stale && t.heads.len() == 1,
                    "task needs review before assigning another attempt"
                );
            }
            _ => {}
        }
        if let WorkAction::CreateTask { definition, .. } | WorkAction::ReviseTask { definition, .. } =
            &change
            && let Some(id) = &definition.workstream
        {
            let stream = self
                .workstreams(mission, &actor)?
                .into_iter()
                .find(|s| &s.id == id)
                .ok_or_else(|| anyhow!("workstream unavailable"))?;
            ensure!(
                !stream.stale && stream.heads.len() == 1,
                "review the workstream goal first"
            );
        }
        let records = self.work_records(mission)?;
        let actual = match &change {
            WorkAction::ReviseWorkstream {
                workstream,
                bases: expected,
                ..
            } => Some((
                expected,
                heads(
                    records
                        .values()
                        .filter(|e| stream_revision(e, workstream).is_some()),
                ),
            )),
            WorkAction::ReviseTask {
                task,
                bases: expected,
                ..
            } => Some((
                expected,
                heads(
                    records
                        .values()
                        .filter(|e| task_revision(e, task).is_some()),
                ),
            )),
            WorkAction::ReportAttempt {
                task,
                task_revision: revision,
                allocation,
                registration,
                bases: expected,
                ..
            } => {
                let task_heads = heads(
                    records
                        .values()
                        .filter(|e| task_revision(e, task).is_some()),
                );
                ensure!(
                    task_heads.len() == 1 && task_heads[0].id == *revision,
                    "task changed; review the current definition"
                );
                Some((expected, heads(records.values().filter(|e|matches!(action(e),Some((_,WorkAction::ReportAttempt{allocation:a,registration:r,..})) if a==allocation && r==registration)))))
            }
            _ => None,
        };
        if let Some((expected, actual)) = actual {
            ensure!(
                equal_ids(expected, actual.iter().map(|e| e.id.clone()))
                    || (actual.len() > 256
                        && expected.len() == 256
                        && expected.iter().all(|id| actual.iter().any(|e| e.id == *id))),
                "work changed; refresh before editing"
            );
        }
        if let WorkAction::AssignWorkstream {
            registration,
            workstream,
            goal_revision,
            ..
        } = &change
        {
            self.communicative_agent(mission, registration)?;
            if let Some(old) = self.work_assignments(mission)?.get(registration) {
                ensure!(
                    actor == self.owner(mission)? || old.author != self.owner(mission)?,
                    "human direction takes precedence"
                );
            }
            if let Some(id) = workstream {
                let view = self
                    .workstreams(mission, &actor)?
                    .into_iter()
                    .find(|s| s.id == *id)
                    .ok_or_else(|| anyhow!("unknown workstream"))?;
                ensure!(
                    !view.stale
                        && view.heads.len() == 1
                        && goal_revision.as_ref() == Some(&view.heads[0].id),
                    "workstream goal changed; review it again"
                );
            }
        }
        let authorization = if let Some(reg) = self.agent_registration(mission, &actor)? {
            self.agent_views(mission)?
                .into_iter()
                .find(|a| a.id == reg)
                .and_then(|a| a.direction.map(|d| d.id))
        } else {
            None
        };
        self.append(
            identity,
            mission,
            Payload::WorkRecorded {
                authorization,
                control: control.into(),
                action: change,
            },
        )
    }
    pub(crate) fn validate_work(&self, e: &Event) -> Result<bool> {
        if let Payload::WorkstreamMessage { workstream, .. } = &e.body.payload {
            let Some(root) = self.event(workstream)? else {
                return Ok(false);
            };
            ensure!(
                root.mission_id() == e.mission_id()
                    && matches!(
                        action(&root),
                        Some((_, WorkAction::CreateWorkstream { .. }))
                    ),
                "invalid workstream"
            );
            return Ok(true);
        }
        let Some((control, a)) = action(e) else {
            return Ok(true);
        };
        let mission = e.mission_id();
        if self.event(control)?.is_none() {
            return Ok(false);
        };
        let history = self.control_history(mission)?;
        let state = history.at(control)?;
        let owner = e.body.author == history.root.body.author;
        let agent = self.agent_registration(mission, &e.body.author)?;
        let co = state
            .lifecycle
            .coordinator
            .as_ref()
            .is_some_and(|c| c.identity.author == e.body.author);
        if let Some(reg) = &agent {
            let offer = self.offer(mission, reg)?;
            let Payload::AgentOffered {
                control: reviewed,
                identity,
            } = offer.body.payload
            else {
                unreachable!()
            };
            ensure!(
                history.at(&reviewed)?.lifecycle.terms_revision == state.lifecycle.terms_revision,
                "agent terms require review"
            );
            ensure!(
                identity.role != AgentRole::Coordinator || co,
                "Coordinator appointment required"
            );
            ensure!(
                !co || identity.role == AgentRole::Coordinator,
                "Coordinator contribution required"
            );
        }
        ensure!(
            state.lifecycle.phase != MissionPhase::Archived,
            "archived mission is read only"
        );
        ensure!(
            owner || agent.is_some(),
            "mission owner or registered agent required"
        );
        ensure!(
            owner
                || state.lifecycle.phase == MissionPhase::Active
                || (co && state.lifecycle.phase == MissionPhase::Preparing),
            "work is paused or preparing"
        );
        if !owner && !co {
            let Payload::WorkRecorded {
                authorization: Some(id),
                ..
            } = &e.body.payload
            else {
                bail!("work requires an exact direction");
            };
            let Some(direction) = self.event(id)? else {
                return Ok(false);
            };
            ensure!(
                direction.mission_id() == mission && direction.body.audience == "main",
                "invalid work authorization"
            );
            let valid = match &direction.body.payload {
                Payload::AgentDirected {
                    registration,
                    control: c,
                    ..
                } => Some(registration) == agent.as_ref() && c == control,
                Payload::MissionControlled {
                    action: harakiri_protocol::lifecycle::ControlAction::Start { participants, .. },
                    ..
                } => {
                    direction.id == control
                        && (participants.iter().any(|r| Some(r) == agent.as_ref())
                            || state
                                .definition
                                .policy
                                .as_ref()
                                .is_some_and(|p| p.coordination == Coordination::Peer))
                }
                Payload::WorkRecorded {
                    control: c,
                    action: WorkAction::AssignWorkstream { registration, .. },
                    ..
                } => {
                    Some(registration) == agent.as_ref()
                        && history.at(c)?.lifecycle.terms_revision == state.lifecycle.terms_revision
                }
                _ => false,
            };
            ensure!(valid, "work requires assigned direction");
        }
        let peer = state
            .definition
            .policy
            .as_ref()
            .is_some_and(|p| p.coordination == Coordination::Peer);
        let organizer = owner || co || peer;
        let mut deps = BTreeMap::new();
        for id in a.references() {
            let Some(r) = self.event(id)? else {
                return Ok(false);
            };
            ensure!(
                r.mission_id() == mission && r.body.audience == "main",
                "work references must be public in this mission"
            );
            if let Some((c, _)) = action(&r) {
                ensure!(
                    history.get(c)?.body.sequence <= history.get(control)?.body.sequence,
                    "future work dependency"
                );
            }
            deps.insert(id, r);
        }
        let records = self.work_records(mission)?;
        ensure!(
            records.len() < limits::MAX_WORK_RECORDS,
            "work history limit"
        );
        // Bound the complete retained definition/report projection, including
        // concurrent heads, before accepting bytes. A valid task must always
        // remain readable inside a bounded IPC page.
        let group = |event: &Event| -> Option<String> {
            match action(event).map(|(_, a)| a) {
                Some(WorkAction::CreateWorkstream { .. } | WorkAction::ReviseWorkstream { .. }) => {
                    Some("workstreams".into())
                }
                Some(WorkAction::CreateTask { .. }) => Some(event.id.clone()),
                Some(
                    WorkAction::ReviseTask { task, .. }
                    | WorkAction::AssignTask { task, .. }
                    | WorkAction::ReportAttempt { task, .. },
                ) => Some(task.clone()),
                _ => None,
            }
        };
        if let Some(key) = group(e) {
            let mut bytes = serde_json::to_vec(&e.body.payload)?.len();
            for r in records.values().filter(|r| group(r).as_ref() == Some(&key)) {
                bytes += serde_json::to_vec(&r.body.payload)?.len();
            }
            ensure!(
                bytes <= limits::MAX_WORK_OBJECT_BYTES,
                "work object history byte limit"
            );
        }
        let require_agent = |id: &str| -> Result<()> {
            ensure!(
                matches!(deps[id].body.payload, Payload::AgentOffered { .. }),
                "agent registration required"
            );
            Ok(())
        };
        let require_stream = |id: &str| -> Result<()> {
            ensure!(
                matches!(
                    action(&deps[id]),
                    Some((_, WorkAction::CreateWorkstream { .. }))
                ),
                "workstream required"
            );
            Ok(())
        };
        let require_task = |id: &str| -> Result<()> {
            ensure!(
                matches!(action(&deps[id]), Some((_, WorkAction::CreateTask { .. }))),
                "task required"
            );
            Ok(())
        };
        match a {
            WorkAction::CreateWorkstream { .. } => {
                ensure!(organizer, "Coordinator or peer collaboration required");
                ensure!(
                    records
                        .values()
                        .filter(|e| matches!(
                            action(e),
                            Some((_, WorkAction::CreateWorkstream { .. }))
                        ))
                        .count()
                        < limits::MAX_WORKSTREAMS,
                    "workstream limit"
                );
            }
            WorkAction::ReviseWorkstream {
                workstream, bases, ..
            } => {
                ensure!(organizer, "Coordinator or peer collaboration required");
                require_stream(workstream)?;
                for id in bases {
                    ensure!(
                        stream_revision(&deps[id.as_str()], workstream).is_some(),
                        "workstream revision required"
                    );
                }
            }
            WorkAction::AssignWorkstream {
                registration,
                workstream,
                goal_revision,
                ..
            } => {
                require_agent(registration)?;
                ensure!(
                    owner || co || (peer && agent.as_ref() == Some(registration)),
                    "cannot assign another agent"
                );
                if let Some(id) = workstream {
                    require_stream(id)?;
                    ensure!(
                        stream_revision(
                            &deps[goal_revision
                                .as_deref()
                                .ok_or_else(|| anyhow!("missing goal revision"))?],
                            id
                        )
                        .is_some(),
                        "workstream goal revision required"
                    );
                }
            }
            WorkAction::CreateTask {
                definition,
                assignees,
            } => {
                ensure!(
                    records
                        .values()
                        .filter(|e| matches!(action(e), Some((_, WorkAction::CreateTask { .. }))))
                        .count()
                        < limits::MAX_TASKS,
                    "task limit"
                );
                if let Some(id) = &definition.workstream {
                    require_stream(id)?;
                }
                for id in assignees {
                    require_agent(id)?;
                    ensure!(
                        organizer || agent.as_ref() == Some(id),
                        "only your own task can be allocated"
                    );
                }
                ensure!(
                    organizer || (assignees.len() == 1 && agent.as_ref() == assignees.first()),
                    "an agent owns its new task"
                );
            }
            WorkAction::ReviseTask {
                task,
                bases,
                definition,
            } => {
                require_task(task)?;
                ensure!(
                    organizer || deps[task.as_str()].body.author == e.body.author,
                    "task author or Coordinator required"
                );
                if let Some(id) = &definition.workstream {
                    require_stream(id)?;
                }
                for id in bases {
                    ensure!(
                        task_revision(&deps[id.as_str()], task).is_some(),
                        "task revision required"
                    );
                }
            }
            WorkAction::AssignTask {
                task, registration, ..
            } => {
                require_task(task)?;
                require_agent(registration)?;
                ensure!(
                    organizer
                        || (agent.as_ref() == Some(registration)
                            && deps[task.as_str()].body.author == e.body.author),
                    "Coordinator allocates other agents"
                );
                ensure!(records.values().filter(|e|matches!(action(e),Some((_,WorkAction::AssignTask{task:t,..})) if t==task)).count()<limits::MAX_TASK_ATTEMPTS,"task attempt limit");
            }
            WorkAction::ReportAttempt {
                task,
                task_revision: revision,
                allocation,
                registration,
                bases,
                status,
                evidence,
                ..
            } => {
                require_task(task)?;
                require_agent(registration)?;
                ensure!(
                    task_revision(&deps[revision.as_str()], task).is_some(),
                    "task revision required"
                );
                ensure!(
                    allocated(&deps[allocation.as_str()], task, registration),
                    "attempt allocation required"
                );
                ensure!(
                    owner || co || agent.as_ref() == Some(registration),
                    "only the attempt owner or Coordinator can report"
                );
                for id in bases {
                    ensure!(
                        matches!(action(&deps[id.as_str()]),Some((_,WorkAction::ReportAttempt{allocation:a,registration:r,..})) if a==allocation && r==registration),
                        "report belongs to a different attempt"
                    );
                }
                for id in evidence {
                    ensure!(
                        matches!(
                            deps[id.as_str()].body.payload,
                            Payload::ArtifactPublished { .. }
                                | Payload::ArtifactRecorded {
                                    action: harakiri_protocol::artifacts::ArtifactAction::Publish { .. },
                                    ..
                                }
                                | Payload::MessageSent { .. }
                                | Payload::MessagePosted { .. }
                                | Payload::WorkstreamMessage { .. }
                        ),
                        "evidence must reference a message or artifact"
                    );
                }
                if *status == AttemptStatus::Complete && !owner {
                    ensure!(
                        evidence.iter().any(|id| {
                            let event = &deps[id.as_str()];
                            let legacy =
                                matches!(event.body.payload, Payload::ArtifactPublished { .. });
                            let delivered = crate::artifacts::revision(event)
                                .is_some_and(|(_, doc, _)| doc.stage == ArtifactStage::Complete);
                            let complete = legacy || delivered;
                            complete && event.body.author == e.body.author
                        }),
                        "completion requires a complete artifact published by the reporting agent"
                    );
                }
                if !owner {
                    ensure!(
                        state.lifecycle.phase == MissionPhase::Active,
                        "progress reports require an active mission"
                    );
                }
            }
        }
        Ok(true)
    }
}
