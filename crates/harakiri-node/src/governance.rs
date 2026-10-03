//! Conservative resource ledger. Capacity is transferred only by the owner's
//! serial writer. Reservations belong to the contributor's serial writer.
//! Explicit causal references make replay independent of delivery order.
use crate::store::Store;
use anyhow::{Result, anyhow, ensure};
use harakiri_protocol::{
    Event, Identity, Payload,
    governance::*,
    lifecycle::{ControlAction, MissionPhase},
    policy::MissionBudget,
};
use std::collections::{BTreeMap, BTreeSet};

fn action(e: &Event) -> Option<(&str, &GovernanceAction)> {
    match &e.body.payload {
        Payload::GovernanceRecorded { control, action } => Some((control, action)),
        _ => None,
    }
}
#[derive(Default)]
struct Ledger {
    seals: BTreeMap<String, String>,
    seal_basis: BTreeMap<String, BTreeSet<String>>,
    allocations: BTreeMap<String, AllocationView>,
    grants: BTreeMap<String, GrantView>,
    reservations: BTreeMap<String, ReservationView>,
}
impl Ledger {
    fn totals(&mut self) {
        for a in self.allocations.values_mut() {
            a.charged = 0;
            a.reserved = 0;
            a.active = 0;
        }
        for g in self.grants.values_mut() {
            g.charged = 0;
            g.reserved = 0;
        }
        for r in self.reservations.values() {
            let g = self.grants.get_mut(&r.grant).expect("validated grant");
            let a = self
                .allocations
                .get_mut(&g.allocation)
                .expect("validated allocation");
            let settled = r.resolution.is_some() || (r.stopped && r.used.is_some());
            let used = if r.resolution.is_some() {
                1
            } else {
                r.used.unwrap_or(0)
            };
            if settled {
                a.charged += used;
                g.charged += used;
            } else {
                a.reserved += 1;
                g.reserved += 1;
                a.active += 1;
            }
        }
    }
    fn apply(&mut self, e: &Event, validate: bool) -> Result<()> {
        let Some((control, a)) = action(e) else {
            return Ok(());
        };
        let actor = &e.body.author;
        match a {
            GovernanceAction::Allocate { node, turns, slots } => {
                self.allocations.insert(
                    e.id.clone(),
                    AllocationView {
                        id: e.id.clone(),
                        node: node.clone(),
                        turns: *turns,
                        slots: *slots,
                        charged: 0,
                        reserved: 0,
                        active: 0,
                        sealed: None,
                        reclaimed: false,
                    },
                );
            }
            GovernanceAction::Reclaim { seal } => {
                let a = self
                    .seals
                    .get(seal)
                    .and_then(|id| self.allocations.get_mut(id))
                    .ok_or_else(|| anyhow!("allocation seal unavailable"))?;
                ensure!(
                    !validate
                        || !a.reclaimed
                            && !self
                                .grants
                                .values()
                                .any(|g| g.allocation == a.id && !g.sealed),
                    "unresolved allocation grants"
                );
                a.reclaimed = true;
            }
            GovernanceAction::Grant {
                purpose,
                direction,
                allocation,
                registration,
                execution,
                generation,
                turns,
                expires_ms,
                offline_ms,
                ..
            } => {
                let a = self
                    .allocations
                    .get(allocation)
                    .ok_or_else(|| anyhow!("allocation unavailable"))?;
                ensure!(
                    !validate || a.sealed.is_none() && !a.reclaimed,
                    "allocation closed"
                );
                ensure!(
                    !validate
                        || !self
                            .grants
                            .values()
                            .any(|g| g.registration == *registration && !g.sealed),
                    "previous permission for this agent is unresolved"
                );
                let prior = self
                    .grants
                    .values()
                    .filter(|g| g.execution == *execution)
                    .max_by_key(|g| g.generation);
                ensure!(
                    !validate
                        || prior.map_or(*generation == 1, |g| g.sealed
                            && g.generation.checked_add(1) == Some(*generation)),
                    "execution generation unresolved"
                );
                self.grants.insert(
                    e.id.clone(),
                    GrantView {
                        id: e.id.clone(),
                        purpose: *purpose,
                        issued_ms: e.body.created_at_ms.unwrap_or(0),
                        allocation: allocation.clone(),
                        registration: registration.clone(),
                        node: a.node.clone(),
                        execution: execution.clone(),
                        generation: *generation,
                        turns: *turns,
                        expires_ms: *expires_ms,
                        offline_ms: *offline_ms,
                        control: control.into(),
                        direction: direction.clone(),
                        consent: None,
                        consent_binding: None,
                        risk_accepted: None,
                        sealed: false,
                        seal: None,
                        charged: 0,
                        reserved: 0,
                    },
                );
            }
            GovernanceAction::Consent { grant, binding } => {
                let g = self
                    .grants
                    .get_mut(grant)
                    .ok_or_else(|| anyhow!("grant unavailable"))?;
                ensure!(
                    !validate
                        || &g.node == actor
                            && !g.sealed
                            && g.consent.is_none()
                            && self.allocations[&g.allocation].sealed.is_none(),
                    "grant consent unavailable"
                );
                g.consent = Some(e.id.clone());
                g.consent_binding = Some(binding.clone());
            }
            GovernanceAction::Reserve {
                grant,
                consent,
                nonce,
            } => {
                let g = self
                    .grants
                    .get(grant)
                    .ok_or_else(|| anyhow!("grant unavailable"))?;
                let a = &self.allocations[&g.allocation];
                ensure!(
                    !validate
                        || &g.node == actor
                            && !g.sealed
                            && a.sealed.is_none()
                            && g.consent.as_ref() == Some(consent),
                    "grant is not consented or is closed"
                );
                ensure!(
                    !validate
                        || g.charged + g.reserved < g.turns
                            && a.turns.is_none_or(|n| a.charged + a.reserved < n)
                            && a.active < a.slots,
                    "allowance exhausted"
                );
                ensure!(
                    !validate
                        || !self.reservations.values().any(|r| r.grant == *grant
                            && (r.nonce == *nonce
                                || (r.resolution.is_none() && !(r.stopped && r.used.is_some())))),
                    "duplicate or unresolved execution reservation"
                );
                self.reservations.insert(
                    e.id.clone(),
                    ReservationView {
                        id: e.id.clone(),
                        grant: grant.clone(),
                        node: actor.clone(),
                        nonce: nonce.clone(),
                        receipt: None,
                        used: None,
                        stopped: false,
                        resolution: None,
                        summary: None,
                    },
                );
            }
            GovernanceAction::Receipt {
                reservation,
                used,
                stopped,
                summary,
            } => {
                let r = self
                    .reservations
                    .get_mut(reservation)
                    .ok_or_else(|| anyhow!("reservation unavailable"))?;
                ensure!(
                    !validate || &r.node == actor && r.receipt.is_none() && r.resolution.is_none(),
                    "receipt already recorded or wrong contributor"
                );
                r.receipt = Some(e.id.clone());
                r.used = *used;
                r.stopped = *stopped;
                r.summary = Some(summary.clone());
            }
            GovernanceAction::Resolve {
                reservation,
                reason,
            } => {
                let r = self
                    .reservations
                    .get_mut(reservation)
                    .ok_or_else(|| anyhow!("reservation unavailable"))?;
                ensure!(
                    !validate || r.resolution.is_none() && !(r.stopped && r.used.is_some()),
                    "reservation already settled"
                );
                r.resolution = Some(e.id.clone());
                r.summary = Some(format!(
                    "Human accepted uncertainty, charged one full turn. {reason}"
                ));
            }
            GovernanceAction::RetireGrant { grant, reason } => {
                let g = self
                    .grants
                    .get_mut(grant)
                    .ok_or_else(|| anyhow!("grant unavailable"))?;
                ensure!(
                    !validate || (!g.sealed && g.reserved == 0),
                    "resolve known reservations first"
                );
                g.sealed = true;
                g.seal = Some(e.id.clone());
                g.risk_accepted = Some(reason.clone());
            }
            GovernanceAction::SealGrant { grant, .. } => {
                let g = self
                    .grants
                    .get_mut(grant)
                    .ok_or_else(|| anyhow!("grant unavailable"))?;
                ensure!(
                    !validate || &g.node == actor && !g.sealed && g.reserved == 0,
                    "grant still has unresolved work"
                );
                g.sealed = true;
                g.seal = Some(e.id.clone());
            }
            GovernanceAction::SealAllocation { allocation, .. } => {
                let observed: BTreeSet<_> = self
                    .grants
                    .values()
                    .filter(|g| g.allocation == *allocation)
                    .map(|g| g.id.clone())
                    .collect();
                ensure!(
                    !validate || self.seal_basis.get(allocation) != Some(&observed),
                    "allocation already sealed against these permissions"
                );
                self.seal_basis.insert(allocation.clone(), observed);
                let a = self
                    .allocations
                    .get_mut(allocation)
                    .ok_or_else(|| anyhow!("allocation unavailable"))?;
                ensure!(
                    !validate
                        || &a.node == actor
                            && !a.reclaimed
                            && a.reserved == 0
                            && !self
                                .grants
                                .values()
                                .any(|g| g.allocation == *allocation && !g.sealed),
                    "allocation still has unresolved grants"
                );
                a.sealed = Some(e.id.clone());
                self.seals.insert(e.id.clone(), allocation.clone());
            }
            GovernanceAction::Criterion { .. } => {}
        }
        self.totals();
        Ok(())
    }
}

