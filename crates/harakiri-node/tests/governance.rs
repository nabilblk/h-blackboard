use harakiri_node::store::Store;
use harakiri_protocol::{
    Event, Identity, MissionDefinition, Payload,
    agents::{AgentIdentity, AgentRole},
    governance::GovernanceAction as G,
    lifecycle::{ControlAction as C, MissionPhase},
    policy::{Coordination, MissionBudget, MissionPolicy, Participation},
};
use rand::{SeedableRng, seq::SliceRandom};
struct F {
    dir: tempfile::TempDir,
    s: Store,
    a: Identity,
    b: Identity,
    m: String,
    reg: String,
    control: String,
}

#[test]
fn stopping_remote_permission_keeps_unconfirmed_usage_reserved() {
    let mut f = F::new(true);
    let (_, grant) = f.grant();
    let reservation = f.reserve(&grant, "ac");
    assert!(
        f.s.govern(
            &f.b,
            &f.m,
            &f.control,
            G::StopGrant {
                grant: grant.clone(),
                reason: "Contributor cannot impersonate owner".into()
            }
        )
        .is_err()
    );
    f.owner(G::StopGrant {
        grant: grant.clone(),
        reason: "Owner ended the contribution".into(),
    });
    let ledger = f.s.governance(&f.m, &f.a.public_key()).unwrap();
    let g = ledger.grants.iter().find(|g| g.id == grant).unwrap();
    assert!(g.revoked);
    assert!(!g.sealed);
    assert_eq!(g.reserved, 1);
    assert!(g.risk_accepted.is_none());
    assert!(
        f.s.govern(
            &f.b,
            &f.m,
            &f.control,
            G::Reserve {
                grant: grant.clone(),
                consent: g.consent.clone().unwrap(),
                nonce: "ad".repeat(32)
            }
        )
        .is_err()
    );
    let receipt = f.peer(G::Receipt {
        reservation: reservation.id,
        used: Some(1),
        stopped: true,
        summary: "Confirmed termination".into(),
    });
    f.peer(G::SealGrant {
        grant,
        settlements: vec![receipt.id],
    });
    let ledger = f.s.governance(&f.m, &f.a.public_key()).unwrap();
    assert!(ledger.grants[0].sealed);
    assert_eq!(ledger.grants[0].reserved, 0);
}

