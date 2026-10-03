use anyhow::Result;
use harakiri_node::{
    admission::Offer,
    contact::{CONTACT_DOMAIN, Contact, NetworkConfig, NetworkMode},
    peer::{PeerNode, Request, Response, with_store},
};

#[tokio::test]
async fn live_review_is_nonce_bound_and_changed_terms_require_new_consent() -> Result<()> {
    use harakiri_protocol::lifecycle::ControlAction;
    let root = tempfile::tempdir()?;
    let a = node(&root.path().join("review-owner"), 11).await?;
    let b = node(&root.path().join("review-contributor"), 12).await?;
    let mission = with_store(&a.store, |s| {
        s.create(&a.identity, a.endpoint.id().to_string(), definition())
    })?
    .id;
    let ticket = with_store(&a.store, |s| {
        s.issue_invitation(&a.identity, &mission, Contact::current(&a.endpoint.addr()))
    })?;
    let nonce = "ab".repeat(32);
    let challenged = with_store(&a.store, |s| {
        s.inspect_current(&a.identity, &ticket, &nonce)
    })?;
    assert!(challenged.review(&ticket, Some(&nonce)).is_ok());
    assert!(challenged.review(&ticket, Some(&"cd".repeat(32))).is_err());
    let old = b.inspect(&ticket, &config()).await?;
    with_store(&b.store, |s| s.remember_join(&ticket, &old))?;
    assert_eq!(b.poll_join(&ticket, &config()).await?, "pending");
    with_store(&a.store, |s| {
        s.append(
            &a.identity,
            &mission,
            Payload::MessagePosted {
                text: "Main history must not leak during inspection".into(),
            },
        )
    })?;
    let mut changed = definition();
    changed.objective = "An updated objective".into();
    changed.scope = "New instructions requiring review".into();
    let edit = with_store(&a.store, |s| {
        s.control(
            &a.identity,
            &mission,
            &mission,
            ControlAction::UpdateInstructions {
                definition: changed.clone(),
            },
        )
    })?;
    assert_eq!(
        with_store(&a.store, |s| s.requests(&mission))?[0].status,
        "review_required"
    );
    assert!(
        with_store(&a.store, |s| s.decide_join(
            &a.identity,
            &mission,
            &b.identity.public_key(),
            true
        ))
        .is_err()
    );
    assert_eq!(b.poll_join(&ticket, &config()).await?, "review_required");
    let new = b.inspect(&ticket, &config()).await?;
    let reviewed = new.review(&ticket, None)?;
    assert_eq!(reviewed.definition, changed);
    assert_eq!(reviewed.reviewed_revision, edit.id);
    // The bounded inspection holds a root and an owner terms claim, not the
    // ordinary messages that intervene in its control writer chain.
    assert!(
        !String::from_utf8_lossy(&hex::decode(&new.proof)?).contains("Main history must not leak")
    );
    assert!(
        !String::from_utf8_lossy(&hex::decode(&new.genesis)?)
            .contains("Main history must not leak")
    );
    with_store(&b.store, |s| s.remember_join(&ticket, &new))?;
    assert_eq!(b.poll_join(&ticket, &config()).await?, "pending");
    with_store(&a.store, |s| {
        s.decide_join(&a.identity, &mission, &b.identity.public_key(), true)
    })?;
    assert_eq!(b.poll_join(&ticket, &config()).await?, "admitted");
    assert_eq!(
        with_store(&b.store, |s| s.control_state(&mission))?.definition,
        changed
    );
    a.shutdown().await?;
    b.shutdown().await?;
    Ok(())
}
use harakiri_protocol::{
    Identity, MissionDefinition, Payload,
    policy::{Coordination, MissionBudget, MissionPolicy, Participation},
};

async fn node(root: &std::path::Path, seed: u8) -> Result<PeerNode> {
    PeerNode::open(
        root,
        Identity::from_seed([seed; 32]),
        PeerNode::local_endpoint([seed + 10; 32]).await?,
    )
    .await
}
fn config() -> NetworkConfig {
    NetworkConfig {
        mode: NetworkMode::Direct,
        relays: vec![],
        allow_lan: true,
    }
}
fn definition() -> MissionDefinition {
    MissionDefinition {
        name: "Invited fixture".into(),
        objective: "Three independent nodes".into(),
        scope: "Isolated profiles".into(),
        criteria: vec![],
        policy: Some(MissionPolicy {
            coordination: Coordination::Coordinated,
            participation: Participation::Private,
            budget: MissionBudget::Unlimited {},
        }),
    }
}

