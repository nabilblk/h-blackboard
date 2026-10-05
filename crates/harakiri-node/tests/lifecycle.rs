use harakiri_node::store::Store;
use harakiri_protocol::{
    Event, EventBody, Identity, MissionDefinition, Payload,
    lifecycle::{ControlAction as Action, CoordinatorIdentity, MissionPhase},
    policy::{Coordination, MissionBudget, MissionPolicy, Participation},
};
use rand::{SeedableRng, seq::SliceRandom};

fn definition(mode: Coordination) -> MissionDefinition {
    MissionDefinition {
        name: "Prepare a community festival".into(),
        objective: "Deliver a practical plan".into(),
        scope: "Research, no purchases".into(),
        criteria: vec!["A feasible schedule".into()],
        policy: Some(MissionPolicy {
            coordination: mode,
            participation: Participation::Private,
            budget: MissionBudget::Unlimited {},
        }),
    }
}
fn command(s: &mut Store, owner: &Identity, mission: &str, action: Action) -> Event {
    let revision = s.control_state(mission).unwrap().lifecycle.revision;
    s.control(owner, mission, &revision, action).unwrap()
}
fn appoint(s: &mut Store, owner: &Identity, mission: &str, c: &Identity) -> Event {
    command(
        s,
        owner,
        mission,
        Action::SetCoordination {
            mode: Coordination::Coordinated,
            coordinator: Some(CoordinatorIdentity {
                author: c.public_key(),
                label: "Festival Coordinator".into(),
                runtime: "grok-build".into(),
            }),
        },
    )
}
fn plan(s: &mut Store, c: &Identity, mission: &str, text: &str) -> Event {
    let control = s.control_state(mission).unwrap().lifecycle.revision;
    s.append(
        c,
        mission,
        Payload::CoordinatorPlanned {
            control,
            text: text.into(),
        },
    )
    .unwrap()
}
fn ready(s: &mut Store, c: &Identity, mission: &str) -> Event {
    let p = s.control_state(mission).unwrap();
    s.append(
        c,
        mission,
        Payload::CoordinatorReadied {
            control: p.lifecycle.revision,
            plan: p.lifecycle.plan.unwrap().id,
        },
    )
    .unwrap()
}

