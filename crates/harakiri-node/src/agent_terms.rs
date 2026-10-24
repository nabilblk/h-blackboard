//! Renewing a contribution preserves its registration. Current projections may
//! observe a new review; historical authority uses only exact signed evidence.
use crate::store::Store;
use anyhow::{Result, anyhow, ensure};
use harakiri_protocol::{
    Event, Identity, Payload,
    governance::GovernanceAction,
    lifecycle::{ControlAction, MissionPhase},
    work::WorkAction,
};
use std::collections::BTreeMap;

/// Only operations that need reviewed terms collect proofs. Recovery, withdrawal,
/// accounting settlement and review itself must remain possible without them.
fn actor_control(payload: &Payload) -> Option<&str> {
    match payload {
        Payload::AgentDirected { control, .. }
        | Payload::AgentAcknowledged { control, .. }
        | Payload::AgentClarified { control, .. }
        | Payload::AgentClarificationAcknowledged { control, .. }
        | Payload::CoordinatorPlanned { control, .. }
        | Payload::CoordinatorPlanArtifact { control, .. }
        | Payload::CoordinatorReadied { control, .. }
        | Payload::WorkRecorded { control, .. }
        | Payload::ArtifactRecorded { control, .. }
        | Payload::GovernanceRecorded {
            control,
            action: GovernanceAction::Criterion { .. },
        } => Some(control),
        _ => None,
    }
}

fn coordinator_writer(payload: &Payload) -> bool {
    matches!(
        payload,
        Payload::CoordinatorPlanned { .. }
            | Payload::CoordinatorPlanArtifact { .. }
            | Payload::CoordinatorReadied { .. }
            | Payload::AgentDirected { .. }
            | Payload::AgentClarified { .. }
    )
}

fn targets(payload: &Payload) -> Vec<(&str, &str)> {
    match payload {
        Payload::MissionControlled {
            previous,
            action: ControlAction::Start { participants, .. },
        } => participants
            .iter()
            .map(|r| (r.as_str(), previous.as_str()))
            .collect(),
        Payload::AgentDirected {
            registration,
            control,
            ..
        }
        | Payload::AgentAcknowledged {
            registration,
            control,
            ..
        }
        | Payload::AgentClarified {
            registration,
            control,
            ..
        }
        | Payload::AgentClarificationAcknowledged {
            registration,
            control,
            ..
        }
        | Payload::GovernanceRecorded {
            control,
            action: GovernanceAction::Grant { registration, .. },
        }
        | Payload::WorkRecorded {
            control,
            action: WorkAction::AssignWorkstream { registration, .. },
            ..
        } => vec![(registration, control)],
        _ => vec![],
    }
}

impl Store {
    /// Latest contributor review, ordered by its serial writer, never arrival or
    /// display time. Terminal status is enforced by the caller's current view.
    pub(crate) fn agent_reviewed_terms(&self, mission: &str, registration: &str) -> Result<String> {
        let offer = self.offer(mission, registration)?;
        let Payload::AgentOffered { control, .. } = &offer.body.payload else {
            unreachable!()
        };
        let records = self.agent_records(mission)?;
        let control = records
            .values()
            .filter_map(|event| match &event.body.payload {
                Payload::AgentTermsReviewed {
                    registration: r,
                    control,
                } if r == registration => Some((event.body.sequence, control)),
                _ => None,
            })
            .max_by_key(|(sequence, _)| *sequence)
            .map_or(control, |(_, control)| control);
        Ok(self
            .control_history(mission)?
            .at(control)?
            .lifecycle
            .terms_revision)
    }

