use anyhow::Result;
use harakiri_node::peer::{ALPN, PeerNode, Request, Response, with_store};
use harakiri_protocol::{Identity, MissionDefinition, Payload};
use iroh::{Endpoint, RelayMode, SecretKey, endpoint::presets};
use iroh_relay::tls::CaTlsConfig;

fn definition() -> MissionDefinition {
    MissionDefinition {
        name: "Peer proof".into(),
        objective: "Preserve work without the creator".into(),
        scope: "Isolated test nodes".into(),
        criteria: vec!["Accessible artifact".into()],
        policy: None,
    }
}

async fn local(root: &std::path::Path, seed: u8) -> Result<PeerNode> {
    PeerNode::open(
        root,
        Identity::from_seed([seed; 32]),
        PeerNode::local_endpoint([seed + 10; 32]).await?,
    )
    .await
}

fn admit(owner: &PeerNode, mission: &str, other: &PeerNode) -> Result<()> {
    owner.append(
        mission,
        Payload::MemberAdmitted {
            member: other.identity.public_key(),
            endpoint: other.endpoint.id().to_string(),
        },
    )?;
    Ok(())
}

#[tokio::test]
async fn peers_preserve_work_with_creator_offline_and_deny_known_private_hashes() -> Result<()> {
    let root = tempfile::tempdir()?;
    let a = local(&root.path().join("a"), 1).await?;
    let b = local(&root.path().join("b"), 2).await?;
    let c = local(&root.path().join("c"), 3).await?;
    let outsider = local(&root.path().join("outsider"), 4).await?;
    let genesis = with_store(&a.store, |s| {
        s.create(&a.identity, a.endpoint.id().to_string(), definition())
    })?;
    let mission = &genesis.id;
    admit(&a, mission, &b)?;
    admit(&a, mission, &c)?;
    let artifact = a
        .publish_file(
            mission,
            "Event guide".into(),
            "index.html".into(),
            "text/html".into(),
            b"<!doctype html><title>Event guide</title><h1>A useful plan</h1>",
        )
        .await?;
    let Payload::ArtifactPublished { files, .. } = artifact.body.payload else {
        unreachable!()
    };
    let file = &files[0];
    assert_eq!(b.pull(a.endpoint.addr(), mission).await?, 4);
    assert_eq!(b.pull(a.endpoint.addr(), mission).await?, 0);
    c.pull(a.endpoint.addr(), mission).await?;
    let expected = b.fetch_file(a.endpoint.addr(), &artifact.id, file).await?;

    let rejected = outsider
        .request(
            a.endpoint.addr(),
            &Request::Pull {
                audience: "main".into(),
                mission: mission.clone(),
                heads: vec![],
            },
        )
        .await?;
    assert!(matches!(rejected, Response::Rejected));
    assert!(
        outsider
            .fetch_file(a.endpoint.addr(), &artifact.id, file)
            .await
            .is_err()
    );
    let secret = with_store(&a.store, |s| {
        s.create(&a.identity, a.endpoint.id().to_string(), definition())
    })?;
    let hidden = a
        .publish_file(
            &secret.id,
            "Private guide".into(),
            "secret.txt".into(),
            "text/plain".into(),
            b"another mission's private output",
        )
        .await?;
    let Payload::ArtifactPublished { files, .. } = hidden.body.payload else {
        unreachable!()
    };
    // A known member of one mission cannot use a valid hash from another mission.
    assert!(
        b.fetch_file(a.endpoint.addr(), &hidden.id, &files[0])
            .await
            .is_err()
    );

    a.shutdown().await?;
    b.append(
        mission,
        Payload::MessagePosted {
            text: "The creator is offline; the authorized work is still available.".into(),
        },
    )?;
    assert_eq!(c.pull(b.endpoint.addr(), mission).await?, 1);
    assert_eq!(
        c.fetch_file(b.endpoint.addr(), &artifact.id, file).await?,
        expected
    );
    b.shutdown().await?;
    let b = local(&root.path().join("b"), 2).await?;
    assert_eq!(with_store(&b.store, |s| s.missions())?[0].event_count, 5);
    assert_eq!(
        c.fetch_file(b.endpoint.addr(), &artifact.id, file).await?,
        expected
    );
    b.shutdown().await?;
    c.shutdown().await?;
    outsider.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn independent_relays_work_without_vendor_lookup_or_direct_ip() -> Result<()> {
    // These are two separate, local relay deployments. This proves configured
    // relay independence; it does not claim a cross-NAT Internet trial.
    for deployment in 0..2 {
        let (relays, _, relay) = iroh::test_utils::run_relay_server_with(false).await?;
        let root = tempfile::tempdir()?;
        let endpoint = |seed| {
            Endpoint::builder(presets::Minimal)
                .secret_key(SecretKey::from_bytes(&[seed; 32]))
                .relay_mode(RelayMode::Custom(relays.clone()))
                // Only this isolated test trusts the ephemeral self-signed relay.
                .ca_tls_config(CaTlsConfig::insecure_skip_verify())
                .clear_ip_transports()
        };
        let a = PeerNode::open(
            &root.path().join("a"),
            Identity::from_seed([1; 32]),
            endpoint(11).bind().await?,
        )
        .await?;
        let b = PeerNode::open(
            &root.path().join("b"),
            Identity::from_seed([2; 32]),
            endpoint(12).bind().await?,
        )
        .await?;
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            tokio::join!(a.endpoint.online(), b.endpoint.online());
        })
        .await?;
        let mission = with_store(&a.store, |s| {
            s.create(&a.identity, a.endpoint.id().to_string(), definition())
        })?;
        admit(&a, &mission.id, &b)?;
        assert_eq!(b.pull(a.endpoint.addr(), &mission.id).await?, 2);
        let connection = b.endpoint.connect(a.endpoint.addr(), ALPN).await?;
        assert!(connection.paths().iter().any(|path| path.is_relay()));
        assert!(!connection.paths().iter().any(|path| path.is_ip()));
        connection.close(0u32.into(), b"verified");
        println!(
            "relay deployment {deployment}: signed records synchronized, no direct IP transport, no vendor lookup"
        );
        a.shutdown().await?;
        b.shutdown().await?;
        drop(relay);
    }
    Ok(())
}

