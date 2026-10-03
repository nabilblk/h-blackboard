use harakiri_node::{
    communication::{AgentOperation, MessageFeed, MessageQuery},
    store::Store,
};
use harakiri_protocol::{
    ArtifactFile, Event, Identity, MissionDefinition, Payload,
    agents::{AgentIdentity, AgentRole, AgentStatus},
    lifecycle::ControlAction,
    policy::{Coordination, MissionBudget, MissionPolicy, Participation},
    work::*,
};
use rand::{SeedableRng, seq::SliceRandom};

struct Fixture {
    temp: tempfile::TempDir,
    s: Store,
    owner: Identity,
    host: Identity,
    mission: String,
    a: String,
    b: String,
}
impl Fixture {
    fn new() -> Self {
        Self::with_mode(Coordination::Peer)
    }
    fn with_mode(mode: Coordination) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let mut s = Store::open(&temp.path().join("a.sqlite")).unwrap();
        let owner = Identity::from_seed([71; 32]);
        let host = Identity::from_seed([72; 32]);
        let mission = s
            .create(
                &owner,
                "71".repeat(32),
                MissionDefinition {
                    name: "Festival".into(),
                    objective: "Make a usable plan".into(),
                    scope: "Plan and compare".into(),
                    criteria: vec![],
                    policy: Some(MissionPolicy {
                        coordination: mode,
                        participation: Participation::Private,
                        budget: MissionBudget::Unlimited {},
                    }),
                },
            )
            .unwrap()
            .id;
        s.append(
            &owner,
            &mission,
            Payload::MemberAdmitted {
                member: host.public_key(),
                endpoint: "72".repeat(32),
            },
        )
        .unwrap();
        let mut offer = |name: &str| {
            s.offer_agent(
                &host,
                &mission,
                &mission,
                AgentIdentity {
                    author: host
                        .coordinator_identity(&mission, name)
                        .unwrap()
                        .public_key(),
                    label: name.into(),
                    contributor_name: "Contributor".into(),
                    runtime: "grok".into(),
                    role: AgentRole::Agent,
                },
            )
            .unwrap()
            .id
        };
        let a = offer("a");
        let b = offer("b");
        Self {
            temp,
            s,
            owner,
            host,
            mission,
            a,
            b,
        }
    }
    fn key(&self, name: &str) -> Identity {
        self.host.coordinator_identity(&self.mission, name).unwrap()
    }
    fn control(&mut self, action: ControlAction) -> String {
        let c = self
            .s
            .control_state(&self.mission)
            .unwrap()
            .lifecycle
            .revision;
        self.s
            .control(&self.owner, &self.mission, &c, action)
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
    fn work(&mut self, actor: &Identity, a: WorkAction) -> anyhow::Result<Event> {
        let c = self.s.control_state(&self.mission)?.lifecycle.revision;
        self.s.work(actor, &self.mission, &c, a)
    }
    fn owner_work(&mut self, a: WorkAction) -> Event {
        self.work(&self.owner.clone(), a).unwrap()
    }
    fn tasks(&self) -> Vec<TaskView> {
        self.s
            .tasks(
                &self.mission,
                &self.owner.public_key(),
                TaskQuery::default(),
            )
            .unwrap()
            .items
    }
    fn stream(&mut self) -> Event {
        self.owner_work(WorkAction::CreateWorkstream {
            name: "Access".into(),
            goal: "Compare two accessible routes".into(),
        })
    }
    fn task(&mut self, assignees: Vec<String>) -> Event {
        self.owner_work(WorkAction::CreateTask {
            definition: definition(None),
            assignees,
        })
    }
    fn report(
        &mut self,
        actor: &Identity,
        task: &str,
        reg: &str,
        status: AttemptStatus,
        evidence: Vec<String>,
    ) -> anyhow::Result<Event> {
        self.work(
            actor,
            WorkAction::ReportAttempt {
                task: task.into(),
                task_revision: task.into(),
                allocation: task.into(),
                registration: reg.into(),
                bases: vec![],
                status,
                summary: "Measured the route and recorded limitations".into(),
                evidence,
            },
        )
    }
}
fn definition(workstream: Option<String>) -> TaskDefinition {
    TaskDefinition {
        title: "Compare the routes".into(),
        description: "Choose a step-free route with evidence".into(),
        criteria: vec!["Document walking distance".into()],
        workstream,
    }
}

