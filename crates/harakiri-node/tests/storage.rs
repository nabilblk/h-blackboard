use harakiri_node::store::Store;
use harakiri_protocol::{EventBody, Identity, MissionDefinition, Payload};
use rand::{SeedableRng, seq::SliceRandom};

fn definition() -> MissionDefinition {
    MissionDefinition {
        name: "Fixture".into(),
        objective: "Test replication".into(),
        scope: "Temporary profiles".into(),
        criteria: vec![],
        policy: None,
    }
}

#[test]
fn scoped_review_upgrade_preserves_v9_history_and_sets_downgrade_barrier() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("upgrade.sqlite");
    let owner = Identity::from_seed([71; 32]);
    let mut store = Store::open(&path).unwrap();
    let template = store.create(&owner, "71".repeat(32), definition()).unwrap();
    let legacy = owner
        .sign(EventBody {
            version: 9,
            ..template.body.clone()
        })
        .unwrap();
    store.import(&[legacy.bytes().to_vec()]).unwrap();
    drop(store);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.pragma_update(None, "user_version", 13).unwrap();
    drop(db);
    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.event(&legacy.id).unwrap().unwrap().bytes(),
        legacy.bytes()
    );
    drop(store);
    let db = rusqlite::Connection::open(path).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
            .unwrap(),
        14
    );
}

#[test]
fn restart_reordered_import_and_duplicates_preserve_mission() {
    let root = tempfile::tempdir().unwrap();
    let owner = Identity::from_seed([1; 32]);
    let participant = Identity::from_seed([2; 32]);
    let path = root.path().join("a.sqlite");
    let mut a = Store::open(&path).unwrap();
    let genesis = a.create(&owner, "01".repeat(32), definition()).unwrap();
    let admitted = a
        .append(
            &owner,
            &genesis.id,
            Payload::MemberAdmitted {
                member: participant.public_key(),
                endpoint: "02".repeat(32),
            },
        )
        .unwrap();
    let message = a
        .append(
            &participant,
            &genesis.id,
            Payload::MessagePosted {
                text: "My direction".into(),
            },
        )
        .unwrap();
    drop(a);
    let a = Store::open(&path).unwrap();
    assert_eq!(a.missions().unwrap()[0].event_count, 3);
    let mut b = Store::open(&root.path().join("b.sqlite")).unwrap();
    let bytes = vec![
        message.bytes().to_vec(),
        admitted.bytes().to_vec(),
        genesis.bytes().to_vec(),
    ];
    assert_eq!(b.import(&bytes).unwrap().inserted, 3);
    assert_eq!(b.import(&bytes).unwrap().duplicates, 3);
    assert!(
        a.delta(&genesis.id, &b.heads(&genesis.id).unwrap())
            .unwrap()
            .is_empty()
    );
    assert_eq!(b.missions().unwrap()[0].state, "preparing");
}

#[test]
fn unauthorized_author_and_cross_mission_grants_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(&root.path().join("node.sqlite")).unwrap();
    let owner = Identity::from_seed([1; 32]);
    let attacker = Identity::from_seed([2; 32]);
    let a = store.create(&owner, "01".repeat(32), definition()).unwrap();
    let b = store.create(&owner, "01".repeat(32), definition()).unwrap();
    let body = EventBody {
        version: 1,
        mission: Some(a.id.clone()),
        author: attacker.public_key(),
        audience: "main".into(),
        sequence: 0,
        previous: None,
        authority: Some(a.id.clone()),
        created_at_ms: None,
        payload: Payload::MessagePosted {
            text: "forged membership".into(),
        },
    };
    let invalid = attacker.sign(body.clone()).unwrap();
    assert!(store.import(&[invalid.bytes().to_vec()]).is_err());
    let invalid = owner
        .sign(EventBody {
            author: owner.public_key(),
            authority: Some(b.id),
            ..body
        })
        .unwrap();
    assert!(store.import(&[invalid.bytes().to_vec()]).is_err());
    assert!(!store.can_read(&a.id, &"02".repeat(32)).unwrap());
}