#[test]
fn planning_is_bounded_to_the_appointed_coordinator_and_does_not_start_workers() {
    use harakiri_protocol::{governance::GrantPurpose, lifecycle::CoordinatorIdentity};
    let mut f = F::new(true);
    f.control =
        f.s.control(
            &f.a,
            &f.m,
            &f.control,
            C::SetCoordination {
                mode: Coordination::Coordinated,
                coordinator: None,
            },
        )
        .unwrap()
        .id;
    let terms = f.control.clone();
    let coordinator = Identity::from_seed([113; 32]);
    let identity = AgentIdentity {
        author: coordinator.public_key(),
        label: "Planner".into(),
        runtime: "grok".into(),
        role: AgentRole::Coordinator,
        contributor_name: "Contributor".into(),
    };
    let reg =
        f.s.offer_agent(&f.b, &f.m, &terms, identity.clone())
            .unwrap()
            .id;
    let worker =
        f.s.offer_agent(
            &f.b,
            &f.m,
            &terms,
            AgentIdentity {
                author: Identity::from_seed([114; 32]).public_key(),
                role: AgentRole::Agent,
                ..identity.clone()
            },
        )
        .unwrap()
        .id;
    let allocation = f
        .owner(G::Allocate {
            node: f.b.public_key(),
            turns: Some(8),
            slots: 1,
        })
        .id;
    let expires_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 600_000;
    let mut grant = G::Grant {
        purpose: GrantPurpose::Planning,
        previous: None,
        allocation,
        registration: reg.clone(),
        direction: f.control.clone(),
        execution: "ab".repeat(32),
        generation: 1,
        turns: 2,
        expires_ms,
        offline_ms: 300_000,
    };
    assert!(
        f.s.govern(&f.a, &f.m, &f.control, grant.clone()).is_err(),
        "unappointed Coordinator cannot run"
    );
    f.control =
        f.s.control(
            &f.a,
            &f.m,
            &f.control,
            C::SetCoordination {
                mode: Coordination::Coordinated,
                coordinator: Some(CoordinatorIdentity {
                    author: coordinator.public_key(),
                    label: "Planner".into(),
                    runtime: "grok".into(),
                }),
            },
        )
        .unwrap()
        .id;
    if let G::Grant { direction, .. } = &mut grant {
        *direction = f.control.clone();
    }
    for invalid in [0, 1, 2] {
        let mut wrong = grant.clone();
        if let G::Grant {
            purpose,
            registration,
            turns,
            ..
        } = &mut wrong
        {
            match invalid {
                0 => *purpose = GrantPurpose::Work,
                1 => *registration = worker.clone(),
                _ => *turns = 9,
            }
        }
        assert!(f.s.govern(&f.a, &f.m, &f.control, wrong).is_err());
    }
    let permission = f.owner(grant);
    let consent = f.peer(G::Consent {
        grant: permission.id.clone(),
        binding: "cd".repeat(32),
    });
    f.reg = reg;
    let reserved = f.reserve(&permission.id, "de");
    let plan =
        f.s.append(
            &coordinator,
            &f.m,
            Payload::CoordinatorPlanned {
                control: f.control.clone(),
                text: "Discuss scope and prepare optional experiments".into(),
            },
        )
        .unwrap();
    let ready =
        f.s.append(
            &coordinator,
            &f.m,
            Payload::CoordinatorReadied {
                control: f.control.clone(),
                plan: plan.id,
            },
        )
        .unwrap();
    assert_eq!(
        f.s.control_state(&f.m).unwrap().lifecycle.phase,
        MissionPhase::Preparing
    );
    assert!(
        f.s.agent_views(&f.m)
            .unwrap()
            .iter()
            .find(|a| a.id == worker)
            .unwrap()
            .direction
            .is_none()
    );
    f.peer(G::Receipt {
        reservation: reserved.id,
        used: Some(1),
        stopped: true,
        summary: "Planning process terminated".into(),
    });
    f.control =
        f.s.control(
            &f.a,
            &f.m,
            &f.control,
            C::Start {
                readiness: Some(ready.id),
                participants: vec![f.reg.clone(), worker]
                    .into_iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .into_iter()
                    .collect(),
            },
        )
        .unwrap()
        .id;
    assert!(
        f.s.govern(
            &f.b,
            &f.m,
            &f.control,
            G::Reserve {
                grant: permission.id.clone(),
                consent: consent.id,
                nonce: "ef".repeat(32)
            }
        )
        .is_err(),
        "planning permission cannot become a working permission"
    );
    let view = f.s.governance(&f.m, &f.a.public_key()).unwrap();
    let g = &view.grants[0];
    assert_eq!(g.purpose, GrantPurpose::Planning);
    assert_eq!(g.issued_ms, permission.body.created_at_ms.unwrap());
    assert_eq!(g.consent_binding.as_deref(), Some("cd".repeat(32).as_str()));
}
impl F {
    fn new(unlimited: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(&dir.path().join("db")).unwrap();
        let a = Identity::from_seed([51; 32]);
        let b = Identity::from_seed([52; 32]);
        let m = s
            .create(
                &a,
                "51".repeat(32),
                MissionDefinition {
                    name: "Ledger proof".into(),
                    objective: "Coordinate without double spending".into(),
                    scope: "No execution".into(),
                    criteria: vec!["Verified result".into()],
                    policy: Some(MissionPolicy {
                        coordination: Coordination::Peer,
                        participation: Participation::Private,
                        budget: if unlimited {
                            MissionBudget::Unlimited {}
                        } else {
                            MissionBudget::Limited {
                                turns: Some(4),
                                concurrency: Some(1),
                                deadline_ms: None,
                                tokens: None,
                                model_cost_microusd: None,
                            }
                        },
                    }),
                },
            )
            .unwrap()
            .id;
        s.append(
            &a,
            &m,
            Payload::MemberAdmitted {
                member: b.public_key(),
                endpoint: "52".repeat(32),
            },
        )
        .unwrap();
        let reg = s
            .offer_agent(
                &b,
                &m,
                &m,
                AgentIdentity {
                    author: Identity::from_seed([53; 32]).public_key(),
                    label: "Agent".into(),
                    runtime: "grok".into(),
                    role: AgentRole::Agent,
                    contributor_name: "Peer".into(),
                },
            )
            .unwrap()
            .id;
        let control = s
            .control(
                &a,
                &m,
                &m,
                C::Start {
                    readiness: None,
                    participants: vec![reg.clone()],
                },
            )
            .unwrap()
            .id;
        Self {
            dir,
            s,
            a,
            b,
            m,
            reg,
            control,
        }
    }
    fn owner(&mut self, a: G) -> Event {
        self.s.govern(&self.a, &self.m, &self.control, a).unwrap()
    }
    fn peer(&mut self, a: G) -> Event {
        self.s.govern(&self.b, &self.m, &self.control, a).unwrap()
    }
    fn grant(&mut self) -> (String, String) {
        let allocation = self
            .owner(G::Allocate {
                node: self.b.public_key(),
                turns: Some(4),
                slots: 1,
            })
            .id;
        let expires = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 3600000;
        let grant = self
            .owner(G::Grant {
                purpose: Default::default(),
                previous: None,
                allocation: allocation.clone(),
                registration: self.reg.clone(),
                direction: self.control.clone(),
                execution: "aa".repeat(32),
                generation: 1,
                turns: 4,
                expires_ms: expires,
                offline_ms: 600000,
            })
            .id;
        self.peer(G::Consent {
            grant: grant.clone(),
            binding: "bb".repeat(32),
        });
        (allocation, grant)
    }
    fn reserve(&mut self, grant: &str, nonce: &str) -> Event {
        let consent = self
            .s
            .governance(&self.m, &self.a.public_key())
            .unwrap()
            .grants
            .iter()
            .find(|g| g.id == grant)
            .unwrap()
            .consent
            .clone()
            .unwrap();
        self.peer(G::Reserve {
            grant: grant.into(),
            consent,
            nonce: nonce.repeat(32),
        })
    }
}
#[test]
fn disjoint_allocations_hold_unknown_usage_until_explicit_reconciliation() {
    let mut f = F::new(false);
    let (allocation, grant) = f.grant();
    assert!(
        f.s.govern(
            &f.a,
            &f.m,
            &f.control,
            G::Allocate {
                node: f.a.public_key(),
                turns: Some(1),
                slots: 1
            }
        )
        .is_err()
    );
    let r = f.reserve(&grant, "01");
    let nonce = r.clone();
    let receipt = f.peer(G::Receipt {
        reservation: r.id.clone(),
        used: None,
        stopped: false,
        summary: "Lost contact, usage unknown".into(),
    });
    f.s.import(&[receipt.bytes().to_vec(), nonce.bytes().to_vec()])
        .unwrap();
    let v = f.s.governance(&f.m, &f.a.public_key()).unwrap();
    assert_eq!(v.allocations[0].reserved, 1);
    assert_eq!(v.allocations[0].charged, 0);
    assert!(
        f.s.govern(
            &f.b,
            &f.m,
            &f.control,
            G::SealGrant {
                grant: grant.clone(),
                settlements: vec![]
            }
        )
        .is_err()
    );
    assert!(
        f.s.control(
            &f.a,
            &f.m,
            &f.control,
            C::SetCoordination {
                mode: Coordination::Peer,
                coordinator: None
            }
        )
        .is_err()
    );
    let resolution = f.owner(G::Resolve {
        reservation: r.id,
        reason: "Accept the uncertainty and charge the full reserved turn".into(),
    });
    assert!(
        f.s.govern(
            &f.a,
            &f.m,
            &f.control,
            G::Resolve {
                reservation: nonce.id,
                reason: "duplicate".into()
            }
        )
        .is_err()
    );
    let closed = f.peer(G::SealGrant {
        grant: grant.clone(),
        settlements: vec![resolution.id],
    });
    let seal_action = G::SealAllocation {
        allocation,
        grants: vec![closed.id],
    };
    let sealed = f.peer(seal_action.clone());
    assert!(
        f.s.govern(&f.b, &f.m, &f.control, seal_action).is_err(),
        "duplicate seals must not exhaust recovery capacity"
    );
    f.owner(G::Reclaim { seal: sealed.id });
    // Of the original four turns only three can be transferred; uncertainty cost one.
    f.owner(G::Allocate {
        node: f.a.public_key(),
        turns: Some(3),
        slots: 1,
    });
    assert!(
        f.s.govern(
            &f.a,
            &f.m,
            &f.control,
            G::Allocate {
                node: f.a.public_key(),
                turns: Some(1),
                slots: 1
            }
        )
        .is_err()
    );
    let before = serde_json::to_value(f.s.governance(&f.m, &f.a.public_key()).unwrap()).unwrap();
    let all = f.s.delta(&f.m, &[]).unwrap();
    for seed in 0..16 {
        let mut other = Store::open(&f.dir.path().join(format!("replay-{seed}"))).unwrap();
        let mut input = all.clone();
        input.extend(all.clone());
        input.shuffle(&mut rand::rngs::StdRng::seed_from_u64(seed));
        other.import(&input).unwrap();
        assert_eq!(
            serde_json::to_value(other.governance(&f.m, &f.a.public_key()).unwrap()).unwrap(),
            before
        );
        drop(other);
        let other = Store::open(&f.dir.path().join(format!("replay-{seed}"))).unwrap();
        assert_eq!(
            serde_json::to_value(other.governance(&f.m, &f.a.public_key()).unwrap()).unwrap(),
            before
        );
    }
}
#[test]
fn unlimited_still_requires_current_consent_direction_and_nonduplicate_generations() {
    let mut f = F::new(true);
    let (_, grant) = f.grant();
    let r = f.reserve(&grant, "02");
    let consent = f.s.governance(&f.m, &f.a.public_key()).unwrap().grants[0]
        .consent
        .clone()
        .unwrap();
    assert!(
        f.s.govern(
            &f.a,
            &f.m,
            &f.control,
            G::Reserve {
                grant: grant.clone(),
                consent: consent.clone(),
                nonce: "03".repeat(32)
            }
        )
        .is_err()
    );
    assert!(
        f.s.govern(
            &f.b,
            &f.m,
            &f.control,
            G::Reserve {
                grant: grant.clone(),
                consent: consent.clone(),
                nonce: "03".repeat(32)
            }
        )
        .is_err()
    );
    f.peer(G::Receipt {
        reservation: r.id,
        used: Some(1),
        stopped: true,
        summary: "Attributed fixture receipt, no model".into(),
    });
    assert!(
        f.s.govern(
            &f.b,
            &f.m,
            &f.control,
            G::Reserve {
                grant: grant.clone(),
                consent: consent.clone(),
                nonce: "02".repeat(32)
            }
        )
        .is_err()
    );
    f.reserve(&grant, "03");
    let pause =
        f.s.control(
            &f.a,
            &f.m,
            &f.control,
            C::Pause {
                reason: "Human pause".into(),
            },
        )
        .unwrap();
    f.control = pause.id;
    assert!(
        f.s.govern(
            &f.b,
            &f.m,
            &f.control,
            G::Reserve {
                grant,
                consent,
                nonce: "04".repeat(32)
            }
        )
        .is_err()
    );
    let v = f.s.governance(&f.m, &f.a.public_key()).unwrap();
    assert!(!v.execution_available);
    assert_eq!(v.allocations[0].charged, 1);
    assert_eq!(v.allocations[0].reserved, 1);
}
#[test]
fn archive_preserves_history_and_restores_paused_or_closed() {
    let mut f = F::new(true);
    let archive =
        f.s.control(
            &f.a,
            &f.m,
            &f.control,
            C::Archive {
                reason: "Keep this experiment".into(),
            },
        )
        .unwrap();
    assert!(
        f.s.send_message(&f.a, &f.m, "main", "Must not publish".into(), None, None)
            .is_err()
    );
    assert!(
        f.s.control(
            &f.a,
            &f.m,
            &archive.id,
            C::Start {
                readiness: None,
                participants: vec![]
            }
        )
        .is_err()
    );
    let restore = f.s.control(&f.a, &f.m, &archive.id, C::Restore {}).unwrap();
    assert_eq!(
        f.s.control_state(&f.m).unwrap().lifecycle.phase,
        MissionPhase::Paused
    );
    let closed =
        f.s.control(
            &f.a,
            &f.m,
            &restore.id,
            C::Close {
                reason: "Human reviewed the result".into(),
            },
        )
        .unwrap();
    let archive =
        f.s.control(
            &f.a,
            &f.m,
            &closed.id,
            C::Archive {
                reason: "File the result".into(),
            },
        )
        .unwrap();
    f.s.control(&f.a, &f.m, &archive.id, C::Restore {}).unwrap();
    assert_eq!(
        f.s.control_state(&f.m).unwrap().lifecycle.phase,
        MissionPhase::Closed
    );
}