#[test]
fn coordinator_acknowledges_exact_plan_and_only_human_starts_or_pauses() {
    let temp = tempfile::tempdir().unwrap();
    let mut s = Store::open(&temp.path().join("node.sqlite")).unwrap();
    let owner = Identity::from_seed([1; 32]);
    let m = s
        .create(
            &owner,
            "01".repeat(32),
            definition(Coordination::Coordinated),
        )
        .unwrap()
        .id;
    let c = owner
        .coordinator_identity(&m, "prepared-contribution-1")
        .unwrap();
    assert_ne!(c.public_key(), owner.public_key());
    assert_eq!(
        c.public_key(),
        owner
            .coordinator_identity(&m, "prepared-contribution-1")
            .unwrap()
            .public_key()
    );
    assert_ne!(
        c.public_key(),
        owner
            .coordinator_identity(&m, "prepared-contribution-2")
            .unwrap()
            .public_key()
    );
    assert!(
        s.control(
            &owner,
            &m,
            &m,
            Action::Start {
                readiness: None,
                participants: vec![]
            }
        )
        .is_err()
    );
    let appointment = appoint(&mut s, &owner, &m, &c);
    assert_eq!(s.control_state(&m).unwrap().lifecycle.terms_revision, m);
    assert!(
        s.append(
            &owner,
            &m,
            Payload::CoordinatorPlanned {
                control: appointment.id.clone(),
                text: "Impersonate the Coordinator".into()
            }
        )
        .is_err()
    );
    let p1 = plan(
        &mut s,
        &c,
        &m,
        "Explore two directions in Main. Tasks are optional.",
    );
    let r1 = ready(&mut s, &c, &m);
    assert!(
        s.control(
            &c,
            &m,
            &appointment.id,
            Action::Start {
                participants: vec![],
                readiness: Some(r1.id.clone())
            }
        )
        .is_err()
    );
    let p2 = plan(&mut s, &c, &m, "Use the new venue constraints.");
    assert_ne!(p1.id, p2.id);
    assert!(s.control_state(&m).unwrap().lifecycle.readiness.is_none());
    assert!(
        s.control(
            &owner,
            &m,
            &appointment.id,
            Action::Start {
                participants: vec![],
                readiness: Some(r1.id)
            }
        )
        .is_err()
    );
    let r2 = ready(&mut s, &c, &m);
    let start = command(
        &mut s,
        &owner,
        &m,
        Action::Start {
            participants: vec![],
            readiness: Some(r2.id),
        },
    );
    assert_eq!(
        s.control_state(&m).unwrap().lifecycle.phase,
        MissionPhase::Active
    );
    assert!(
        s.append(
            &c,
            &m,
            Payload::CoordinatorPlanned {
                control: start.id.clone(),
                text: "Unauthorized replan".into()
            }
        )
        .is_err()
    );
    assert!(
        s.control(
            &c,
            &m,
            &start.id,
            Action::Pause {
                reason: "Agent cannot pause globally".into()
            }
        )
        .is_err()
    );
    let pause = command(
        &mut s,
        &owner,
        &m,
        Action::Pause {
            reason: "Check the venue".into(),
        },
    );
    let paused = s.control_state(&m).unwrap();
    assert_eq!(paused.lifecycle.phase, MissionPhase::Paused);
    assert_eq!(paused.lifecycle.plan.unwrap().id, p2.id);
    assert_eq!(paused.lifecycle.readiness.as_ref().unwrap().plan, p2.id);
    assert!(paused.lifecycle.start_blockers.is_empty());
    assert!(
        s.control(
            &owner,
            &m,
            &pause.id,
            Action::Start {
                readiness: None,
                participants: vec![]
            }
        )
        .is_err()
    );
    let resumed = paused.lifecycle.readiness.unwrap();
    command(
        &mut s,
        &owner,
        &m,
        Action::Start {
            participants: vec![],
            readiness: Some(resumed.id),
        },
    );
    let mut updated = definition(Coordination::Coordinated);
    updated.scope = "A different venue; still no purchases".into();
    let edit = command(
        &mut s,
        &owner,
        &m,
        Action::UpdateInstructions {
            definition: updated.clone(),
        },
    );
    let state = s.control_state(&m).unwrap();
    assert_eq!(state.definition, updated);
    assert_eq!(state.lifecycle.terms_revision, edit.id);
    assert_eq!(state.lifecycle.phase, MissionPhase::Preparing);
    assert!(state.lifecycle.plan.is_none() && state.lifecycle.readiness.is_none());
    command(
        &mut s,
        &owner,
        &m,
        Action::SetCoordination {
            mode: Coordination::Coordinated,
            coordinator: None,
        },
    );
    assert_eq!(
        s.control_state(&m).unwrap().lifecycle.start_blockers,
        vec!["coordinator_missing"]
    );
}

#[test]
fn peer_mode_needs_only_human_start_and_never_inherits_coordinator_authority() {
    let temp = tempfile::tempdir().unwrap();
    let mut s = Store::open(&temp.path().join("node.sqlite")).unwrap();
    let owner = Identity::from_seed([1; 32]);
    let other = Identity::from_seed([2; 32]);
    let m = s
        .create(&owner, "01".repeat(32), definition(Coordination::Peer))
        .unwrap()
        .id;
    s.append(
        &owner,
        &m,
        Payload::MemberAdmitted {
            member: other.public_key(),
            endpoint: "02".repeat(32),
        },
    )
    .unwrap();
    assert!(
        s.control(
            &other,
            &m,
            &m,
            Action::Start {
                readiness: None,
                participants: vec![]
            }
        )
        .is_err()
    );
    let start = command(
        &mut s,
        &owner,
        &m,
        Action::Start {
            readiness: None,
            participants: vec![],
        },
    );
    assert!(
        s.control(
            &owner,
            &m,
            &m,
            Action::Pause {
                reason: "Stale UI".into()
            }
        )
        .is_err()
    );
    assert!(
        s.control(
            &owner,
            &m,
            &start.id,
            Action::Start {
                readiness: None,
                participants: vec![]
            }
        )
        .is_err()
    );
    command(
        &mut s,
        &owner,
        &m,
        Action::Pause {
            reason: "Owner request".into(),
        },
    );
    command(
        &mut s,
        &owner,
        &m,
        Action::Start {
            readiness: None,
            participants: vec![],
        },
    );
    command(
        &mut s,
        &owner,
        &m,
        Action::SetCoordination {
            mode: Coordination::Coordinated,
            coordinator: None,
        },
    );
    let p = s.control_state(&m).unwrap();
    assert_eq!(p.lifecycle.phase, MissionPhase::Preparing);
    assert!(
        s.control(
            &owner,
            &m,
            &p.lifecycle.revision,
            Action::Start {
                readiness: None,
                participants: vec![]
            }
        )
        .is_err()
    );
    assert!(
        s.control(
            &owner,
            &m,
            &p.lifecycle.revision,
            Action::SetCoordination {
                mode: Coordination::Coordinated,
                coordinator: Some(CoordinatorIdentity {
                    author: other.public_key(),
                    label: "Human key".into(),
                    runtime: "grok-build".into()
                })
            }
        )
        .is_err()
    );
}