#[test]
fn signed_forks_freeze_writes_and_survive_restart() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("node.sqlite");
    let mut store = Store::open(&path).unwrap();
    let owner = Identity::from_seed([1; 32]);
    let genesis = store.create(&owner, "01".repeat(32), definition()).unwrap();
    let original = store
        .append(
            &owner,
            &genesis.id,
            Payload::MessagePosted {
                text: "first".into(),
            },
        )
        .unwrap();
    let fork = owner
        .sign(EventBody {
            payload: Payload::MessagePosted {
                text: "conflict".into(),
            },
            ..original.body
        })
        .unwrap();
    assert_eq!(store.import(&[fork.bytes().to_vec()]).unwrap().forks, 1);
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert!(store.conflicted(&genesis.id).unwrap());
    assert!(
        store
            .append(
                &owner,
                &genesis.id,
                Payload::MessagePosted {
                    text: "unsafe".into()
                }
            )
            .is_err()
    );
}

#[test]
fn newer_database_is_preserved_and_refused() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("future.sqlite");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.pragma_update(None, "user_version", 99).unwrap();
    drop(connection);
    assert!(Store::open(&path).is_err());
    assert_eq!(
        rusqlite::Connection::open(path)
            .unwrap()
            .pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
            .unwrap(),
        99
    );
}

#[test]
fn schema_seven_preserves_old_messages_and_requires_pending_applicants_to_review() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("upgrade.sqlite");
    let owner = Identity::from_seed([1; 32]);
    let mut s = Store::open(&path).unwrap();
    let e = owner
        .sign(EventBody {
            version: 2,
            mission: None,
            author: owner.public_key(),
            audience: "main".into(),
            sequence: 0,
            previous: None,
            authority: None,
            created_at_ms: None,
            payload: Payload::MissionCreated {
                definition: definition(),
                endpoint: "01".repeat(32),
                nonce: "07".repeat(32),
            },
        })
        .unwrap();
    s.import(&[e.bytes().to_vec()]).unwrap();
    let msg = s
        .append(
            &owner,
            &e.id,
            Payload::MessagePosted {
                text: "Existing shared history".into(),
            },
        )
        .unwrap();
    drop(s);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute("INSERT INTO local_joins(mission,ticket,genesis,status) VALUES(?1,'old-pending-capability',?2,'pending')",rusqlite::params![e.id,e.bytes()]).unwrap();
    db.execute_batch("DROP TABLE governance_records; DROP TABLE available_files; DROP TABLE artifact_records; DROP TABLE work_records; DROP TABLE message_reads; DROP TABLE message_details; DROP TABLE agent_registry; DROP TABLE agent_records; DROP TABLE control_records; DROP TABLE join_reviews; PRAGMA user_version=6;")
        .unwrap();
    drop(db);
    let s = Store::open(&path).unwrap();
    assert_eq!(s.local_joins().unwrap()[0].status, "review_required");
    assert_eq!(s.messages(&e.id, None).unwrap().items[0].id, msg.id);
    assert_eq!(s.control_state(&e.id).unwrap().lifecycle.revision, e.id);
    assert_eq!(s.event(&e.id).unwrap().unwrap().bytes(), e.bytes());
    drop(s);
    // An invalid signed prefix rolls back both the new projection and the
    // pending-consent migration rather than silently resetting the profile.
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("DROP TABLE governance_records; DROP TABLE available_files; DROP TABLE artifact_records; DROP TABLE work_records; DROP TABLE message_reads; DROP TABLE message_details; DROP TABLE agent_registry; DROP TABLE agent_records; DROP TABLE control_records; DROP TABLE join_reviews; PRAGMA user_version=6; UPDATE local_joins SET status='pending';").unwrap();
    db.execute(
        "UPDATE events SET bytes=?1 WHERE id=?2",
        rusqlite::params![vec![1u8, 2, 3], e.id],
    )
    .unwrap();
    drop(db);
    assert!(Store::open(&path).is_err());
    let db = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
            .unwrap(),
        6
    );
    assert_eq!(
        db.query_row("SELECT status FROM local_joins", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "pending"
    );
}

