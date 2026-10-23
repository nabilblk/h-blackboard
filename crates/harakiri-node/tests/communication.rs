use harakiri_node::{
    communication::{AgentOperation, MessageFeed, MessageQuery},
    store::Store,
};
use harakiri_protocol::{
    Identity, MissionDefinition, Payload,
    agents::{AgentIdentity, AgentRole},
    lifecycle::ControlAction,
    policy::{Coordination, MissionBudget, MissionPolicy, Participation},
};

struct Fixture {
    _temp: tempfile::TempDir,
    s: Store,
    owner: Identity,
    host: Identity,
    outsider: Identity,
    mission: String,
    a: String,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let mut s = Store::open(&temp.path().join("test.sqlite")).unwrap();
        let owner = Identity::from_seed([1; 32]);
        let host = Identity::from_seed([2; 32]);
        let outsider = Identity::from_seed([3; 32]);
        let mission = s
            .create(
                &owner,
                "01".repeat(32),
                MissionDefinition {
                    name: "Festival".into(),
                    objective: "Accessible festival".into(),
                    scope: "Research".into(),
                    criteria: vec![],
                    policy: Some(MissionPolicy {
                        coordination: Coordination::Peer,
                        participation: Participation::Private,
                        budget: MissionBudget::Unlimited {},
                    }),
                },
            )
            .unwrap()
            .id;
        for (human, endpoint) in [(&host, "02"), (&outsider, "03")] {
            s.append(
                &owner,
                &mission,
                Payload::MemberAdmitted {
                    member: human.public_key(),
                    endpoint: endpoint.repeat(32),
                },
            )
            .unwrap();
        }
        let mut offer = |label: &str| {
            let identity = host.coordinator_identity(&mission, label).unwrap();
            s.offer_agent(
                &host,
                &mission,
                &mission,
                AgentIdentity {
                    author: identity.public_key(),
                    label: label.into(),
                    runtime: "grok".into(),
                    role: AgentRole::Agent,
                    contributor_name: "Host".into(),
                },
            )
            .unwrap()
            .id
        };
        let a = offer("a");
        offer("b");
        Self {
            _temp: temp,
            s,
            owner,
            host,
            outsider,
            mission,
            a,
        }
    }
    fn key(&self, name: &str) -> Identity {
        self.host.coordinator_identity(&self.mission, name).unwrap()
    }
    fn control(&mut self, action: ControlAction) -> String {
        let r = self
            .s
            .control_state(&self.mission)
            .unwrap()
            .lifecycle
            .revision;
        self.s
            .control(&self.owner, &self.mission, &r, action)
            .unwrap()
            .id
    }
    fn start(&mut self) -> String {
        let participants = self.s.start_participants(&self.mission).unwrap();
        self.control(ControlAction::Start {
            readiness: None,
            participants,
        })
    }
    fn request(&mut self, op: AgentOperation) -> anyhow::Result<serde_json::Value> {
        self.s
            .agent_request(&self.host, &self.mission, "a", &self.a, op)
    }
}
fn query(view: MessageFeed, audience: &str) -> MessageQuery {
    let mut q = MessageQuery::conversation(audience, None);
    q.view = view;
    q
}

