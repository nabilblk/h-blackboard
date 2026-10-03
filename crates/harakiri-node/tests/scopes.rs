use harakiri_node::store::Store;
use harakiri_protocol::{Identity, MissionDefinition, Payload};

fn setup() -> (tempfile::TempDir, Store, [Identity; 3], String) {
    let temp = tempfile::tempdir().unwrap();
    let mut s = Store::open(&temp.path().join("node.sqlite")).unwrap();
    let people = [1, 2, 3].map(|i| Identity::from_seed([i; 32]));
    let m = s
        .create(
            &people[0],
            "01".repeat(32),
            MissionDefinition {
                name: "Scope fixture".into(),
                objective: "Private streams".into(),
                scope: "Isolated tests".into(),
                criteria: vec![],
                policy: None,
            },
        )
        .unwrap()
        .id;
    for (i, p) in people.iter().enumerate().skip(1) {
        s.append(
            &people[0],
            &m,
            Payload::MemberAdmitted {
                member: p.public_key(),
                endpoint: format!("{:02x}", i + 1).repeat(32),
            },
        )
        .unwrap();
    }
    (temp, s, people, m)
}
fn message(text: &str) -> Payload {
    Payload::MessagePosted { text: text.into() }
}

#[test]
fn private_streams_do_not_change_public_history_and_owner_is_not_a_reader() {
    let (temp, mut s, p, m) = setup();
    let public = s.delta(&m, &[]).unwrap();
    let a = format!("private:{}", "ab".repeat(32));
    s.append_to(
        &p[1],
        &m,
        &a,
        Payload::AudienceCreated {
            readers: vec![p[1].public_key(), p[2].public_key()],
        },
    )
    .unwrap();
    let private = s.append_to(&p[2], &m, &a, message("Only B and C")).unwrap();
    assert_eq!(s.delta(&m, &[]).unwrap(), public);
    assert_eq!(s.missions().unwrap()[0].event_count, 3);
    assert!(s.messages(&m, None).unwrap().items.is_empty());
    assert!(s.messages(&m, Some(private.id.clone())).is_err());
    assert!(!s.can_read_scope(&m, &a, &"01".repeat(32)).unwrap());
    assert!(s.audiences_for(&m, &"01".repeat(32)).unwrap().is_empty());
    assert!(s.can_read_scope(&m, &a, &"02".repeat(32)).unwrap());
    assert!(
        s.append_to(&p[0], &m, &a, message("Owner intrusion"))
            .is_err()
    );
    let public_c = s.append(&p[2], &m, message("Public C")).unwrap();
    assert_eq!(public_c.body.previous, None);
    let mut replica = Store::open(&temp.path().join("replica.sqlite")).unwrap();
    let mut records = s.delta(&m, &[]).unwrap();
    records.extend(s.delta_in(&m, &a, &[]).unwrap());
    records.reverse();
    replica.import(&records).unwrap();
    assert_eq!(
        replica.messages_in(&m, &a, None).unwrap().items[0].id,
        private.id
    );
    let fork = p[2]
        .sign(harakiri_protocol::EventBody {
            payload: message("Private fork"),
            ..private.body
        })
        .unwrap();
    s.import(&[fork.bytes().to_vec()]).unwrap();
    assert!(s.conflicted_scope(&m, &a).unwrap());
    assert!(!s.conflicted(&m).unwrap());
    s.append(&p[2], &m, message("Public remains writable"))
        .unwrap();
    assert!(
        s.append_to(&p[1], &m, &a, message("Blocked private write"))
            .is_err()
    );
}

#[test]
fn revocation_retains_evidence_but_blocks_access_and_marks_unaccepted_work() {
    let (temp, mut s, p, m) = setup();
    let a = format!("private:{}", "cd".repeat(32));
    s.append_to(
        &p[1],
        &m,
        &a,
        Payload::AudienceCreated {
            readers: vec![p[1].public_key(), p[2].public_key()],
        },
    )
    .unwrap();
    let private = s
        .append_to(&p[2], &m, &a, message("Previously shared privately"))
        .unwrap();
    let accepted = s.append(&p[2], &m, message("Accepted frontier")).unwrap();
    let unaccepted = s.append(&p[2], &m, message("Partitioned work")).unwrap();
    let revoke = s
        .append(
            &p[0],
            &m,
            Payload::MemberRevoked {
                member: p[2].public_key(),
                accepted: Some(accepted.id.clone()),
            },
        )
        .unwrap();
    assert!(!s.can_read(&m, &"03".repeat(32)).unwrap());
    assert!(!s.can_read_scope(&m, &a, &"03".repeat(32)).unwrap());
    assert!(!s.provisional(&accepted.id).unwrap());
    assert!(s.provisional(&unaccepted.id).unwrap());
    assert!(s.provisional(&private.id).unwrap());
    assert!(s.append(&p[2], &m, message("Revoked")).is_err());
    s.append_to(
        &p[1],
        &m,
        &a,
        Payload::AudienceFrontier {
            member: p[2].public_key(),
            revocation: revoke.id,
            accepted: Some(private.id.clone()),
        },
    )
    .unwrap();
    assert!(!s.provisional(&private.id).unwrap());
    let mut records = s.delta_in(&m, &a, &[]).unwrap();
    records.extend(s.delta(&m, &[]).unwrap());
    records.reverse();
    let mut other = Store::open(&temp.path().join("other.sqlite")).unwrap();
    other.import(&records).unwrap();
    assert!(other.provisional(&unaccepted.id).unwrap());
    assert!(!other.provisional(&private.id).unwrap());
    assert!(!other.can_read(&m, &"03".repeat(32)).unwrap());
}