#[test]
fn message_pages_skip_other_events_and_bound_json_expansion_without_losing_history() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(&root.path().join("node.sqlite")).unwrap();
    let owner = Identity::from_seed([1; 32]);
    let mission = store
        .create(&owner, "01".repeat(32), definition())
        .unwrap()
        .id;
    let mut ids = Vec::new();
    for i in 0..220 {
        ids.push(
            store
                .append(
                    &owner,
                    &mission,
                    Payload::MessagePosted {
                        text: format!("{i} {}", "\u{0001}".repeat(16000)),
                    },
                )
                .unwrap()
                .id,
        );
        store
            .append(
                &owner,
                &mission,
                Payload::MemberAdmitted {
                    member: format!("{i:064x}"),
                    endpoint: format!("{:064x}", i + 300),
                },
            )
            .unwrap();
    }
    let mut before = None;
    let mut recovered = Vec::new();
    loop {
        let page = store.messages(&mission, before).unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() < 1024 * 1024 + 256);
        let mut next = page.items.into_iter().map(|m| m.id).collect::<Vec<_>>();
        next.extend(recovered);
        recovered = next;
        before = page.before;
        if before.is_none() {
            break;
        }
    }
    assert_eq!(recovered, ids);
}

#[test]
fn message_projection_migrates_transactionally_and_preserves_invalid_history() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("node.sqlite");
    let owner = Identity::from_seed([1; 32]);
    let mut store = Store::open(&path).unwrap();
    let mission = store
        .create(&owner, "01".repeat(32), definition())
        .unwrap()
        .id;
    let event = store
        .append(
            &owner,
            &mission,
            Payload::MessagePosted {
                text: "Preserved".into(),
            },
        )
        .unwrap();
    drop(store);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "DROP TABLE governance_records; DROP TABLE available_files; DROP TABLE artifact_records; DROP TABLE work_records; DROP TABLE message_reads; DROP TABLE message_details; DROP TABLE agent_registry; DROP TABLE agent_records; DROP TABLE join_reviews; DROP TABLE control_records; DROP TABLE advertisements; DROP TABLE withdrawals; DROP TABLE local_withdrawals; DROP TABLE revocation_notices; DROP TABLE invitations; DROP TABLE join_requests; DROP TABLE contacts; DROP TABLE local_joins; DROP TABLE settings; DROP TABLE messages; DROP TABLE audience_cuts; DROP TABLE revocations;
        DROP TABLE audience_readers; DROP TABLE audiences; DROP TABLE delivery;
        DROP INDEX writer_history; ALTER TABLE events DROP COLUMN audience;
        CREATE INDEX writer_history ON events(mission,author,sequence); PRAGMA user_version=1;",
    )
    .unwrap();
    drop(db);
    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.messages(&mission, None).unwrap().items[0].id,
        event.id
    );
    drop(store);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "DROP TABLE governance_records; DROP TABLE available_files; DROP TABLE artifact_records; DROP TABLE work_records; DROP TABLE message_reads; DROP TABLE message_details; DROP TABLE agent_registry; DROP TABLE agent_records; DROP TABLE join_reviews; DROP TABLE control_records; DROP TABLE advertisements; DROP TABLE withdrawals; DROP TABLE local_withdrawals; DROP TABLE revocation_notices; DROP TABLE invitations; DROP TABLE join_requests; DROP TABLE contacts; DROP TABLE local_joins; DROP TABLE settings; DROP TABLE messages; DROP TABLE audience_cuts; DROP TABLE revocations;
        DROP TABLE audience_readers; DROP TABLE audiences; DROP TABLE delivery;
        DROP INDEX writer_history; ALTER TABLE events DROP COLUMN audience;
        CREATE INDEX writer_history ON events(mission,author,sequence); PRAGMA user_version=1;",
    )
    .unwrap();
    db.execute(
        "UPDATE events SET bytes=?1 WHERE id=?2",
        rusqlite::params![vec![1u8, 2, 3], event.id],
    )
    .unwrap();
    drop(db);
    assert!(Store::open(&path).is_err());
    let db = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='messages'",
            [],
            |r| r.get::<_, u32>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("SELECT bytes FROM events WHERE id=?1", [event.id], |r| r
            .get::<_, Vec<u8>>(0))
            .unwrap(),
        vec![1, 2, 3]
    );
}

