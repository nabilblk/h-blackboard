use harakiri_node::store::Store;
use harakiri_protocol::{
    Event, EventBody, Identity, MissionDefinition, Payload,
    agents::{AgentIdentity, AgentRole, AgentStatus},
    artifacts::{ArtifactAction, ArtifactDocument, ArtifactKind, ArtifactStage},
    governance::{GovernanceAction as G, GrantPurpose},
    lifecycle::{ControlAction as C, CoordinatorIdentity, MissionPhase},
    policy::{Coordination, MissionBudget, MissionPolicy, Participation},
    work::{TaskDefinition, WorkAction},
};
use rand::{SeedableRng, seq::SliceRandom};

struct F {
    dir: tempfile::TempDir,
    s: Store,
    owner: Identity,
    host: Identity,
    worker: Identity,
    m: String,
    reg: String,
}
impl F {
    fn new(mode: Coordination) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(&dir.path().join("source.sqlite")).unwrap();
        let owner = Identity::from_seed([201; 32]);
        let host = Identity::from_seed([202; 32]);
        let worker = Identity::from_seed([203; 32]);
        let m = s
            .create(
                &owner,
                "01".repeat(32),
                MissionDefinition {
                    name: "Retained contribution".into(),
                    objective: "Investigate options".into(),
                    scope: "Research only".into(),
                    criteria: vec!["Evidence reviewed".into()],
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
            &m,
            Payload::MemberAdmitted {
                member: host.public_key(),
                endpoint: "02".repeat(32),
            },
        )
        .unwrap();
        let reg = s
            .offer_agent(
                &host,
                &m,
                &m,
                descriptor(&worker, AgentRole::Agent, "Worker"),
            )
            .unwrap()
            .id;
        Self {
            dir,
            s,
            owner,
            host,
            worker,
            m,
            reg,
        }
    }
    fn control(&mut self, a: C) -> Event {
        let revision = self.s.control_state(&self.m).unwrap().lifecycle.revision;
        self.s.control(&self.owner, &self.m, &revision, a).unwrap()
    }
    fn change(&mut self) -> Event {
        let mut definition = self.s.control_state(&self.m).unwrap().definition;
        definition.objective.push_str(" with updated constraints");
        self.control(C::UpdateInstructions { definition })
    }
    fn start(&mut self, readiness: Option<String>) -> Event {
        let participants = self.s.start_participants(&self.m).unwrap();
        self.control(C::Start {
            readiness,
            participants,
        })
    }
    fn all(&self) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        let mut after = None;
        loop {
            let page = self
                .s
                .history_page(&self.m, "main", after.as_deref())
                .unwrap();
            out.extend(page.events);
            if !page.more {
                break;
            }
            after = page.after;
        }
        out
    }
    fn replica(&self, name: &str, history: &[Vec<u8>]) -> Store {
        let mut s = Store::open(&self.dir.path().join(format!("{name}.sqlite"))).unwrap();
        for chunk in history.chunks(256) {
            s.import(chunk).unwrap();
        }
        s
    }
    fn signed(&self, identity: &Identity, authority: &str, payload: Payload) -> Event {
        let head = self.s.head(&self.m, &identity.public_key()).unwrap();
        identity
            .sign(EventBody {
                version: 14,
                mission: Some(self.m.clone()),
                author: identity.public_key(),
                audience: "main".into(),
                sequence: head.as_ref().map_or(0, |h| h.sequence + 1),
                previous: head.map(|h| h.id),
                authority: Some(authority.into()),
                created_at_ms: Some(1),
                terms_reviews: Default::default(),
                payload,
            })
            .unwrap()
    }
}
fn descriptor(key: &Identity, role: AgentRole, name: &str) -> AgentIdentity {
    AgentIdentity {
        author: key.public_key(),
        label: name.into(),
        runtime: "grok".into(),
        role,
        contributor_name: "Contributor".into(),
    }
}

