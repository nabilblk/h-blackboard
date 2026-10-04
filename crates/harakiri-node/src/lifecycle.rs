//! Local commands and causal validation around the pure protocol reducer.
//! Network imports validate against referenced history; local commands also
//! require the latest observed revision. Neither path executes an agent.
use crate::store::Store;
use anyhow::{Result, anyhow, ensure};
use harakiri_protocol::{
    Event, Identity, Payload,
    lifecycle::{ControlAction, History, Projection},
};
use std::sync::Arc;

pub fn is_control(payload: &Payload) -> bool {
    matches!(
        payload,
        Payload::MissionCreated { .. }
            | Payload::MissionControlled { .. }
            | Payload::CoordinatorPlanArtifact { .. }
            | Payload::CoordinatorPlanned { .. }
            | Payload::CoordinatorReadied { .. }
    )
}

/// Human-readable activity uses the same signed record as the reducer. These
/// entries are history, not assertions that a process ran or actually stopped.
pub fn activity(payload: &Payload) -> Option<(&'static str, String)> {
    match payload {
        Payload::ArtifactRecorded{action,..}=>Some(("artifact",match action {
            harakiri_protocol::artifacts::ArtifactAction::Publish{artifact,document,..}=>format!("Artifact {}: {}\n\n{}",if artifact.is_some(){"revised"}else{"published"},document.title,document.summary),
            harakiri_protocol::artifacts::ArtifactAction::Review{summary,..}=>format!("Artifact review recorded.\n\n{summary}"),
            harakiri_protocol::artifacts::ArtifactAction::Accept{accepted,reason,..}=>format!("Human acceptance {}.\n\n{reason}",if *accepted{"recorded"}else{"withdrawn"}),
            harakiri_protocol::artifacts::ArtifactAction::Highlight{highlighted,..}=>if *highlighted{"Artifact highlighted.".into()}else{"Artifact highlight removed.".into()},
        })),
        Payload::MessagePosted { text } | Payload::MessageSent { text, .. } | Payload::WorkstreamMessage { text, .. } => Some(("message", text.clone())),
        Payload::WorkRecorded { action, .. } => Some(("work", match action {
            harakiri_protocol::work::WorkAction::CreateWorkstream { name, goal } => format!("Workstream created: {name}\n\n{goal}"),
            harakiri_protocol::work::WorkAction::ReviseWorkstream { name, goal, .. } => format!("Workstream goal updated: {name}\n\n{goal}"),
            harakiri_protocol::work::WorkAction::AssignWorkstream { direction, .. } => format!("Workstream direction assigned. Awaiting the agent’s acknowledgment.\n\n{direction}"),
            harakiri_protocol::work::WorkAction::CreateTask { definition, .. } => format!("Task planned: {}\n\n{}",definition.title,definition.description),
            harakiri_protocol::work::WorkAction::ReviseTask { definition, .. } => format!("Task definition updated: {}",definition.title),
            harakiri_protocol::work::WorkAction::AssignTask { approach, .. } => format!("Task attempt assigned.\n\n{approach}"),
            harakiri_protocol::work::WorkAction::ReportAttempt { summary, .. } => format!("Task progress reported.\n\n{summary}"),
        })),
        Payload::AgentAcknowledged { .. } => Some(("acknowledgment", "Acknowledged the assigned direction. Receipt is recorded; execution status is tracked separately.".into())),
        Payload::GovernanceRecorded {action,..} => Some(("governance", match action {
            harakiri_protocol::governance::GovernanceAction::Criterion{wording,met,summary,..}=>format!("Criterion {}: {wording}\n\n{summary}",if *met {"reported met"}else{"not yet met"}),
            _=>"Resource permission or allowance updated. Open Budget & permissions for the signed ledger.".into(),
        })),
        Payload::CoordinatorPlanArtifact{..}=>Some(("plan","Coordinator selected an exact artifact revision as the shared plan.".into())),
        Payload::CoordinatorPlanned { text, .. } => Some(("plan", text.clone())),
        Payload::AgentOffered { identity, .. } => Some(("agent", format!("{} ({}) shared with the mission. Prepared contribution; execution has not started.", identity.label, identity.runtime))),
        Payload::AgentWithdrawn { .. } => Some(("agent", "An agent contribution was withdrawn by its contributor. Previous work remains in the conversation.".into())),
        Payload::AgentDirected { text, .. } => Some(("direction", format!("Direction assigned in Main. Assignment is not an acknowledgment or a running process.\n\n{text}"))),
        Payload::CoordinatorReadied { .. } => Some(("readiness", "Coordinator acknowledged the current mission instructions and shared plan. Waiting for the mission owner to start.".into())),
        Payload::MissionControlled { action, .. } => Some(("control", match action {
            ControlAction::UpdateInstructions { definition } => format!("Mission instructions updated. Returned to Preparing; previous readiness and local terms need review.\n\n{}\n\nScope: {}", definition.objective, definition.scope),
            ControlAction::SetCoordination { coordinator:Some(c), .. } => format!("{} appointed as Coordinator. Waiting for a plan and readiness acknowledgment.",c.label),
            ControlAction::SetCoordination { mode:harakiri_protocol::policy::Coordination::Peer, .. } => "Peer collaboration selected. Returned to Preparing; the owner decides when to start.".into(),
            ControlAction::SetCoordination { .. } => "Coordinator removed. The mission remains coordinator-led and returns to Preparing.".into(),
            ControlAction::Handover{coordinator,..}=>format!("Coordination handed to {}. Fresh plan and readiness required before Start.",coordinator.label),
            ControlAction::SetPlanArtifact{..}=>"Shared plan bound to an exact artifact revision. Readiness must be renewed.".into(),
            ControlAction::Close{reason}=>format!("Mission closed by its owner. {reason}"),
            ControlAction::Archive{reason}=>format!("Channel archived; history is preserved. {reason}"),
            ControlAction::Restore{}=>"Channel restored. It remains paused or closed.".into(),
            ControlAction::SetPlan { text } => format!("Shared plan set by the mission owner. Returned to Preparing.\n\n{text}"),
            ControlAction::Start { .. } => "Mission started by the owner. Local contribution consent and execution controls still apply.".into(),
            ControlAction::Pause { reason } => format!("Mission paused by the owner.\n\n{reason}"),
        })),
        _ => None,
    }
}
impl Store {
    pub(crate) fn check_plan_artifact(&self, mission: &str, id: &str, fresh: bool) -> Result<()> {
        let e = self
            .event(id)?
            .ok_or_else(|| anyhow!("plan artifact unavailable"))?;
        ensure!(
            e.mission_id() == mission
                && e.body.audience == "main"
                && matches!(
                    e.body.payload,
                    Payload::ArtifactRecorded {
                        action: harakiri_protocol::artifacts::ArtifactAction::Publish {
                            document: harakiri_protocol::artifacts::ArtifactDocument {
                                kind: harakiri_protocol::artifacts::ArtifactKind::Plan,
                                stage: harakiri_protocol::artifacts::ArtifactStage::Complete,
                                ..
                            },
                            ..
                        },
                        ..
                    }
                ),
            "complete public plan artifact required"
        );
        if fresh {
            ensure!(
                !self.artifact_evidence_stale(mission, id)?,
                "plan artifact needs review"
            );
        }
        Ok(())
    }
    pub fn control_history(&self, mission: &str) -> Result<Arc<History>> {
        if let Some(cached) = self.control_cache.borrow().get(mission) {
            return Ok(cached.clone());
        }
        let root = self
            .event(mission)?
            .ok_or_else(|| anyhow!("unknown mission"))?;
        let mut q = self.connection.prepare("SELECT bytes FROM events JOIN control_records ON control_records.event=events.id WHERE mission=?1 ORDER BY author,sequence,id LIMIT 2049")?;
        let rows = q
            .query_map([mission], |r| r.get::<_, Vec<u8>>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let records = rows
            .into_iter()
            .map(|b| Event::verify(&b).map_err(Into::into))
            .collect::<Result<Vec<_>>>()?;
        let history = Arc::new(History::new(root, records)?);
        let mut cache = self.control_cache.borrow_mut();
        if cache.len() >= 32
            && let Some(first) = cache.keys().next().cloned()
        {
            cache.remove(&first);
        }
        cache.insert(mission.into(), history.clone());
        Ok(history)
    }
    pub fn control_state(&self, mission: &str) -> Result<Projection> {
        let history = self.control_history(mission)?;
        // Forks are retained, but neither branch supplies operative authority.
        if self.conflicted(mission)? {
            let mut p = history.at(mission)?;
            p.lifecycle.start_blockers = vec!["control_conflict".into()];
            return Ok(p);
        }
        let mut p = history.current()?;
        if let Some(id) = p.lifecycle.plan.as_ref().and_then(|p| p.artifact.as_ref())
            && self.artifact_evidence_stale(mission, id)?
        {
            p.lifecycle.readiness = None;
            p.lifecycle
                .start_blockers
                .push("plan_artifact_stale".into());
        }
        // A withdrawn/revoked offered Coordinator cannot keep the mission
        // ready. Legacy reducer fixtures without a roster remain readable.
        if let Some(c) = &p.lifecycle.coordinator {
            let records = self.agent_records(mission)?;
            let offers: Vec<_> = records.values().filter(|e| matches!(&e.body.payload, Payload::AgentOffered {identity,..} if identity.author==c.identity.author)).collect();
            if !offers.is_empty() {
                let offer = offers[0];
                let unavailable = offers.len()!=1 || self.is_revoked(mission,&offer.body.author)? || records.values().any(|e| matches!(&e.body.payload,Payload::AgentWithdrawn {registration} if registration==&offer.id)) || match &offer.body.payload {Payload::AgentOffered {control,..}=>history.at(control)?.lifecycle.terms_revision!=p.lifecycle.terms_revision,_=>true};
                if unavailable {
                    p.lifecycle.readiness = None;
                    p.lifecycle
                        .start_blockers
                        .push("coordinator_unavailable".into());
                }
            }
        }
        Ok(p)
    }
    pub fn control(
        &mut self,
        identity: &Identity,
        mission: &str,
        expected: &str,
        action: ControlAction,
    ) -> Result<Event> {
        ensure!(
            self.owner(mission)? == identity.public_key(),
            "mission owner required"
        );
        let p = self.control_state(mission)?;
        ensure!(
            !self.conflicted(mission)? && p.lifecycle.revision == expected,
            "control revision changed"
        );
        if let ControlAction::Handover { registration, .. } = &action {
            self.communicative_agent(mission, registration)?;
        }
        if matches!(
            &action,
            ControlAction::SetCoordination { .. } | ControlAction::Handover { .. }
        ) {
            ensure!(
                !self.unresolved_grants(mission)?,
                "handover waits for outstanding permissions to be sealed; disconnect or expiry is not proof of termination"
            );
        }
        if let ControlAction::SetPlanArtifact { revision } = &action {
            self.check_plan_artifact(mission, revision, true)?;
        }
        if let ControlAction::Start { readiness, .. } = &action {
            if let Some(id) = p.lifecycle.plan.as_ref().and_then(|p| p.artifact.as_ref()) {
                self.check_plan_artifact(mission, id, true)?;
            }
            ensure!(
                p.lifecycle.start_blockers.is_empty(),
                "mission is not ready"
            );
            ensure!(
                p.lifecycle.readiness.as_ref().map(|r| &r.id) == readiness.as_ref(),
                "readiness changed"
            );
        }
        self.append(
            identity,
            mission,
            Payload::MissionControlled {
                previous: expected.into(),
                action,
            },
        )
    }
    pub(crate) fn validate_control(&self, event: &Event) -> Result<bool> {
        if !is_control(&event.body.payload)
            || matches!(event.body.payload, Payload::MissionCreated { .. })
        {
            return Ok(true);
        }
        let mission = event.mission_id();
        let mut dependencies = vec![];
        match &event.body.payload {
            Payload::MissionControlled { previous, action } => {
                dependencies.push(previous);
                if let ControlAction::Start {
                    readiness: Some(id),
                    ..
                } = action
                {
                    dependencies.push(id);
                }
            }
            Payload::CoordinatorPlanArtifact { control, .. }
            | Payload::CoordinatorPlanned { control, .. } => dependencies.push(control),
            Payload::CoordinatorReadied { control, plan } => {
                dependencies.push(control);
                dependencies.push(plan);
            }
            _ => {}
        }
        for id in dependencies {
            let Some(e) = self.event(id)? else {
                return Ok(false);
            };
            ensure!(
                e.mission_id() == mission
                    && e.body.audience == "main"
                    && is_control(&e.body.payload),
                "invalid control dependency"
            );
        }
        let artifact = match &event.body.payload {
            Payload::CoordinatorPlanArtifact { revision, .. }
            | Payload::MissionControlled {
                action: ControlAction::SetPlanArtifact { revision },
                ..
            } => Some(revision),
            _ => None,
        };
        if let Some(id) = artifact {
            if self.event(id)?.is_none() {
                return Ok(false);
            }
            self.check_plan_artifact(mission, id, false)?;
        }
        let history = self.control_history(mission)?;
        ensure!(
            history.records.len() < harakiri_protocol::limits::MAX_CONTROL_EVENTS,
            "control history limit"
        );
        if matches!(
            event.body.payload,
            Payload::CoordinatorPlanArtifact { .. }
                | Payload::CoordinatorPlanned { .. }
                | Payload::CoordinatorReadied { .. }
        ) {
            ensure!(
                history
                    .records
                    .values()
                    .filter(|e| matches!(
                        e.body.payload,
                        Payload::CoordinatorPlanArtifact { .. }
                            | Payload::CoordinatorPlanned { .. }
                            | Payload::CoordinatorReadied { .. }
                    ))
                    .count()
                    < harakiri_protocol::limits::MAX_COORDINATOR_EVENTS,
                "Coordinator history limit"
            );
        }
        // Reserve the final slot for an owner pause. Exhaustion must never
        // create an Active mission whose owner cannot record a stop decision.
        if history.records.len() >= harakiri_protocol::limits::MAX_CONTROL_EVENTS - 1 {
            ensure!(
                matches!(
                    event.body.payload,
                    Payload::MissionControlled {
                        action: ControlAction::Pause { .. },
                        ..
                    }
                ),
                "control history reserved for pause"
            );
        }
        match &event.body.payload {
            Payload::MissionControlled { previous, action } => {
                // The previous control must be on this exact owner writer
                // branch, including ordinary intervening messages/admissions.
                let mut cursor = event.body.previous.clone();
                let mut found = None;
                for _ in 0..harakiri_protocol::limits::MAX_HISTORY_EVENTS {
                    let Some(id) = cursor else {
                        break;
                    };
                    let Some(parent) = self.event(&id)? else {
                        return Ok(false);
                    };
                    if matches!(
                        parent.body.payload,
                        Payload::MissionCreated { .. } | Payload::MissionControlled { .. }
                    ) {
                        found = Some(id);
                        break;
                    }
                    cursor = parent.body.previous;
                }
                ensure!(
                    found.as_ref() == Some(previous),
                    "owner control predecessor mismatch"
                );
                if let ControlAction::SetCoordination {
                    coordinator: Some(c),
                    ..
                } = action
                {
                    ensure!(
                        !self.members(mission)?.iter().any(|m| m.author == c.author),
                        "Coordinator identity must be separate from human membership"
                    );
                }
                if matches!(
                    action,
                    ControlAction::SetCoordination { .. } | ControlAction::Handover { .. }
                ) && !self.check_handover_cut(event)?
                {
                    return Ok(false);
                }
                let mut next = (*history).clone();
                next.records.insert(event.id.clone(), event.clone());
                next.at(&event.id)?;
            }
            Payload::CoordinatorPlanArtifact { control, .. }
            | Payload::CoordinatorPlanned { control, .. }
            | Payload::CoordinatorReadied { control, .. } => {
                let p = history.at(control)?;
                history.check_coordinator(&p, event)?;
                if let Payload::CoordinatorReadied { plan, .. } = &event.body.payload {
                    ensure!(
                        history
                            .plan_for(&p, Some(event.body.sequence))
                            .as_ref()
                            .map(|p| &p.id)
                            == Some(plan),
                        "readiness requires the latest plan in this writer history"
                    );
                }
            }
            _ => {}
        }
        Ok(true)
    }
}
