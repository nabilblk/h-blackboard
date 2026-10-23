use anyhow::Result;
use harakiri_node::{
    peer::{PeerNode, with_store},
    store::Store,
};
use harakiri_protocol::{Identity, MissionDefinition, Payload, limits};

fn definition() -> MissionDefinition {
    MissionDefinition {
        name: "Concurrent history".into(),
        objective: "Make progress".into(),
        scope: "Temporary regression".into(),
        criteria: vec![],
        policy: None,
    }
}
async fn node(root: &std::path::Path, seed: u8) -> Result<PeerNode> {
    PeerNode::open(
        root,
        Identity::from_seed([seed; 32]),
        PeerNode::local_endpoint([seed + 10; 32]).await?,
    )
    .await
}
fn messages(node: &PeerNode, mission: &str, count: usize) -> Result<()> {
    for n in 0..count {
        node.append(
            mission,
            Payload::MessagePosted {
                text: format!("Useful update {n}"),
            },
        )?;
    }
    Ok(())
}
#[tokio::test]
async fn concurrent_writers_progress_past_duplicate_prefixes_and_keep_cursors_after_restart()
-> Result<()> {
    let root = tempfile::tempdir()?;
    let a = node(&root.path().join("a"), 1).await?;
    let b = node(&root.path().join("b"), 2).await?;
    let m = with_store(&a.store, |s| {
        s.create(&a.identity, a.endpoint.id().to_string(), definition())
    })?
    .id;
    a.append(
        &m,
        Payload::MemberAdmitted {
            member: b.identity.public_key(),
            endpoint: b.endpoint.id().to_string(),
        },
    )?;
    messages(&a, &m, 130)?;
    b.pull(a.endpoint.addr(), &m).await?;
    messages(&b, &m, 130)?;
    a.pull(b.endpoint.addr(), &m).await?;
    b.pull(a.endpoint.addr(), &m).await?;
    messages(&a, &m, 65)?;
    messages(&b, &m, 65)?;
    // This fixture reproduces the old head-only anti-entropy deadlock: its
    // bounded delta is all duplicates, in both directions.
    for (sender, receiver) in [(&a, &b), (&b, &a)] {
        let heads = with_store(&receiver.store, |s| s.heads(&m))?;
        let batch = with_store(&sender.store, |s| s.delta(&m, &heads))?;
        assert_eq!(batch.len(), limits::MAX_BATCH_EVENTS);
        let imported = with_store(&receiver.store, |s| s.import(&batch))?;
        assert_eq!(imported.inserted, 0);
    }
    a.sync_scope(b.endpoint.addr(), &m, "main").await?;
    a.shutdown().await?;
    let a = node(&root.path().join("a"), 1).await?;
    for _ in 0..10 {
        a.sync_scope(b.endpoint.addr(), &m, "main").await?;
    }
    assert_eq!(
        with_store(&a.store, |s| s.heads(&m))?,
        with_store(&b.store, |s| s.heads(&m))?
    );
    let delivery = with_store(&a.store, |s| s.deliveries(&m, "main"))?;
    let peer = delivery
        .iter()
        .find(|d| d.endpoint == b.endpoint.id().to_string())
        .unwrap();
    assert!(!peer.pending);
    assert!(peer.last_converged_ms.is_some());
    assert_eq!(peer.stalled_exchanges, 0);
    assert!(peer.control_acknowledged);
    a.shutdown().await?;
    b.shutdown().await?;
    Ok(())
}

#[test]
fn history_cursor_is_scoped_bounded_and_recovers_an_unknown_anchor() -> Result<()> {
    let mut s = Store::open(std::path::Path::new(":memory:"))?;
    let owner = Identity::from_seed([1; 32]);
    let m = s.create(&owner, "1".repeat(64), definition())?.id;
    let other = s.create(&owner, "1".repeat(64), definition())?.id;
    for i in 0..130 {
        s.append(
            &owner,
            &m,
            Payload::MessagePosted {
                text: format!("{i}"),
            },
        )?;
    }
    let first = s.history_page(&m, "main", None)?;
    assert_eq!(first.events.len(), 64);
    assert!(first.more);
    let second = s.history_page(&m, "main", first.after.as_deref())?;
    assert_eq!(second.events.len(), 64);
    assert_ne!(first.after, second.after);
    let third = s.history_page(&m, "main", second.after.as_deref())?;
    assert_eq!(third.events.len(), 3);
    assert!(!third.more);
    assert!(
        s.history_page(&m, "main", third.after.as_deref())?
            .events
            .is_empty()
    );
    let reset = s.history_page(&m, "main", Some(&other))?;
    assert!(reset.reset);
    assert_eq!(reset.events, first.events);
    assert!(s.history_page(&m, "main", Some("invalid")).is_err());
    assert!(
        s.save_sync_cursor(&m, "main", "peer", true, Some(&other))
            .is_err()
    );
    Ok(())
}

#[tokio::test]
async fn three_writers_converge_at_batch_boundaries_and_restore_a_peer_backup() -> Result<()> {
    let root = tempfile::tempdir()?;
    let a = node(&root.path().join("a"), 3).await?;
    let b = node(&root.path().join("b"), 4).await?;
    let c = node(&root.path().join("c"), 5).await?;
    let m = with_store(&a.store, |s| {
        s.create(&a.identity, a.endpoint.id().to_string(), definition())
    })?
    .id;
    for other in [&b, &c] {
        a.append(
            &m,
            Payload::MemberAdmitted {
                member: other.identity.public_key(),
                endpoint: other.endpoint.id().to_string(),
            },
        )?;
    }
    let backup = with_store(&a.store, |s| s.history_page(&m, "main", None))?.events;
    b.pull(a.endpoint.addr(), &m).await?;
    c.pull(a.endpoint.addr(), &m).await?;
    for (writer, count) in [(&a, 63), (&b, 64), (&c, 65)] {
        messages(writer, &m, count)?;
    }
    for _ in 0..12 {
        a.sync_scope(b.endpoint.addr(), &m, "main").await?;
        b.sync_scope(c.endpoint.addr(), &m, "main").await?;
        c.sync_scope(a.endpoint.addr(), &m, "main").await?;
    }
    let expected = with_store(&a.store, |s| s.heads(&m))?;
    assert_eq!(expected, with_store(&b.store, |s| s.heads(&m))?);
    assert_eq!(expected, with_store(&c.store, |s| s.heads(&m))?);
    b.shutdown().await?;
    // Same authenticated endpoint, restored to a much earlier accepted log.
    // A retains both cursors from before this loss of history.
    let restored = node(&root.path().join("restored-b"), 4).await?;
    with_store(&restored.store, |s| s.import(&backup))?;
    for _ in 0..12 {
        a.sync_scope(restored.endpoint.addr(), &m, "main").await?;
    }
    assert_eq!(expected, with_store(&restored.store, |s| s.heads(&m))?);
    assert!(
        !with_store(&a.store, |s| s.deliveries(&m, "main"))?
            .iter()
            .find(|d| d.endpoint == restored.endpoint.id().to_string())
            .unwrap()
            .pending
    );
    a.shutdown().await?;
    c.shutdown().await?;
    restored.shutdown().await?;
    Ok(())
}