#[test]
fn artifact_plan_and_criterion_keep_exact_revisions_and_human_authority() {
    use harakiri_protocol::artifacts::*;
    let mut f = F::new(true);
    let doc = ArtifactDocument {
        title: "Plan".into(),
        summary: "Plan with exact inputs".into(),
        kind: ArtifactKind::Plan,
        stage: ArtifactStage::Complete,
        limitations: "Fixture".into(),
        entrypoint: None,
        inputs: vec![],
        files: vec![harakiri_protocol::ArtifactFile {
            path: "plan.md".into(),
            hash: "ad".repeat(32),
            size: 4,
            media_type: "text/markdown".into(),
        }],
    };
    let first =
        f.s.artifact_action(
            &f.a,
            &f.m,
            &f.control,
            "main",
            ArtifactAction::Publish {
                artifact: None,
                parents: vec![],
                document: doc.clone(),
            },
        )
        .unwrap();
    let set =
        f.s.control(
            &f.a,
            &f.m,
            &f.control,
            C::SetPlanArtifact {
                revision: first.id.clone(),
            },
        )
        .unwrap();
    f.control = set.id;
    assert_eq!(
        f.s.control_state(&f.m)
            .unwrap()
            .lifecycle
            .plan
            .unwrap()
            .artifact,
        Some(first.id.clone())
    );
    let start =
        f.s.control(
            &f.a,
            &f.m,
            &f.control,
            C::Start {
                readiness: None,
                participants: vec![],
            },
        )
        .unwrap();
    f.control = start.id;
    f.owner(G::Criterion {
        index: 0,
        wording: "Verified result".into(),
        met: true,
        summary: "Human inspected this exact artifact".into(),
        evidence: vec![first.id.clone()],
    });
    assert!(
        f.s.govern(
            &f.b,
            &f.m,
            &f.control,
            G::Criterion {
                index: 0,
                wording: "Verified result".into(),
                met: true,
                summary: "Not the owner or Coordinator".into(),
                evidence: vec![first.id.clone()]
            }
        )
        .is_err()
    );
    assert!(f.s.governance(&f.m, &f.a.public_key()).unwrap().criteria[0].met);
    f.s.artifact_action(
        &f.a,
        &f.m,
        &f.control,
        "main",
        ArtifactAction::Publish {
            artifact: Some(first.id.clone()),
            parents: vec![first.id],
            document: doc,
        },
    )
    .unwrap();
    let v = f.s.governance(&f.m, &f.a.public_key()).unwrap();
    assert!(v.criteria[0].stale);
    assert!(!v.criteria[0].met);
    let paused =
        f.s.control(
            &f.a,
            &f.m,
            &f.control,
            C::Pause {
                reason: "Review the new plan".into(),
            },
        )
        .unwrap();
    assert!(
        f.s.control(
            &f.a,
            &f.m,
            &paused.id,
            C::Start {
                readiness: None,
                participants: vec![]
            }
        )
        .is_err()
    );
}

