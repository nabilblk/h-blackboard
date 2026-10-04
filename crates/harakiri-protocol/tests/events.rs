use harakiri_protocol::{Event, EventBody, Identity, MissionDefinition, Payload, codec, limits};

fn genesis() -> Event {
    let identity = Identity::from_seed([1; 32]);
    identity
        .sign(EventBody {
            version: 1,
            mission: None,
            author: identity.public_key(),
            audience: "main".into(),
            sequence: 0,
            previous: None,
            authority: None,
            created_at_ms: None,
            payload: Payload::MissionCreated {
                definition: MissionDefinition {
                    name: "Community event".into(),
                    objective: "Make a usable event plan".into(),
                    scope: "Research only".into(),
                    criteria: vec!["Reviewed schedule".into()],
                    policy: None,
                },
                endpoint: "02".repeat(32),
                nonce: "03".repeat(32),
            },
        })
        .expect("valid fixture")
}

#[test]
fn signatures_are_deterministic_and_bound_to_every_byte() {
    let event = genesis();
    assert_eq!(event.bytes(), genesis().bytes());
    assert_eq!(Event::verify(event.bytes()).unwrap().body, event.body);
    for index in 0..event.bytes().len() {
        let mut bytes = event.bytes().to_vec();
        bytes[index] ^= 1;
        assert!(
            Event::verify(&bytes).is_err(),
            "accepted mutation at {index}"
        );
    }
}

#[test]
fn cbor_rejects_ambiguity_and_resource_exhaustion_before_decoding() {
    for bad in [
        vec![0x18, 0x00],
        vec![0x9f, 0xff],
        vec![0xa2, 0x01, 0x01, 0x01, 0x02],
        vec![0x01, 0x01],
        vec![0xc0, 0x00],
        vec![0xf9, 0, 0],
        vec![0x81; 40],
        vec![0xff],
    ] {
        assert!(codec::check(&bad).is_err(), "accepted {bad:?}");
    }
    assert!(Event::verify(&vec![0; limits::MAX_EVENT_BYTES + 1]).is_err());
}

#[test]
fn unsupported_versions_and_private_audiences_fail_closed() {
    let identity = Identity::from_seed([1; 32]);
    let mut body = genesis().body;
    body.version = limits::VERSION + 1;
    assert!(identity.sign(body.clone()).is_err());
    body.version = 1;
    body.audience = "dm:someone".into();
    assert!(identity.sign(body).is_err());
}

#[test]
fn published_vector_matches_the_rust_implementation() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../protocol/fixtures/genesis-v1.json");
    let event = genesis();
    let actual = serde_json::json!({ "event_id": event.id, "public_key": event.body.author,
        "cose_hex": hex::encode(event.bytes()), "body": event.body });
    if std::env::var_os("HARAKIRI_WRITE_PROTOCOL_FIXTURES").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_string_pretty(&actual).unwrap() + "\n").unwrap();
    }
    let expected: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).expect("checked-in protocol vector")).unwrap();
    assert_eq!(actual, expected);
}

#[test]
fn scoped_v2_and_domain_separated_claim_vectors() {
    let identity = Identity::from_seed([1; 32]);
    let event = identity
        .sign(EventBody {
            version: 2,
            mission: Some(genesis().id),
            author: identity.public_key(),
            audience: format!("private:{}", "04".repeat(32)),
            sequence: 0,
            previous: None,
            authority: Some(genesis().id),
            created_at_ms: Some(1790899200000),
            payload: Payload::AudienceCreated {
                readers: vec![
                    identity.public_key(),
                    Identity::from_seed([2; 32]).public_key(),
                ],
            },
        })
        .unwrap();
    let claim_body = serde_json::json!({"endpoint":"02".repeat(32),"addresses":["127.0.0.1:4000"],"relays":[],"expires_ms":1790985600000u64});
    let claim = identity.claim(b"harakiri/contact/1", &claim_body).unwrap();
    let actual = serde_json::json!([
        {"domain":"harakiri/event/1","event_id":event.id,"public_key":identity.public_key(),"cose_hex":hex::encode(event.bytes()),"body":event.body},
        {"domain":"harakiri/contact/1","public_key":identity.public_key(),"cose_hex":claim,"body":claim_body},
    ]);
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../protocol/fixtures/scoped-v2.json");
    if std::env::var_os("HARAKIRI_WRITE_PROTOCOL_FIXTURES").is_some() {
        std::fs::write(&path, serde_json::to_string_pretty(&actual).unwrap() + "\n").unwrap();
    }
    let expected: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(actual, expected);
    assert!(
        harakiri_protocol::claims::verify::<serde_json::Value>(b"harakiri/join-offer/1", &claim)
            .is_err()
    );
    assert!(Event::verify(&hex::decode(&claim).unwrap()).is_err());
    assert_eq!(
        harakiri_protocol::claims::verify::<serde_json::Value>(b"harakiri/contact/1", &claim)
            .unwrap()
            .1,
        claim_body
    );
}