#[test]
fn renewal_keeps_identity_and_requires_fresh_coordinator_readiness_and_human_start() {
    let mut f = F::new(Coordination::Coordinated);
    let co = Identity::from_seed([204; 32]);
    let coreg =
        f.s.offer_agent(
            &f.host,
            &f.m,
            &f.m,
            descriptor(&co, AgentRole::Coordinator, "Coordinator"),
        )
        .unwrap()
        .id;
    let appointment = f.control(C::SetCoordination {
        mode: Coordination::Coordinated,
        coordinator: Some(CoordinatorIdentity {
            author: co.public_key(),
            label: "Coordinator".into(),
            runtime: "grok".into(),
        }),
    });
    let plan =
        f.s.append(
            &co,
            &f.m,
            Payload::CoordinatorPlanned {
                control: appointment.id.clone(),
                text: "Original plan".into(),
            },
        )
        .unwrap();
    assert_eq!(plan.body.terms_reviews.get(&coreg), Some(&coreg));
    let ready =
        f.s.append(
            &co,
            &f.m,
            Payload::CoordinatorReadied {
                control: appointment.id,
                plan: plan.id,
            },
        )
        .unwrap();
    let start = f.start(Some(ready.id));
    let direction =
        f.s.direct_agent(&f.owner, &f.m, &start.id, &f.reg, "Original task".into())
            .unwrap();
    f.s.append(
        &f.worker,
        &f.m,
        Payload::AgentAcknowledged {
            registration: f.reg.clone(),
            control: start.id,
            direction: direction.id,
        },
    )
    .unwrap();
    let update = f.change();
    assert!(
        f.s.agent_views(&f.m)
            .unwrap()
            .iter()
            .all(|a| a.status == AgentStatus::ReviewRequired)
    );
    assert!(
        f.s.control_state(&f.m)
            .unwrap()
            .lifecycle
            .readiness
            .is_none()
    );
    assert!(
        f.s.review_agent_terms(&f.owner, &f.m, &f.reg, &update.id)
            .is_err()
    );
    assert!(
        f.s.review_agent_terms(&f.worker, &f.m, &f.reg, &update.id)
            .is_err()
    );
    let worker_review =
        f.s.review_agent_terms(&f.host, &f.m, &f.reg, &update.id)
            .unwrap();
    let coordinator_review =
        f.s.review_agent_terms(&f.host, &f.m, &coreg, &update.id)
            .unwrap();
    assert_eq!(
        worker_review.id,
        f.s.review_agent_terms(&f.host, &f.m, &f.reg, &update.id)
            .unwrap()
            .id
    );
    let views = f.s.agent_views(&f.m).unwrap();
    assert_eq!(views.len(), 2);
    assert!(
        views
            .iter()
            .all(|a| a.status == AgentStatus::WaitingForStart
                && a.direction.is_none()
                && a.acknowledgment.is_none())
    );
    assert!(
        f.s.control_state(&f.m)
            .unwrap()
            .lifecycle
            .readiness
            .is_none()
    );
    let plan =
        f.s.append(
            &co,
            &f.m,
            Payload::CoordinatorPlanned {
                control: update.id.clone(),
                text: "Fresh reviewed plan".into(),
            },
        )
        .unwrap();
    assert_eq!(
        plan.body.terms_reviews.get(&coreg),
        Some(&coordinator_review.id)
    );
    let before_direction = f.all();
    let directed =
        f.s.direct_agent(
            &co,
            &f.m,
            &update.id,
            &f.reg,
            "Review the updated plan".into(),
        )
        .unwrap();
    assert_eq!(
        directed.body.terms_reviews.get(&coreg),
        Some(&coordinator_review.id)
    );
    assert_eq!(
        directed.body.terms_reviews.get(&f.reg),
        Some(&worker_review.id)
    );
    for (i, registration) in [&coreg, &f.reg].into_iter().enumerate() {
        let mut body = directed.body.clone();
        body.terms_reviews.remove(registration);
        let forged = co.sign(body).unwrap();
        let mut replica = f.replica(&format!("missing-actor-or-target-{i}"), &before_direction);
        assert!(replica.import(&[forged.bytes().to_vec()]).is_err());
    }
    let ready =
        f.s.append(
            &co,
            &f.m,
            Payload::CoordinatorReadied {
                control: update.id.clone(),
                plan: plan.id,
            },
        )
        .unwrap();
    let start = f.start(Some(ready.id));
    assert_eq!(
        start.body.terms_reviews.get(&f.reg),
        Some(&worker_review.id)
    );
    assert_eq!(
        start.body.terms_reviews.get(&coreg),
        Some(&coordinator_review.id)
    );
    assert_eq!(
        f.s.governance(&f.m, &f.host.public_key())
            .unwrap()
            .grants
            .len(),
        0
    );
    let task =
        f.s.work(
            &f.worker,
            &f.m,
            &start.id,
            WorkAction::CreateTask {
                definition: TaskDefinition {
                    title: "Revised investigation".into(),
                    description: "Use renewed terms".into(),
                    criteria: vec![],
                    workstream: None,
                },
                assignees: vec![],
            },
        )
        .unwrap();
    assert_eq!(task.body.terms_reviews.get(&f.reg), Some(&worker_review.id));
    let mut history = f.all();
    history.shuffle(&mut rand::rngs::StdRng::seed_from_u64(7));
    let replay = f.replica("shuffled", &history);
    assert_eq!(
        replay.control_state(&f.m).unwrap().lifecycle.phase,
        MissionPhase::Active
    );
    assert!(
        replay
            .agent_views(&f.m)
            .unwrap()
            .iter()
            .all(|a| a.status == AgentStatus::DirectionAssigned && a.terms_revision == update.id)
    );
    drop(replay);
    let reopened = Store::open(&f.dir.path().join("shuffled.sqlite")).unwrap();
    assert_eq!(
        reopened.event(&worker_review.id).unwrap().unwrap().bytes(),
        worker_review.bytes()
    );
}