#[test]
fn unreachable_grants_require_explicit_risk_and_do_not_return_allowance() {
    let mut f = F::new(false);
    let (_, grant) = f.grant();
    let retired = f.owner(G::RetireGrant {
        grant: grant.clone(),
        reason: "Owner reviewed the unavailable device and accepts duplicate-effect risk".into(),
    });
    let v = f.s.governance(&f.m, &f.a.public_key()).unwrap();
    assert!(v.handover_blockers.is_empty());
    assert!(v.grants[0].risk_accepted.is_some());
    assert!(!v.allocations[0].reclaimed);
    assert!(
        f.s.govern(
            &f.a,
            &f.m,
            &f.control,
            G::Allocate {
                node: f.a.public_key(),
                turns: Some(1),
                slots: 1
            }
        )
        .is_err()
    );
    let consent = v.grants[0].consent.clone().unwrap();
    assert!(
        f.s.govern(
            &f.b,
            &f.m,
            &f.control,
            G::Reserve {
                grant,
                consent,
                nonce: "cd".repeat(32)
            }
        )
        .is_err()
    );
    assert_eq!(v.grants[0].seal, Some(retired.id));
}

#[test]
fn schema_twelve_rebuilds_without_modifying_signed_history_and_rolls_back_corruption() {
    let mut f = F::new(true);
    f.grant();
    let all = f.s.delta(&f.m, &[]).unwrap();
    let path = f.dir.path().join("db");
    drop(f.s);
    {
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("DROP TABLE governance_records; PRAGMA user_version=11;")
            .unwrap();
    }
    let s = Store::open(&path).unwrap();
    assert_eq!(s.delta(&f.m, &[]).unwrap(), all);
    assert_eq!(
        s.governance(&f.m, &f.a.public_key()).unwrap().grants.len(),
        1
    );
    drop(s);
    {
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("DROP TABLE governance_records; PRAGMA user_version=11; UPDATE events SET bytes=x'ff' WHERE rowid=(SELECT max(rowid) FROM events);").unwrap();
    }
    assert!(Store::open(&path).is_err());
    let db = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
            .unwrap(),
        11
    );
}