    fn current_terms_proof(
        &self,
        mission: &str,
        registration: &str,
        control: &str,
    ) -> Result<Event> {
        let offer = self.offer(mission, registration)?;
        let history = self.control_history(mission)?;
        let terms = history.at(control)?.lifecycle.terms_revision;
        let Payload::AgentOffered {
            control: offered, ..
        } = &offer.body.payload
        else {
            unreachable!()
        };
        if history.at(offered)?.lifecycle.terms_revision == terms {
            return Ok(offer);
        }
        self.agent_records(mission)?.values().filter(|e| matches!(&e.body.payload,
            Payload::AgentTermsReviewed { registration: r, control: c }
            if r == registration && history.at(c).is_ok_and(|p| p.lifecycle.terms_revision == terms)))
            .max_by_key(|e| e.body.sequence).cloned().ok_or_else(|| anyhow!("contribution terms require review"))
    }

    pub fn review_agent_terms(
        &mut self,
        contributor: &Identity,
        mission: &str,
        registration: &str,
        terms: &str,
    ) -> Result<Event> {
        let state = self.control_state(mission)?;
        ensure!(
            !self.conflicted(mission)? && state.lifecycle.terms_revision == terms,
            "mission terms changed; review again"
        );
        ensure!(
            !matches!(
                state.lifecycle.phase,
                MissionPhase::Closed | MissionPhase::Archived
            ),
            "mission is closed or archived"
        );
        let offer = self.offer(mission, registration)?;
        ensure!(
            offer.body.author == contributor.public_key(),
            "original contributor review required"
        );
        ensure!(
            !self.is_revoked(mission, &offer.body.author)? && !self.locally_withdrawn(mission)?,
            "contributor revoked or withdrawn"
        );
        let records = self.agent_records(mission)?;
        ensure!(!records.values().any(|e| matches!(&e.body.payload, Payload::AgentWithdrawn { registration: r } if r == registration)), "agent withdrawn");
        let Payload::AgentOffered { identity, .. } = &offer.body.payload else {
            unreachable!()
        };
        ensure!(records.values().filter(|e| matches!(&e.body.payload, Payload::AgentOffered { identity: i, .. } if i.author == identity.author)).count() == 1, "agent identity conflict");
        // Recover a lost native response without appending another review. No
        // current terminal-state check is skipped for an idempotent retry.
        if let Ok(existing) =
            self.current_terms_proof(mission, registration, &state.lifecycle.revision)
        {
            return Ok(existing);
        }
        self.append(
            contributor,
            mission,
            Payload::AgentTermsReviewed {
                registration: registration.into(),
                control: state.lifecycle.revision,
            },
        )
    }

    pub(crate) fn collect_terms_reviews(
        &self,
        mission: &str,
        author: &str,
        payload: &Payload,
    ) -> Result<BTreeMap<String, String>> {
        let mut proofs = BTreeMap::new();
        for (registration, control) in targets(payload) {
            let proof = self.current_terms_proof(mission, registration, control)?;
            if proof.id != registration {
                proofs.insert(registration.into(), proof.id);
            }
        }
        if let Some(control) = actor_control(payload) {
            if let Some(registration) = self.agent_registration(mission, author)? {
                let proof = self.current_terms_proof(mission, &registration, control)?;
                // Even the original offer is explicit for an appointed writer:
                // its appointment alone does not identify the contribution.
                proofs.insert(registration, proof.id);
            } else {
                ensure!(
                    !coordinator_writer(payload) || author == self.owner(mission)?,
                    "registered Coordinator contribution required"
                );
            }
        }
        Ok(proofs)
    }

