use anyhow::Result;
use harakiri_node::{
    admission::Invitation,
    contact::{Contact, now},
    discovery::{Advertisement, DOMAIN, DiscoveryConfig, PREFIX, TTL},
    store::Store,
    withdrawal::Withdrawal,
};
use harakiri_protocol::{
    Identity, MissionDefinition, Payload,
    policy::{Coordination, MissionBudget, MissionPolicy, Participation},
};

fn definition(participation: Participation) -> MissionDefinition {
    MissionDefinition {
        name: "Community science day".into(),
        objective: "Prepare a practical event".into(),
        scope: "INSPECTION_ONLY_SCOPE".into(),
        criteria: vec!["A usable plan".into()],
        policy: Some(MissionPolicy {
            coordination: Coordination::Coordinated,
            participation,
            budget: MissionBudget::Unlimited {},
        }),
    }
}
fn contact(key: &Identity) -> Contact {
    Contact {
        endpoint: key.public_key(),
        addresses: vec!["127.0.0.1:8089".into()],
        relays: vec![],
        expires_ms: now() + TTL,
    }
}
fn enabled() -> DiscoveryConfig {
    DiscoveryConfig {
        enabled: true,
        ..Default::default()
    }
}

#[test]
fn listings_are_public_briefs_not_membership_or_private_history() -> Result<()> {
    let root = tempfile::tempdir()?;
    let mut s = Store::open(&root.path().join("a.sqlite"))?;
    let owner = Identity::from_seed([1; 32]);
    let private = s.create(
        &owner,
        owner.public_key(),
        definition(Participation::Private),
    )?;
    let public = s.create(
        &owner,
        owner.public_key(),
        definition(Participation::Approval),
    )?;
    assert!(
        s.publish_listing(
            &owner,
            &public.id,
            "Help plan a science day".into(),
            vec![],
            true,
            contact(&owner)
        )
        .is_err()
    );
    s.save_discovery_config(&enabled())?;
    assert!(
        s.publish_listing(
            &owner,
            &private.id,
            "No disclosure".into(),
            vec![],
            true,
            contact(&owner)
        )
        .is_err()
    );
    let reference = s.publish_listing(
        &owner,
        &public.id,
        "Help plan a science day".into(),
        vec!["Research".into()],
        true,
        contact(&owner),
    )?;
    let (signer, ad) = Advertisement::parse(&reference)?;
    assert_eq!(signer, owner.public_key());
    assert!(!serde_json::to_string(&ad)?.contains("INSPECTION_ONLY_SCOPE"));
    assert_eq!(s.discovery_page(None)?.items, vec![reference.clone()]);
    assert_eq!(
        Invitation::review(&reference, &s.inspect_ticket(&reference)?)?
            .definition
            .scope,
        "INSPECTION_ONLY_SCOPE"
    );
    assert_eq!(s.members(&public.id)?.len(), 1);
    assert!(!s.can_read(&public.id, &Identity::from_seed([2; 32]).public_key())?);
    let fake = Identity::from_seed([3; 32]);
    let forged = format!("{PREFIX}{}", fake.claim(DOMAIN, &ad)?);
    assert!(Invitation::review(&forged, public.bytes()).is_err());
    let wrong_domain = format!("{PREFIX}{}", owner.claim(b"harakiri/contact/1", &ad)?);
    assert!(Advertisement::parse(&wrong_domain).is_err());
    let mut tampered = reference.into_bytes();
    let last = tampered.len() - 2;
    tampered[last] = if tampered[last] == b'a' { b'b' } else { b'a' };
    assert!(Advertisement::parse(std::str::from_utf8(&tampered)?).is_err());
    // A relay becoming available after endpoint startup must refresh the brief
    // immediately, rather than leaving it unreachable until the TTL renewal.
    let mut refreshed = contact(&owner);
    refreshed.relays = vec!["https://relay.example.org".into()];
    s.renew_publications(&owner, refreshed, false)?;
    let renewed = s.listing_views()?.remove(0).advertisement;
    assert_eq!(renewed.revision, ad.revision + 1);
    assert_eq!(renewed.contact.relays, vec!["https://relay.example.org"]);
    Ok(())
}