#[test]
fn local_allowance_is_stricter_than_unlimited_mission_and_retries_survive_restart() {
    use harakiri_node::governance::LocalAllowance as L;
    let mut f = F::new(true);
    let (_, grant) = f.grant();
    let consent = f.s.governance(&f.m, &f.a.public_key()).unwrap().grants[0]
        .consent
        .clone()
        .unwrap();
    let nonce = "ef".repeat(32);
    let r =
        f.s.reserve_local(
            &f.b,
            &f.m,
            &f.control,
            &f.reg,
            &grant,
            &consent,
            &nonce,
            L::Bounded {
                turns: 1,
                concurrency: 1,
                minutes: 60,
            },
        )
        .unwrap();
    let retry =
        f.s.reserve_local(
            &f.b,
            &f.m,
            &f.control,
            &f.reg,
            &grant,
            &consent,
            &nonce,
            L::Bounded {
                turns: 1,
                concurrency: 1,
                minutes: 60,
            },
        )
        .unwrap();
    assert_eq!(retry.id, r.id);
    f.peer(G::Receipt {
        reservation: r.id,
        used: Some(1),
        stopped: true,
        summary: "Attributed local test receipt".into(),
    });
    let path = f.dir.path().join("db");
    drop(f.s);
    f.s = Store::open(&path).unwrap();
    assert!(
        f.s.reserve_local(
            &f.b,
            &f.m,
            &f.control,
            &f.reg,
            &grant,
            &consent,
            &"fe".repeat(32),
            L::Bounded {
                turns: 1,
                concurrency: 1,
                minutes: 60
            }
        )
        .is_err()
    );
    assert!(
        f.s.reserve_local(
            &f.a,
            &f.m,
            &f.control,
            &f.reg,
            &grant,
            &consent,
            &"fe".repeat(32),
            L::Unlimited { concurrency: 1 }
        )
        .is_err()
    );
}