#[test]
fn delayed_old_plan_never_undoes_human_start_and_shuffled_replay_converges() {
    let temp = tempfile::tempdir().unwrap();
    let owner = Identity::from_seed([1; 32]);
    let c = Identity::from_seed([2; 32]);
    let mut s = Store::open(&temp.path().join("source.sqlite")).unwrap();
    let m = s
        .create(
            &owner,
            "01".repeat(32),
            definition(Coordination::Coordinated),
        )
        .unwrap()
        .id;
    let appointment = appoint(&mut s, &owner, &m, &c);
    plan(&mut s, &c, &m, "Agreed plan");
    let r = ready(&mut s, &c, &m);
    let late = c
        .sign(EventBody {
            payload: Payload::CoordinatorPlanned {
                control: appointment.id,
                text: "In-flight old plan".into(),
            },
            previous: Some(r.id.clone()),
            sequence: r.body.sequence + 1,
            ..r.body.clone()
        })
        .unwrap();
    command(
        &mut s,
        &owner,
        &m,
        Action::Start {
            participants: vec![],
            readiness: Some(r.id),
        },
    );
    s.import(&[late.bytes().to_vec()]).unwrap();
    let active = s.control_state(&m).unwrap();
    assert_eq!(active.lifecycle.phase, MissionPhase::Active);
    assert_eq!(active.lifecycle.plan.unwrap().text, "Agreed plan");
    command(
        &mut s,
        &owner,
        &m,
        Action::Pause {
            reason: "Human pause".into(),
        },
    );
    let ack = ready(&mut s, &c, &m);
    command(
        &mut s,
        &owner,
        &m,
        Action::Start {
            participants: vec![],
            readiness: Some(ack.id),
        },
    );
    let c2 = Identity::from_seed([3; 32]);
    appoint(&mut s, &owner, &m, &c2);
    let epoch = s.control_state(&m).unwrap().lifecycle.revision;
    assert!(
        s.append(
            &c,
            &m,
            Payload::CoordinatorPlanned {
                control: epoch,
                text: "Old Coordinator".into()
            }
        )
        .is_err()
    );
    command(
        &mut s,
        &owner,
        &m,
        Action::SetPlan {
            text: "Human's explicit direction".into(),
        },
    );
    let ack = ready(&mut s, &c2, &m);
    command(
        &mut s,
        &owner,
        &m,
        Action::Start {
            participants: vec![],
            readiness: Some(ack.id),
        },
    );
    let expected = s.control_state(&m).unwrap();
    let all = s.delta(&m, &[]).unwrap();
    let mut random = rand::rngs::StdRng::seed_from_u64(20261003);
    for trial in 0..32 {
        let path = temp.path().join(format!("replica-{trial}.sqlite"));
        let mut replica = Store::open(&path).unwrap();
        let mut shuffled = all.clone();
        shuffled.extend_from_slice(&all[..3]);
        shuffled.shuffle(&mut random);
        replica.import(&shuffled).unwrap();
        assert_eq!(replica.control_state(&m).unwrap(), expected);
        drop(replica);
        assert_eq!(
            Store::open(&path).unwrap().control_state(&m).unwrap(),
            expected
        );
    }
}