#[test]
fn expiry_unlisting_forks_and_blocking_cannot_silently_restore_old_claims() -> Result<()> {
    let root = tempfile::tempdir()?;
    let path = root.path().join("a.sqlite");
    let mut a = Store::open(&path)?;
    let mut b = Store::open(&root.path().join("b.sqlite"))?;
    let owner = Identity::from_seed([1; 32]);
    a.save_discovery_config(&enabled())?;
    b.save_discovery_config(&enabled())?;
    let m = a
        .create(
            &owner,
            owner.public_key(),
            definition(Participation::Approval),
        )?
        .id;
    let old = a.publish_listing(
        &owner,
        &m,
        "Original public brief".into(),
        vec![],
        true,
        contact(&owner),
    )?;
    b.cache_listing(&old)?;
    let unlisted = a.publish_listing(
        &owner,
        &m,
        "Original public brief".into(),
        vec![],
        false,
        contact(&owner),
    )?;
    b.cache_listing(&unlisted)?;
    b.cache_listing(&old)?;
    assert_eq!(b.listing_views()?[0].status, "unlisted");
    assert!(a.inspect_ticket(&old).is_err());
    assert!(a.inspect_ticket(&unlisted).is_err());
    let (_, mut ad) = Advertisement::parse(&unlisted)?;
    ad.summary = "Different bytes, same revision".into();
    b.cache_listing(&format!("{PREFIX}{}", owner.claim(DOMAIN, &ad)?))?;
    assert_eq!(b.listing_views()?[0].status, "conflict");
    assert!(b.discovery_page(None)?.items.is_empty());
    ad.revision += 1;
    ad.active = true;
    ad.issued_ms = now() - TTL - 10;
    ad.expires_ms = now() - 10;
    let expired = format!("{PREFIX}{}", owner.claim(DOMAIN, &ad)?);
    assert!(b.cache_listing(&expired).is_err());
    assert!(Invitation::review(&expired, a.event(&m)?.unwrap().bytes()).is_err());
    b.save_discovery_config(&DiscoveryConfig {
        blocked: vec![owner.public_key()],
        ..enabled()
    })?;
    assert!(b.listing_views()?.is_empty());
    assert!(b.cache_listing(&old).is_err());
    drop(a);
    let a = Store::open(&path)?;
    assert_eq!(a.listing_views()?[0].status, "unlisted");
    assert!(a.inspect_ticket(&old).is_err());
    Ok(())
}

#[test]
fn catalog_pagination_caps_and_disabled_discovery_are_enforced() -> Result<()> {
    let root = tempfile::tempdir()?;
    let mut s = Store::open(&root.path().join("a.sqlite"))?;
    assert!(s.discovery_page(None).is_err());
    s.save_discovery_config(&enabled())?;
    for seed in 1..=2 {
        let owner = Identity::from_seed([seed; 32]);
        for _ in 0..8 {
            let m = s
                .create(
                    &owner,
                    owner.public_key(),
                    definition(Participation::Approval),
                )?
                .id;
            s.publish_listing(
                &owner,
                &m,
                "A bounded brief".into(),
                vec![],
                true,
                contact(&owner),
            )?;
        }
        let ninth = s
            .create(
                &owner,
                owner.public_key(),
                definition(Participation::Approval),
            )?
            .id;
        assert!(
            s.publish_listing(
                &owner,
                &ninth,
                "No ninth slot".into(),
                vec![],
                true,
                contact(&owner)
            )
            .is_err()
        );
    }
    let first = s.discovery_page(None)?;
    assert_eq!(first.items.len(), 8);
    let second = s.discovery_page(first.after.as_deref())?;
    assert_eq!(second.items.len(), 8);
    assert!(second.after.is_none());
    assert!(first.items.iter().all(|i| !second.items.contains(i)));
    assert!(s.discovery_page(Some("invalid")).is_err());
    assert!(s.discovery_page(Some(&"x".repeat(129))).is_err());
    assert!(
        s.discovery_page(Some(&format!("{}:{}", "é".repeat(32), "a".repeat(64))))
            .is_err()
    );
    s.save_discovery_config(&DiscoveryConfig::default())?;
    assert!(s.discovery_page(None).is_err());
    Ok(())
}