#[test]
fn forty_concurrent_workstream_heads_can_be_reconciled_without_discarding_branches() {
    use harakiri_protocol::work::WorkAction as W;
    let mut f = F::new(true);
    let mut agents = Vec::new();
    let mut registrations = Vec::new();
    for i in 61..101 {
        let a = Identity::from_seed([i; 32]);
        let r =
            f.s.offer_agent(
                &f.b,
                &f.m,
                &f.m,
                AgentIdentity {
                    author: a.public_key(),
                    label: format!("Explorer {i}"),
                    runtime: "grok".into(),
                    role: AgentRole::Agent,
                    contributor_name: "Peer".into(),
                },
            )
            .unwrap();
        registrations.push(r.id);
        agents.push(a);
    }
    let pause =
        f.s.control(
            &f.a,
            &f.m,
            &f.control,
            C::Pause {
                reason: "Include preparations".into(),
            },
        )
        .unwrap();
    registrations.push(f.reg.clone());
    registrations.sort();
    f.control =
        f.s.control(
            &f.a,
            &f.m,
            &pause.id,
            C::Start {
                readiness: None,
                participants: registrations,
            },
        )
        .unwrap()
        .id;
    let stream =
        f.s.work(
            &f.a,
            &f.m,
            &f.control,
            W::CreateWorkstream {
                name: "Options".into(),
                goal: "Explore directions".into(),
            },
        )
        .unwrap()
        .id;
    let baseline = f.s.delta(&f.m, &[]).unwrap();
    let mut branches = Vec::new();
    for (index, agent) in agents.iter().enumerate() {
        let mut peer = Store::open(&f.dir.path().join(format!("branch-{index}"))).unwrap();
        peer.import(&baseline).unwrap();
        let e = peer
            .work(
                agent,
                &f.m,
                &f.control,
                W::ReviseWorkstream {
                    workstream: stream.clone(),
                    bases: vec![stream.clone()],
                    name: "Options".into(),
                    goal: format!("Independent proposal {index}"),
                },
            )
            .unwrap();
        branches.push(e.bytes().to_vec());
    }
    f.s.import(&branches).unwrap();
    let streams = f.s.workstreams(&f.m, &f.a.public_key()).unwrap();
    assert_eq!(streams[0].heads.len(), 40);
    f.s.work(
        &f.a,
        &f.m,
        &f.control,
        W::ReviseWorkstream {
            workstream: stream,
            bases: streams[0].heads.iter().map(|h| h.id.clone()).collect(),
            name: "Options".into(),
            goal: "Reconciled proposals with all predecessors retained".into(),
        },
    )
    .unwrap();
    assert_eq!(
        f.s.workstreams(&f.m, &f.a.public_key()).unwrap()[0]
            .heads
            .len(),
        1
    );
    for branch in branches {
        assert!(
            f.s.event(&Event::verify(&branch).unwrap().id)
                .unwrap()
                .is_some()
        );
    }
}