#[test]
fn a_newer_cursor_cannot_hide_older_fork_evidence() {
    let root = tempfile::tempdir().unwrap();
    let owner = Identity::from_seed([1; 32]);
    let mut a = Store::open(&root.path().join("a.sqlite")).unwrap();
    let mut b = Store::open(&root.path().join("b.sqlite")).unwrap();
    let genesis = a.create(&owner, "01".repeat(32), definition()).unwrap();
    let first = a
        .append(
            &owner,
            &genesis.id,
            Payload::MessagePosted {
                text: "first".into(),
            },
        )
        .unwrap();
    a.append(
        &owner,
        &genesis.id,
        Payload::MessagePosted {
            text: "second".into(),
        },
    )
    .unwrap();
    b.import(&a.delta(&genesis.id, &[]).unwrap()).unwrap();
    let fork = owner
        .sign(EventBody {
            payload: Payload::MessagePosted {
                text: "fork behind the cursor".into(),
            },
            ..first.body
        })
        .unwrap();
    a.import(&[fork.bytes().to_vec()]).unwrap();
    let delta = a
        .delta(&genesis.id, &b.heads(&genesis.id).unwrap())
        .unwrap();
    assert_eq!(delta, vec![fork.bytes().to_vec()]);
    assert_eq!(b.import(&delta).unwrap().forks, 1);
    assert!(b.conflicted(&genesis.id).unwrap());
}

#[test]
fn shuffled_concurrent_writers_and_duplicates_have_identical_complete_history() {
    let root = tempfile::tempdir().unwrap();
    let owner = Identity::from_seed([1; 32]);
    let participant = Identity::from_seed([2; 32]);
    let mut source = Store::open(&root.path().join("source.sqlite")).unwrap();
    let genesis = source
        .create(&owner, "01".repeat(32), definition())
        .unwrap();
    source
        .append(
            &owner,
            &genesis.id,
            Payload::MemberAdmitted {
                member: participant.public_key(),
                endpoint: "02".repeat(32),
            },
        )
        .unwrap();
    for writer in [&owner, &participant, &owner, &participant] {
        source
            .append(
                writer,
                &genesis.id,
                Payload::MessagePosted {
                    text: "concurrent work".into(),
                },
            )
            .unwrap();
    }
    let records = source.delta(&genesis.id, &[]).unwrap();
    let heads = serde_json::to_value(source.heads(&genesis.id).unwrap()).unwrap();
    let mut random = rand::rngs::StdRng::seed_from_u64(20261002);
    for trial in 0..48 {
        let mut shuffled = records.clone();
        shuffled.extend_from_slice(&records[..3]);
        shuffled.shuffle(&mut random);
        let mut replica =
            Store::open(&root.path().join(format!("replica-{trial}.sqlite"))).unwrap();
        let result = replica.import(&shuffled).unwrap();
        assert_eq!(result.inserted, 6);
        assert_eq!(result.duplicates, 3);
        assert_eq!(
            serde_json::to_value(replica.heads(&genesis.id).unwrap()).unwrap(),
            heads
        );
        assert!(!replica.conflicted(&genesis.id).unwrap());
        assert!(
            source
                .delta(&genesis.id, &replica.heads(&genesis.id).unwrap())
                .unwrap()
                .is_empty()
        );
    }
}

#[test]
fn a_forked_admission_is_not_read_authority() {
    let root = tempfile::tempdir().unwrap();
    let owner = Identity::from_seed([1; 32]);
    let participant = Identity::from_seed([2; 32]);
    let mut store = Store::open(&root.path().join("node.sqlite")).unwrap();
    let genesis = store.create(&owner, "01".repeat(32), definition()).unwrap();
    let admission = store
        .append(
            &owner,
            &genesis.id,
            Payload::MemberAdmitted {
                member: participant.public_key(),
                endpoint: "02".repeat(32),
            },
        )
        .unwrap();
    assert!(store.can_read(&genesis.id, &"02".repeat(32)).unwrap());
    let conflict = owner
        .sign(EventBody {
            payload: Payload::MessagePosted {
                text: "a conflicting owner history".into(),
            },
            ..admission.body
        })
        .unwrap();
    store.import(&[conflict.bytes().to_vec()]).unwrap();
    assert!(!store.can_read(&genesis.id, &"02".repeat(32)).unwrap());
    // The root owner can still recover its conflicting history.
    assert!(store.can_read(&genesis.id, &"01".repeat(32)).unwrap());
}