impl Store {
    fn governance_records(&self, mission: &str) -> Result<Vec<Event>> {
        let mut q=self.connection.prepare("SELECT bytes FROM events JOIN governance_records ON event=id WHERE mission=?1 AND fork=0 ORDER BY id LIMIT 4097")?;
        let bytes = q
            .query_map([mission], |r| r.get::<_, Vec<u8>>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(bytes.len() <= MAX_RECORDS, "governance history limit");
        bytes
            .into_iter()
            .map(|b| Event::verify(&b).map_err(Into::into))
            .collect()
    }
    /// Walk writer predecessors and explicit resource dependencies. Other
    /// writers' future records can never change validation of this signed cut.
    fn governance_order(&self, roots: Vec<Event>) -> Result<Vec<Event>> {
        let mut stack: Vec<_> = roots.into_iter().map(|e| (e, false)).collect();
        let mut seen = BTreeSet::new();
        let mut ordered = Vec::new();
        while let Some((e, exit)) = stack.pop() {
            if exit {
                if action(&e).is_some() {
                    ordered.push(e);
                }
                continue;
            }
            if !seen.insert(e.id.clone()) {
                continue;
            }
            ensure!(
                seen.len() <= harakiri_protocol::limits::MAX_HISTORY_EVENTS,
                "history traversal limit"
            );
            let mut deps = Vec::new();
            if let Some(id) = &e.body.previous {
                deps.push(id.as_str());
            }
            if let Some((_, a)) = action(&e) {
                deps.extend(a.references());
            }
            stack.push((e.clone(), true));
            for id in deps {
                stack.push((
                    self.event(id)?
                        .ok_or_else(|| anyhow!("missing resource dependency"))?,
                    false,
                ));
            }
        }
        Ok(ordered)
    }
    fn ledger(&self, roots: Vec<Event>) -> Result<Ledger> {
        let mut ledger = Ledger::default();
        for e in self.governance_order(roots)? {
            ledger.apply(&e, false)?;
        }
        Ok(ledger)
    }
    pub fn governance(&self, mission: &str, viewer: &str) -> Result<GovernanceView> {
        ensure!(
            self.members(mission)?.iter().any(|m| m.author == viewer)
                || self.agent_registration(mission, viewer)?.is_some(),
            "mission unavailable"
        );
        let records = self.governance_records(mission)?;
        let ledger = self.ledger(records.clone())?;
        let state = self.control_state(mission)?;
        let owner = self.owner(mission)?;
        let mut criteria = Vec::new();
        for (index, wording) in state.definition.criteria.iter().enumerate() {
            let candidates:Vec<_>=records.iter().filter(|e|matches!(action(e),Some((_,GovernanceAction::Criterion{index:i,wording:w,..})) if usize::from(*i)==index && w==wording)).collect();
            let history = self.control_history(mission)?;
            let latest = candidates.into_iter().max_by_key(|e| {
                let past = action(e).and_then(|(c, _)| history.at(c).ok());
                let current = past.as_ref().is_some_and(|p| {
                    p.lifecycle.terms_revision == state.lifecycle.terms_revision
                        && (e.body.author == owner
                            || p.lifecycle.coordinator.as_ref().map(|c| &c.appointment)
                                == state.lifecycle.coordinator.as_ref().map(|c| &c.appointment))
                });
                (current, e.body.author == owner, e.body.sequence)
            });
            let mut v = CriterionView {
                index: index as u16,
                wording: wording.clone(),
                met: false,
                report: None,
                author: None,
                summary: None,
                evidence: vec![],
                stale: false,
            };
            if let Some(e) = latest
                && let Some((
                    control,
                    GovernanceAction::Criterion {
                        met,
                        summary,
                        evidence,
                        ..
                    },
                )) = action(e)
            {
                v.report = Some(e.id.clone());
                v.author = Some(e.body.author.clone());
                v.summary = Some(summary.clone());
                v.evidence = evidence.clone();
                v.met = *met;
                v.stale = self
                    .control_history(mission)?
                    .at(control)?
                    .lifecycle
                    .terms_revision
                    != state.lifecycle.terms_revision;
                for id in evidence {
                    v.stale |= self.artifact_evidence_stale(mission, id)?;
                }
                v.stale |= self.provisional(&e.id)?;
                if e.body.author != owner {
                    v.stale |= self
                        .control_history(mission)?
                        .at(control)?
                        .lifecycle
                        .coordinator
                        .as_ref()
                        .map(|c| &c.appointment)
                        != state.lifecycle.coordinator.as_ref().map(|c| &c.appointment);
                }
                if v.stale {
                    v.met = false;
                }
            }
            criteria.push(v);
        }
        // Grants all use the owner's writer stream. Preserve that order so the
        // desktop can select the latest sealed permission when replacing it.
        let sequences: BTreeMap<_, _> = records
            .iter()
            .map(|e| (e.id.as_str(), e.body.sequence))
            .collect();
        let mut grants: Vec<_> = ledger.grants.into_values().collect();
        grants.sort_by_key(|g| sequences.get(g.id.as_str()).copied());
        Ok(GovernanceView {
            handover_blockers: grants
                .iter()
                .filter(|g| !g.sealed)
                .map(|g| g.id.clone())
                .collect(),
            allocations: ledger.allocations.into_values().collect(),
            grants,
            reservations: ledger.reservations.into_values().collect(),
            criteria,
            execution_available: false,
        })
    }
    pub fn govern(
        &mut self,
        identity: &Identity,
        mission: &str,
        control: &str,
        a: GovernanceAction,
    ) -> Result<Event> {
        let p = self.control_state(mission)?;
        ensure!(
            p.lifecycle.revision == control && !self.conflicted(mission)?,
            "mission changed; refresh controls"
        );
        if let GovernanceAction::Reserve { grant, .. } | GovernanceAction::Consent { grant, .. } =
            &a
        {
            let ledger = self.ledger(self.governance_records(mission)?)?;
            let g = ledger
                .grants
                .get(grant)
                .ok_or_else(|| anyhow!("grant unavailable"))?;
            let agent = self.communicative_agent(mission, &g.registration)?;
            let planning = g.purpose == GrantPurpose::Planning
                && p.lifecycle.phase == MissionPhase::Preparing
                && g.direction == control
                && agent.status == harakiri_protocol::agents::AgentStatus::WaitingForStart
                && p.lifecycle
                    .coordinator
                    .as_ref()
                    .is_some_and(|c| c.identity.author == agent.identity.author);
            ensure!(
                planning
                    || (agent.status == harakiri_protocol::agents::AgentStatus::DirectionAssigned
                        && agent
                            .direction
                            .as_ref()
                            .is_some_and(|d| d.id == g.direction)),
                "permission direction changed"
            );
            ensure!(
                !g.sealed && ledger.allocations[&g.allocation].sealed.is_none(),
                "permission was sealed or retired"
            );
        }
        if let GovernanceAction::Grant {
            purpose,
            registration,
            direction,
            ..
        } = &a
        {
            let agent = self.communicative_agent(mission, registration)?;
            let planning = *purpose == GrantPurpose::Planning
                && p.lifecycle.phase == MissionPhase::Preparing
                && direction == control
                && agent.status == harakiri_protocol::agents::AgentStatus::WaitingForStart
                && p.lifecycle
                    .coordinator
                    .as_ref()
                    .is_some_and(|c| c.identity.author == agent.identity.author);
            ensure!(
                planning
                    || (*purpose == GrantPurpose::Work
                        && agent.status
                            == harakiri_protocol::agents::AgentStatus::DirectionAssigned
                        && agent.direction.as_ref().is_some_and(|d| &d.id == direction)),
                "current agent direction required"
            );
        }
        if let GovernanceAction::Criterion { evidence, .. } = &a {
            for id in evidence {
                ensure!(
                    !self.artifact_evidence_stale(mission, id)?,
                    "evidence needs review"
                );
            }
        }
        if matches!(
            a,
            GovernanceAction::Reserve { .. }
                | GovernanceAction::Consent { .. }
                | GovernanceAction::Grant { .. }
        ) {
            let deadline = match p.definition.policy.as_ref().map(|p| &p.budget) {
                Some(MissionBudget::Limited { deadline_ms, .. }) => *deadline_ms,
                _ => None,
            };
            ensure!(
                deadline.is_none_or(|d| crate::store::now().is_ok_and(|now| now < d)),
                "mission deadline passed"
            );
        }
        self.append(
            identity,
            mission,
            Payload::GovernanceRecorded {
                control: control.into(),
                action: a,
            },
        )
    }
    pub(crate) fn validate_governance(&self, e: &Event) -> Result<bool> {
        let Some((control, a)) = action(e) else {
            return Ok(true);
        };
        if self.event(control)?.is_none() {
            return Ok(false);
        }
        for id in a.references() {
            let Some(dep) = self.event(id)? else {
                return Ok(false);
            };
            ensure!(
                dep.mission_id() == e.mission_id() && dep.body.audience == "main",
                "resource dependency scope"
            );
        }
        let p = self.control_history(e.mission_id())?.at(control)?;
        let owner = self.owner(e.mission_id())?;
        let is_owner = e.body.author == owner;
        ensure!(
            self.governance_records(e.mission_id())?.len() < MAX_RECORDS,
            "governance history limit"
        );
        let existing = self.governance_records(e.mission_id())?;
        let count = |which: u8| {
            existing
                .iter()
                .filter(|r| {
                    matches!(
                        (which, action(r)),
                        (0, Some((_, GovernanceAction::Allocate { .. })))
                            | (1, Some((_, GovernanceAction::Grant { .. })))
                            | (2, Some((_, GovernanceAction::Reserve { .. })))
                            | (3, Some((_, GovernanceAction::Criterion { .. })))
                    )
                })
                .count()
        };
        match a {
            GovernanceAction::Allocate { .. } => ensure!(count(0) < 128, "allocation limit"),
            GovernanceAction::Grant { .. } => ensure!(count(1) < 256, "permission limit"),
            GovernanceAction::Reserve { .. } => ensure!(count(2) < 512, "reservation limit"),
            GovernanceAction::Criterion { .. } => {
                ensure!(count(3) < 512, "criterion history limit")
            }
            _ => {}
        }
        match a {
            GovernanceAction::Allocate { node, .. } => {
                ensure!(
                    is_owner
                        && matches!(
                            p.lifecycle.phase,
                            MissionPhase::Preparing | MissionPhase::Active | MissionPhase::Paused
                        ),
                    "owner allocation authority"
                );
                ensure!(
                    self.members(e.mission_id())?
                        .iter()
                        .any(|m| &m.author == node),
                    "allocation contributor unavailable"
                );
            }
            GovernanceAction::Grant {
                purpose,
                turns,
                registration,
                direction,
                expires_ms,
                offline_ms,
                ..
            } => {
                ensure!(
                    is_owner
                        && match purpose {
                            GrantPurpose::Work => p.lifecycle.phase == MissionPhase::Active,
                            GrantPurpose::Planning => p.lifecycle.phase == MissionPhase::Preparing,
                        },
                    "owner permission for the current mission phase required"
                );
                let offered = self
                    .event(registration)?
                    .ok_or_else(|| anyhow!("registration unavailable"))?;
                let Payload::AgentOffered {
                    control: offered_control,
                    identity: offered_identity,
                } = &offered.body.payload
                else {
                    anyhow::bail!("registration required")
                };
                ensure!(
                    self.control_history(e.mission_id())?
                        .at(offered_control)?
                        .lifecycle
                        .terms_revision
                        == p.lifecycle.terms_revision,
                    "stale contribution terms"
                );
                ensure!(
                    offered_identity.role != harakiri_protocol::agents::AgentRole::Coordinator
                        || p.lifecycle
                            .coordinator
                            .as_ref()
                            .is_some_and(|c| c.identity.author == offered_identity.author),
                    "Coordinator must be appointed before permission"
                );
                if *purpose == GrantPurpose::Planning {
                    ensure!(
                        offered_identity.role == harakiri_protocol::agents::AgentRole::Coordinator
                            && p.lifecycle
                                .coordinator
                                .as_ref()
                                .is_some_and(|c| c.identity.author == offered_identity.author)
                            && direction == control
                            && *turns <= 8,
                        "bounded appointed Coordinator planning permission required"
                    );
                }
                let direction = self
                    .event(direction)?
                    .ok_or_else(|| anyhow!("direction unavailable"))?;
                let valid = match &direction.body.payload {
                    Payload::MissionControlled {
                        action: ControlAction::Start { participants, .. },
                        ..
                    } => {
                        direction.id == control
                            && (participants.contains(registration)
                                || p.definition.policy.as_ref().is_some_and(|p| {
                                    p.coordination == harakiri_protocol::policy::Coordination::Peer
                                }))
                    }
                    Payload::AgentDirected {
                        registration: r,
                        control: c,
                        ..
                    } => r == registration && c == control,
                    Payload::WorkRecorded {
                        control: c,
                        action:
                            harakiri_protocol::work::WorkAction::AssignWorkstream {
                                registration: r,
                                ..
                            },
                        ..
                    } => r == registration && c == control,
                    _ => false,
                };
                ensure!(
                    valid || (*purpose == GrantPurpose::Planning && direction.id == control),
                    "exact current direction required"
                );
                let now = e
                    .body
                    .created_at_ms
                    .ok_or_else(|| anyhow!("permission timestamp required"))?;
                ensure!(
                    *expires_ms > now
                        && expires_ms - now <= MAX_GRANT_MS
                        && *offline_ms <= expires_ms - now,
                    "permission validity exceeds bound"
                );
                ensure!(
                    *purpose != GrantPurpose::Planning || expires_ms - now <= 900_000,
                    "planning permission is limited to fifteen minutes"
                );
            }
            GovernanceAction::Reclaim { .. }
            | GovernanceAction::Resolve { .. }
            | GovernanceAction::RetireGrant { .. } => {
                ensure!(is_owner, "owner reconciliation required")
            }
            GovernanceAction::Criterion {
                index,
                wording,
                evidence,
                ..
            } => {
                let coord = p
                    .lifecycle
                    .coordinator
                    .as_ref()
                    .is_some_and(|c| c.identity.author == e.body.author);
                ensure!(
                    p.lifecycle.phase != MissionPhase::Archived
                        && (is_owner || (coord && p.lifecycle.phase == MissionPhase::Active)),
                    "criterion authority"
                );
                ensure!(
                    p.definition.criteria.get(usize::from(*index)) == Some(wording),
                    "criterion definition changed"
                );
                for id in evidence {
                    let Some(ev) = self.event(id)? else {
                        return Ok(false);
                    };
                    ensure!(
                        ev.mission_id() == e.mission_id()
                            && ev.body.audience == "main"
                            && matches!(
                                ev.body.payload,
                                Payload::ArtifactRecorded {
                                    action: harakiri_protocol::artifacts::ArtifactAction::Publish { .. },
                                    ..
                                }
                            ),
                        "exact public artifact evidence required"
                    );
                }
            }
            GovernanceAction::Consent { .. } | GovernanceAction::Reserve { .. } => ensure!(
                matches!(
                    p.lifecycle.phase,
                    MissionPhase::Active | MissionPhase::Preparing
                ),
                "mission does not permit execution"
            ),
            _ => {}
        }
        let mut roots = Vec::new();
        if let Some(previous) = &e.body.previous {
            roots.push(
                self.event(previous)?
                    .ok_or_else(|| anyhow!("writer predecessor unavailable"))?,
            );
        }
        for id in a.references() {
            roots.push(
                self.event(id)?
                    .ok_or_else(|| anyhow!("missing resource dependency"))?,
            );
        }
        let mut ledger = self.ledger(roots)?;
        if let GovernanceAction::Allocate { turns, slots, .. } = a {
            let assigned_turns: Option<u64> = ledger
                .allocations
                .values()
                .map(|a| {
                    if a.reclaimed {
                        Some(u64::from(a.charged))
                    } else {
                        a.turns.map(u64::from)
                    }
                })
                .sum();
            let assigned_slots: u64 = ledger
                .allocations
                .values()
                .filter(|a| !a.reclaimed)
                .map(|a| u64::from(a.slots))
                .sum();
            if let Some(MissionBudget::Limited {
                turns: cap,
                concurrency,
                ..
            }) = p.definition.policy.as_ref().map(|p| &p.budget)
            {
                if let Some(cap) = cap {
                    ensure!(
                        assigned_turns
                            .zip(*turns)
                            .is_some_and(|(total, n)| total + u64::from(n) <= u64::from(*cap)),
                        "mission turn allowance exhausted"
                    );
                }
                if let Some(cap) = concurrency {
                    ensure!(
                        assigned_slots + u64::from(*slots) <= u64::from(*cap),
                        "mission concurrency allocated"
                    );
                }
            }
        }
        if let GovernanceAction::Grant {
            previous,
            allocation,
            registration,
            ..
        } = a
        {
            if let Some(id) = previous {
                let e = self
                    .event(id)?
                    .ok_or_else(|| anyhow!("previous permission seal unavailable"))?;
                let prior = match action(&e) {
                    Some((
                        _,
                        GovernanceAction::SealGrant { grant, .. }
                        | GovernanceAction::RetireGrant { grant, .. },
                    )) => grant,
                    _ => anyhow::bail!("previous permission seal required"),
                };
                ensure!(
                    ledger
                        .grants
                        .get(prior)
                        .is_some_and(|g| g.registration == *registration),
                    "previous permission belongs to another agent"
                );
            }
            let alloc = ledger
                .allocations
                .get(allocation)
                .ok_or_else(|| anyhow!("allocation unavailable"))?;
            ensure!(
                self.event(registration)?
                    .is_some_and(|r| r.body.author == alloc.node),
                "grant belongs to a different contributor"
            );
        }
        if let GovernanceAction::Reserve { grant, .. } | GovernanceAction::Consent { grant, .. } = a
        {
            let g = ledger
                .grants
                .get(grant)
                .ok_or_else(|| anyhow!("grant unavailable"))?;
            ensure!(
                g.control == control && e.body.created_at_ms.is_some_and(|t| t < g.expires_ms),
                "permission changed or expired"
            );
            ensure!(
                match g.purpose {
                    GrantPurpose::Work => p.lifecycle.phase == MissionPhase::Active,
                    GrantPurpose::Planning => p.lifecycle.phase == MissionPhase::Preparing,
                },
                "permission purpose does not match mission phase"
            );
        }
        ledger.apply(e, true)?;
        Ok(true)
    }
    pub(crate) fn check_handover_cut(&self, e: &Event) -> Result<bool> {
        let mut roots = Vec::new();
        if let Some(id) = &e.body.previous {
            roots.push(
                self.event(id)?
                    .ok_or_else(|| anyhow!("missing owner history"))?,
            );
        }
        if let Payload::MissionControlled {
            action:
                ControlAction::Handover {
                    registration,
                    coordinator,
                    settlements,
                },
            ..
        } = &e.body.payload
        {
            let Some(offer) = self.event(registration)? else {
                return Ok(false);
            };
            ensure!(
                offer.mission_id() == e.mission_id()
                    && matches!(&offer.body.payload,Payload::AgentOffered{identity,..} if identity.author==coordinator.author && identity.runtime==coordinator.runtime && identity.role==harakiri_protocol::agents::AgentRole::Coordinator),
                "share a Coordinator contribution before handover"
            );
            for id in settlements {
                let Some(record) = self.event(id)? else {
                    return Ok(false);
                };
                ensure!(
                    record.mission_id() == e.mission_id()
                        && matches!(
                            record.body.payload,
                            Payload::GovernanceRecorded {
                                action: GovernanceAction::SealGrant { .. }
                                    | GovernanceAction::RetireGrant { .. },
                                ..
                            }
                        ),
                    "grant seal required"
                );
                roots.push(record);
            }
        }
        ensure!(
            !self.ledger(roots)?.grants.values().any(|g| !g.sealed),
            "handover has outstanding grants; include contributor seals"
        );
        Ok(true)
    }
    pub(crate) fn unresolved_grants(&self, mission: &str) -> Result<bool> {
        Ok(self
            .ledger(self.governance_records(mission)?)?
            .grants
            .values()
            .any(|g| !g.sealed))
    }
}

/// Host-only local admission terms. Never serialized into mission history.
#[derive(Debug, serde::Deserialize, ts_rs::TS)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum LocalAllowance {
    Bounded {
        turns: u32,
        concurrency: u16,
        minutes: u32,
    },
    Unlimited {
        concurrency: u16,
    },
}
impl Store {
    #[allow(clippy::too_many_arguments)]
    pub fn reserve_local(
        &mut self,
        human: &Identity,
        mission: &str,
        control: &str,
        registration: &str,
        grant: &str,
        consent: &str,
        nonce: &str,
        limits: LocalAllowance,
    ) -> Result<Event> {
        let ledger = self.ledger(self.governance_records(mission)?)?;
        let g = ledger
            .grants
            .get(grant)
            .ok_or_else(|| anyhow!("permission unavailable"))?;
        ensure!(
            g.registration == registration && g.node == human.public_key(),
            "local permission binding mismatch"
        );
        // A retry of the same reservation returns the durable record, including
        // after a response was lost. It never creates a second turn.
        if let Some(r) = ledger
            .reservations
            .values()
            .find(|r| r.grant == grant && r.nonce == nonce)
        {
            return self
                .event(&r.id)?
                .ok_or_else(|| anyhow!("reservation unavailable"));
        }
        let grants: Vec<_> = ledger
            .grants
            .values()
            .filter(|g| g.registration == registration)
            .collect();
        let spent: u32 = grants.iter().map(|g| g.charged + g.reserved).sum();
        let active: u32 = grants.iter().map(|g| g.reserved).sum();
        let concurrency = match limits {
            LocalAllowance::Bounded { concurrency, .. }
            | LocalAllowance::Unlimited { concurrency } => concurrency,
        };
        ensure!(
            (1..=32).contains(&concurrency) && active < u32::from(concurrency),
            "local concurrency exhausted"
        );
        if let LocalAllowance::Bounded { turns, minutes, .. } = limits {
            ensure!(
                (1..=10000).contains(&turns) && (1..=10080).contains(&minutes) && spent < turns,
                "local turn allowance exhausted"
            );
            let mut earliest = None;
            for g in grants {
                if let Some(id) = &g.consent {
                    let t = self
                        .event(id)?
                        .and_then(|e| e.body.created_at_ms)
                        .ok_or_else(|| anyhow!("consent timestamp unavailable"))?;
                    earliest = Some(earliest.map_or(t, |old: u64| old.min(t)));
                }
            }
            let start = earliest.ok_or_else(|| anyhow!("local consent required"))?;
            let now = crate::store::now()?;
            ensure!(
                now >= start && now - start < u64::from(minutes) * 60000,
                "local time allowance expired or clock uncertain"
            );
        }
        self.govern(
            human,
            mission,
            control,
            GovernanceAction::Reserve {
                grant: grant.into(),
                consent: consent.into(),
                nonce: nonce.into(),
            },
        )
    }
}