#[test]
fn communication_v5_signed_vectors_and_downgrade_rejection() {
    let identity = Identity::from_seed([5; 32]);
    let payloads = [
        (
            "main".to_owned(),
            Payload::MessageSent {
                text: "Review the north entrance.".into(),
                to: Some("06".repeat(32)),
                thread: Some("07".repeat(32)),
            },
        ),
        (
            format!("private:{}", "08".repeat(32)),
            Payload::AgentConversationCreated {
                registration: "09".repeat(32),
            },
        ),
        (
            "main".to_owned(),
            Payload::AgentAcknowledged {
                registration: "09".repeat(32),
                control: "0a".repeat(32),
                direction: "0b".repeat(32),
            },
        ),
    ];
    let mut actual = Vec::new();
    for (audience, payload) in payloads {
        let body = EventBody {
            version: 5,
            mission: Some(genesis().id),
            author: identity.public_key(),
            audience,
            sequence: 0,
            previous: None,
            authority: Some("09".repeat(32)),
            created_at_ms: Some(1790899200000),
            payload,
        };
        let e = identity.sign(body.clone()).unwrap();
        actual.push(serde_json::json!({"domain":"harakiri/event/1","event_id":e.id,"public_key":identity.public_key(),"cose_hex":hex::encode(e.bytes()),"body":e.body}));
        assert!(identity.sign(EventBody { version: 4, ..body }).is_err());
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../protocol/fixtures/communication-v5.json");
    if std::env::var_os("HARAKIRI_WRITE_PROTOCOL_FIXTURES").is_some() {
        std::fs::write(&path, serde_json::to_string_pretty(&actual).unwrap() + "\n").unwrap();
    }
    let expected: Vec<serde_json::Value> =
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(actual, expected);
}

#[test]
fn work_v6_vectors_preserve_exact_direction_and_parallel_attempt_references() {
    use harakiri_protocol::work::{AttemptStatus, WorkAction};
    let identity = Identity::from_seed([6; 32]);
    let payloads = [
        Payload::WorkRecorded {
            control: "01".repeat(32),
            authorization: None,
            action: WorkAction::CreateWorkstream {
                name: "Access".into(),
                goal: "Compare step-free routes".into(),
            },
        },
        Payload::WorkRecorded {
            control: "01".repeat(32),
            authorization: Some("02".repeat(32)),
            action: WorkAction::ReportAttempt {
                task: "03".repeat(32),
                task_revision: "04".repeat(32),
                allocation: "05".repeat(32),
                registration: "06".repeat(32),
                bases: vec!["07".repeat(32)],
                status: AttemptStatus::Submitted,
                summary: "North route measured; rain check pending".into(),
                evidence: vec!["08".repeat(32)],
            },
        },
        Payload::WorkstreamMessage {
            workstream: "09".repeat(32),
            text: "Compare both options here.".into(),
            to: Some("0a".repeat(32)),
            thread: Some("0b".repeat(32)),
        },
    ];
    let mut actual = Vec::new();
    for payload in payloads {
        let body = EventBody {
            version: 6,
            mission: Some(genesis().id),
            author: identity.public_key(),
            audience: "main".into(),
            sequence: 0,
            previous: None,
            authority: Some("0c".repeat(32)),
            created_at_ms: Some(1790899200000),
            payload,
        };
        let e = identity.sign(body.clone()).unwrap();
        actual.push(serde_json::json!({"domain":"harakiri/event/1","event_id":e.id,"public_key":identity.public_key(),"cose_hex":hex::encode(e.bytes()),"body":e.body}));
        assert!(
            identity
                .sign(EventBody {
                    version: 5,
                    ..body.clone()
                })
                .is_err()
        );
        assert!(
            identity
                .sign(EventBody {
                    audience: format!("private:{}", "0d".repeat(32)),
                    ..body
                })
                .is_err()
        );
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../protocol/fixtures/work-v6.json");
    if std::env::var_os("HARAKIRI_WRITE_PROTOCOL_FIXTURES").is_some() {
        std::fs::write(&path, serde_json::to_string_pretty(&actual).unwrap() + "\n").unwrap();
    }
    let expected: Vec<serde_json::Value> =
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(actual, expected);
}

#[test]
fn artifact_v7_vectors_preserve_private_scope_files_and_exact_reviews() {
    use harakiri_protocol::{ArtifactFile, artifacts::*};
    let identity = Identity::from_seed([7; 32]);
    let private = format!("private:{}", "0a".repeat(32));
    let actions = [
        (
            "main".to_owned(),
            ArtifactAction::Publish {
                artifact: None,
                parents: vec![],
                document: ArtifactDocument {
                    title: "Event guide".into(),
                    summary: "A useful offline guide".into(),
                    kind: ArtifactKind::Application,
                    stage: ArtifactStage::Complete,
                    limitations: "Static fixture only".into(),
                    entrypoint: Some("site/index.html".into()),
                    inputs: vec!["05".repeat(32)],
                    files: vec![ArtifactFile {
                        path: "site/index.html".into(),
                        hash: "06".repeat(32),
                        size: 42,
                        media_type: "text/html".into(),
                    }],
                },
            },
        ),
        (
            private.clone(),
            ArtifactAction::Review {
                checks: vec![],
                revision: "07".repeat(32),
                verdict: ReviewVerdict::Verified,
                summary: "Private checks".into(),
                conditions: "Offline browser".into(),
                evidence: vec!["08".repeat(32)],
            },
        ),
        (
            "main".to_owned(),
            ArtifactAction::Accept {
                revision: "07".repeat(32),
                accepted: true,
                reason: "Meets the reviewed criteria".into(),
            },
        ),
        (
            "main".to_owned(),
            ArtifactAction::Highlight {
                revision: "07".repeat(32),
                highlighted: true,
            },
        ),
    ];
    let mut actual = vec![];
    for (audience, action) in actions {
        let body = EventBody {
            version: 7,
            mission: Some(genesis().id),
            author: identity.public_key(),
            audience: audience.clone(),
            sequence: 0,
            previous: None,
            authority: Some("09".repeat(32)),
            created_at_ms: Some(1790899200000),
            payload: Payload::ArtifactRecorded {
                control: "01".repeat(32),
                authorization: None,
                conversation: audience,
                action,
            },
        };
        let e = identity.sign(body.clone()).unwrap();
        actual.push(serde_json::json!({"domain":"harakiri/event/1","event_id":e.id,"public_key":identity.public_key(),"cose_hex":hex::encode(e.bytes()),"body":e.body}));
        assert!(
            identity
                .sign(EventBody {
                    version: 6,
                    ..body.clone()
                })
                .is_err()
        );
        let other = if body.audience == "main" {
            private.clone()
        } else {
            "main".into()
        };
        assert!(
            identity
                .sign(EventBody {
                    audience: other,
                    ..body
                })
                .is_err()
        );
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../protocol/fixtures/artifacts-v7.json");
    if std::env::var_os("HARAKIRI_WRITE_PROTOCOL_FIXTURES").is_some() {
        std::fs::write(&path, serde_json::to_string_pretty(&actual).unwrap() + "\n").unwrap();
    }
    let expected: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(serde_json::json!(actual), expected);
    for path in [
        "../secret",
        "/etc/passwd",
        "a//b",
        "a/./b",
        "C:/file",
        "a\\b",
        "a\nfile",
    ] {
        assert!(!valid_file(&ArtifactFile {
            path: path.into(),
            hash: "06".repeat(32),
            size: 1,
            media_type: "text/plain".into()
        }));
    }
}

#[test]
fn governance_v8_vectors_bind_allocations_and_exact_artifact_plans() {
    use harakiri_protocol::{governance::GovernanceAction as G, lifecycle::ControlAction as C};
    let identity = Identity::from_seed([1; 32]);
    let payloads = vec![
        Payload::GovernanceRecorded {
            control: "01".repeat(32),
            action: G::Allocate {
                node: "02".repeat(32),
                turns: Some(40),
                slots: 2,
            },
        },
        Payload::GovernanceRecorded {
            control: "01".repeat(32),
            action: G::Receipt {
                reservation: "03".repeat(32),
                used: None,
                stopped: false,
                summary: "Unknown; retain the reservation".into(),
            },
        },
        Payload::MissionControlled {
            previous: "01".repeat(32),
            action: C::SetPlanArtifact {
                revision: "04".repeat(32),
            },
        },
    ];
    let mut actual = Vec::new();
    for payload in payloads {
        let body = EventBody {
            version: 8,
            mission: Some(genesis().id),
            author: identity.public_key(),
            audience: "main".into(),
            sequence: 0,
            previous: None,
            authority: Some("09".repeat(32)),
            created_at_ms: Some(1790899200000),
            payload,
        };
        let e = identity.sign(body.clone()).unwrap();
        actual.push(serde_json::json!({"domain":"harakiri/event/1","event_id":e.id,"public_key":identity.public_key(),"cose_hex":hex::encode(e.bytes()),"body":e.body}));
        assert!(identity.sign(EventBody { version: 7, ..body }).is_err());
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../protocol/fixtures/governance-v8.json");
    if std::env::var_os("HARAKIRI_WRITE_PROTOCOL_FIXTURES").is_some() {
        std::fs::write(&path, serde_json::to_string_pretty(&actual).unwrap() + "\n").unwrap();
    }
    let expected: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).expect("checked-in protocol vector")).unwrap();
    assert_eq!(serde_json::to_value(actual).unwrap(), expected);
}

#[test]
fn scoped_reviews_preserve_legacy_bytes_and_reject_contradictory_claims() {
    use harakiri_protocol::artifacts::*;
    let legacy = serde_json::json!({"type":"review","revision":"ab".repeat(32),"verdict":"verified","summary":"Read source","conditions":"No browser","evidence":[]});
    let mut action: ArtifactAction = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(serde_json::to_value(&action).unwrap(), legacy);
    if let ArtifactAction::Review { checks, .. } = &mut action {
        checks.push(ReviewCheck {
            method: ReviewMethod::SourceInspection,
            result: CheckResult::Passed,
            details: "Inspected index.html; no runtime test.".into(),
        });
        checks.push(ReviewCheck {
            method: ReviewMethod::BrowserCheck,
            result: CheckResult::NotRun,
            details: "Browser unavailable.".into(),
        });
    }
    action.validate().unwrap();
    let identity = Identity::from_seed([7; 32]);
    let body = EventBody {
        version: 10,
        mission: Some(genesis().id),
        author: identity.public_key(),
        audience: "main".into(),
        sequence: 0,
        previous: None,
        authority: Some("09".repeat(32)),
        created_at_ms: None,
        payload: Payload::ArtifactRecorded {
            control: "01".repeat(32),
            authorization: None,
            conversation: "main".into(),
            action: action.clone(),
        },
    };
    let signed = identity.sign(body.clone()).unwrap();
    Event::verify(signed.bytes()).unwrap();
    assert!(identity.sign(EventBody { version: 9, ..body }).is_err());
    if let ArtifactAction::Review { checks, .. } = &mut action {
        checks[1].result = CheckResult::Failed;
    }
    assert!(action.validate().is_err());
    if let ArtifactAction::Review { verdict, .. } = &mut action {
        *verdict = ReviewVerdict::ChangesRequested;
    }
    action.validate().unwrap();
    if let ArtifactAction::Review { checks, .. } = &mut action {
        checks[0].details = "x".repeat(1025);
    }
    assert!(action.validate().is_err());
}