#[tokio::test]
async fn interrupted_bounded_catchup_resumes_from_another_replica_after_restart() -> Result<()> {
    let root = tempfile::tempdir()?;
    let a = local(&root.path().join("a"), 1).await?;
    let b = local(&root.path().join("b"), 2).await?;
    let c = local(&root.path().join("c"), 3).await?;
    let m = with_store(&a.store, |s| {
        s.create(&a.identity, a.endpoint.id().to_string(), definition())
    })?
    .id;
    admit(&a, &m, &b)?;
    admit(&a, &m, &c)?;
    for i in 0..130 {
        a.append(
            &m,
            Payload::MessagePosted {
                text: format!("Durable batch record {i}"),
            },
        )?;
    }
    c.pull(a.endpoint.addr(), &m).await?;
    // One bounded pass only. B's valid prefix commits before it is stopped.
    b.sync_scope(a.endpoint.addr(), &m, "main").await?;
    assert_eq!(with_store(&b.store, |s| s.missions())?[0].event_count, 64);
    b.shutdown().await?;
    a.shutdown().await?;
    let b = local(&root.path().join("b"), 2).await?;
    b.pull(c.endpoint.addr(), &m).await?;
    assert_eq!(
        with_store(&b.store, |s| s.messages(&m, None))?.items.len(),
        130
    );
    assert_eq!(b.pull(c.endpoint.addr(), &m).await?, 0);
    assert!(
        with_store(&b.store, |s| s
            .delta(&m, &with_store(&c.store, |s| s.heads(&m))?))?
        .is_empty()
    );
    b.shutdown().await?;
    c.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn agent_private_stream_replicates_only_to_its_host_and_stops_after_withdrawal() -> Result<()>
{
    use harakiri_node::communication::AgentOperation;
    use harakiri_protocol::{
        agents::{AgentIdentity, AgentRole},
        policy::{Coordination, MissionBudget, MissionPolicy, Participation},
    };
    let temp = tempfile::tempdir()?;
    let a = local(&temp.path().join("a"), 1).await?;
    let b = local(&temp.path().join("b"), 2).await?;
    let c = local(&temp.path().join("c"), 3).await?;
    let mut d = definition();
    d.policy = Some(MissionPolicy {
        coordination: Coordination::Peer,
        participation: Participation::Private,
        budget: MissionBudget::Unlimited {},
    });
    let m = with_store(&a.store, |s| {
        s.create(&a.identity, a.endpoint.id().to_string(), d)
    })?
    .id;
    admit(&a, &m, &b)?;
    admit(&a, &m, &c)?;
    b.pull(a.endpoint.addr(), &m).await?;
    c.pull(a.endpoint.addr(), &m).await?;
    let key = b.identity.coordinator_identity(&m, "test-agent")?;
    let offer = with_store(&b.store, |s| {
        s.offer_agent(
            &b.identity,
            &m,
            &m,
            AgentIdentity {
                author: key.public_key(),
                label: "Accessibility".into(),
                runtime: "grok".into(),
                role: AgentRole::Agent,
                contributor_name: "B".into(),
            },
        )
    })?;
    a.pull(b.endpoint.addr(), &m).await?;
    c.pull(b.endpoint.addr(), &m).await?;
    let dm = with_store(&a.store, |s| {
        s.open_agent_conversation(&a.identity, &m, &offer.id)
    })?;
    let private = with_store(&a.store, |s| {
        s.send_message(
            &a.identity,
            &m,
            &dm,
            "Private instruction".into(),
            None,
            None,
        )
    })?;
    assert_eq!(b.exchange(a.endpoint.addr(), &m).await?, vec![dm.clone()]);
    assert!(c.exchange(a.endpoint.addr(), &m).await?.is_empty());
    b.sync_scope(a.endpoint.addr(), &m, &dm).await?;
    assert!(
        with_store(&b.store, |s| s
            .local_audiences(&m, &b.identity.public_key()))?
        .is_empty()
    );
    let reply = with_store(&b.store, |s| {
        s.agent_request(
            &b.identity,
            &m,
            "test-agent",
            &offer.id,
            AgentOperation::Post {
                audience: dm.clone(),
                text: "Scoped agent response".into(),
                to: None,
                thread: Some(private.id),
            },
        )
    })?;
    a.sync_scope(b.endpoint.addr(), &m, &dm).await?;
    assert!(with_store(&a.store, |s| s.event(reply["event"].as_str().unwrap()))?.is_some());
    assert!(matches!(
        c.request(
            b.endpoint.addr(),
            &Request::Pull {
                mission: m.clone(),
                audience: dm.clone(),
                heads: vec![]
            }
        )
        .await?,
        Response::Rejected
    ));
    with_store(&b.store, |s| s.withdraw_agent(&b.identity, &m, &offer.id))?;
    a.pull(b.endpoint.addr(), &m).await?;
    assert!(b.sync_scope(a.endpoint.addr(), &m, &dm).await.is_err());
    assert!(b.exchange(a.endpoint.addr(), &m).await?.is_empty());
    a.shutdown().await?;
    b.shutdown().await?;
    c.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn forged_public_manifest_cannot_launder_private_blob_access() -> Result<()> {
    use harakiri_protocol::artifacts::*;
    let root = tempfile::tempdir()?;
    let a = local(&root.path().join("a"), 41).await?;
    let b = local(&root.path().join("b"), 42).await?;
    let mission = with_store(&a.store, |s| {
        s.create(&a.identity, a.endpoint.id().to_string(), definition())
    })?
    .id;
    admit(&a, &mission, &b)?;
    let secret = with_store(&a.store, |s| {
        s.create(&a.identity, a.endpoint.id().to_string(), definition())
    })?
    .id;
    let hidden = a
        .publish_file(
            &secret,
            "Private".into(),
            "index.html".into(),
            "text/html".into(),
            b"private mission bytes",
        )
        .await?;
    let Payload::ArtifactPublished { files, .. } = &hidden.body.payload else {
        unreachable!()
    };
    b.pull(a.endpoint.addr(), &mission).await?;
    // The attacker knows the private content hash and publishes that manifest in
    // a mission they can access. No node has received those bytes for this record.
    let forged = with_store(&b.store, |s| {
        s.artifact_action(
            &b.identity,
            &mission,
            &mission,
            "main",
            ArtifactAction::Publish {
                artifact: None,
                parents: vec![],
                document: ArtifactDocument {
                    title: "Forged".into(),
                    summary: "Guessing a known hash".into(),
                    kind: ArtifactKind::Application,
                    stage: ArtifactStage::Complete,
                    limitations: String::new(),
                    entrypoint: Some("index.html".into()),
                    inputs: vec![],
                    files: files.clone(),
                },
            },
        )
    })?;
    a.pull(b.endpoint.addr(), &mission).await?;
    assert!(
        b.fetch_file(a.endpoint.addr(), &forged.id, &files[0])
            .await
            .is_err()
    );
    assert!(!with_store(&a.store, |s| s
        .can_read_blob(&b.endpoint.id().to_string(), &files[0].hash))?);
    a.shutdown().await?;
    b.shutdown().await?;
    Ok(())
}