#[test]
fn handover_fences_the_old_coordinator_and_needs_new_readiness() {
    use harakiri_protocol::lifecycle::CoordinatorIdentity;
    let mut f = F::new(true);
    f.control =
        f.s.control(
            &f.a,
            &f.m,
            &f.control,
            C::SetCoordination {
                mode: Coordination::Coordinated,
                coordinator: None,
            },
        )
        .unwrap()
        .id;
    let terms = f.control.clone();
    let ca = Identity::from_seed([111; 32]);
    let cb = Identity::from_seed([112; 32]);
    let mut regs = Vec::new();
    for (human, key, label) in [
        (&f.a, &ca, "First Coordinator"),
        (&f.b, &cb, "Next Coordinator"),
    ] {
        regs.push(
            f.s.offer_agent(
                human,
                &f.m,
                &terms,
                AgentIdentity {
                    author: key.public_key(),
                    label: label.into(),
                    runtime: "grok".into(),
                    role: AgentRole::Coordinator,
                    contributor_name: "Fixture contributor".into(),
                },
            )
            .unwrap()
            .id,
        );
    }
    f.control =
        f.s.control(
            &f.a,
            &f.m,
            &f.control,
            C::SetCoordination {
                mode: Coordination::Coordinated,
                coordinator: Some(CoordinatorIdentity {
                    author: ca.public_key(),
                    label: "First Coordinator".into(),
                    runtime: "grok".into(),
                }),
            },
        )
        .unwrap()
        .id;
    let plan =
        f.s.append(
            &ca,
            &f.m,
            Payload::CoordinatorPlanned {
                control: f.control.clone(),
                text: "Prepare the event".into(),
            },
        )
        .unwrap();
    let ready =
        f.s.append(
            &ca,
            &f.m,
            Payload::CoordinatorReadied {
                control: f.control.clone(),
                plan: plan.id,
            },
        )
        .unwrap();
    let first_registration = regs[0].clone();
    let next_registration = regs[1].clone();
    regs.sort();
    f.control =
        f.s.control(
            &f.a,
            &f.m,
            &f.control,
            C::Start {
                readiness: Some(ready.id.clone()),
                participants: regs,
            },
        )
        .unwrap()
        .id;
    let alloc = f.owner(G::Allocate {
        node: f.a.public_key(),
        turns: None,
        slots: 1,
    });
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 3600000;
    let grant = f.owner(G::Grant {
        purpose: Default::default(),
        previous: None,
        allocation: alloc.id,
        registration: first_registration,
        direction: f.control.clone(),
        execution: "dd".repeat(32),
        generation: 1,
        turns: 10,
        expires_ms: expires,
        offline_ms: 600000,
    });
    let target = CoordinatorIdentity {
        author: cb.public_key(),
        label: "Next Coordinator".into(),
        runtime: "grok".into(),
    };
    assert!(
        f.s.control(
            &f.a,
            &f.m,
            &f.control,
            C::Handover {
                registration: next_registration.clone(),
                coordinator: target.clone(),
                settlements: vec![]
            }
        )
        .is_err()
    );
    let seal = f.owner(G::SealGrant {
        grant: grant.id,
        settlements: vec![],
    });
    f.control =
        f.s.control(
            &f.a,
            &f.m,
            &f.control,
            C::Handover {
                registration: next_registration.clone(),
                coordinator: target,
                settlements: vec![seal.id],
            },
        )
        .unwrap()
        .id;
    assert_eq!(
        f.s.control_state(&f.m).unwrap().lifecycle.phase,
        MissionPhase::Preparing
    );
    assert!(
        f.s.append(
            &ca,
            &f.m,
            Payload::CoordinatorPlanned {
                control: f.control.clone(),
                text: "Old authority".into()
            }
        )
        .is_err()
    );
    assert!(
        f.s.control(
            &f.a,
            &f.m,
            &f.control,
            C::Start {
                readiness: Some(ready.id),
                participants: vec![]
            }
        )
        .is_err()
    );
    let plan =
        f.s.append(
            &cb,
            &f.m,
            Payload::CoordinatorPlanned {
                control: f.control.clone(),
                text: "New reviewed plan".into(),
            },
        )
        .unwrap();
    let ready =
        f.s.append(
            &cb,
            &f.m,
            Payload::CoordinatorReadied {
                control: f.control.clone(),
                plan: plan.id,
            },
        )
        .unwrap();
    f.s.control(
        &f.a,
        &f.m,
        &f.control,
        C::Start {
            readiness: Some(ready.id),
            participants: vec![],
        },
    )
    .unwrap();
    assert_eq!(
        f.s.control_state(&f.m).unwrap().lifecycle.phase,
        MissionPhase::Active
    );
    let expected = serde_json::to_value(f.s.control_state(&f.m).unwrap()).unwrap();
    let all = f.s.delta(&f.m, &[]).unwrap();
    for seed in 0..8 {
        let mut peer = Store::open(&f.dir.path().join(format!("handover-{seed}"))).unwrap();
        let mut records = all.clone();
        records.shuffle(&mut rand::rngs::StdRng::seed_from_u64(seed));
        peer.import(&records).unwrap();
        assert_eq!(
            serde_json::to_value(peer.control_state(&f.m).unwrap()).unwrap(),
            expected
        );
    }
}