#[test]
fn exact_start_proof_defers_missing_history_but_later_review_never_repairs_absent_proof() {
    let mut f = F::new(Coordination::Peer);
    let update = f.change();
    let prefix = f.all();
    let invalid = f.signed(
        &f.owner,
        &f.m,
        Payload::MissionControlled {
            previous: update.id.clone(),
            action: C::Start {
                readiness: None,
                participants: vec![f.reg.clone()],
            },
        },
    );
    let review =
        f.s.review_agent_terms(&f.host, &f.m, &f.reg, &update.id)
            .unwrap();
    let valid = f.start(None);
    for reviewed in [false, true] {
        let mut s = f.replica(if reviewed { "reviewed" } else { "unreviewed" }, &prefix);
        if reviewed {
            s.import(&[review.bytes().to_vec()]).unwrap();
        }
        assert!(s.import(&[invalid.bytes().to_vec()]).is_err());
        assert!(s.event(&invalid.id).unwrap().is_none());
    }
    let mut delayed = f.replica("delayed", &prefix);
    let err = delayed.import(&[valid.bytes().to_vec()]).unwrap_err();
    assert!(err.to_string().contains("missing causal history"));
    delayed
        .import(&[valid.bytes().to_vec(), review.bytes().to_vec()])
        .unwrap();
    assert_eq!(
        delayed.agent_views(&f.m).unwrap()[0].status,
        AgentStatus::DirectionAssigned
    );
}

