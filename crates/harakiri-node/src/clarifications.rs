//! Clarifications preserve the exact assignment and its execution grant. They
//! are signed, addressed updates; delivery and acknowledgment remain distinct.
use crate::{agents::Records, store::Store};
use anyhow::{Result, anyhow, ensure};
use harakiri_protocol::{
    Event, Identity, Payload,
    lifecycle::{ControlAction, MissionPhase},
};
use std::collections::BTreeSet;

pub(crate) fn pending<'a>(
    records: &'a Records,
    registration: &str,
    control: &str,
    direction: &str,
) -> Vec<&'a Event> {
    let acknowledged: BTreeSet<&str> = records
        .values()
        .filter_map(|e| match &e.body.payload {
            Payload::AgentClarificationAcknowledged { clarification, .. } => {
                Some(clarification.as_str())
            }
            _ => None,
        })
        .collect();
    records.values().filter(|e| matches!(&e.body.payload,
        Payload::AgentClarified { registration: r, control: c, direction: d, .. }
            if r == registration && c == control && d == direction && !acknowledged.contains(e.id.as_str())
    )).collect()
}

impl Store {
    pub fn clarify_agent(
        &mut self,
        author: &Identity,
        mission: &str,
        control: &str,
        registration: &str,
        direction: &str,
        text: String,
    ) -> Result<Event> {
        let state = self.control_state(mission)?;
        ensure!(
            state.lifecycle.revision == control && state.lifecycle.phase == MissionPhase::Active,
            "clarification requires current active mission terms"
        );
        let agent = self.communicative_agent(mission, registration)?;
        ensure!(
            agent.direction.as_ref().is_some_and(|d| d.id == direction),
            "direction changed; read context again"
        );
        let records = self.agent_records(mission)?;
        if let Some(existing) = records.values().find(|e| {
            e.body.author == author.public_key()
                && matches!(&e.body.payload,
            Payload::AgentClarified { registration: r, control: c, direction: d, text: t }
                if r == registration && c == control && d == direction && t == &text)
        }) {
            return Ok(existing.clone());
        }
        ensure!(
            agent.pending_clarifications < 32,
            "acknowledge pending clarifications before adding more"
        );
        self.append(
            author,
            mission,
            Payload::AgentClarified {
                registration: registration.into(),
                control: control.into(),
                direction: direction.into(),
                text,
            },
        )
    }

    pub(crate) fn validate_clarification(&self, event: &Event) -> Result<bool> {
        let (registration, control) = match &event.body.payload {
            Payload::AgentClarified {
                registration,
                control,
                ..
            }
            | Payload::AgentClarificationAcknowledged {
                registration,
                control,
                ..
            } => (registration, control),
            _ => return Ok(true),
        };
        let Some(offer) = self.event(registration)? else {
            return Ok(false);
        };
        let Some(_) = self.event(control)? else {
            return Ok(false);
        };
        let Payload::AgentOffered {
            control: reviewed,
            identity,
        } = &offer.body.payload
        else {
            return Err(anyhow!("agent registration required"));
        };
        let mission = event.mission_id();
        let history = self.control_history(mission)?;
        let state = history.at(control)?;
        ensure!(
            offer.mission_id() == mission
                && state.lifecycle.phase == MissionPhase::Active
                && history.at(reviewed)?.lifecycle.terms_revision == state.lifecycle.terms_revision,
            "clarification requires matching active mission terms"
        );
        match &event.body.payload {
            Payload::AgentClarified { direction, .. } => {
                ensure!(
                    event.body.author == history.root.body.author
                        || state
                            .lifecycle
                            .coordinator
                            .as_ref()
                            .is_some_and(|c| c.identity.author == event.body.author
                                && event.body.authority.as_ref() == Some(&c.appointment)),
                    "mission owner or current Coordinator required"
                );
                let Some(d) = self.event(direction)? else {
                    return Ok(false);
                };
                ensure!(
                    d.mission_id() == mission && d.body.audience == "main",
                    "foreign direction"
                );
                let valid = match &d.body.payload {
                    Payload::AgentDirected {
                        registration: r, ..
                    } => r == registration && self.assignment_applies_at(mission, control, &d)?,
                    Payload::WorkRecorded {
                        action:
                            harakiri_protocol::work::WorkAction::AssignWorkstream {
                                registration: r,
                                ..
                            },
                        ..
                    } => r == registration && self.assignment_applies_at(mission, control, &d)?,
                    Payload::MissionControlled {
                        action: ControlAction::Start { participants, .. },
                        ..
                    } => {
                        &d.id == control
                            && (participants.contains(registration)
                                || state.definition.policy.as_ref().is_some_and(|p| {
                                    p.coordination == harakiri_protocol::policy::Coordination::Peer
                                }))
                    }
                    _ => false,
                };
                ensure!(
                    valid,
                    "clarification must reference an authorized direction"
                );
            }
            Payload::AgentClarificationAcknowledged { clarification, .. } => {
                ensure!(
                    event.body.author == identity.author
                        && event.body.authority.as_ref() == Some(registration),
                    "agent acknowledgment authority required"
                );
                let Some(update) = self.event(clarification)? else {
                    return Ok(false);
                };
                ensure!(
                    update.mission_id() == mission
                        && matches!(&update.body.payload,
                    Payload::AgentClarified { registration: r, control: c, .. } if r == registration && c == control),
                    "clarification acknowledgment binding mismatch"
                );
            }
            _ => unreachable!(),
        }
        Ok(true)
    }
}