#[tokio::test]
async fn invitation_review_approval_contacts_and_creator_offline_catchup() -> Result<()> {
    let root = tempfile::tempdir()?;
    let a = node(&root.path().join("a"), 1).await?;
    let b = node(&root.path().join("b"), 2).await?;
    let c = node(&root.path().join("c"), 3).await?;
    let m = with_store(&a.store, |s| {
        s.create(&a.identity, a.endpoint.id().to_string(), definition())
    })?
    .id;
    let ticket = with_store(&a.store, |s| {
        s.issue_invitation(&a.identity, &m, Contact::current(&a.endpoint.addr()))
    })?;
    let bytes = b.inspect(&ticket, &config()).await?;
    assert_eq!(bytes.review(&ticket, None)?.mission, m);
    assert!(with_store(&b.store, |s| s.missions())?.is_empty());
    assert_eq!(with_store(&a.store, |s| s.members(&m))?.len(), 1);
    for joiner in [&b, &c] {
        with_store(&joiner.store, |s| s.remember_join(&ticket, &bytes))?;
        assert_eq!(joiner.poll_join(&ticket, &config()).await?, "pending");
        assert!(with_store(&joiner.store, |s| s.missions())?.is_empty());
        assert!(matches!(
            joiner
                .request(
                    a.endpoint.addr(),
                    &Request::Pull {
                        mission: m.clone(),
                        audience: "main".into(),
                        heads: vec![]
                    }
                )
                .await?,
            Response::Rejected
        ));
        with_store(&a.store, |s| {
            s.decide_join(&a.identity, &m, &joiner.identity.public_key(), true)
        })?;
        // Host announces its address only to admitted peers.
        with_store(&a.store, |s| s.save_contact(&m, &a.contact()?))?;
        assert_eq!(joiner.poll_join(&ticket, &config()).await?, "admitted");
        assert_eq!(
            with_store(&joiner.store, |s| s.missions())?[0].state,
            "preparing"
        );
    }
    b.sync_scope(a.endpoint.addr(), &m, "main").await?;
    b.exchange(a.endpoint.addr(), &m).await?;
    c.exchange(a.endpoint.addr(), &m).await?;
    let b_contacts = with_store(&b.store, |s| s.contacts(&m))?;
    let c_address = b_contacts
        .iter()
        .map(|s| Contact::verify(s))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .find(|(author, _)| author == &c.identity.public_key())
        .unwrap()
        .1
        .address(&config())?;
    a.shutdown().await?;
    b.append(
        &m,
        Payload::MessagePosted {
            text: "Owner offline; B can still contribute".into(),
        },
    )?;
    b.sync_scope(c_address, &m, "main").await?;
    assert_eq!(
        with_store(&c.store, |s| s.messages(&m, None))?.items[0].text,
        "Owner offline; B can still contribute"
    );
    let deliveries = with_store(&b.store, |s| s.deliveries(&m, "main"))?;
    assert!(
        !deliveries
            .iter()
            .find(|d| d.endpoint == c.endpoint.id().to_string())
            .unwrap()
            .pending
    );
    b.shutdown().await?;
    let b = node(&root.path().join("b"), 2).await?;
    c.append(
        &m,
        Payload::MessagePosted {
            text: "Stored during B's restart".into(),
        },
    )?;
    b.sync_scope(c.endpoint.addr(), &m, "main").await?;
    assert_eq!(
        with_store(&b.store, |s| s.messages(&m, None))?.items.len(),
        2
    );
    b.shutdown().await?;
    c.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn tickets_and_join_offers_are_bound_to_owner_mission_and_tls_endpoint() -> Result<()> {
    let root = tempfile::tempdir()?;
    let a = node(&root.path().join("a"), 1).await?;
    let b = node(&root.path().join("b"), 2).await?;
    let c = node(&root.path().join("c"), 3).await?;
    let m = with_store(&a.store, |s| {
        s.create(&a.identity, a.endpoint.id().to_string(), definition())
    })?
    .id;
    let ticket = with_store(&a.store, |s| {
        s.issue_invitation(&a.identity, &m, Contact::current(&a.endpoint.addr()))
    })?;
    let offer = Offer::sign(
        &b.identity,
        &ticket,
        Contact::current(&b.endpoint.addr()),
        m.clone(),
    )?;
    assert!(matches!(
        c.request(
            a.endpoint.addr(),
            &Request::Join {
                ticket: ticket.clone(),
                offer: offer.clone()
            }
        )
        .await?,
        Response::Rejected
    ));
    assert!(
        harakiri_protocol::claims::verify::<harakiri_node::admission::Offer>(
            CONTACT_DOMAIN,
            &offer
        )
        .is_err()
    );
    let mut tampered = ticket.clone().into_bytes();
    let last = tampered.last_mut().unwrap();
    *last = if *last == b'0' { b'1' } else { b'0' };
    assert!(
        b.inspect(&String::from_utf8(tampered)?, &config())
            .await
            .is_err()
    );
    assert!(
        matches!(b.request(a.endpoint.addr(),&Request::Join {ticket:ticket.clone(),offer}).await?,Response::JoinStatus {status} if status=="pending")
    );
    assert!(
        with_store(&a.store, |s| s.decide_join(
            &b.identity,
            &m,
            &b.identity.public_key(),
            true
        ))
        .is_err()
    );
    with_store(&a.store, |s| s.revoke_invitations(&a.identity, &m))?;
    assert!(b.inspect(&ticket, &config()).await.is_err());
    a.shutdown().await?;
    b.shutdown().await?;
    c.shutdown().await?;
    Ok(())
}

#[test]
fn contact_routes_require_local_consent_and_never_adopt_peer_relay_urls() -> Result<()> {
    let c = Contact {
        endpoint: Identity::from_seed([1; 32]).public_key(),
        addresses: vec![
            "127.0.0.1:3000".into(),
            "[::ffff:169.254.169.254]:80".into(),
        ],
        relays: vec!["https://untrusted.example/".into()],
        expires_ms: harakiri_node::contact::now() + 60000,
    };
    let strict = NetworkConfig {
        mode: NetworkMode::Direct,
        relays: vec![],
        allow_lan: false,
    };
    assert!(c.address(&strict).is_err());
    assert_eq!(c.address(&config())?.relay_urls().count(), 0);
    assert_eq!(c.address(&config())?.ip_addrs().count(), 2);
    let signed = c.sign(&Identity::from_seed([2; 32]))?;
    assert_eq!(
        Contact::verify(&signed)?.0,
        Identity::from_seed([2; 32]).public_key()
    );
    Ok(())
}

#[tokio::test]
async fn private_streams_and_blobs_exclude_the_owner_and_revocation_reaches_removed_nodes()
-> Result<()> {
    let root = tempfile::tempdir()?;
    let a = node(&root.path().join("a"), 1).await?;
    let b = node(&root.path().join("b"), 2).await?;
    let c = node(&root.path().join("c"), 3).await?;
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
    b.pull(a.endpoint.addr(), &m).await?;
    c.pull(a.endpoint.addr(), &m).await?;
    let scope = format!("private:{}", "cd".repeat(32));
    with_store(&b.store, |s| {
        s.append_to(
            &b.identity,
            &m,
            &scope,
            Payload::AudienceCreated {
                readers: vec![b.identity.public_key(), c.identity.public_key()],
            },
        )
    })?;
    with_store(&b.store, |s| {
        s.append_to(
            &b.identity,
            &m,
            &scope,
            Payload::MessagePosted {
                text: "B and C only".into(),
            },
        )
    })?;
    let artifact = b
        .publish_file_to(
            &m,
            &scope,
            harakiri_node::peer::FileInput {
                title: "Private evidence",
                path: "evidence.txt",
                media_type: "text/plain",
                bytes: b"Private fixture bytes",
            },
        )
        .await?;
    let Payload::ArtifactPublished { files, .. } = artifact.body.payload else {
        unreachable!()
    };
    assert!(
        a.fetch_file(b.endpoint.addr(), &artifact.id, &files[0])
            .await
            .is_err()
    );
    // Even a known cursor/stream/hash does not grant the mission owner access.
    assert!(matches!(
        a.request(
            b.endpoint.addr(),
            &Request::Pull {
                mission: m.clone(),
                audience: scope.clone(),
                heads: vec![]
            }
        )
        .await?,
        Response::Rejected
    ));
    assert!(a.exchange(b.endpoint.addr(), &m).await?.is_empty());
    assert_eq!(
        c.exchange(b.endpoint.addr(), &m).await?,
        vec![scope.clone()]
    );
    c.pull_scope(b.endpoint.addr(), &m, &scope).await?;
    assert_eq!(
        c.fetch_file(b.endpoint.addr(), &artifact.id, &files[0])
            .await?,
        b"Private fixture bytes"
    );
    assert_eq!(with_store(&a.store, |s| s.missions())?[0].event_count, 3);
    // Owner revokes C. B learns the record and rejects C's existing identity.
    a.append(
        &m,
        Payload::MemberRevoked {
            member: c.identity.public_key(),
            accepted: None,
        },
    )?;
    b.sync_scope(a.endpoint.addr(), &m, "main").await?;
    assert!(c.sync_scope(b.endpoint.addr(), &m, "main").await.is_err());
    assert!(with_store(&c.store, |s| s.is_revoked(&m, &c.identity.public_key()))?);
    assert!(
        c.append(
            &m,
            Payload::MessagePosted {
                text: "must stop locally".into()
            }
        )
        .is_err()
    );
    assert_eq!(
        with_store(&c.store, |s| s.messages_in(&m, &scope, None))?
            .items
            .len(),
        1
    );
    assert!(
        c.fetch_file(b.endpoint.addr(), &artifact.id, &files[0])
            .await
            .is_err()
    );
    assert!(
        with_store(&b.store, |s| s.can_read_scope(
            &m,
            &scope,
            &c.endpoint.id().to_string()
        ))? == false
    );
    c.shutdown().await?;
    let c = node(&root.path().join("c"), 3).await?;
    assert!(
        c.append(
            &m,
            Payload::MessagePosted {
                text: "restart cannot bypass revocation".into()
            }
        )
        .is_err()
    );
    a.shutdown().await?;
    b.shutdown().await?;
    c.shutdown().await?;
    Ok(())
}
