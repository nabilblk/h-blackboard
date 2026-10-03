use harakiri_node::{communication::MessageQuery, store::Store};
use harakiri_protocol::{
    ArtifactFile, Event, Identity, MissionDefinition, Payload,
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
        files: vec![ArtifactFile {
            path: "index.html".into(),
            hash: blake3::hash(b"fixture").to_hex().to_string(),
            size: 7,
            media_type: "text/html".into(),
        }],
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
            "DROP TABLE governance_records; DROP TABLE available_files; DROP TABLE artifact_records; PRAGMA user_version=10;",
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