#[test]
fn optional_objects_never_release_work_before_start_and_assignment_needs_receipt() {
    let mut f = Fixture::new();
    let key = f.key("a");
    assert!(
        f.work(
            &key,
            WorkAction::CreateWorkstream {
                name: "Early".into(),
                goal: "Premature".into()
            }
        )
        .is_err()
    );
    let stream = f.stream();
    let assigned = f.owner_work(WorkAction::AssignWorkstream {
        registration: f.a.clone(),
        workstream: Some(stream.id.clone()),
        goal_revision: Some(stream.id.clone()),
        direction: "Compare routes".into(),
    });
    assert_eq!(
        f.s.agent_views(&f.mission).unwrap()[0].status,
        AgentStatus::WaitingForStart
    );
    assert!(f.tasks().is_empty());
    let start = f.start();
    let a =
        f.s.agent_views(&f.mission)
            .unwrap()
            .into_iter()
            .find(|a| a.id == f.a)
            .unwrap();
    assert_eq!(a.direction.unwrap().id, assigned.id);
    assert!(a.acknowledgment.is_none());
    f.s.agent_request(
        &f.host,
        &f.mission,
        "a",
        &f.a,
        AgentOperation::Acknowledge {
            control: start,
            direction: assigned.id,
        },
    )
    .unwrap();
    assert!(
        f.s.agent_views(&f.mission)
            .unwrap()
            .into_iter()
            .find(|a| a.id == f.a)
            .unwrap()
            .acknowledgment
            .is_some()
    );
    let task = f
        .work(
            &key,
            WorkAction::CreateTask {
                definition: definition(None),
                assignees: vec![],
            },
        )
        .unwrap();
    let t = f.tasks().into_iter().find(|t| t.id == task.id).unwrap();
    assert_eq!(t.definition.workstream, Some(stream.id.clone()));
    assert_eq!(t.attempts[0].registration, f.a);
    assert_eq!(t.status, "planned");
    f.owner_work(WorkAction::ReviseWorkstream {
        workstream: stream.id.clone(),
        bases: vec![stream.id],
        name: "Access".into(),
        goal: "New venue requires another route".into(),
    });
    let a =
        f.s.agent_views(&f.mission)
            .unwrap()
            .into_iter()
            .find(|a| a.id == f.a)
            .unwrap();
    assert_eq!(a.status, AgentStatus::WaitingForDirection);
    assert!(a.acknowledgment.is_none());
}

#[test]
fn public_workstream_messages_keep_their_channel_in_threads_inbox_search_and_restart() {
    let mut f = Fixture::new();
    let stream = f.stream();
    let channel = format!("workstream:{}", stream.id);
    let posted =
        f.s.send_message(
            &f.owner,
            &f.mission,
            &channel,
            "Public route table".into(),
            Some(f.key("a").public_key()),
            None,
        )
        .unwrap();
    let reply =
        f.s.send_message(
            &f.key("a"),
            &f.mission,
            &channel,
            "Verified ramp".into(),
            None,
            Some(posted.id.clone()),
        )
        .unwrap();
    assert!(
        f.s.send_message(
            &f.key("a"),
            &f.mission,
            "main",
            "Wrong channel".into(),
            None,
            Some(posted.id.clone())
        )
        .is_err()
    );
    let main =
        f.s.query_messages(
            &f.mission,
            &f.owner.public_key(),
            MessageQuery::conversation("main", None),
        )
        .unwrap();
    assert!(!main.items.iter().any(|m| m.id == posted.id));
    let mut q = MessageQuery::conversation(&channel, None);
    q.thread = Some(posted.id.clone());
    let page =
        f.s.query_messages(&f.mission, &f.owner.public_key(), q)
            .unwrap();
    assert_eq!(page.items.len(), 2);
    assert!(page.items.iter().all(|m| m.audience == channel));
    let mut q = MessageQuery::conversation("main", None);
    q.view = MessageFeed::Inbox;
    let page =
        f.s.query_messages(&f.mission, &f.owner.public_key(), q)
            .unwrap();
    assert!(page.items.iter().any(|m| m.id == reply.id));
    drop(f.s);
    let s = Store::open(&f.temp.path().join("a.sqlite")).unwrap();
    let mut q = MessageQuery::conversation(&channel, None);
    q.search = Some("ramp".into());
    assert_eq!(
        s.query_messages(&f.mission, &f.owner.public_key(), q)
            .unwrap()
            .items[0]
            .id,
        reply.id
    );
}

