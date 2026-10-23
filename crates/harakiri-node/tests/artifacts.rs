use harakiri_node::{communication::MessageQuery, store::Store};
use harakiri_protocol::{
    ArtifactFile, Event, Identity, MissionDefinition, Payload,
    agents::{AgentIdentity, AgentRole},
    artifacts::*,
    lifecycle::ControlAction,
    policy::{Coordination, MissionBudget, MissionPolicy, Participation},
};
use rand::{SeedableRng, seq::SliceRandom};
struct Fixture {
    dir: tempfile::TempDir,
    s: Store,
    a: Identity,
    b: Identity,
    c: Identity,
    m: String,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(&dir.path().join("node.sqlite")).unwrap();
        let a = Identity::from_seed([31; 32]);
        let b = Identity::from_seed([32; 32]);
        let c = Identity::from_seed([33; 32]);
        let m = s
            .create(
                &a,
                "31".repeat(32),
                MissionDefinition {
                    name: "Community event".into(),
                    objective: "Plan a usable event".into(),
                    scope: "Plan and verify".into(),
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
        for (key, endpoint) in [(&b, "32"), (&c, "33")] {
            s.append(
                &a,
                &m,
                Payload::MemberAdmitted {
                    member: key.public_key(),
                    endpoint: endpoint.repeat(32),
                },
            )
            .unwrap();
        }
        Self { dir, s, a, b, c, m }
    }
    fn publish(
        &mut self,
        title: &str,
        artifact: Option<String>,
        parents: Vec<String>,
        inputs: Vec<String>,
    ) -> Event {
        let control = self.s.control_state(&self.m).unwrap().lifecycle.revision;
        self.s
            .artifact_action(
                &self.a,
                &self.m,
                &control,
                "main",
                ArtifactAction::Publish {
                    artifact,
                    parents,
                    document: document(title, inputs),
                },
            )
            .unwrap()
    }
    fn detail(&self, id: &str) -> ArtifactDetail {
        self.s
            .artifact_detail(&self.m, &self.a.public_key(), id)
            .unwrap()
    }
}
fn document(title: &str, inputs: Vec<String>) -> ArtifactDocument {
    ArtifactDocument {
        title: title.into(),
        summary: "A usable fixture output".into(),
        kind: ArtifactKind::Application,
        stage: ArtifactStage::Complete,
        limitations: "Offline fixture".into(),
        entrypoint: Some("index.html".into()),
        inputs,
        references: vec![],
        files: vec![ArtifactFile {
            path: "index.html".into(),
            hash: blake3::hash(b"fixture").to_hex().to_string(),
            size: 7,
            media_type: "text/html".into(),
        }],
    }
}

#[test]
fn prepared_directions_authorize_exact_artifact_publication_and_review_after_start() {
    for workstream in [false, true] {
        let mut f = Fixture::new();
        let builder = Identity::from_seed([61; 32]);
        let reviewer = Identity::from_seed([62; 32]);
        let excluded = Identity::from_seed([63; 32]);
        let mut registrations = vec![];
        let mut directions = vec![];
        for (identity, label) in [
            (&builder, "Builder"),
            (&reviewer, "Reviewer"),
            (&excluded, "Excluded"),
        ] {
            let offer =
                f.s.offer_agent(
                    &f.b,
                    &f.m,
                    &f.m,
                    AgentIdentity {
                        author: identity.public_key(),
                        label: label.into(),
                        runtime: "grok".into(),
                        role: AgentRole::Agent,
                        contributor_name: "Contributor".into(),
                    },
                )
                .unwrap();
            let direction = if workstream {
                f.s.work(
                    &f.a,
                    &f.m,
                    &f.m,
                    harakiri_protocol::work::WorkAction::AssignWorkstream {
                        registration: offer.id.clone(),
                        workstream: None,
                        goal_revision: None,
                        direction: "Publish or independently review the exact lesson after Start"
                            .into(),
                    },
                )
                .unwrap()
            } else {
                f.s.direct_agent(
                    &f.a,
                    &f.m,
                    &f.m,
                    &offer.id,
                    "Publish or independently review the exact lesson after Start".into(),
                )
                .unwrap()
            };
            registrations.push(offer.id);
            directions.push(direction.id);
        }
        let publish = ArtifactAction::Publish {
            artifact: None,
            parents: vec![],
            document: document("Lesson", vec![]),
        };
        assert!(
            f.s.artifact_action(&builder, &f.m, &f.m, "main", publish.clone())
                .is_err()
        );
        let mut participants = registrations[..2].to_vec();
        participants.sort();
        let started =
            f.s.control(
                &f.a,
                &f.m,
                &f.m,
                ControlAction::Start {
                    readiness: None,
                    participants,
                },
            )
            .unwrap();
        let draft =
            f.s.artifact_action(&builder, &f.m, &started.id, "main", publish.clone())
                .unwrap();
        assert!(
            matches!(&draft.body.payload, Payload::ArtifactRecorded { authorization: Some(id), .. } if id == &directions[0])
        );
        let review =
            f.s.artifact_action(
                &reviewer,
                &f.m,
                &started.id,
                "main",
                ArtifactAction::Review {
                    revision: draft.id.clone(),
                    verdict: ReviewVerdict::ChangesRequested,
                    summary: "Correct the narrow layout".into(),
                    conditions: "Exact draft only".into(),
                    evidence: vec![],
                    checks: vec![ReviewCheck {
                        method: ReviewMethod::VisualInspection,
                        result: CheckResult::Failed,
                        details: "The diagram is clipped".into(),
                    }],
                },
            )
            .unwrap();
        let mut corrected = document("Corrected lesson", vec![]);
        corrected.references.push(ArtifactReference {
            revision: review.id.clone(),
            relation: ArtifactRelation::Citation,
        });
        let revision =
            f.s.artifact_action(
                &builder,
                &f.m,
                &started.id,
                "main",
                ArtifactAction::Publish {
                    artifact: Some(draft.id.clone()),
                    parents: vec![draft.id.clone()],
                    document: corrected,
                },
            )
            .unwrap();
        // Import uses the same authorization semantics as local creation, including
        // when dependencies arrive out of order. Historical reviews stay exact.
        let mut records = f.s.delta(&f.m, &[]).unwrap();
        records.shuffle(&mut rand::rngs::StdRng::seed_from_u64(512));
        let mut peer = Store::open(&f.dir.path().join("artifact-peer.sqlite")).unwrap();
        peer.import(&records).unwrap();
        let detail = peer
            .artifact_detail(&f.m, &f.b.public_key(), &revision.id)
            .unwrap();
        assert_eq!(detail.artifact.id, draft.id);
        assert_eq!(detail.history.len(), 2);
        assert!(detail.reviews.is_empty());
        assert_eq!(
            peer.artifact_detail(&f.m, &f.b.public_key(), &draft.id)
                .unwrap()
                .reviews[0]
                .id,
            review.id
        );
        // A fabricated publication cannot reuse a preparing direction for an agent
        // absent from the exact reviewed Start, even though peer mode permits later work.
        assert!(
            f.s.append(
                &excluded,
                &f.m,
                Payload::ArtifactRecorded {
                    control: started.id.clone(),
                    authorization: Some(directions[2].clone()),
                    conversation: "main".into(),
                    action: publish.clone(),
                }
            )
            .is_err()
        );
        let paused =
            f.s.control(
                &f.a,
                &f.m,
                &started.id,
                ControlAction::Pause {
                    reason: "Operator review".into(),
                },
            )
            .unwrap();
        assert!(
            f.s.artifact_action(&builder, &f.m, &paused.id, "main", publish)
                .is_err()
        );
    }
}
#[test]
fn revisions_reviews_acceptance_and_exact_inputs_stay_separate() {
    let mut f = Fixture::new();
    let brief = f.publish("Brief", None, vec![], vec![]);
    let page = f.publish("Event guide", None, vec![], vec![brief.id.clone()]);
    f.s.artifact_action(
        &f.a,
        &f.m,
        &f.m,
        "main",
        ArtifactAction::Highlight {
            revision: page.id.clone(),
            highlighted: true,
        },
    )
    .unwrap();
    assert!(f.detail(&page.id).highlighted);
    let review =
        f.s.artifact_action(
            &f.b,
            &f.m,
            &f.m,
            "main",
            ArtifactAction::Review {
                checks: vec![ReviewCheck {
                    method: ReviewMethod::SourceInspection,
                    result: CheckResult::Passed,
                    details: "Inspected the fixture's schedule; no browser was run.".into(),
                }],
                revision: page.id.clone(),
                verdict: ReviewVerdict::Verified,
                summary: "Opened and checked the times".into(),
                conditions: "Static fixture; no live users".into(),
                evidence: vec![brief.id.clone()],
            },
        )
        .unwrap();
    let d = f.detail(&page.id);
    assert_eq!(d.artifact.review_status, "reviewed");
    assert!(!d.artifact.accepted);
    assert!(!d.reviews[0].self_review);
    assert_eq!(d.reviews[0].checks.len(), 1);
    assert_eq!(
        d.reviews[0].checks[0].method,
        ReviewMethod::SourceInspection
    );
    assert_eq!(d.reviews[0].checks[0].result, CheckResult::Passed);
    assert!(
        f.s.artifact_action(
            &f.b,
            &f.m,
            &f.m,
            "main",
            ArtifactAction::Accept {
                revision: page.id.clone(),
                accepted: true,
                reason: "Not the owner".into()
            }
        )
        .is_err()
    );
    f.s.artifact_action(
        &f.a,
        &f.m,
        &f.m,
        "main",
        ArtifactAction::Accept {
            revision: page.id.clone(),
            accepted: true,
            reason: "Meets the brief".into(),
        },
    )
    .unwrap();
    assert!(f.detail(&page.id).artifact.accepted);
    let changed = f.publish(
        "Changed venue brief",
        Some(brief.id.clone()),
        vec![brief.id.clone()],
        vec![],
    );
    let d = f.detail(&page.id);
    assert!(d.stale && d.reviews[0].stale && d.acceptance.unwrap().stale);
    assert!(!d.artifact.accepted);
    let page2 = f.publish(
        "Updated guide",
        Some(page.id.clone()),
        vec![page.id.clone()],
        vec![changed.id],
    );
    let d = f.detail(&page2.id);
    assert!(!d.stale);
    assert!(d.reviews.is_empty() && d.acceptance.is_none());
    assert!(!d.highlighted);
    assert!(f.detail(&page.id).highlighted);
    assert_eq!(d.history.len(), 2);
    assert_eq!(f.detail(&page.id).reviews[0].id, review.id);
    let mut definition = f.s.control_state(&f.m).unwrap().definition;
    definition.scope = "New constraints".into();
    f.s.control(
        &f.a,
        &f.m,
        &f.m,
        ControlAction::UpdateInstructions { definition },
    )
    .unwrap();
    assert!(f.detail(&page2.id).stale);
}
#[test]
fn concurrent_revisions_survive_shuffling_restart_and_explicit_merge() {
    let mut f = Fixture::new();
    let original = f.publish("Guide", None, vec![], vec![]);
    let baseline = f.s.delta(&f.m, &[]).unwrap();
    let mut other = Store::open(&f.dir.path().join("other.sqlite")).unwrap();
    other.import(&baseline).unwrap();
    let left = f.publish(
        "North approach",
        Some(original.id.clone()),
        vec![original.id.clone()],
        vec![],
    );
    let right = other
        .artifact_action(
            &f.b,
            &f.m,
            &f.m,
            "main",
            ArtifactAction::Publish {
                artifact: Some(original.id.clone()),
                parents: vec![original.id.clone()],
                document: document("South approach", vec![]),
            },
        )
        .unwrap();
    f.s.import(&[right.bytes().to_vec()]).unwrap();
    assert_eq!(f.detail(&left.id).artifact.heads.len(), 2);
    assert!(
        f.s.artifact_action(
            &f.a,
            &f.m,
            &f.m,
            "main",
            ArtifactAction::Publish {
                artifact: Some(original.id.clone()),
                parents: vec![left.id.clone()],
                document: document("Stale editor", vec![])
            }
        )
        .is_err()
    );
    let merged = f.publish(
        "Both routes compared",
        Some(original.id.clone()),
        vec![left.id.clone(), right.id.clone()],
        vec![],
    );
    let mut history = baseline;
    history.extend([left, right, merged.clone()].map(|e| e.bytes().to_vec()));
    let mut rng = rand::rngs::StdRng::seed_from_u64(100307);
    for i in 0..12 {
        let path = f.dir.path().join(format!("restart-{i}.sqlite"));
        let mut s = Store::open(&path).unwrap();
        let mut events = history.clone();
        events.extend(history.iter().take(2).cloned());
        events.shuffle(&mut rng);
        s.import(&events).unwrap();
        drop(s);
        let s = Store::open(&path).unwrap();
        let d = s
            .artifact_detail(&f.m, &f.a.public_key(), &merged.id)
            .unwrap();
        assert_eq!(d.artifact.heads, vec![merged.id.clone()]);
        assert_eq!(d.history.len(), 4);
    }
}
#[test]
fn private_revisions_cannot_leak_through_inputs_lists_or_known_hashes() {
    let mut f = Fixture::new();
    let audience = format!("private:{}", "c1".repeat(32));
    f.s.append_to(
        &f.b,
        &f.m,
        &audience,
        Payload::AudienceCreated {
            readers: vec![f.b.public_key(), f.c.public_key()],
        },
    )
    .unwrap();
    let hidden =
        f.s.artifact_action(
            &f.b,
            &f.m,
            &f.m,
            &audience,
            ArtifactAction::Publish {
                artifact: None,
                parents: vec![],
                document: document("Private guide", vec![]),
            },
        )
        .unwrap();
    let hash = document("", vec![]).files[0].hash.clone();
    f.s.mark_materialized(&hidden.id, &hash).unwrap();
    assert!(!f.s.can_read_blob(&"31".repeat(32), &hash).unwrap());
    assert!(f.s.can_read_blob(&"33".repeat(32), &hash).unwrap());
    assert!(
        f.s.artifact_detail(&f.m, &f.a.public_key(), &hidden.id)
            .is_err()
    );
    assert_eq!(
        f.s.artifacts(&f.m, &f.a.public_key(), ArtifactQuery::default())
            .unwrap()
            .total,
        0
    );
    assert!(
        f.s.artifact_action(
            &f.b,
            &f.m,
            &f.m,
            "main",
            ArtifactAction::Publish {
                artifact: None,
                parents: vec![],
                document: document("Leaking reference", vec![hidden.id.clone()])
            }
        )
        .is_err()
    );
    // A malicious member can sign a public manifest naming a known private hash.
    // Without possession/materialization for that manifest, it grants no GET.
    let forged =
        f.s.artifact_action(
            &f.c,
            &f.m,
            &f.m,
            "main",
            ArtifactAction::Publish {
                artifact: None,
                parents: vec![],
                document: document("Hash claim only", vec![]),
            },
        )
        .unwrap();
    assert!(f.detail(&forged.id).available_files.is_empty());
    assert!(!f.s.can_read_blob(&"31".repeat(32), &hash).unwrap());
    // Explicit, byte-verified materialization is a separate host operation.
    f.s.mark_materialized(&forged.id, &hash).unwrap();
    assert!(f.s.can_read_blob(&"31".repeat(32), &hash).unwrap());
    let conversation =
        f.s.query_messages(
            &f.m,
            &f.b.public_key(),
            MessageQuery::conversation(&audience, None),
        )
        .unwrap();
    assert!(conversation.items.iter().any(|m| {
        m.work
            .as_ref()
            .is_some_and(|w| w.kind == "artifact" && w.id == hidden.id)
    }));
}
#[test]
fn pagination_search_and_workstream_context_cover_saved_history() {
    let mut f = Fixture::new();
    for i in 0..38 {
        f.publish(&format!("Guide {i:02}"), None, vec![], vec![]);
    }
    let first =
        f.s.artifacts(&f.m, &f.a.public_key(), ArtifactQuery::default())
            .unwrap();
    assert_eq!(first.total, 38);
    assert_eq!(first.items.len(), 32);
    let next =
        f.s.artifacts(
            &f.m,
            &f.a.public_key(),
            ArtifactQuery {
                after: first.after,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(next.items.len(), 6);
    assert!(next.after.is_none());
    let search =
        f.s.artifacts(
            &f.m,
            &f.a.public_key(),
            ArtifactQuery {
                search: Some("Guide 37".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(search.items.len(), 1);
    let reviewed = f.publish("Reviewed guide", None, vec![], vec![]);
    f.s.artifact_action(
        &f.b,
        &f.m,
        &f.m,
        "main",
        ArtifactAction::Review {
            revision: reviewed.id.clone(),
            verdict: ReviewVerdict::Verified,
            summary: "Independently inspected".into(),
            conditions: "Fixture only".into(),
            evidence: vec![],
            checks: vec![],
        },
    )
    .unwrap();
    let filtered =
        f.s.artifacts(
            &f.m,
            &f.a.public_key(),
            ArtifactQuery {
                kind: Some(ArtifactKind::Application),
                review_status: Some("reviewed".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(filtered.total, 1);
    assert_eq!(filtered.items[0].revision, reviewed.id);
    assert!(
        f.s.artifacts(
            &f.m,
            &f.a.public_key(),
            ArtifactQuery {
                review_status: Some("anything".into()),
                ..Default::default()
            }
        )
        .is_err()
    );
    let ws =
        f.s.work(
            &f.a,
            &f.m,
            &f.m,
            harakiri_protocol::work::WorkAction::CreateWorkstream {
                name: "Routes".into(),
                goal: "Compare entrances".into(),
            },
        )
        .unwrap();
    let channel = format!("workstream:{}", ws.id);
    let e =
        f.s.artifact_action(
            &f.a,
            &f.m,
            &f.m,
            &channel,
            ArtifactAction::Publish {
                artifact: None,
                parents: vec![],
                document: document("Route map", vec![]),
            },
        )
        .unwrap();
    assert_eq!(
        f.s.artifacts(
            &f.m,
            &f.a.public_key(),
            ArtifactQuery {
                conversation: Some(channel.clone()),
                ..Default::default()
            }
        )
        .unwrap()
        .total,
        1
    );
    assert!(
        f.s.query_messages(
            &f.m,
            &f.a.public_key(),
            MessageQuery::conversation(&channel, None)
        )
        .unwrap()
        .items
        .iter()
        .any(|m| m.id == e.id)
    );
}
#[test]
fn schema_eleven_rebuild_preserves_signed_bytes_and_rolls_back_corruption() {
    let mut f = Fixture::new();
    let e = f.publish("Migration", None, vec![], vec![]);
    let before = f.s.delta(&f.m, &[]).unwrap();
    let path = f.dir.path().join("node.sqlite");
    drop(f.s);
    let reset = || {
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch(
            "DROP TABLE sync_progress; DROP INDEX replication_history; ALTER TABLE delivery DROP COLUMN last_progress_ms; ALTER TABLE delivery DROP COLUMN last_converged_ms; ALTER TABLE delivery DROP COLUMN stalled_exchanges; DROP TABLE governance_records; DROP TABLE available_files; DROP TABLE artifact_records; PRAGMA user_version=10;",
        )
        .unwrap();
    };
    reset();
    let s = Store::open(&path).unwrap();
    assert_eq!(s.delta(&f.m, &[]).unwrap(), before);
    assert_eq!(
        s.artifact_detail(&f.m, &f.a.public_key(), &e.id)
            .unwrap()
            .document
            .title,
        "Migration"
    );
    drop(s);
    reset();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute(
        "UPDATE events SET bytes=?1 WHERE id=?2",
        rusqlite::params![vec![0_u8], e.id],
    )
    .unwrap();
    drop(db);
    assert!(Store::open(&path).is_err());
    let db = rusqlite::Connection::open(path).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
            .unwrap(),
        10
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='artifact_records'",
            [],
            |r| r.get::<_, u32>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn pinned_inputs_and_historical_reviews_do_not_create_a_live_stale_loop() {
    let mut f = Fixture::new();
    let input = f.publish("Pinned brief", None, vec![], vec![]);
    let live = f.publish("Live output", None, vec![], vec![input.id.clone()]);
    let mut doc = document("Pinned output", vec![]);
    doc.references = vec![ArtifactReference {
        revision: input.id.clone(),
        relation: ArtifactRelation::Pinned,
    }];
    let pinned =
        f.s.artifact_action(
            &f.a,
            &f.m,
            &f.m,
            "main",
            ArtifactAction::Publish {
                artifact: None,
                parents: vec![],
                document: doc,
            },
        )
        .unwrap();
    let review =
        f.s.artifact_action(
            &f.b,
            &f.m,
            &f.m,
            "main",
            ArtifactAction::Review {
                revision: pinned.id.clone(),
                verdict: ReviewVerdict::ChangesRequested,
                summary: "Correct visible feedback".into(),
                conditions: "Source scope only".into(),
                evidence: vec![],
                checks: vec![],
            },
        )
        .unwrap();
    f.publish("New input", Some(input.id.clone()), vec![input.id], vec![]);
    assert!(f.detail(&live.id).stale);
    assert!(!f.detail(&pinned.id).stale);
    let mut corrected = f.detail(&pinned.id).document;
    corrected.references.push(ArtifactReference {
        revision: review.id,
        relation: ArtifactRelation::Citation,
    });
    let updated =
        f.s.artifact_action(
            &f.a,
            &f.m,
            &f.m,
            "main",
            ArtifactAction::Publish {
                artifact: Some(pinned.id.clone()),
                parents: vec![pinned.id.clone()],
                document: corrected,
            },
        )
        .unwrap();
    assert!(
        !f.detail(&updated.id).stale,
        "an old review remains history, not a freshness dependency"
    );
    assert!(!f.detail(&updated.id).artifact.accepted);
    assert!(
        f.detail(&updated.id).reviews.is_empty(),
        "review must not silently transfer to changed bytes"
    );
    let invalid = ArtifactAction::Publish {
        artifact: Some(pinned.id),
        parents: vec![updated.id.clone()],
        document: document("Wrong self dependency", vec![updated.id]),
    };
    assert!(
        f.s.artifact_action(&f.a, &f.m, &f.m, "main", invalid)
            .is_err()
    );
}

#[test]
fn delivery_candidate_is_exact_and_new_publication_requires_a_new_choice() {
    let mut f = Fixture::new();
    let original = f.publish("Application", None, vec![], vec![]);
    let candidate =
        f.s.artifact_action(
            &f.a,
            &f.m,
            &f.m,
            "main",
            ArtifactAction::Candidate {
                revision: original.id.clone(),
                previous: vec![],
            },
        )
        .unwrap();
    assert!(
        f.s.artifact_action(
            &f.b,
            &f.m,
            &f.m,
            "main",
            ArtifactAction::Candidate {
                revision: original.id.clone(),
                previous: vec![candidate.id.clone()]
            }
        )
        .is_err(),
        "ordinary participant cannot select mission delivery"
    );
    let updated = f.publish(
        "Corrected application",
        Some(original.id.clone()),
        vec![original.id.clone()],
        vec![],
    );
    let page =
        f.s.artifacts(&f.m, &f.a.public_key(), Default::default())
            .unwrap();
    assert_eq!(page.candidates[0].revision, original.id);
    assert!(page.candidates[0].stale);
    assert!(
        f.s.artifact_action(
            &f.a,
            &f.m,
            &f.m,
            "main",
            ArtifactAction::Accept {
                revision: original.id,
                accepted: true,
                reason: "Old version".into()
            }
        )
        .is_err()
    );
    assert!(
        f.s.artifact_action(
            &f.a,
            &f.m,
            &f.m,
            "main",
            ArtifactAction::Candidate {
                revision: updated.id.clone(),
                previous: vec![]
            }
        )
        .is_err(),
        "stale selection must refresh"
    );
    f.s.artifact_action(
        &f.a,
        &f.m,
        &f.m,
        "main",
        ArtifactAction::Candidate {
            revision: updated.id.clone(),
            previous: vec![candidate.id],
        },
    )
    .unwrap();
    let page =
        f.s.artifacts(&f.m, &f.a.public_key(), Default::default())
            .unwrap();
    assert_eq!(page.candidates.len(), 1);
    assert_eq!(page.candidates[0].revision, updated.id);
    assert!(!page.candidates[0].stale);
    assert!(!f.detail(&updated.id).artifact.accepted);
}
