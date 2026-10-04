use harakiri_node::store::Store;
use harakiri_protocol::{
    Event, Identity, MissionDefinition, Payload,
    agents::{AgentIdentity, AgentRole, AgentStatus},
    lifecycle::{ControlAction, CoordinatorIdentity},
    policy::{Coordination, MissionBudget, MissionPolicy, Participation},
};
use rand::{SeedableRng, seq::SliceRandom};

fn definition(mode: Coordination) -> MissionDefinition {
    MissionDefinition {
        name: "Festival".into(),
        objective: "An accessible festival".into(),
        scope: "Research only".into(),
        criteria: vec![],
        policy: Some(MissionPolicy {
            coordination: mode,
            participation: Participation::Private,
            budget: MissionBudget::Unlimited {},
        }),
    }
}
fn command(s: &mut Store, owner: &Identity, mission: &str, action: ControlAction) -> Event {
    let revision = s.control_state(mission).unwrap().lifecycle.revision;
    s.control(owner, mission, &revision, action).unwrap()
}
fn descriptor(author: &Identity, label: &str) -> AgentIdentity {
    AgentIdentity {
        author: author.public_key(),
        label: label.into(),
        runtime: "grok".into(),
        role: AgentRole::Agent,
        contributor_name: "Contributor".into(),
    }
}
fn offer(s: &mut Store, owner: &Identity, mission: &str, label: &str) -> Event {
    let terms = s.control_state(mission).unwrap().lifecycle.terms_revision;
    let agent = owner.coordinator_identity(mission, label).unwrap();
    s.offer_agent(owner, mission, &terms, descriptor(&agent, label))
        .unwrap()
}
fn start(s: &mut Store, owner: &Identity, mission: &str) -> Event {
    let state = s.control_state(mission).unwrap();
    let participants = s.start_participants(mission).unwrap();
    command(
        s,
        owner,
        mission,
        ControlAction::Start {
            readiness: state.lifecycle.readiness.map(|r| r.id),
            participants,
        },
    )
}
fn view(s: &Store, m: &str, id: &str) -> harakiri_protocol::agents::AgentView {
    s.agent_views(m)
        .unwrap()
        .into_iter()
        .find(|v| v.id == id)
        .unwrap()
}