#[test]
fn human_catch_up_and_message_links_are_scoped_paginated_and_not_read_receipts() {
    let mut f = Fixture::new();
    let owner = f.owner.public_key();
    let host = f.host.public_key();
    let baseline = f.s.catch_up(&f.mission, &owner, None).unwrap();
    assert!(baseline.items.is_empty());
    let dm =
        f.s.open_agent_conversation(&f.owner, &f.mission, &f.a)
            .unwrap();
    let secret =
        f.s.send_message(&f.owner, &f.mission, &dm, "Private note".into(), None, None)
            .unwrap();
    assert!(f.s.read_message(&f.mission, &host, &secret.id).is_err());
    assert!(f.s.catch_up(&f.mission, &host, Some(&secret.id)).is_err());
    assert_eq!(
        f.s.read_message(&f.mission, &owner, &secret.id)
            .unwrap()
            .text,
        "Private note"
    );
    assert!(
        f.s.catch_up(
            &f.mission,
            &Identity::from_seed([99; 32]).public_key(),
            None
        )
        .is_err()
    );
    let mut expected = vec![secret.id];
    for n in 0..39 {
        expected.push(
            f.s.send_message(
                &f.host,
                &f.mission,
                "main",
                format!("Finding {n}"),
                None,
                None,
            )
            .unwrap()
            .id,
        );
    }
    let mut cursor = baseline.after;
    let mut actual = vec![];
    loop {
        let page = f.s.catch_up(&f.mission, &owner, cursor.as_deref()).unwrap();
        assert!(page.items.len() <= 32);
        actual.extend(
            page.items
                .iter()
                .filter(|m| m.kind == "message")
                .map(|m| m.id.clone()),
        );
        cursor = page.after;
        if !page.has_more {
            break;
        }
    }
    assert_eq!(actual, expected);
    assert!(
        f.s.query_messages(&f.mission, &owner, MessageQuery::conversation("main", None))
            .unwrap()
            .items
            .iter()
            .filter(|m| m.author == host)
            .all(|m| m.unread)
    );
    let mut remote = Store::open(&f._temp.path().join("late.sqlite")).unwrap();
    remote.import(&f.s.delta(&f.mission, &[]).unwrap()).unwrap();
    let event = remote
        .send_message(
            &f.outsider,
            &f.mission,
            "main",
            "Late evidence".into(),
            None,
            None,
        )
        .unwrap();
    let mut body = event.body;
    body.created_at_ms = Some(1);
    let late = f.outsider.sign(body).unwrap();
    f.s.import(&[late.bytes().to_vec()]).unwrap();
    let page = f.s.catch_up(&f.mission, &owner, cursor.as_deref()).unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].id, late.id);
}