#[test]
fn delivery_acknowledgment_cannot_erase_a_concurrent_write_and_survives_restart() {
    let (temp, mut s, p, m) = setup();
    let before = s.heads(&m).unwrap();
    s.append(&p[0], &m, message("New while sending")).unwrap();
    s.acknowledge(&m, "main", &"02".repeat(32), &before, 1)
        .unwrap();
    assert!(
        s.deliveries(&m, "main")
            .unwrap()
            .iter()
            .find(|d| d.endpoint == "02".repeat(32))
            .unwrap()
            .pending
    );
    let current = s.heads(&m).unwrap();
    s.acknowledge(&m, "main", &"02".repeat(32), &current, 2)
        .unwrap();
    drop(s);
    let s = Store::open(&temp.path().join("node.sqlite")).unwrap();
    let d = s.deliveries(&m, "main").unwrap();
    let b = d.iter().find(|d| d.endpoint == "02".repeat(32)).unwrap();
    assert!(!b.pending);
    assert_eq!(b.last_success_ms, Some(2));
}

#[test]
fn a_private_dependency_or_forked_root_cannot_expand_reader_authority() {
    let (_temp, mut s, p, m) = setup();
    let a = format!("private:{}", "ef".repeat(32));
    let root = s
        .append_to(
            &p[1],
            &m,
            &a,
            Payload::AudienceCreated {
                readers: vec![p[1].public_key(), p[2].public_key()],
            },
        )
        .unwrap();
    let secret = s
        .append_to(&p[1], &m, &a, message("Private predecessor"))
        .unwrap();
    let malicious = p[1]
        .sign(harakiri_protocol::EventBody {
            audience: "main".into(),
            ..secret.body.clone()
        })
        .unwrap();
    assert!(s.import(&[malicious.bytes().to_vec()]).is_err());
    let cursor = harakiri_node::store::Head {
        author: secret.body.author,
        sequence: secret.body.sequence,
        id: secret.id,
    };
    assert_eq!(s.delta(&m, &[cursor]).unwrap(), s.delta(&m, &[]).unwrap());
    let fork = p[1]
        .sign(harakiri_protocol::EventBody {
            payload: Payload::AudienceCreated {
                readers: vec![p[1].public_key(), p[0].public_key()],
            },
            ..root.body
        })
        .unwrap();
    assert_eq!(s.import(&[fork.bytes().to_vec()]).unwrap().forks, 1);
    assert!(!s.can_read_scope(&m, &a, &"01".repeat(32)).unwrap());
    assert!(!s.can_read_scope(&m, &a, &"03".repeat(32)).unwrap());
    assert!(s.audiences_for(&m, &"03".repeat(32)).unwrap().is_empty());
    assert!(s.can_read_scope(&m, &a, &"02".repeat(32)).unwrap());
    assert!(!s.conflicted(&m).unwrap());
}

#[test]
fn independent_audience_histories_converge_under_shuffling_and_duplicates() {
    use rand::{SeedableRng, seq::SliceRandom};
    let (temp, mut s, p, m) = setup();
    let mut scopes = vec!["main".to_string()];
    for id in ["11", "22"] {
        let scope = format!("private:{}", id.repeat(32));
        s.append_to(
            &p[1],
            &m,
            &scope,
            Payload::AudienceCreated {
                readers: vec![p[1].public_key(), p[2].public_key()],
            },
        )
        .unwrap();
        for person in [&p[1], &p[2], &p[1]] {
            s.append_to(person, &m, &scope, message("Concurrent private work"))
                .unwrap();
        }
        scopes.push(scope);
    }
    let mut records = vec![];
    for scope in &scopes {
        records.extend(s.delta_in(&m, scope, &[]).unwrap());
    }
    let expected = records.len();
    records.extend_from_within(..3);
    let mut rng = rand::rngs::StdRng::seed_from_u64(20261003);
    for iteration in 0..32 {
        records.shuffle(&mut rng);
        let mut replica =
            Store::open(&temp.path().join(format!("private-{iteration}.sqlite"))).unwrap();
        let result = replica.import(&records).unwrap();
        assert_eq!(result.inserted, expected);
        assert_eq!(result.duplicates, 3);
        for scope in &scopes {
            assert!(
                s.delta_in(&m, scope, &replica.heads_in(&m, scope).unwrap())
                    .unwrap()
                    .is_empty()
            );
        }
        assert_eq!(replica.missions().unwrap()[0].event_count, 3);
    }
}