    /// False means a named dependency is missing. Missing consent itself is an
    /// error, so an unrelated review arriving later cannot authorize this event.
    pub(crate) fn validate_agent_terms(
        &self,
        event: &Event,
        registration: &str,
        control: &str,
    ) -> Result<bool> {
        let Some(offer) = self.event(registration)? else {
            return Ok(false);
        };
        let Payload::AgentOffered {
            control: original, ..
        } = &offer.body.payload
        else {
            anyhow::bail!("agent registration required")
        };
        ensure!(
            offer.mission_id() == event.mission_id(),
            "foreign contribution"
        );
        if self.event(control)?.is_none() {
            return Ok(false);
        }
        let reviewed = if let Some(id) = event.body.terms_reviews.get(registration) {
            let Some(proof) = self.event(id)? else {
                return Ok(false);
            };
            match proof.body.payload {
                Payload::AgentOffered { control, .. } if proof.id == registration => control,
                Payload::AgentTermsReviewed {
                    registration: r,
                    control,
                } if r == registration
                    && proof.mission_id() == event.mission_id()
                    && proof.body.author == offer.body.author =>
                {
                    control
                }
                _ => anyhow::bail!("invalid contribution review proof"),
            }
        } else {
            original.clone()
        };
        let history = self.control_history(event.mission_id())?;
        ensure!(
            history.at(&reviewed)?.lifecycle.terms_revision
                == history.at(control)?.lifecycle.terms_revision,
            "contribution terms require exact review"
        );
        Ok(true)
    }

    pub(crate) fn validate_terms_reviews(&self, event: &Event) -> Result<bool> {
        if event.body.version < 14 {
            let control = match &event.body.payload {
                Payload::MissionControlled { previous, .. } => Some(previous.as_str()),
                Payload::AgentOffered { control, .. }
                | Payload::GovernanceRecorded { control, .. } => Some(control.as_str()),
                payload => actor_control(payload),
            };
            if let Some(control) = control {
                let Some(dependency) = self.event(control)? else {
                    return Ok(false);
                };
                ensure!(
                    dependency.body.version < 14,
                    "legacy record cannot depend on v14 control"
                );
            }
        }
        // Validate all named references, including ones unnecessary for a
        // payload. They can never smuggle a foreign/private/unverified record.
        for (registration, proof) in &event.body.terms_reviews {
            let Some(offer) = self.event(registration)? else {
                return Ok(false);
            };
            ensure!(
                offer.mission_id() == event.mission_id()
                    && matches!(offer.body.payload, Payload::AgentOffered { .. }),
                "invalid review registration"
            );
            let Some(proof) = self.event(proof)? else {
                return Ok(false);
            };
            ensure!(
                proof.mission_id() == event.mission_id()
                    && proof.body.audience == "main"
                    && (proof.id == *registration
                        || matches!(&proof.body.payload, Payload::AgentTermsReviewed { registration: r, .. } if r == registration && proof.body.author == offer.body.author)),
                "invalid contribution review proof"
            );
        }
        if event.body.version < 14 {
            return Ok(true);
        }
        for (registration, control) in targets(&event.body.payload) {
            if !self.validate_agent_terms(event, registration, control)? {
                return Ok(false);
            }
        }
        if let Some(control) = actor_control(&event.body.payload) {
            let authority = self
                .event(
                    event
                        .body
                        .authority
                        .as_deref()
                        .ok_or_else(|| anyhow!("missing authority"))?,
                )?
                .ok_or_else(|| anyhow!("authority unavailable"))?;
            let registration = match &authority.body.payload {
                Payload::AgentOffered { .. } => Some(authority.id.clone()),
                Payload::AgentConversationCreated { registration }
                    if authority.body.author != event.body.author =>
                {
                    Some(registration.clone())
                }
                _ => None,
            };
            if let Some(registration) = registration {
                if !self.validate_agent_terms(event, &registration, control)? {
                    return Ok(false);
                }
            } else if coordinator_writer(&event.body.payload)
                && event.body.author != self.owner(event.mission_id())?
            {
                // Select solely from the signed map: looking up a Coordinator
                // in the current roster would make replay arrival-dependent.
                let mut actors = Vec::new();
                for registration in event.body.terms_reviews.keys() {
                    let offer = self.offer(event.mission_id(), registration)?;
                    if matches!(&offer.body.payload, Payload::AgentOffered { identity, .. } if identity.author == event.body.author && identity.role == harakiri_protocol::agents::AgentRole::Coordinator)
                    {
                        actors.push(registration);
                    }
                }
                ensure!(
                    actors.len() == 1,
                    "exact Coordinator contribution proof required"
                );
                if !self.validate_agent_terms(event, actors[0], control)? {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }
}