#[test]
fn clarification_is_addressed_acknowledged_and_does_not_replace_direction() {
    let mut f = Fixture::new();
    let control = f.start();
    let before = f.request(AgentOperation::Context {}).unwrap();
    let direction = before["agent"]["direction"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let update =
        f.s.clarify_agent(
            &f.owner,
            &f.mission,
            &control,
            &f.a,
            &direction,
            "Use the revised venue capacity as evidence; keep the approved research scope.".into(),
        )
        .unwrap();
    let retry =
        f.s.clarify_agent(
            &f.owner,
            &f.mission,
            &control,
            &f.a,
            &direction,
            "Use the revised venue capacity as evidence; keep the approved research scope.".into(),
        )
        .unwrap();
    assert_eq!(retry.id, update.id);
    let after = f.request(AgentOperation::Context {}).unwrap();
    assert_eq!(after["agent"]["direction"], before["agent"]["direction"]);
    assert_eq!(after["lifecycle"]["revision"], control);
    assert_eq!(after["agent"]["pending_clarifications"], 1);
    let priority = f
        .request(AgentOperation::PriorityUpdates { after: None })
        .unwrap();
    assert!(
        priority["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == update.id && m["to"] == f.key("a").public_key())
    );
    let pending = f.request(AgentOperation::Clarifications {}).unwrap();
    assert_eq!(pending["items"][0]["id"], update.id);
    assert_eq!(
        f.request(AgentOperation::Context {}).unwrap()["agent"]["pending_clarifications"],
        1,
        "reading is not acknowledgment"
    );
    let ack = f
        .request(AgentOperation::AcknowledgeUpdate {
            control: control.clone(),
            clarification: update.id.clone(),
        })
        .unwrap();
    assert_eq!(
        f.request(AgentOperation::AcknowledgeUpdate {
            control: control.clone(),
            clarification: update.id.clone()
        })
        .unwrap(),
        ack
    );
    assert_eq!(
        f.request(AgentOperation::Context {}).unwrap()["agent"]["pending_clarifications"],
        0
    );
    assert!(
        f.s.clarify_agent(
            &f.outsider,
            &f.mission,
            &control,
            &f.a,
            &direction,
            "Unapproved change".into()
        )
        .is_err()
    );
    assert!(
        f.s.agent_request(
            &f.host,
            &f.mission,
            "b",
            &f.s.agent_views(&f.mission)
                .unwrap()
                .iter()
                .find(|a| a.identity.label == "b")
                .unwrap()
                .id
                .clone(),
            AgentOperation::AcknowledgeUpdate {
                control,
                clarification: update.id
            }
        )
        .is_err()
    );
}

#[test]
fn accounting_activity_cannot_displace_human_instructions_from_a_snapshot() {
    use harakiri_protocol::governance::GovernanceAction;
    let mut f = Fixture::new();
    let start = f.start();
    let instruction =
        f.s.send_message(
            &f.owner,
            &f.mission,
            "main",
            "Check the numerical boundary before handoff".into(),
            None,
            None,
        )
        .unwrap();
    for _ in 0..70 {
        let allocation =
            f.s.govern(
                &f.owner,
                &f.mission,
                &start,
                GovernanceAction::Allocate {
                    node: f.host.public_key(),
                    turns: Some(1),
                    slots: 1,
                },
            )
            .unwrap();
        let seal =
            f.s.govern(
                &f.host,
                &f.mission,
                &start,
                GovernanceAction::SealAllocation {
                    allocation: allocation.id,
                    grants: vec![],
                },
            )
            .unwrap();
        f.s.govern(
            &f.owner,
            &f.mission,
            &start,
            GovernanceAction::Reclaim { seal: seal.id },
        )
        .unwrap();
    }
    let full = f
        .request(AgentOperation::Messages {
            query: MessageQuery::conversation("main", None),
        })
        .unwrap();
    assert_eq!(full["items"].as_array().unwrap().len(), 200);
    assert!(
        full["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["kind"] == "governance")
    );
    let brief = f
        .request(AgentOperation::Snapshot {
            watch: vec![],
            after: None,
            priority_after: None,
        })
        .unwrap();
    let messages = brief["main"]["items"].as_array().unwrap();
    assert!(messages.iter().any(|m| m["id"] == instruction.id));
    assert!(messages.iter().all(|m| m["kind"] != "governance"));
    assert_eq!(brief["context"]["lifecycle"]["revision"], start);
    assert!(brief["criteria"].is_array());
    assert!(
        brief["message_projection"]
            .as_str()
            .unwrap()
            .contains("full accounting")
    );
    let ledger = f.request(AgentOperation::Governance {}).unwrap();
    assert_eq!(ledger["allocations"].as_array().unwrap().len(), 70);
}

#[test]
fn addressing_a_registration_explains_the_identity_mismatch_without_a_sync_retry() {
    let mut f = Fixture::new();
    let error =
        f.s.send_message(
            &f.owner,
            &f.mission,
            "main",
            "Hello".into(),
            Some(f.a.clone()),
            None,
        )
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "message recipient is an agent registration; use identity.author"
    );
    let recipient = f.key("a").public_key();
    let sent =
        f.s.send_message(
            &f.owner,
            &f.mission,
            "main",
            "Hello".into(),
            Some(recipient.clone()),
            None,
        )
        .unwrap();
    assert!(
        matches!(sent.body.payload, Payload::MessageSent { to: Some(to), .. } if to == recipient)
    );
}

#[test]
fn agent_identity_scope_and_acknowledgment_are_bound_to_exact_current_direction() {
    let mut f = Fixture::new();
    let ctx = f.request(AgentOperation::Context {}).unwrap();
    assert_eq!(ctx["execution"], "unavailable");
    assert!(ctx["agent"]["direction"].is_null());
    assert!(
        f.request(AgentOperation::Acknowledge {
            control: f.mission.clone(),
            direction: f.mission.clone()
        })
        .is_err()
    );
    let start = f.start();
    let ack = f
        .request(AgentOperation::Acknowledge {
            control: start.clone(),
            direction: start.clone(),
        })
        .unwrap();
    assert_eq!(
        ack,
        f.request(AgentOperation::Acknowledge {
            control: start.clone(),
            direction: start.clone()
        })
        .unwrap()
    );
    let event = f.s.event(ack["event"].as_str().unwrap()).unwrap().unwrap();
    assert_eq!(event.body.author, f.key("a").public_key());
    assert_ne!(event.body.author, f.host.public_key());
    let direction =
        f.s.direct_agent(
            &f.owner,
            &f.mission,
            &start,
            &f.a,
            "Use the indoor venue".into(),
        )
        .unwrap();
    assert!(f.request(AgentOperation::Context {}).unwrap()["agent"]["acknowledgment"].is_null());
    assert!(
        f.request(AgentOperation::Acknowledge {
            control: start.clone(),
            direction: start.clone()
        })
        .is_err()
    );
    f.request(AgentOperation::Acknowledge {
        control: start.clone(),
        direction: direction.id,
    })
    .unwrap();
    assert!(
        f.s.agent_request(&f.host, &f.mission, "b", &f.a, AgentOperation::Context {})
            .is_err()
    );
    assert!(
        f.s.agent_request(&f.owner, &f.mission, "a", &f.a, AgentOperation::Context {})
            .is_err()
    );
    assert!(
        f.request(AgentOperation::Plan {
            control: start,
            text: "I am now in charge".into()
        })
        .is_err()
    );
    f.control(ControlAction::Pause {
        reason: "Human review".into(),
    });
    let ctx = f.request(AgentOperation::Context {}).unwrap();
    assert_eq!(ctx["agent"]["status"], "paused");
    assert!(ctx["agent"]["acknowledgment"].is_null());
    f.request(AgentOperation::Post {
        audience: "main".into(),
        text: "Waiting for human review".into(),
        to: None,
        thread: None,
    })
    .unwrap();
}

#[test]
fn private_agents_share_a_host_but_never_each_others_conversations_or_cursors() {
    let mut f = Fixture::new();
    let dm =
        f.s.open_agent_conversation(&f.owner, &f.mission, &f.a)
            .unwrap();
    assert_eq!(
        dm,
        f.s.open_agent_conversation(&f.owner, &f.mission, &f.a)
            .unwrap()
    );
    let secret =
        f.s.send_message(
            &f.owner,
            &f.mission,
            &dm,
            "Private constraint".into(),
            None,
            None,
        )
        .unwrap();
    assert!(
        f.s.can_read_scope(&f.mission, &dm, &"02".repeat(32))
            .unwrap(),
        "the agent host transports its bytes"
    );
    assert!(
        !f.s.can_read_scope(&f.mission, &dm, &"03".repeat(32))
            .unwrap()
    );
    assert!(
        f.s.local_audiences(&f.mission, &f.host.public_key())
            .unwrap()
            .is_empty(),
        "hosting an agent does not add the human to its UI audience"
    );
    for key in [
        f.key("b").public_key(),
        f.host.public_key(),
        f.outsider.public_key(),
    ] {
        assert!(
            f.s.query_messages(&f.mission, &key, query(MessageFeed::Conversation, &dm))
                .is_err()
        );
        let mut q = query(MessageFeed::Sent, "main");
        q.before = Some(secret.id.clone());
        assert!(
            f.s.query_messages(&f.mission, &key, q).is_err(),
            "private cursor cannot leak into another feed"
        );
    }
    let messages = f
        .request(AgentOperation::Messages {
            query: query(MessageFeed::Inbox, "main"),
        })
        .unwrap();
    assert_eq!(messages["items"][0]["text"], "Private constraint");
    let snapshot = f
        .request(AgentOperation::Snapshot {
            watch: vec![],
            after: None,
            priority_after: None,
        })
        .unwrap();
    assert!(snapshot["inbox"].to_string().contains("Private constraint"));
    let other =
        f.s.agent_views(&f.mission)
            .unwrap()
            .into_iter()
            .find(|a| a.identity.label == "b")
            .unwrap();
    let snapshot =
        f.s.agent_request(
            &f.host,
            &f.mission,
            "b",
            &other.id,
            AgentOperation::Snapshot {
                watch: vec![],
                after: None,
                priority_after: None,
            },
        )
        .unwrap();
    assert!(!snapshot.to_string().contains("Private constraint"));
    f.request(AgentOperation::Post {
        audience: dm.clone(),
        text: "Received privately".into(),
        to: None,
        thread: Some(secret.id.clone()),
    })
    .unwrap();
    assert!(
        f.request(AgentOperation::Post {
            audience: "main".into(),
            text: "Cross-scope reply".into(),
            to: None,
            thread: Some(secret.id)
        })
        .is_err()
    );
    assert!(
        f.request(AgentOperation::Post {
            audience: dm.clone(),
            text: "Invite an unrelated reader".into(),
            to: Some(f.key("b").public_key()),
            thread: None
        })
        .is_err()
    );
    f.s.withdraw_agent(&f.host, &f.mission, &f.a).unwrap();
    assert!(f.request(AgentOperation::Context {}).is_err());
    assert!(
        !f.s.can_read_scope(&f.mission, &dm, &"02".repeat(32))
            .unwrap()
    );
    let saved =
        f.s.local_audiences(&f.mission, &f.owner.public_key())
            .unwrap();
    assert!(!saved[0].writable);
    assert!(
        f.s.query_messages(
            &f.mission,
            &f.owner.public_key(),
            query(MessageFeed::Conversation, &dm)
        )
        .is_ok()
    );
    assert!(
        f.s.send_message(
            &f.owner,
            &f.mission,
            &dm,
            "No longer deliverable".into(),
            None,
            None
        )
        .is_err()
    );
}

#[test]
fn inbox_sent_threads_full_history_search_and_read_state_survive_restart() {
    let mut f = Fixture::new();
    let public =
        f.s.send_message(
            &f.owner,
            &f.mission,
            "main",
            "Check access".into(),
            Some(f.key("a").public_key()),
            None,
        )
        .unwrap();
    let reply = f
        .request(AgentOperation::Post {
            audience: "main".into(),
            text: "The north entrance is accessible".into(),
            to: None,
            thread: Some(public.id.clone()),
        })
        .unwrap();
    let reply = reply["event"].as_str().unwrap().to_owned();
    f.request(AgentOperation::Post {
        audience: "main".into(),
        text: "Human, please confirm".into(),
        to: Some(f.owner.public_key()),
        thread: None,
    })
    .unwrap();
    let dm =
        f.s.open_agent_conversation(&f.owner, &f.mission, &f.a)
            .unwrap();
    f.request(AgentOperation::Post {
        audience: dm,
        text: "A private question".into(),
        to: None,
        thread: None,
    })
    .unwrap();
    let inbox =
        f.s.query_messages(
            &f.mission,
            &f.owner.public_key(),
            query(MessageFeed::Inbox, "main"),
        )
        .unwrap();
    assert_eq!(inbox.items.len(), 3);
    assert!(inbox.items.iter().all(|m| m.unread));
    let sent =
        f.s.query_messages(
            &f.mission,
            &f.owner.public_key(),
            query(MessageFeed::Sent, "main"),
        )
        .unwrap();
    assert_eq!(sent.items.len(), 1);
    assert_eq!(sent.items[0].replies, 1);
    let mut thread = query(MessageFeed::Conversation, "main");
    thread.thread = Some(public.id.clone());
    assert_eq!(
        f.s.query_messages(&f.mission, &f.owner.public_key(), thread)
            .unwrap()
            .items
            .len(),
        2
    );
    let read: Vec<_> = inbox.items.iter().map(|m| m.id.clone()).collect();
    f.s.mark_messages_read(&f.mission, &f.owner.public_key(), &read)
        .unwrap();
    for i in 0..205 {
        f.request(AgentOperation::Post {
            audience: "main".into(),
            text: format!("Public progress {i}"),
            to: None,
            thread: None,
        })
        .unwrap();
    }
    let mut search = query(MessageFeed::Inbox, "main");
    search.search = Some("north entrance".into());
    let found =
        f.s.query_messages(&f.mission, &f.owner.public_key(), search.clone())
            .unwrap();
    assert_eq!(found.items.len(), 1);
    assert_eq!(found.items[0].id, reply);
    assert!(!found.items[0].unread);
    drop(f.s);
    f.s = Store::open(&f._temp.path().join("test.sqlite")).unwrap();
    assert!(
        !f.s.query_messages(&f.mission, &f.owner.public_key(), search)
            .unwrap()
            .items[0]
            .unread
    );
    let mut anchor = query(MessageFeed::Conversation, "main");
    anchor.anchor = Some(public.id.clone());
    assert_eq!(
        f.s.query_messages(&f.mission, &f.owner.public_key(), anchor)
            .unwrap()
            .items
            .last()
            .unwrap()
            .id,
        public.id
    );
}

#[test]
fn terms_changes_and_contributor_revocation_disable_agent_communication() {
    let mut f = Fixture::new();
    let dm =
        f.s.open_agent_conversation(&f.owner, &f.mission, &f.a)
            .unwrap();
    f.s.append(
        &f.owner,
        &f.mission,
        Payload::MemberRevoked {
            member: f.host.public_key(),
            accepted: f
                .s
                .head(&f.mission, &f.host.public_key())
                .unwrap()
                .map(|h| h.id),
        },
    )
    .unwrap();
    assert!(f.request(AgentOperation::Context {}).is_err());
    assert!(
        !f.s.can_read_scope(&f.mission, &dm, &"02".repeat(32))
            .unwrap()
    );
    let mut f = Fixture::new();
    let mut definition = f.s.control_state(&f.mission).unwrap().definition;
    definition.scope = "Different approved scope".into();
    f.control(ControlAction::UpdateInstructions { definition });
    assert!(f.request(AgentOperation::Context {}).is_err());
}

#[test]
fn shuffled_signed_communication_replays_without_turning_stale_receipts_current() {
    use rand::{SeedableRng, seq::SliceRandom};
    let mut f = Fixture::new();
    let start = f.start();
    f.request(AgentOperation::Acknowledge {
        control: start.clone(),
        direction: start.clone(),
    })
    .unwrap();
    let dm =
        f.s.open_agent_conversation(&f.owner, &f.mission, &f.a)
            .unwrap();
    let question =
        f.s.send_message(
            &f.owner,
            &f.mission,
            &dm,
            "Private context".into(),
            None,
            None,
        )
        .unwrap();
    f.request(AgentOperation::Post {
        audience: dm.clone(),
        text: "Same private thread".into(),
        to: None,
        thread: Some(question.id),
    })
    .unwrap();
    f.s.direct_agent(
        &f.owner,
        &f.mission,
        &start,
        &f.a,
        "A newer direction".into(),
    )
    .unwrap();
    let mut all = f.s.delta(&f.mission, &[]).unwrap();
    all.extend(f.s.delta_in(&f.mission, &dm, &[]).unwrap());
    for seed in 0..12 {
        let mut s = Store::open(&f._temp.path().join(format!("replica-{seed}.sqlite"))).unwrap();
        let mut shuffled = all.clone();
        shuffled.shuffle(&mut rand::rngs::StdRng::seed_from_u64(seed));
        s.import(&shuffled).unwrap();
        s.import(&shuffled).unwrap();
        let ctx = s
            .agent_request(&f.host, &f.mission, "a", &f.a, AgentOperation::Context {})
            .unwrap();
        assert!(ctx["agent"]["acknowledgment"].is_null());
        assert_eq!(ctx["agent"]["direction"]["text"], "A newer direction");
        assert_eq!(
            s.query_messages(
                &f.mission,
                &f.owner.public_key(),
                query(MessageFeed::Inbox, "main")
            )
            .unwrap()
            .items
            .len(),
            1
        );
    }
}

#[test]
fn schema_nine_rebuilds_verified_indexes_and_rolls_back_corruption() {
    let f = Fixture::new();
    let path = f._temp.path().join("test.sqlite");
    let before = f.s.event(&f.a).unwrap().unwrap().bytes().to_vec();
    drop(f.s);
    let reset = || {
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("DROP TABLE sync_progress; DROP INDEX replication_history; ALTER TABLE delivery DROP COLUMN last_progress_ms; ALTER TABLE delivery DROP COLUMN last_converged_ms; ALTER TABLE delivery DROP COLUMN stalled_exchanges; DROP TABLE governance_records; DROP TABLE available_files; DROP TABLE artifact_records; DROP TABLE work_records; DROP TABLE message_reads; DROP TABLE message_details; DROP TABLE agent_registry; PRAGMA user_version=8;").unwrap();
    };
    reset();
    let s = Store::open(&path).unwrap();
    assert_eq!(s.event(&f.a).unwrap().unwrap().bytes(), before);
    assert_eq!(s.agent_views(&f.mission).unwrap().len(), 2);
    drop(s);
    reset();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute("UPDATE events SET bytes=x'00' WHERE id=?1", [f.a])
        .unwrap();
    drop(db);
    assert!(Store::open(&path).is_err());
    let db = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
            .unwrap(),
        8
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='agent_registry'",
            [],
            |r| r.get::<_, u32>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn incremental_delivery_survives_page_limits_restart_private_cursors_and_late_replication() {
    use harakiri_protocol::work::WorkAction;
    let mut f = Fixture::new();
    let control = f.start();
    let mut expected = vec![];
    for n in 0..205 {
        expected.push(
            f.s.send_message(
                &f.owner,
                &f.mission,
                "main",
                format!("Instruction {n}"),
                None,
                None,
            )
            .unwrap()
            .id,
        );
    }
    let stream =
        f.s.work(
            &f.owner,
            &f.mission,
            &control,
            WorkAction::CreateWorkstream {
                name: "Evidence".into(),
                goal: "Compare counterexamples".into(),
            },
        )
        .unwrap()
        .id;
    let stream_message =
        f.s.send_message(
            &f.owner,
            &f.mission,
            &format!("workstream:{stream}"),
            "New counterexample".into(),
            None,
            None,
        )
        .unwrap();
    expected.push(stream_message.id.clone());
    let other =
        f.s.agent_views(&f.mission)
            .unwrap()
            .into_iter()
            .find(|a| a.identity.label == "b")
            .unwrap();
    let dm =
        f.s.open_agent_conversation(&f.owner, &f.mission, &other.id)
            .unwrap();
    let secret =
        f.s.send_message(
            &f.owner,
            &f.mission,
            &dm,
            "Private B instruction".into(),
            None,
            None,
        )
        .unwrap();
    assert!(
        f.request(AgentOperation::Updates {
            after: Some(secret.id)
        })
        .is_err()
    );
    let mut cursor = None;
    let mut delivered = vec![];
    loop {
        let page = f
            .request(AgentOperation::Updates {
                after: cursor.clone(),
            })
            .unwrap();
        let items = page["items"].as_array().unwrap();
        assert!(items.len() <= 32);
        delivered.extend(items.iter().map(|m| m["id"].as_str().unwrap().to_owned()));
        cursor = page["after"].as_str().map(str::to_owned);
        if page["has_more"] == false {
            break;
        }
    }
    assert_eq!(delivered, expected);
    // Reopen the same local store: its insertion cursor remains valid.
    f.s = Store::open(&f._temp.path().join("test.sqlite")).unwrap();
    assert!(
        f.request(AgentOperation::Updates {
            after: cursor.clone()
        })
        .unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    // A remote author's older clock must not put a newly replicated message
    // behind an already-delivered cursor. Sign it on a separate replica.
    let mut remote = Store::open(&f._temp.path().join("remote.sqlite")).unwrap();
    remote.import(&f.s.delta(&f.mission, &[]).unwrap()).unwrap();
    let event = remote
        .send_message(
            &f.outsider,
            &f.mission,
            "main",
            "Arrived after partition".into(),
            None,
            None,
        )
        .unwrap();
    let mut body = event.body.clone();
    body.created_at_ms = Some(1);
    let late = f.outsider.sign(body).unwrap();
    f.s.import(&[late.bytes().to_vec()]).unwrap();
    let page = f
        .request(AgentOperation::Updates { after: cursor })
        .unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["id"], late.id);
    assert_eq!(page["items"][0]["created_at_ms"], 1);
}

#[test]
fn new_registration_keeps_old_history_readable_without_replaying_it_as_pending_work() {
    let mut f = Fixture::new();
    let historical =
        f.s.send_message(
            &f.owner,
            &f.mission,
            "main",
            "Earlier direction, now superseded".into(),
            None,
            None,
        )
        .unwrap();
    let newcomer = f.key("newcomer");
    let registration =
        f.s.offer_agent(
            &f.host,
            &f.mission,
            &f.mission,
            AgentIdentity {
                author: newcomer.public_key(),
                label: "newcomer".into(),
                runtime: "grok".into(),
                role: AgentRole::Agent,
                contributor_name: "Host".into(),
            },
        )
        .unwrap()
        .id;
    let instruction =
        f.s.send_message(
            &f.owner,
            &f.mission,
            "main",
            "The current direction".into(),
            None,
            None,
        )
        .unwrap();
    let pending =
        f.s.agent_request(
            &f.host,
            &f.mission,
            "newcomer",
            &registration,
            AgentOperation::Updates { after: None },
        )
        .unwrap();
    assert_eq!(pending["items"].as_array().unwrap().len(), 1);
    assert_eq!(pending["items"][0]["id"], instruction.id);
    let old =
        f.s.agent_request(
            &f.host,
            &f.mission,
            "newcomer",
            &registration,
            AgentOperation::Message {
                id: historical.id.clone(),
            },
        )
        .unwrap();
    assert_eq!(old["id"], historical.id);
}

#[test]
fn priority_messages_cannot_be_hidden_behind_unrelated_dependency_wait_chatter() {
    let mut f = Fixture::new();
    f.start();
    let b = f.key("b");
    for n in 0..70 {
        f.s.send_message(
            &b,
            &f.mission,
            "main",
            format!("Unrelated result {n}"),
            None,
            None,
        )
        .unwrap();
    }
    let human =
        f.s.send_message(
            &f.owner,
            &f.mission,
            "main",
            "Stop waiting and review the changed brief".into(),
            None,
            None,
        )
        .unwrap();
    let snapshot = f
        .request(AgentOperation::Snapshot {
            watch: vec![],
            after: None,
            priority_after: None,
        })
        .unwrap();
    assert_eq!(snapshot["updates"]["items"].as_array().unwrap().len(), 32);
    assert!(!snapshot["updates"].to_string().contains(&human.id));
    assert_eq!(snapshot["priority"]["items"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["priority"]["items"][0]["id"], human.id);
    let directed =
        f.s.send_message(
            &b,
            &f.mission,
            "main",
            "Please check this counterexample".into(),
            Some(f.key("a").public_key()),
            None,
        )
        .unwrap();
    let page = f
        .request(AgentOperation::PriorityUpdates {
            after: Some(human.id),
        })
        .unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["id"], directed.id);
    // Priority delivery never consumes or discards the ordinary conversation.
    assert_eq!(
        f.request(AgentOperation::Updates { after: None }).unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        32
    );
}
