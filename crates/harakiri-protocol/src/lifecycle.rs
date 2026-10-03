//! Pure mission-control reduction. No clocks, IO, runtime calls or arrival-order
//! winners. A human Start accepts an exact Coordinator acknowledgment; it never
//! constitutes a device execution grant or a receipt that a process has stopped.
use crate::{
    Error, Event, MissionDefinition, Payload, Result, event::is_hash, policy::Coordination,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct CoordinatorIdentity {
    pub author: String,
    pub label: String,
    pub runtime: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ControlAction {
    UpdateInstructions {
        definition: MissionDefinition,
    },
    SetCoordination {
        mode: Coordination,
        coordinator: Option<CoordinatorIdentity>,
    },
    SetPlan {
        text: String,
    },
    Handover {
        registration: String,
        coordinator: CoordinatorIdentity,
        settlements: Vec<String>,
    },
    SetPlanArtifact {
        revision: String,
    },
    Close {
        reason: String,
    },
    Archive {
        reason: String,
    },
    Restore {},
    Start {
        readiness: Option<String>,
        /// Exact contributions observed by the human at Start. Late arrivals
        /// cannot infer inclusion from clocks or network arrival order.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        participants: Vec<String>,
    },
    Pause {
        reason: String,
    },
}

impl ControlAction {
    pub fn validate(&self) -> Result<()> {
        let text = |s: &str, max| !s.trim().is_empty() && s.len() <= max && !s.contains('\0');
        let valid = match self {
            Self::UpdateInstructions { definition } => {
                definition.validate()?;
                definition.policy.is_some()
            }
            Self::SetCoordination { mode, coordinator } => {
                (mode != &Coordination::Peer || coordinator.is_none())
                    && coordinator.as_ref().is_none_or(|c| {
                        is_hash(&c.author) && text(&c.label, 120) && text(&c.runtime, 80)
                    })
            }
            Self::Handover {
                registration,
                coordinator,
                settlements,
            } => {
                is_hash(registration)
                    && is_hash(&coordinator.author)
                    && text(&coordinator.label, 120)
                    && text(&coordinator.runtime, 80)
                    && settlements.len() <= 256
                    && settlements.iter().all(|s| is_hash(s))
            }
            Self::SetPlanArtifact { revision } => is_hash(revision),
            Self::Close { reason } | Self::Archive { reason } => text(reason, 2048),
            Self::Restore {} => true,
            Self::SetPlan { text: s } => text(s, crate::limits::MAX_MESSAGE_BYTES),
            Self::Start {
                readiness,
                participants,
            } => {
                readiness.as_deref().is_none_or(is_hash)
                    && participants.len() <= crate::limits::MAX_AGENTS
                    && participants.iter().all(|id| is_hash(id))
                    && participants.windows(2).all(|w| w[0] < w[1])
            }
            Self::Pause { reason } => text(reason, 1024),
        };
        if !valid {
            return Err(Error::Invalid("mission control"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum MissionPhase {
    Preparing,
    Active,
    Paused,
    Closed,
    Archived,
}
impl MissionPhase {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Closed => "closed",
            Self::Archived => "archived",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct CoordinatorView {
    pub identity: CoordinatorIdentity,
    pub appointment: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct PlanView {
    pub artifact: Option<String>,
    pub id: String,
    pub author: String,
    pub text: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct ReadinessView {
    pub id: String,
    pub author: String,
    pub control: String,
    pub plan: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct LifecycleView {
    pub archived_from: Option<MissionPhase>,
    pub revision: String,
    pub terms_revision: String,
    pub phase: MissionPhase,
    pub coordinator: Option<CoordinatorView>,
    pub plan: Option<PlanView>,
    pub readiness: Option<ReadinessView>,
    pub pause_reason: Option<String>,
    pub start_blockers: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Projection {
    pub definition: MissionDefinition,
    pub lifecycle: LifecycleView,
}

/// Only genesis/control/Coordinator records belong here. Writer-chain and
/// membership verification precede reduction in the node store.
#[derive(Debug, Clone)]
pub struct History {
    pub root: Event,
    pub records: BTreeMap<String, Event>,
}
impl History {
    pub fn new(root: Event, records: impl IntoIterator<Item = Event>) -> Result<Self> {
        let records: BTreeMap<_, _> = records.into_iter().map(|e| (e.id.clone(), e)).collect();
        if records.len() > crate::limits::MAX_CONTROL_EVENTS {
            return Err(Error::Limit);
        }
        Ok(Self { root, records })
    }
    pub fn get(&self, id: &str) -> Result<&Event> {
        if id == self.root.id {
            return Ok(&self.root);
        }
        self.records
            .get(id)
            .ok_or(Error::Invalid("missing control dependency"))
    }
    fn initial(&self) -> Result<Projection> {
        let Payload::MissionCreated { definition, .. } = &self.root.body.payload else {
            return Err(Error::Invalid("mission root"));
        };
        Ok(Projection {
            definition: definition.clone(),
            lifecycle: LifecycleView {
                archived_from: None,
                revision: self.root.id.clone(),
                terms_revision: self.root.id.clone(),
                phase: MissionPhase::Preparing,
                coordinator: None,
                plan: None,
                readiness: None,
                pause_reason: None,
                start_blockers: vec![],
            },
        })
    }
    /// Follow explicit owner-control predecessors, never ingestion order. The
    /// chain is bounded and walked iteratively rather than through recursion.
    pub fn at(&self, revision: &str) -> Result<Projection> {
        let mut chain = Vec::new();
        let mut next = revision;
        while next != self.root.id {
            if chain.len() >= crate::limits::MAX_CONTROL_EVENTS {
                return Err(Error::Limit);
            }
            let e = self.get(next)?;
            let Payload::MissionControlled { previous, .. } = &e.body.payload else {
                return Err(Error::Invalid("control predecessor"));
            };
            if e.body.author != self.root.body.author
                || e.mission_id() != self.root.id
                || e.body.audience != "main"
            {
                return Err(Error::Invalid("owner control authority"));
            }
            chain.push(e);
            next = previous;
        }
        let mut state = self.initial()?;
        for e in chain.into_iter().rev() {
            self.apply(&mut state, e)?;
        }
        Ok(state)
    }
    fn apply(&self, p: &mut Projection, e: &Event) -> Result<()> {
        let Payload::MissionControlled { previous, action } = &e.body.payload else {
            return Err(Error::Invalid("control record"));
        };
        if previous != &p.lifecycle.revision {
            return Err(Error::Invalid("control chain"));
        }
        action.validate()?;
        if p.lifecycle.phase == MissionPhase::Archived
            && !matches!(action, ControlAction::Restore {})
        {
            return Err(Error::Invalid("archived mission is read only"));
        }
        if p.lifecycle.phase == MissionPhase::Closed
            && !matches!(action, ControlAction::Archive { .. })
        {
            return Err(Error::Invalid("closed mission"));
        }
        match action {
            ControlAction::UpdateInstructions { definition } => {
                let old = p
                    .definition
                    .policy
                    .as_ref()
                    .ok_or(Error::Invalid("missing policy"))?;
                let new = definition
                    .policy
                    .as_ref()
                    .ok_or(Error::Invalid("missing policy"))?;
                // Publishing a private mission or changing coordination requires
                // its own explicit policy transition, never an instruction edit.
                if old.participation != new.participation || old.coordination != new.coordination {
                    return Err(Error::Invalid("instruction policy change"));
                }
                p.definition = definition.clone();
                p.lifecycle.terms_revision = e.id.clone();
                p.lifecycle.phase = MissionPhase::Preparing;
                p.lifecycle.plan = None;
            }
            ControlAction::SetCoordination { mode, coordinator } => {
                let policy = p
                    .definition
                    .policy
                    .as_mut()
                    .ok_or(Error::Invalid("missing policy"))?;
                if coordinator
                    .as_ref()
                    .is_some_and(|c| c.author == self.root.body.author)
                {
                    return Err(Error::Invalid("Coordinator needs a separate identity"));
                }
                // Selecting a prepared Coordinator must not invalidate that
                // contribution's just-reviewed device terms. A mode change
                // does change participation expectations and requires review.
                if policy.coordination != *mode {
                    p.lifecycle.terms_revision = e.id.clone();
                }
                policy.coordination = mode.clone();
                p.lifecycle.coordinator = coordinator.clone().map(|identity| CoordinatorView {
                    identity,
                    appointment: e.id.clone(),
                });
                p.lifecycle.phase = MissionPhase::Preparing;
                p.lifecycle.plan = None;
            }
            ControlAction::SetPlan { text } => {
                p.lifecycle.plan = Some(PlanView {
                    artifact: None,
                    id: e.id.clone(),
                    author: e.body.author.clone(),
                    text: text.clone(),
                });
                p.lifecycle.phase = MissionPhase::Preparing;
            }
            ControlAction::Handover { coordinator, .. } => {
                if coordinator.author == self.root.body.author
                    || p.definition
                        .policy
                        .as_ref()
                        .is_none_or(|p| p.coordination != Coordination::Coordinated)
                {
                    return Err(Error::Invalid(
                        "coordinated mission and separate identity required",
                    ));
                }
                p.lifecycle.coordinator = Some(CoordinatorView {
                    identity: coordinator.clone(),
                    appointment: e.id.clone(),
                });
                p.lifecycle.phase = MissionPhase::Preparing;
                p.lifecycle.plan = None;
            }
            ControlAction::SetPlanArtifact { revision } => {
                p.lifecycle.plan = Some(PlanView {
                    id: e.id.clone(),
                    author: e.body.author.clone(),
                    text: "Artifact-backed shared plan".into(),
                    artifact: Some(revision.clone()),
                });
                p.lifecycle.phase = MissionPhase::Preparing;
            }
            ControlAction::Close { reason } => {
                p.lifecycle.phase = MissionPhase::Closed;
                p.lifecycle.pause_reason = Some(reason.clone());
            }
            ControlAction::Archive { reason } => {
                p.lifecycle.archived_from = Some(if p.lifecycle.phase == MissionPhase::Closed {
                    MissionPhase::Closed
                } else {
                    MissionPhase::Paused
                });
                p.lifecycle.phase = MissionPhase::Archived;
                p.lifecycle.pause_reason = Some(reason.clone());
            }
            ControlAction::Restore {} => {
                p.lifecycle.phase = p
                    .lifecycle
                    .archived_from
                    .take()
                    .unwrap_or(MissionPhase::Paused);
            }
            ControlAction::Start { readiness, .. } => {
                if p.lifecycle.phase == MissionPhase::Active {
                    return Err(Error::Invalid("mission already active"));
                }
                let policy = p
                    .definition
                    .policy
                    .as_ref()
                    .ok_or(Error::Invalid("missing policy"))?;
                if policy.coordination == Coordination::Coordinated {
                    let ready = self.get(
                        readiness
                            .as_deref()
                            .ok_or(Error::Invalid("Coordinator readiness required"))?,
                    )?;
                    self.check_coordinator(p, ready)?;
                    let Payload::CoordinatorReadied { control, plan } = &ready.body.payload else {
                        return Err(Error::Invalid("readiness record required"));
                    };
                    let selected = self.plan_for(p, Some(ready.body.sequence));
                    if selected.as_ref().map(|p| &p.id) != Some(plan) {
                        return Err(Error::Invalid(
                            "readiness does not confirm the current plan",
                        ));
                    }
                    p.lifecycle.plan = selected;
                    p.lifecycle.readiness = Some(ReadinessView {
                        id: ready.id.clone(),
                        author: ready.body.author.clone(),
                        control: control.clone(),
                        plan: plan.clone(),
                    });
                } else if readiness.is_some() {
                    return Err(Error::Invalid("peer mode has no Coordinator readiness"));
                }
                p.lifecycle.phase = MissionPhase::Active;
                p.lifecycle.pause_reason = None;
            }
            ControlAction::Pause { reason } => {
                if p.lifecycle.phase != MissionPhase::Active {
                    return Err(Error::Invalid("mission is not active"));
                }
                p.lifecycle.phase = MissionPhase::Paused;
                p.lifecycle.pause_reason = Some(reason.clone());
            }
        }
        if !matches!(action, ControlAction::Start { .. }) {
            p.lifecycle.readiness = None;
        }
        if p.lifecycle.phase == MissionPhase::Preparing {
            p.lifecycle.pause_reason = None;
        }
        p.lifecycle.revision = e.id.clone();
        Ok(())
    }
    pub fn check_coordinator(&self, p: &Projection, e: &Event) -> Result<()> {
        let c = p
            .lifecycle
            .coordinator
            .as_ref()
            .ok_or(Error::Invalid("no appointed Coordinator"))?;
        let control = match &e.body.payload {
            Payload::CoordinatorPlanArtifact { control, .. }
            | Payload::CoordinatorPlanned { control, .. }
            | Payload::CoordinatorReadied { control, .. } => control,
            _ => return Err(Error::Invalid("unsupported Coordinator action")),
        };
        if control != &p.lifecycle.revision
            || e.body.author != c.identity.author
            || e.body.authority.as_ref() != Some(&c.appointment)
            || e.body.audience != "main"
            || e.mission_id() != self.root.id
            || !matches!(
                p.lifecycle.phase,
                MissionPhase::Preparing | MissionPhase::Paused
            )
        {
            return Err(Error::Invalid("Coordinator epoch or control revision"));
        }
        Ok(())
    }
    pub fn plan_for(&self, p: &Projection, before: Option<u64>) -> Option<PlanView> {
        self.records
            .values()
            .filter(|e| {
                matches!(
                    e.body.payload,
                    Payload::CoordinatorPlanned { .. } | Payload::CoordinatorPlanArtifact { .. }
                ) && self.check_coordinator(p, e).is_ok()
                    && before.is_none_or(|n| e.body.sequence < n)
            })
            .max_by_key(|e| e.body.sequence)
            .and_then(|e| {
                let (text, artifact) = match &e.body.payload {
                    Payload::CoordinatorPlanned { text, .. } => (text.clone(), None),
                    Payload::CoordinatorPlanArtifact { revision, .. } => {
                        ("Artifact-backed shared plan".into(), Some(revision.clone()))
                    }
                    _ => return None,
                };
                Some(PlanView {
                    id: e.id.clone(),
                    author: e.body.author.clone(),
                    text,
                    artifact,
                })
            })
            .or_else(|| p.lifecycle.plan.clone())
    }
    pub fn current(&self) -> Result<Projection> {
        let last = self
            .records
            .values()
            .filter(|e| {
                matches!(e.body.payload, Payload::MissionControlled { .. })
                    && e.body.author == self.root.body.author
            })
            .max_by_key(|e| e.body.sequence);
        let mut p = self.at(last.map_or(&self.root.id, |e| &e.id))?;
        if p.lifecycle.phase != MissionPhase::Active {
            p.lifecycle.plan = self.plan_for(&p, None);
            p.lifecycle.readiness = self
                .records
                .values()
                .filter(|e| self.check_coordinator(&p, e).is_ok())
                .filter_map(|e| {
                    let Payload::CoordinatorReadied { control, plan } = &e.body.payload else {
                        return None;
                    };
                    (p.lifecycle.plan.as_ref().map(|p| &p.id) == Some(plan))
                        .then_some((e, control, plan))
                })
                .max_by_key(|(e, _, _)| e.body.sequence)
                .map(|(e, control, plan)| ReadinessView {
                    id: e.id.clone(),
                    author: e.body.author.clone(),
                    control: control.clone(),
                    plan: plan.clone(),
                });
        }
        p.lifecycle.start_blockers = if matches!(
            p.lifecycle.phase,
            MissionPhase::Closed | MissionPhase::Archived
        ) {
            vec![p.lifecycle.phase.as_str().into()]
        } else if p.lifecycle.phase == MissionPhase::Active {
            vec!["already_active".into()]
        } else if self.records.len() >= crate::limits::MAX_CONTROL_EVENTS - 1 {
            vec!["control_history_full".into()]
        } else if p.definition.policy.is_none() {
            vec!["unsupported_policy".into()]
        } else if p
            .definition
            .policy
            .as_ref()
            .is_some_and(|p| p.coordination == Coordination::Peer)
        {
            vec![]
        } else if p.lifecycle.coordinator.is_none() {
            vec!["coordinator_missing".into()]
        } else if p.lifecycle.plan.is_none() {
            vec!["plan_missing".into()]
        } else if p.lifecycle.readiness.is_none() {
            vec!["coordinator_not_ready".into()]
        } else {
            vec![]
        };
        Ok(p)
    }
}