#[test]
fn all_renewed_actions_bind_proof_and_old_grants_cannot_resume() {
    let mut f = F::new(Coordination::Peer);
    let old_start = f.start(None);
    let allocation =
        f.s.govern(
            &f.owner,
            &f.m,
            &old_start.id,
            G::Allocate {
                node: f.host.public_key(),
                turns: None,
                slots: 1,
            },
        )
        .unwrap();
    let expiry = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 60_000;
    let old =
        f.s.govern(
            &f.owner,
            &f.m,
            &old_start.id,
            G::Grant {
                purpose: GrantPurpose::Work,
                previous: None,
                allocation: allocation.id.clone(),
                registration: f.reg.clone(),
                direction: old_start.id.clone(),
                execution: "ef".repeat(32),
                generation: 1,
                turns: 1,
                expires_ms: expiry,
                offline_ms: 30_000,
            },
        )
        .unwrap();
    let update = f.change();
    // Recovery remains possible while every contribution requires review.
    let seal =
        f.s.govern(
            &f.host,
            &f.m,
            &update.id,
            G::SealGrant {
                grant: old.id.clone(),
                settlements: vec![],
            },
        )
        .unwrap();
    f.s.review_agent_terms(&f.host, &f.m, &f.reg, &update.id)
        .unwrap();
    let started = f.start(None);
    assert!(
        f.s.govern(
            &f.host,
            &f.m,
            &started.id,
            G::Consent {
                grant: old.id,
                binding: "fa".repeat(32)
            }
        )
        .is_err()
    );
    let mut cases = Vec::new();
    let before = f.all();
    let direction =
        f.s.direct_agent(
            &f.owner,
            &f.m,
            &started.id,
            &f.reg,
            "Updated direction".into(),
        )
        .unwrap();
    cases.push((before, direction.clone(), &f.owner));
    let before = f.all();
    let ack =
        f.s.append(
            &f.worker,
            &f.m,
            Payload::AgentAcknowledged {
                registration: f.reg.clone(),
                control: started.id.clone(),
                direction: direction.id.clone(),
            },
        )
        .unwrap();
    cases.push((before, ack, &f.worker));
    let before = f.all();
    let clarification =
        f.s.clarify_agent(
            &f.owner,
            &f.m,
            &started.id,
            &f.reg,
            &direction.id,
            "Use the reviewed scope".into(),
        )
        .unwrap();
    cases.push((before, clarification, &f.owner));
    let before = f.all();
    let task =
        f.s.work(
            &f.worker,
            &f.m,
            &started.id,
            WorkAction::CreateTask {
                definition: TaskDefinition {
                    title: "Inspect evidence".into(),
                    description: "Respect current scope".into(),
                    criteria: vec![],
                    workstream: None,
                },
                assignees: vec![],
            },
        )
        .unwrap();
    cases.push((before, task, &f.worker));
    let before = f.all();
    let artifact =
        f.s.artifact_action(
            &f.worker,
            &f.m,
            &started.id,
            "main",
            ArtifactAction::Publish {
                artifact: None,
                parents: vec![],
                document: ArtifactDocument {
                    title: "Draft findings".into(),
                    summary: "Current investigation".into(),
                    kind: ArtifactKind::Report,
                    stage: ArtifactStage::Draft,
                    limitations: "Not complete".into(),
                    entrypoint: None,
                    inputs: vec![],
                    references: vec![],
                    files: vec![harakiri_protocol::ArtifactFile {
                        path: "report.txt".into(),
                        hash: "ae".repeat(32),
                        size: 1,
                        media_type: "text/plain".into(),
                    }],
                },
            },
        )
        .unwrap();
    cases.push((before, artifact, &f.worker));
    let before = f.all();
    let grant =
        f.s.govern(
            &f.owner,
            &f.m,
            &started.id,
            G::Grant {
                purpose: GrantPurpose::Work,
                previous: Some(seal.id),
                allocation: allocation.id,
                registration: f.reg.clone(),
                direction: direction.id,
                execution: "ef".repeat(32),
                generation: 2,
                turns: 1,
                expires_ms: expiry,
                offline_ms: 30_000,
            },
        )
        .unwrap();
    cases.push((before, grant, &f.owner));
    for (i, (prefix, event, signer)) in cases.iter().enumerate() {
        assert!(event.body.terms_reviews.contains_key(&f.reg));
        let mut body = event.body.clone();
        body.terms_reviews.clear();
        let without_review = signer.sign(body).unwrap();
        let mut s = f.replica(&format!("missing-{i}"), prefix);
        assert!(
            s.import(&[without_review.bytes().to_vec()]).is_err(),
            "accepted missing proof in {:?}",
            event.body.payload
        );
        s.import(&[event.bytes().to_vec()]).unwrap();
    }
}

#[test]
fn withdrawal_and_revocation_are_terminal_but_do_not_break_earlier_signed_reviews() {
    let mut f = F::new(Coordination::Peer);
    let update = f.change();
    let review =
        f.s.review_agent_terms(&f.host, &f.m, &f.reg, &update.id)
            .unwrap();
    f.s.withdraw_agent(&f.host, &f.m, &f.reg).unwrap();
    assert!(
        f.s.review_agent_terms(&f.host, &f.m, &f.reg, &update.id)
            .is_err()
    );
    let late = f.signed(
        &f.host,
        f.s.event(&review.id)
            .unwrap()
            .unwrap()
            .body
            .authority
            .as_deref()
            .unwrap(),
        Payload::AgentTermsReviewed {
            registration: f.reg.clone(),
            control: update.id,
        },
    );
    assert!(f.s.import(&[late.bytes().to_vec()]).is_err());
    let mut history = f.all();
    history.reverse();
    let s = f.replica("withdrawn-reordered", &history);
    assert_eq!(
        s.agent_views(&f.m).unwrap()[0].status,
        AgentStatus::Withdrawn
    );
    assert!(s.event(&review.id).unwrap().is_some());

    let mut f = F::new(Coordination::Peer);
    let update = f.change();
    let review =
        f.s.review_agent_terms(&f.host, &f.m, &f.reg, &update.id)
            .unwrap();
    f.s.append(
        &f.owner,
        &f.m,
        Payload::MemberRevoked {
            member: f.host.public_key(),
            accepted: Some(f.reg.clone()),
        },
    )
    .unwrap();
    assert!(
        f.s.review_agent_terms(&f.host, &f.m, &f.reg, &update.id)
            .is_err()
    );
    let mut history = f.all();
    history.reverse();
    let s = f.replica("revoked-reordered", &history);
    assert_eq!(s.agent_views(&f.m).unwrap()[0].status, AgentStatus::Revoked);
    assert!(s.provisional(&review.id).unwrap());
}