#[test]
fn exact_start_snapshot_late_direction_and_human_precedence_survive_reordering() {
    let temp = tempfile::tempdir().unwrap();
    let mut s = Store::open(&temp.path().join("a.sqlite")).unwrap();
    let owner = Identity::from_seed([1; 32]);
    let contributor = Identity::from_seed([2; 32]);
    let coordinator = Identity::from_seed([3; 32]);
    let root = s
        .create(
            &owner,
            "01".repeat(32),
            definition(Coordination::Coordinated),
        )
        .unwrap();
    let m = &root.id;
    let mut history = vec![root.bytes().to_vec()];
    let admitted = s
        .append(
            &owner,
            m,
            Payload::MemberAdmitted {
                member: contributor.public_key(),
                endpoint: "02".repeat(32),
            },
        )
        .unwrap();
    history.push(admitted.bytes().to_vec());
    let appointment = command(
        &mut s,
        &owner,
        m,
        ControlAction::SetCoordination {
            mode: Coordination::Coordinated,
            coordinator: Some(CoordinatorIdentity {
                author: coordinator.public_key(),
                label: "Coordinator".into(),
                runtime: "grok".into(),
            }),
        },
    );
    history.push(appointment.bytes().to_vec());
    let plan = s
        .append(
            &coordinator,
            m,
            Payload::CoordinatorPlanned {
                control: appointment.id.clone(),
                text: "Research in Main".into(),
            },
        )
        .unwrap();
    history.push(plan.bytes().to_vec());
    let ready = s
        .append(
            &coordinator,
            m,
            Payload::CoordinatorReadied {
                control: appointment.id.clone(),
                plan: plan.id,
            },
        )
        .unwrap();
    history.push(ready.bytes().to_vec());
    let early = offer(&mut s, &contributor, m, "Accessibility");
    history.push(early.bytes().to_vec());
    assert_eq!(view(&s, m, &early.id).status, AgentStatus::WaitingForStart);
    let begun = start(&mut s, &owner, m);
    history.push(begun.bytes().to_vec());
    assert_eq!(
        view(&s, m, &early.id).status,
        AgentStatus::DirectionAssigned
    );
    let late = offer(&mut s, &contributor, m, "Schedule");
    history.push(late.bytes().to_vec());
    assert_eq!(
        view(&s, m, &late.id).status,
        AgentStatus::WaitingForDirection
    );
    assert!(
        s.direct_agent(&contributor, m, &begun.id, &late.id, "Self-assign".into())
            .is_err()
    );
    let assigned = s
        .direct_agent(
            &coordinator,
            m,
            &begun.id,
            &late.id,
            "Check transport".into(),
        )
        .unwrap();
    history.push(assigned.bytes().to_vec());
    let repeated = s
        .direct_agent(
            &coordinator,
            m,
            &begun.id,
            &late.id,
            "Check transport".into(),
        )
        .unwrap();
    assert_eq!(repeated.id, assigned.id);
    assert_eq!(view(&s, m, &late.id).direction.unwrap().id, assigned.id);
    let human = s
        .direct_agent(
            &owner,
            m,
            &begun.id,
            &late.id,
            "Focus on accessibility first".into(),
        )
        .unwrap();
    history.push(human.bytes().to_vec());
    let conflicting = s
        .direct_agent(
            &coordinator,
            m,
            &begun.id,
            &late.id,
            "Ignore that and check pricing".into(),
        )
        .unwrap();
    history.push(conflicting.bytes().to_vec());
    assert_eq!(view(&s, m, &late.id).direction.unwrap().id, human.id);
    let expected = serde_json::to_value(s.agent_views(m).unwrap()).unwrap();
    let mut rng = rand::rngs::StdRng::seed_from_u64(91);
    for trial in 0..16 {
        let path = temp.path().join(format!("reordered-{trial}.sqlite"));
        let mut replica = Store::open(&path).unwrap();
        let mut shuffled = history.clone();
        shuffled.extend(history.iter().take(4).cloned());
        shuffled.shuffle(&mut rng);
        replica.import(&shuffled).unwrap();
        drop(replica);
        let replica = Store::open(&path).unwrap();
        assert_eq!(
            serde_json::to_value(replica.agent_views(m).unwrap()).unwrap(),
            expected
        );
    }
    command(
        &mut s,
        &owner,
        m,
        ControlAction::Pause {
            reason: "Review".into(),
        },
    );
    assert_eq!(view(&s, m, &late.id).status, AgentStatus::Paused);
    assert!(
        s.direct_agent(&owner, m, &begun.id, &late.id, "Stale control".into())
            .is_err()
    );
}

#[test]
fn current_terms_withdrawal_revocation_and_identity_collisions_never_imply_work() {
    let temp = tempfile::tempdir().unwrap();
    let mut s = Store::open(&temp.path().join("node.sqlite")).unwrap();
    let owner = Identity::from_seed([1; 32]);
    let contributor = Identity::from_seed([2; 32]);
    let m = s
        .create(&owner, "01".repeat(32), definition(Coordination::Peer))
        .unwrap()
        .id;
    s.append(
        &owner,
        &m,
        Payload::MemberAdmitted {
            member: contributor.public_key(),
            endpoint: "02".repeat(32),
        },
    )
    .unwrap();
    start(&mut s, &owner, &m);
    let a = offer(&mut s, &contributor, &m, "Peer researcher");
    assert_eq!(view(&s, &m, &a.id).status, AgentStatus::DirectionAssigned);
    assert_eq!(offer(&mut s, &contributor, &m, "Peer researcher").id, a.id);
    assert!(s.withdraw_agent(&owner, &m, &a.id).is_err());
    let w = s.withdraw_agent(&contributor, &m, &a.id).unwrap();
    assert_eq!(s.withdraw_agent(&contributor, &m, &a.id).unwrap().id, w.id);
    assert_eq!(view(&s, &m, &a.id).status, AgentStatus::Withdrawn);
    let b = offer(&mut s, &contributor, &m, "Another researcher");
    let stale_terms = s.control_state(&m).unwrap().lifecycle.terms_revision;
    let mut changed = definition(Coordination::Peer);
    changed.scope = "Different venue".into();
    command(
        &mut s,
        &owner,
        &m,
        ControlAction::UpdateInstructions {
            definition: changed,
        },
    );
    assert_eq!(view(&s, &m, &b.id).status, AgentStatus::ReviewRequired);
    assert!(s.start_participants(&m).unwrap().is_empty());
    assert!(
        s.offer_agent(
            &contributor,
            &m,
            &stale_terms,
            descriptor(&Identity::from_seed([8; 32]), "Stale")
        )
        .is_err()
    );
    let control = s.control_state(&m).unwrap().lifecycle.revision;
    assert!(
        s.append(
            &contributor,
            &m,
            Payload::AgentOffered {
                control: control.clone(),
                identity: descriptor(&owner, "Human key")
            }
        )
        .is_err()
    );
    let key = Identity::from_seed([9; 32]);
    let first = s
        .append(
            &contributor,
            &m,
            Payload::AgentOffered {
                control: control.clone(),
                identity: descriptor(&key, "One"),
            },
        )
        .unwrap();
    s.append(
        &owner,
        &m,
        Payload::AgentOffered {
            control,
            identity: descriptor(&key, "Two"),
        },
    )
    .unwrap();
    assert_eq!(view(&s, &m, &first.id).status, AgentStatus::Conflict);
    let accepted = s.head(&m, &contributor.public_key()).unwrap().map(|h| h.id);
    s.append(
        &owner,
        &m,
        Payload::MemberRevoked {
            member: contributor.public_key(),
            accepted,
        },
    )
    .unwrap();
    assert_eq!(view(&s, &m, &b.id).status, AgentStatus::Revoked);
}