#[test]
fn parallel_attempts_preserve_ownership_reports_and_private_evidence_is_rejected() {
    let mut f = Fixture::new();
    f.start();
    let t = f.task(vec![f.a.clone(), f.b.clone()]);
    f.report(
        &f.key("a"),
        &t.id,
        &f.a.clone(),
        AttemptStatus::InProgress,
        vec![],
    )
    .unwrap();
    assert!(
        f.report(
            &f.key("b"),
            &t.id,
            &f.a.clone(),
            AttemptStatus::Blocked,
            vec![]
        )
        .is_err()
    );
    let private =
        f.s.open_agent_conversation(&f.owner, &f.mission, &f.b)
            .unwrap();
    let msg =
        f.s.send_message(
            &f.owner,
            &f.mission,
            &private,
            "Private access requirement".into(),
            None,
            None,
        )
        .unwrap();
    assert!(
        f.report(
            &f.key("b"),
            &t.id,
            &f.b.clone(),
            AttemptStatus::Submitted,
            vec![msg.id]
        )
        .is_err()
    );
    assert!(
        f.report(
            &f.key("b"),
            &t.id,
            &f.b.clone(),
            AttemptStatus::Complete,
            vec![]
        )
        .is_err()
    );
    // A draft in the new lifecycle is not a delivered contribution.
    let current = f.s.control_state(&f.mission).unwrap().lifecycle.revision;
    let draft =
        f.s.artifact_action(
            &f.key("b"),
            &f.mission,
            &current,
            "main",
            harakiri_protocol::artifacts::ArtifactAction::Publish {
                artifact: None,
                parents: vec![],
                document: harakiri_protocol::artifacts::ArtifactDocument {
                    title: "Draft route".into(),
                    summary: "Measurements still pending".into(),
                    kind: harakiri_protocol::artifacts::ArtifactKind::Report,
                    stage: harakiri_protocol::artifacts::ArtifactStage::Draft,
                    limitations: "Draft only".into(),
                    entrypoint: Some("report.md".into()),
                    inputs: vec![],
                    files: vec![ArtifactFile {
                        path: "report.md".into(),
                        hash: blake3::hash(b"Draft").to_hex().to_string(),
                        size: 5,
                        media_type: "text/markdown".into(),
                    }],
                },
            },
        )
        .unwrap();
    assert!(
        f.report(
            &f.key("b"),
            &t.id,
            &f.b.clone(),
            AttemptStatus::Complete,
            vec![draft.id]
        )
        .is_err()
    );
    let artifact =
        f.s.append(
            &f.key("b"),
            &f.mission,
            Payload::ArtifactPublished {
                title: "Route evidence".into(),
                files: vec![ArtifactFile {
                    path: "report.md".into(),
                    hash: blake3::hash(b"Evidence").to_hex().to_string(),
                    size: 8,
                    media_type: "text/markdown".into(),
                }],
            },
        )
        .unwrap();
    f.report(
        &f.key("b"),
        &t.id,
        &f.b.clone(),
        AttemptStatus::Complete,
        vec![artifact.id],
    )
    .unwrap();
    let tasks = f.tasks();
    assert_eq!(tasks[0].attempts.len(), 2);
    assert_eq!(tasks[0].status, "in_progress");
    assert_eq!(
        f.s.control_state(&f.mission).unwrap().lifecycle.phase,
        harakiri_protocol::lifecycle::MissionPhase::Active
    );
    f.s.withdraw_agent(&f.host, &f.mission, &f.a).unwrap();
    assert!(
        f.tasks()[0]
            .attempts
            .iter()
            .find(|a| a.registration == f.a)
            .unwrap()
            .unavailable
    );
}