#[test]
fn directions_invalidate_permissions_and_replacement_needs_an_exact_seal() {
    let mut f = F::new(true);
    let (_, grant) = f.grant();
    let payload = f.s.event(&grant).unwrap().unwrap().body.payload;
    let Payload::GovernanceRecorded {
        action: mut replacement,
        ..
    } = payload
    else {
        panic!("permission")
    };
    if let G::Grant { execution, .. } = &mut replacement {
        *execution = "ed".repeat(32);
    }
    assert!(
        f.s.govern(&f.a, &f.m, &f.control, replacement.clone())
            .is_err(),
        "a new execution ID must not bypass outstanding work"
    );
    let changed =
        f.s.direct_agent(
            &f.a,
            &f.m,
            &f.control,
            &f.reg,
            "Explore the new venue instead".into(),
        )
        .unwrap();
    let consent = f.s.governance(&f.m, &f.a.public_key()).unwrap().grants[0]
        .consent
        .clone()
        .unwrap();
    assert!(
        f.s.govern(
            &f.b,
            &f.m,
            &f.control,
            G::Reserve {
                grant: grant.clone(),
                consent,
                nonce: "ea".repeat(32)
            }
        )
        .is_err(),
        "the old permission must not start a turn after observed redirection"
    );
    let seal = f.peer(G::SealGrant {
        grant,
        settlements: vec![],
    });
    if let G::Grant {
        previous,
        direction,
        ..
    } = &mut replacement
    {
        *previous = Some(seal.id);
        *direction = changed.id;
    }
    let replacement = f.owner(replacement);
    assert_eq!(
        f.s.governance(&f.m, &f.a.public_key())
            .unwrap()
            .grants
            .last()
            .unwrap()
            .id,
        replacement.id,
        "permissions stay in owner order so renewal selects the latest seal"
    );
}