#[test]
fn control_forks_freeze_start_and_cross_mission_dependencies_fail() {
    let temp = tempfile::tempdir().unwrap();
    let owner = Identity::from_seed([1; 32]);
    let mut s = Store::open(&temp.path().join("source.sqlite")).unwrap();
    let m = s
        .create(&owner, "01".repeat(32), definition(Coordination::Peer))
        .unwrap()
        .id;
    let other = s
        .create(&owner, "01".repeat(32), definition(Coordination::Peer))
        .unwrap()
        .id;
    let start = command(
        &mut s,
        &owner,
        &m,
        Action::Start {
            readiness: None,
            participants: vec![],
        },
    );
    let bad = owner
        .sign(EventBody {
            payload: Payload::MissionControlled {
                previous: other,
                action: Action::Pause {
                    reason: "Wrong mission".into(),
                },
            },
            sequence: start.body.sequence + 1,
            previous: Some(start.id.clone()),
            ..start.body.clone()
        })
        .unwrap();
    assert!(s.import(&[bad.bytes().to_vec()]).is_err());
    let fork = owner
        .sign(EventBody {
            payload: Payload::MissionControlled {
                previous: m.clone(),
                action: Action::SetPlan {
                    text: "Conflicting human direction".into(),
                },
            },
            ..start.body
        })
        .unwrap();
    s.import(&[fork.bytes().to_vec()]).unwrap();
    assert_eq!(
        s.control_state(&m).unwrap().lifecycle.start_blockers,
        vec!["control_conflict"]
    );
    assert!(
        s.control(
            &owner,
            &m,
            &m,
            Action::Start {
                readiness: None,
                participants: vec![]
            }
        )
        .is_err()
    );
}

#[test]
fn coordinator_cannot_exhaust_the_owners_pause_allowance() {
    let temp = tempfile::tempdir().unwrap();
    let owner = Identity::from_seed([1; 32]);
    let c = Identity::from_seed([2; 32]);
    let mut s = Store::open(&temp.path().join("bounded.sqlite")).unwrap();
    let m = s
        .create(
            &owner,
            "01".repeat(32),
            definition(Coordination::Coordinated),
        )
        .unwrap()
        .id;
    appoint(&mut s, &owner, &m, &c);
    for _ in 0..harakiri_protocol::limits::MAX_COORDINATOR_EVENTS - 1 {
        plan(&mut s, &c, &m, "Bounded experimental planning");
    }
    let r = ready(&mut s, &c, &m);
    let before = s.control_state(&m).unwrap();
    assert!(
        s.append(
            &c,
            &m,
            Payload::CoordinatorPlanned {
                control: before.lifecycle.revision,
                text: "Exceed allowance".into()
            }
        )
        .is_err()
    );
    command(
        &mut s,
        &owner,
        &m,
        Action::Start {
            participants: vec![],
            readiness: Some(r.id),
        },
    );
    command(
        &mut s,
        &owner,
        &m,
        Action::Pause {
            reason: "Owner can still pause".into(),
        },
    );
    command(
        &mut s,
        &owner,
        &m,
        Action::SetCoordination {
            mode: Coordination::Peer,
            coordinator: None,
        },
    );
    while s.control_history(&m).unwrap().records.len()
        < harakiri_protocol::limits::MAX_CONTROL_EVENTS - 2
    {
        command(
            &mut s,
            &owner,
            &m,
            Action::SetPlan {
                text: "Owner direction".into(),
            },
        );
    }
    command(
        &mut s,
        &owner,
        &m,
        Action::Start {
            readiness: None,
            participants: vec![],
        },
    );
    assert!(
        s.control(
            &owner,
            &m,
            &s.control_state(&m).unwrap().lifecycle.revision,
            Action::SetPlan {
                text: "Cannot consume the reserved stop slot".into()
            }
        )
        .is_err()
    );
    command(
        &mut s,
        &owner,
        &m,
        Action::Pause {
            reason: "Last available slot".into(),
        },
    );
    assert_eq!(
        s.control_state(&m).unwrap().lifecycle.phase,
        MissionPhase::Paused
    );
    assert_eq!(
        s.control_state(&m).unwrap().lifecycle.start_blockers,
        vec!["control_history_full"]
    );
}