#[test]
fn withdrawal_is_durable_blocks_local_work_and_only_accepts_the_members_notice() -> Result<()> {
    let root = tempfile::tempdir()?;
    let path = root.path().join("b.sqlite");
    let mut a = Store::open(&root.path().join("a.sqlite"))?;
    let mut b = Store::open(&path)?;
    let owner = Identity::from_seed([1; 32]);
    let worker = Identity::from_seed([2; 32]);
    let stranger = Identity::from_seed([3; 32]);
    let m = a.create(
        &owner,
        owner.public_key(),
        definition(Participation::Private),
    )?;
    let grant = a.append(
        &owner,
        &m.id,
        Payload::MemberAdmitted {
            member: worker.public_key(),
            endpoint: worker.public_key(),
        },
    )?;
    b.import(&[m.bytes().to_vec(), grant.bytes().to_vec()])?;
    let result = b.append(
        &worker,
        &m.id,
        Payload::MessagePosted {
            text: "Delivered before withdrawing".into(),
        },
    )?;
    a.import(&[result.bytes().to_vec()])?;
    a.save_contact(&m.id, &contact(&worker).sign(&worker)?)?;
    assert_eq!(a.contacts(&m.id)?.len(), 1);
    assert!(a.withdraw(&owner, &m.id, &owner.public_key()).is_err());
    b.withdraw(&worker, &m.id, &worker.public_key())?;
    assert!(!b.can_read(&m.id, &owner.public_key())?);
    assert!(
        b.append(
            &worker,
            &m.id,
            Payload::MessagePosted {
                text: "Too late".into()
            }
        )
        .is_err()
    );
    let notice = b.withdrawal_notices(&m.id)?.remove(0);
    let (_, n) = Withdrawal::verify(&notice)?;
    let forged = stranger.claim(harakiri_node::withdrawal::DOMAIN, &n)?;
    assert!(a.receive_withdrawal(&forged).is_err());
    a.receive_withdrawal(&notice)?;
    a.receive_withdrawal(&notice)?;
    assert!(!a.can_read(&m.id, &worker.public_key())?);
    assert!(a.contacts(&m.id)?.is_empty());
    assert!(!a.provisional(&result.id)?);
    drop(b);
    let b = Store::open(&path)?;
    assert!(b.locally_withdrawn(&m.id)?);
    assert_eq!(
        b.messages(&m.id, None)?.items[0].text,
        "Delivered before withdrawing"
    );
    assert!(
        b.members(&m.id)?
            .iter()
            .find(|p| p.author == worker.public_key())
            .unwrap()
            .withdrawn
    );
    Ok(())
}

#[tokio::test]
#[ignore = "Opt-in multicast proof on owned interfaces; uses a unique test service namespace"]
async fn lan_discovery_finds_a_peer_then_fetches_only_its_signed_public_brief() -> Result<()> {
    use harakiri_node::{
        contact::{NetworkConfig, NetworkMode},
        peer::{PeerNode, Request, Response, with_store},
    };
    use iroh::{Endpoint, SecretKey, endpoint::presets};
    use iroh_mdns_address_lookup::{DiscoveryEvent, MdnsAddressLookup};
    use n0_future::StreamExt;
    let root = tempfile::tempdir()?;
    let a = PeerNode::open(
        &root.path().join("a"),
        Identity::from_seed([71; 32]),
        Endpoint::builder(presets::Minimal)
            .secret_key(SecretKey::from_bytes(&[81; 32]))
            .bind()
            .await?,
    )
    .await?;
    let b = PeerNode::open(
        &root.path().join("b"),
        Identity::from_seed([72; 32]),
        Endpoint::builder(presets::Minimal)
            .secret_key(SecretKey::from_bytes(&[82; 32]))
            .bind()
            .await?,
    )
    .await?;
    let namespace = format!("hb-proof-{}", hex::encode(rand::random::<[u8; 4]>()));
    let a_mdns = MdnsAddressLookup::builder()
        .service_name(&namespace)
        .addr_filter(iroh::address_lookup::AddrFilter::ip_only())
        .build(a.endpoint.id())?;
    let b_mdns = MdnsAddressLookup::builder()
        .service_name(&namespace)
        .addr_filter(iroh::address_lookup::AddrFilter::ip_only())
        .build(b.endpoint.id())?;
    let mut events = b_mdns.subscribe().await;
    a.endpoint.address_lookup()?.add(a_mdns);
    b.endpoint.address_lookup()?.add(b_mdns);
    let address = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        while let Some(event) = events.next().await {
            if let DiscoveryEvent::Discovered { endpoint_info, .. } = event
                && endpoint_info.endpoint_id == a.endpoint.id()
            {
                return Some(endpoint_info.into_endpoint_addr());
            }
        }
        None
    })
    .await?
    .ok_or_else(|| anyhow::anyhow!("no LAN peer"))?;
    let reference = with_store(&a.store, |s| {
        s.save_discovery_config(&enabled())?;
        let m = s
            .create(
                &a.identity,
                a.endpoint.id().to_string(),
                definition(Participation::Approval),
            )?
            .id;
        s.publish_listing(
            &a.identity,
            &m,
            "An isolated LAN discovery proof".into(),
            vec![],
            true,
            Contact::current(&a.endpoint.addr()),
        )
    })?;
    let Response::Catalog { page } = b
        .request(
            address,
            &Request::Catalog {
                items: vec![],
                after: None,
            },
        )
        .await?
    else {
        anyhow::bail!("missing public feed")
    };
    assert_eq!(page.items, vec![reference.clone()]);
    let cfg = NetworkConfig {
        mode: NetworkMode::Direct,
        allow_lan: true,
        relays: vec![],
    };
    let reviewed = b.inspect(&reference, &cfg).await?;
    assert_eq!(
        reviewed.review(&reference, None)?.definition.scope,
        "INSPECTION_ONLY_SCOPE"
    );
    assert!(with_store(&b.store, |s| s.missions())?.is_empty());
    a.shutdown().await?;
    b.shutdown().await?;
    Ok(())
}