#[test]
fn renewal_rejects_foreign_proofs_stale_confirmation_closed_mission_and_identity_impersonation() {
    let mut f = F::new(Coordination::Peer);
    let old = f.m.clone();
    let update = f.change();
    assert!(f.s.review_agent_terms(&f.host, &f.m, &f.reg, &old).is_err());
    let review =
        f.s.review_agent_terms(&f.host, &f.m, &f.reg, &update.id)
            .unwrap();
    let foreign =
        f.s.create(
            &f.owner,
            "03".repeat(32),
            f.s.control_state(&f.m).unwrap().definition,
        )
        .unwrap();
    let foreign_offer =
        f.s.offer_agent(
            &f.owner,
            &foreign.id,
            &foreign.id,
            descriptor(&f.worker, AgentRole::Agent, "Other mission"),
        )
        .unwrap();
    let candidate = f.signed(
        &f.owner,
        &f.m,
        Payload::MissionControlled {
            previous: update.id.clone(),
            action: C::Start {
                readiness: None,
                participants: vec![f.reg.clone()],
            },
        },
    );
    for proof in [&foreign_offer.id, &update.id, &f.reg] {
        let mut body = candidate.body.clone();
        body.terms_reviews.insert(f.reg.clone(), proof.clone());
        let invalid = f.owner.sign(body).unwrap();
        assert!(f.s.import(&[invalid.bytes().to_vec()]).is_err());
    }
    let mut bad = review.body.clone();
    bad.author = f.owner.public_key();
    let head = f.s.head(&f.m, &bad.author).unwrap().unwrap();
    bad.sequence = head.sequence + 1;
    bad.previous = Some(head.id);
    bad.authority = Some(f.m.clone());
    let bad = f.owner.sign(bad).unwrap();
    assert!(f.s.import(&[bad.bytes().to_vec()]).is_err());
    f.control(C::Close {
        reason: "Human closed the mission".into(),
    });
    assert!(
        f.s.review_agent_terms(&f.host, &f.m, &f.reg, &update.id)
            .is_err()
    );
}

#[test]
fn sync_protocol_negotiation_tracks_the_signed_event_version() {
    assert_eq!(
        harakiri_node::peer::ALPN,
        format!("harakiri/sync/{}", harakiri_protocol::limits::VERSION).as_bytes()
    );
}

#[test]
fn schema_seventeen_preserves_existing_signed_bytes_and_fences_older_executables() {
    let f = F::new(Coordination::Peer);
    let before = f.all();
    let path = f.dir.path().join("source.sqlite");
    drop(f.s);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.pragma_update(None, "user_version", 16).unwrap();
    drop(db);
    let reopened = Store::open(&path).unwrap();
    for bytes in before {
        let event = Event::verify(&bytes).unwrap();
        assert_eq!(reopened.event(&event.id).unwrap().unwrap().bytes(), bytes);
    }
    drop(reopened);
    let db = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
            .unwrap(),
        17
    );
}