#[test]
fn roster_pages_are_bounded_and_private_paths_are_absent() {
    let temp = tempfile::tempdir().unwrap();
    let mut s = Store::open(&temp.path().join("node.sqlite")).unwrap();
    let owner = Identity::from_seed([1; 32]);
    let m = s
        .create(&owner, "01".repeat(32), definition(Coordination::Peer))
        .unwrap()
        .id;
    for n in 0..70 {
        offer(&mut s, &owner, &m, &format!("Researcher {n}"));
    }
    let p = s.agent_page(&m, None).unwrap();
    assert_eq!(p.total, 70);
    assert_eq!(p.items.len(), 64);
    let tail = s.agent_page(&m, p.after).unwrap();
    assert_eq!(tail.items.len(), 6);
    assert!(tail.after.is_none());
    assert!(
        !p.items
            .iter()
            .any(|a| tail.items.iter().any(|b| a.id == b.id))
    );
    let json = serde_json::to_string(&tail).unwrap();
    for private in ["workspace", "credential", "contributionId", "limits"] {
        assert!(!json.contains(private));
    }
    assert!(s.agent_page(&m, Some("invalid".into())).is_err());
}

#[test]
fn schema_eight_rebuild_is_atomic_and_keeps_signed_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("node.sqlite");
    let owner = Identity::from_seed([1; 32]);
    let mut s = Store::open(&path).unwrap();
    let m = s
        .create(&owner, "01".repeat(32), definition(Coordination::Peer))
        .unwrap()
        .id;
    let offer = offer(&mut s, &owner, &m, "Persistent");
    drop(s);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("DROP TABLE governance_records; DROP TABLE available_files; DROP TABLE artifact_records; DROP TABLE work_records; DROP TABLE message_reads; DROP TABLE message_details; DROP TABLE agent_registry; DROP TABLE agent_records; PRAGMA user_version=7;")
        .unwrap();
    drop(db);
    let s = Store::open(&path).unwrap();
    assert_eq!(s.event(&offer.id).unwrap().unwrap().bytes(), offer.bytes());
    assert_eq!(s.agent_page(&m, None).unwrap().total, 1);
    drop(s);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("DROP TABLE governance_records; DROP TABLE available_files; DROP TABLE artifact_records; DROP TABLE work_records; DROP TABLE message_reads; DROP TABLE message_details; DROP TABLE agent_registry; DROP TABLE agent_records; PRAGMA user_version=7;")
        .unwrap();
    db.execute(
        "UPDATE events SET bytes=?1 WHERE id=?2",
        rusqlite::params![vec![0u8], offer.id],
    )
    .unwrap();
    drop(db);
    assert!(Store::open(&path).is_err());
    let db = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
            .unwrap(),
        7
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='agent_records'",
            [],
            |r| r.get::<_, u32>(0)
        )
        .unwrap(),
        0
    );
}
