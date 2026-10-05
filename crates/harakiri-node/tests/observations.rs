use harakiri_node::{
    observations::{Observation, ObservedState},
    store::Store,
};
use harakiri_protocol::{
    Identity, MissionDefinition,
    agents::{AgentIdentity, AgentRole},
    policy::{Coordination, MissionBudget, MissionPolicy, Participation},
};
const DOMAIN: &[u8] = b"harakiri/execution-observation/1";
#[test]
fn reports_require_contributor_signature_current_scope_and_freshness_without_changing_history() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(&dir.path().join("node.sqlite")).unwrap();
    let owner = Identity::from_seed([201; 32]);
    let stranger = Identity::from_seed([202; 32]);
    let root = s
        .create(
            &owner,
            "01".repeat(32),
            MissionDefinition {
                name: "Observation fixture".into(),
                objective: "Temporary report".into(),
                scope: "No execution".into(),
                criteria: vec![],
                policy: Some(MissionPolicy {
                    coordination: Coordination::Peer,
                    participation: Participation::Private,
                    budget: MissionBudget::Unlimited {},
                }),
            },
        )
        .unwrap();
    let identity = AgentIdentity {
        author: Identity::from_seed([203; 32]).public_key(),
        label: "Fixture".into(),
        role: AgentRole::Agent,
        runtime: "grok".into(),
        contributor_name: "Owner".into(),
    };
    let offered = s.offer_agent(&owner, &root.id, &root.id, identity).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let report = Observation {
        mission: root.id.clone(),
        registration: offered.id.clone(),
        control: root.id.clone(),
        grant: None,
        state: ObservedState::Ready,
        issued_ms: now,
    };
    assert!(
        s.receive_observation(&root.id, &stranger.claim(DOMAIN, &report).unwrap())
            .is_err()
    );
    let raw = owner.claim(DOMAIN, &report).unwrap();
    s.receive_observation(&root.id, &raw).unwrap();
    let first = s.observation_views(&root.id).unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].contributor, owner.public_key());
    s.receive_observation(&root.id, &raw).unwrap();
    assert!(s.observation_views(&root.id).unwrap()[0].remaining_ms <= first[0].remaining_ms);
    for changed in [
        Observation {
            issued_ms: now - 31_000,
            ..report.clone()
        },
        Observation {
            issued_ms: now + 60_000,
            ..report.clone()
        },
        Observation {
            control: "ba".repeat(32),
            ..report.clone()
        },
        Observation {
            state: ObservedState::Running,
            ..report.clone()
        },
    ] {
        assert!(
            s.receive_observation(&root.id, &owner.claim(DOMAIN, &changed).unwrap())
                .is_err()
        );
    }
    assert!(s.receive_observation(&"bb".repeat(32), &raw).is_err());
    assert_eq!(
        s.control_state(&root.id).unwrap().lifecycle.revision,
        root.id
    );
    assert_eq!(
        s.governance(&root.id, &owner.public_key())
            .unwrap()
            .grants
            .len(),
        0
    );
    drop(s);
    let reopened = Store::open(&dir.path().join("node.sqlite")).unwrap();
    assert!(
        reopened.observation_views(&root.id).unwrap().is_empty(),
        "restart must not resurrect fresh presence"
    );
}

#[test]
fn expired_report_cannot_be_replayed_to_refresh_receipt_age() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(&dir.path().join("node.sqlite")).unwrap();
    let owner = Identity::from_seed([211; 32]);
    let root = s
        .create(
            &owner,
            "01".repeat(32),
            MissionDefinition {
                name: "Expiry fixture".into(),
                objective: "Temporary report".into(),
                scope: "No execution".into(),
                criteria: vec![],
                policy: Some(MissionPolicy {
                    coordination: Coordination::Peer,
                    participation: Participation::Private,
                    budget: MissionBudget::Unlimited {},
                }),
            },
        )
        .unwrap();
    let offered = s
        .offer_agent(
            &owner,
            &root.id,
            &root.id,
            AgentIdentity {
                author: Identity::from_seed([212; 32]).public_key(),
                label: "Fixture".into(),
                role: AgentRole::Agent,
                runtime: "grok".into(),
                contributor_name: "Owner".into(),
            },
        )
        .unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let report = Observation {
        mission: root.id.clone(),
        registration: offered.id,
        control: root.id.clone(),
        grant: None,
        state: ObservedState::Ready,
        issued_ms: now - 29_800,
    };
    let raw = owner.claim(DOMAIN, &report).unwrap();
    s.receive_observation(&root.id, &raw).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(220));
    assert!(s.observation_views(&root.id).unwrap().is_empty());
    assert!(s.receive_observation(&root.id, &raw).is_err());
}