#[test]
fn concurrent_revisions_converge_preserve_conflicts_and_require_explicit_resolution() {
    let mut f = Fixture::new();
    f.start();
    let root = f.stream();
    let baseline = f.s.delta(&f.mission, &[]).unwrap();
    let mut other = Store::open(&f.temp.path().join("b.sqlite")).unwrap();
    other.import(&baseline).unwrap();
    let control = f.s.control_state(&f.mission).unwrap().lifecycle.revision;
    let a = f.owner_work(WorkAction::ReviseWorkstream {
        workstream: root.id.clone(),
        bases: vec![root.id.clone()],
        name: "Access".into(),
        goal: "Human proposed route".into(),
    });
    let b = other
        .work(
            &f.key("a"),
            &f.mission,
            &control,
            WorkAction::ReviseWorkstream {
                workstream: root.id.clone(),
                bases: vec![root.id.clone()],
                name: "Access".into(),
                goal: "Agent proposed route".into(),
            },
        )
        .unwrap();
    f.s.import(&[b.bytes().to_vec()]).unwrap();
    other.import(&[a.bytes().to_vec()]).unwrap();
    assert_eq!(
        f.s.workstreams(&f.mission, &f.owner.public_key()).unwrap()[0]
            .heads
            .len(),
        2
    );
    assert!(
        f.work(
            &f.owner.clone(),
            WorkAction::AssignWorkstream {
                registration: f.a.clone(),
                workstream: Some(root.id.clone()),
                goal_revision: Some(a.id.clone()),
                direction: "Do it".into()
            }
        )
        .is_err()
    );
    let mut history = baseline;
    history.extend([a.bytes().to_vec(), b.bytes().to_vec()]);
    let expected =
        serde_json::to_value(f.s.workstreams(&f.mission, &f.owner.public_key()).unwrap()).unwrap();
    let mut rng = rand::rngs::StdRng::seed_from_u64(1003);
    for trial in 0..12 {
        let path = f.temp.path().join(format!("shuffle-{trial}.sqlite"));
        let mut replica = Store::open(&path).unwrap();
        let mut bytes = history.clone();
        bytes.extend(history.iter().take(3).cloned());
        bytes.shuffle(&mut rng);
        replica.import(&bytes).unwrap();
        drop(replica);
        let replica = Store::open(&path).unwrap();
        assert_eq!(
            serde_json::to_value(
                replica
                    .workstreams(&f.mission, &f.owner.public_key())
                    .unwrap()
            )
            .unwrap(),
            expected
        );
    }
    assert!(
        f.work(
            &f.owner.clone(),
            WorkAction::ReviseWorkstream {
                workstream: root.id.clone(),
                bases: vec![a.id.clone()],
                name: "Access".into(),
                goal: "Stale editor".into()
            }
        )
        .is_err()
    );
    f.owner_work(WorkAction::ReviseWorkstream {
        workstream: root.id,
        bases: vec![a.id, b.id],
        name: "Access".into(),
        goal: "Resolved with measured evidence".into(),
    });
    assert_eq!(
        f.s.workstreams(&f.mission, &f.owner.public_key()).unwrap()[0]
            .heads
            .len(),
        1
    );
}