#[test]
fn legacy_no_roster_coordinator_history_remains_readable_but_v14_requires_actor_evidence() {
    let f = F::new(Coordination::Coordinated);
    let mut s = Store::open(&f.dir.path().join("legacy-source.sqlite")).unwrap();
    let template = f.s.event(&f.m).unwrap().unwrap();
    let root = f
        .owner
        .sign(EventBody {
            version: 13,
            ..template.body
        })
        .unwrap();
    s.import(&[root.bytes().to_vec()]).unwrap();
    let co = Identity::from_seed([204; 32]);
    let appointment = f
        .owner
        .sign(EventBody {
            version: 13,
            mission: Some(root.id.clone()),
            author: f.owner.public_key(),
            audience: "main".into(),
            sequence: 1,
            previous: Some(root.id.clone()),
            authority: Some(root.id.clone()),
            created_at_ms: None,
            terms_reviews: Default::default(),
            payload: Payload::MissionControlled {
                previous: root.id.clone(),
                action: C::SetCoordination {
                    mode: Coordination::Coordinated,
                    coordinator: Some(CoordinatorIdentity {
                        author: co.public_key(),
                        label: "Legacy Coordinator".into(),
                        runtime: "grok".into(),
                    }),
                },
            },
        })
        .unwrap();
    s.import(&[appointment.bytes().to_vec()]).unwrap();
    let body = EventBody {
        version: 14,
        mission: Some(root.id.clone()),
        author: co.public_key(),
        audience: "main".into(),
        sequence: 0,
        previous: None,
        authority: Some(appointment.id.clone()),
        created_at_ms: None,
        terms_reviews: Default::default(),
        payload: Payload::CoordinatorPlanned {
            control: appointment.id.clone(),
            text: "Historical plan".into(),
        },
    };
    assert!(
        s.import(&[co.sign(body.clone()).unwrap().bytes().to_vec()])
            .is_err()
    );
    let legacy = co
        .sign(EventBody {
            version: 13,
            ..body
        })
        .unwrap();
    s.import(&[legacy.bytes().to_vec()]).unwrap();
    let changed = s
        .control(
            &f.owner,
            &root.id,
            &appointment.id,
            C::SetPlan {
                text: "Current owner plan".into(),
            },
        )
        .unwrap();
    let downgrade = co
        .sign(EventBody {
            sequence: 1,
            previous: Some(legacy.id.clone()),
            payload: Payload::CoordinatorPlanned {
                control: changed.id.clone(),
                text: "Cannot omit v14 proof".into(),
            },
            ..legacy.body.clone()
        })
        .unwrap();
    let error = s.import(&[downgrade.bytes().to_vec()]).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("legacy record cannot depend on v14 control")
    );
    let writer_downgrade = f
        .owner
        .sign(EventBody {
            version: 13,
            sequence: changed.body.sequence + 1,
            previous: Some(changed.id.clone()),
            payload: Payload::MessageSent {
                text: "Old writer version".into(),
                to: None,
                thread: None,
            },
            ..changed.body.clone()
        })
        .unwrap();
    assert!(
        s.import(&[writer_downgrade.bytes().to_vec()])
            .unwrap_err()
            .to_string()
            .contains("legacy writer")
    );
    let authority_downgrade = f
        .host
        .sign(EventBody {
            version: 13,
            mission: Some(f.m.clone()),
            author: f.host.public_key(),
            audience: "main".into(),
            sequence: 0,
            previous: None,
            authority: f.s.event(&f.reg).unwrap().unwrap().body.authority,
            created_at_ms: None,
            terms_reviews: Default::default(),
            payload: Payload::MessageSent {
                text: "Old authority version".into(),
                to: None,
                thread: None,
            },
        })
        .unwrap();
    let mut authority_replica = f.replica("authority-downgrade", &f.all());
    assert!(
        authority_replica
            .import(&[authority_downgrade.bytes().to_vec()])
            .unwrap_err()
            .to_string()
            .contains("legacy authority")
    );
    drop(s);
    let reopened = Store::open(&f.dir.path().join("legacy-source.sqlite")).unwrap();
    assert_eq!(
        reopened.event(&legacy.id).unwrap().unwrap().bytes(),
        legacy.bytes()
    );
    assert_eq!(
        reopened
            .control_state(&root.id)
            .unwrap()
            .lifecycle
            .plan
            .unwrap()
            .id,
        changed.id
    );
}

#[test]
fn a_full_renewed_roster_fits_one_signed_start_and_replicates_in_bounded_pages() {
    let mut f = F::new(Coordination::Peer);
    for i in 1..harakiri_protocol::limits::MAX_AGENTS {
        let mut seed = [0; 32];
        seed[..8].copy_from_slice(&(i as u64).to_le_bytes());
        let key = Identity::from_seed(seed);
        f.s.offer_agent(
            &f.host,
            &f.m,
            &f.m,
            descriptor(&key, AgentRole::Agent, &format!("Worker {i}")),
        )
        .unwrap();
    }
    let update = f.change();
    let registrations: Vec<_> =
        f.s.agent_views(&f.m)
            .unwrap()
            .into_iter()
            .map(|a| a.id)
            .collect();
    for registration in &registrations {
        f.s.review_agent_terms(&f.host, &f.m, registration, &update.id)
            .unwrap();
    }
    let started = f.start(None);
    assert_eq!(started.body.terms_reviews.len(), 512);
    assert!(started.bytes().len() > 64 * 1024);
    assert!(started.bytes().len() <= harakiri_protocol::limits::MAX_EVENT_BYTES);
    let replay = f.replica("full-roster", &f.all());
    assert_eq!(
        replay
            .agent_views(&f.m)
            .unwrap()
            .iter()
            .filter(|a| a.status == AgentStatus::DirectionAssigned)
            .count(),
        512
    );
}