#[test]
fn new_task_definition_and_mission_instructions_make_old_reports_stale() {
    let mut f = Fixture::new();
    f.start();
    let t = f.task(vec![f.a.clone()]);
    f.report(
        &f.key("a"),
        &t.id,
        &f.a.clone(),
        AttemptStatus::Submitted,
        vec![],
    )
    .unwrap();
    let mut revised = definition(None);
    revised.criteria.push("Include rain conditions".into());
    f.owner_work(WorkAction::ReviseTask {
        task: t.id.clone(),
        bases: vec![t.id.clone()],
        definition: revised,
    });
    assert!(f.tasks()[0].attempts[0].reports[0].stale);
    let mut definition = f.s.control_state(&f.mission).unwrap().definition;
    definition.scope = "Now includes a second venue".into();
    f.control(ControlAction::UpdateInstructions { definition });
    assert!(f.tasks()[0].stale);
    assert!(
        f.work(
            &f.key("a"),
            WorkAction::AssignTask {
                task: t.id,
                registration: f.a.clone(),
                approach: "Continue stale scope".into()
            }
        )
        .is_err()
    );
}

#[test]
fn task_filters_and_pagination_cover_all_saved_tasks() {
    let mut f = Fixture::new();
    f.start();
    for n in 0..40 {
        let mut d = definition(None);
        d.title = format!("Route {n}");
        f.owner_work(WorkAction::CreateTask {
            definition: d,
            assignees: vec![f.a.clone()],
        });
    }
    let first =
        f.s.tasks(&f.mission, &f.owner.public_key(), TaskQuery::default())
            .unwrap();
    assert_eq!(first.items.len(), 32);
    assert_eq!(first.total, 40);
    let second =
        f.s.tasks(
            &f.mission,
            &f.owner.public_key(),
            TaskQuery {
                after: first.after,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(second.items.len(), 8);
    assert!(second.after.is_none());
    let filtered =
        f.s.tasks(
            &f.mission,
            &f.owner.public_key(),
            TaskQuery {
                search: Some("Route 39".into()),
                owner: Some("contributor".into()),
                status: Some("planned".into()),
                workstream: Some("main".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(filtered.total, 1);
}

#[test]
fn coordinator_can_plan_during_preparation_but_late_agents_require_explicit_direction() {
    use harakiri_protocol::lifecycle::CoordinatorIdentity;
    let mut f = Fixture::with_mode(Coordination::Coordinated);
    let co = f.key("co");
    let reg =
        f.s.offer_agent(
            &f.host,
            &f.mission,
            &f.mission,
            AgentIdentity {
                author: co.public_key(),
                label: "Coordinator".into(),
                contributor_name: "Contributor".into(),
                runtime: "grok".into(),
                role: AgentRole::Coordinator,
            },
        )
        .unwrap();
    let control = f.control(ControlAction::SetCoordination {
        mode: Coordination::Coordinated,
        coordinator: Some(CoordinatorIdentity {
            author: co.public_key(),
            label: "Coordinator".into(),
            runtime: "grok".into(),
        }),
    });
    let stream = f
        .work(
            &co,
            WorkAction::CreateWorkstream {
                name: "Transport".into(),
                goal: "Compare arrival options".into(),
            },
        )
        .unwrap();
    f.work(
        &co,
        WorkAction::CreateTask {
            definition: definition(Some(stream.id.clone())),
            assignees: vec![f.a.clone(), f.b.clone()],
        },
    )
    .unwrap();
    assert!(
        f.work(
            &f.key("a"),
            WorkAction::CreateTask {
                definition: definition(None),
                assignees: vec![]
            }
        )
        .is_err()
    );
    let plan =
        f.s.append(
            &co,
            &f.mission,
            Payload::CoordinatorPlanned {
                control: control.clone(),
                text: "Compare alternatives in parallel".into(),
            },
        )
        .unwrap();
    let ready =
        f.s.append(
            &co,
            &f.mission,
            Payload::CoordinatorReadied {
                control,
                plan: plan.id,
            },
        )
        .unwrap();
    let participants = f.s.start_participants(&f.mission).unwrap();
    let active = f.control(ControlAction::Start {
        participants,
        readiness: Some(ready.id),
    });
    let late = f.key("late");
    let offer =
        f.s.offer_agent(
            &f.host,
            &f.mission,
            &f.mission,
            AgentIdentity {
                author: late.public_key(),
                label: "Late worker".into(),
                contributor_name: "Contributor".into(),
                runtime: "grok".into(),
                role: AgentRole::Agent,
            },
        )
        .unwrap();
    assert!(
        f.s.append(
            &late,
            &f.mission,
            Payload::WorkRecorded {
                control: active.clone(),
                authorization: Some(active.clone()),
                action: WorkAction::CreateTask {
                    definition: definition(None),
                    assignees: vec![offer.id.clone()]
                }
            }
        )
        .is_err()
    );
    assert!(
        f.work(
            &late,
            WorkAction::CreateTask {
                definition: definition(None),
                assignees: vec![]
            }
        )
        .is_err()
    );
    f.work(
        &co,
        WorkAction::AssignWorkstream {
            registration: offer.id.clone(),
            workstream: Some(stream.id.clone()),
            goal_revision: Some(stream.id.clone()),
            direction: "Compare train access".into(),
        },
    )
    .unwrap();
    f.work(
        &late,
        WorkAction::CreateTask {
            definition: definition(None),
            assignees: vec![],
        },
    )
    .unwrap();
    assert!(
        f.work(
            &late,
            WorkAction::AssignTask {
                task: f.tasks()[0].id.clone(),
                registration: f.b.clone(),
                approach: "Assign another agent".into()
            }
        )
        .is_err()
    );
    let human = f.owner_work(WorkAction::AssignWorkstream {
        registration: offer.id.clone(),
        workstream: None,
        goal_revision: None,
        direction: "Focus on Main synthesis".into(),
    });
    assert!(
        f.work(
            &co,
            WorkAction::AssignWorkstream {
                registration: offer.id.clone(),
                workstream: Some(stream.id.clone()),
                goal_revision: Some(stream.id),
                direction: "Override the human".into()
            }
        )
        .is_err()
    );
    assert_eq!(
        f.s.agent_views(&f.mission)
            .unwrap()
            .into_iter()
            .find(|a| a.id == offer.id)
            .unwrap()
            .direction
            .unwrap()
            .id,
        human.id
    );
    f.control(ControlAction::Pause {
        reason: "Review the alternatives".into(),
    });
    assert!(
        f.work(
            &late,
            WorkAction::CreateTask {
                definition: definition(None),
                assignees: vec![]
            }
        )
        .is_err()
    );
    f.s.withdraw_agent(&f.host, &f.mission, &reg.id).unwrap();
    assert!(
        f.work(
            &co,
            WorkAction::CreateWorkstream {
                name: "Later".into(),
                goal: "After withdrawal".into()
            }
        )
        .is_err()
    );
}

#[test]
fn schema_ten_preserves_work_messages_and_rolls_back_damaged_history() {
    let mut f = Fixture::new();
    let stream = f.stream();
    let channel = format!("workstream:{}", stream.id);
    let msg =
        f.s.send_message(
            &f.owner,
            &f.mission,
            &channel,
            "Retained workstream evidence".into(),
            None,
            None,
        )
        .unwrap();
    let path = f.temp.path().join("a.sqlite");
    drop(f.s);
    let downgrade = || {
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("DROP TABLE governance_records; DROP TABLE available_files; DROP TABLE artifact_records; DROP TABLE work_records; DROP INDEX message_channel; ALTER TABLE message_details DROP COLUMN channel; PRAGMA user_version=9;").unwrap();
    };
    downgrade();
    let s = Store::open(&path).unwrap();
    assert_eq!(s.event(&msg.id).unwrap().unwrap().bytes(), msg.bytes());
    assert_eq!(
        s.query_messages(
            &f.mission,
            &f.owner.public_key(),
            MessageQuery::conversation(&channel, None)
        )
        .unwrap()
        .items[0]
            .id,
        msg.id
    );
    drop(s);
    downgrade();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute("UPDATE events SET bytes=x'00' WHERE id=?1", [&msg.id])
        .unwrap();
    drop(db);
    assert!(Store::open(&path).is_err());
    let db = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
            .unwrap(),
        9
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='work_records'",
            [],
            |r| r.get::<_, u32>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn evidence_inspection_does_not_bypass_private_access_or_accept_control_as_evidence() {
    let mut f = Fixture::new();
    let private =
        f.s.open_agent_conversation(&f.owner, &f.mission, &f.a)
            .unwrap();
    let msg =
        f.s.send_message(
            &f.owner,
            &f.mission,
            &private,
            "Private requirement".into(),
            None,
            None,
        )
        .unwrap();
    assert!(
        f.s.work_evidence(&f.mission, &f.owner.public_key(), &msg.id)
            .is_err()
    );
    assert!(
        f.s.work_evidence(&f.mission, &f.owner.public_key(), &f.mission)
            .is_err()
    );
    let public =
        f.s.send_message(
            &f.owner,
            &f.mission,
            "main",
            "Public measurement".into(),
            None,
            None,
        )
        .unwrap();
    assert_eq!(
        f.s.work_evidence(&f.mission, &f.host.public_key(), &public.id)
            .unwrap()
            .text
            .as_deref(),
        Some("Public measurement")
    );
    assert!(
        f.s.work_evidence(
            &f.mission,
            &Identity::from_seed([99; 32]).public_key(),
            &public.id
        )
        .is_err()
    );
}

#[test]
fn complete_artifact_evidence_becomes_stale_when_its_exact_input_changes() {
    use harakiri_protocol::artifacts::*;
    let mut f = Fixture::new();
    f.start();
    let task = f.task(vec![f.a.clone()]);
    let current = f.s.control_state(&f.mission).unwrap().lifecycle.revision;
    let publish = |store: &mut Store,
                   key: &Identity,
                   title: &str,
                   root: Option<String>,
                   parents: Vec<String>,
                   inputs: Vec<String>| {
        store
            .artifact_action(
                key,
                &f.mission,
                &current,
                "main",
                ArtifactAction::Publish {
                    artifact: root,
                    parents,
                    document: ArtifactDocument {
                        title: title.into(),
                        summary: "Complete usable evidence".into(),
                        kind: ArtifactKind::Report,
                        stage: ArtifactStage::Complete,
                        limitations: "Fixture".into(),
                        entrypoint: Some("report.md".into()),
                        inputs,
                        files: vec![ArtifactFile {
                            path: "report.md".into(),
                            hash: blake3::hash(b"Report").to_hex().to_string(),
                            size: 6,
                            media_type: "text/markdown".into(),
                        }],
                    },
                },
            )
            .unwrap()
    };
    let key = f.key("a");
    let brief = publish(&mut f.s, &f.owner, "Brief", None, vec![], vec![]);
    let result = publish(
        &mut f.s,
        &key,
        "Route result",
        None,
        vec![],
        vec![brief.id.clone()],
    );
    // Import/local projection reports the artifact's complete stage and authorship.
    let changed = publish(
        &mut f.s,
        &f.owner,
        "Revised brief",
        Some(brief.id.clone()),
        vec![brief.id.clone()],
        vec![],
    );
    // Use a replica of the prefix to report before the changed input arrives.
    let temp = tempfile::tempdir().unwrap();
    let mut replica = Store::open(&temp.path().join("replica.sqlite")).unwrap();
    let prefix =
        f.s.delta(&f.mission, &[])
            .unwrap()
            .into_iter()
            .filter(|bytes| Event::verify(bytes).unwrap().id != changed.id)
            .collect::<Vec<_>>();
    replica.import(&prefix).unwrap();
    let mut s = std::mem::replace(&mut f.s, replica);
    f.report(
        &key,
        &task.id,
        &f.a.clone(),
        AttemptStatus::Complete,
        vec![result.id.clone()],
    )
    .unwrap();
    assert!(!f.tasks()[0].stale);
    f.s.import(&[changed.bytes().to_vec()]).unwrap();
    assert!(f.tasks()[0].stale);
    assert!(
        f.report(
            &key,
            &task.id,
            &f.a.clone(),
            AttemptStatus::Complete,
            vec![result.id]
        )
        .is_err()
    );
    std::mem::swap(&mut f.s, &mut s);
}
