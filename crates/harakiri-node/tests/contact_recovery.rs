use anyhow::Result;
use harakiri_node::{
    contact::{Contact, NetworkConfig, NetworkMode, now},
    discovery::{DiscoveryConfig, PEER_PREFIX},
    store::Store,
};
use harakiri_protocol::{Identity, MissionDefinition, Payload};

#[test]
fn community_routes_require_existing_identity_membership_and_local_consent() -> Result<()> {
    for case in [
        "valid",
        "disabled",
        "blocked",
        "expired",
        "unbounded_expiry",
        "wrong_signer",
        "wrong_endpoint",
        "lan_blocked",
        "remote_revoked",
        "local_unknown",
        "local_revoked",
        "local_withdrawn",
    ] {
        let root = tempfile::tempdir()?;
        let mut store = Store::open(&root.path().join("node.sqlite"))?;
        let owner = Identity::from_seed([1; 32]);
        let member = Identity::from_seed([2; 32]);
        let outsider = Identity::from_seed([3; 32]);
        let mission = store
            .create(
                &owner,
                owner.public_key(),
                MissionDefinition {
                    name: "Route recovery".into(),
                    objective: "Retain existing membership".into(),
                    scope: "Isolated fixture".into(),
                    criteria: vec![],
                    policy: None,
                },
            )?
            .id;
        store.append(
            &owner,
            &mission,
            Payload::MemberAdmitted {
                member: member.public_key(),
                endpoint: member.public_key(),
            },
        )?;
        if matches!(case, "local_revoked" | "local_withdrawn") {
            store.append(
                &owner,
                &mission,
                Payload::MemberAdmitted {
                    member: outsider.public_key(),
                    endpoint: outsider.public_key(),
                },
            )?;
        }
        let mut contact = Contact {
            endpoint: member.public_key(),
            addresses: vec!["127.0.0.1:8089".into()],
            relays: vec![],
            expires_ms: now() + 60000,
        };
        if case == "expired" {
            contact.expires_ms = now() - 1;
        }
        if case == "unbounded_expiry" {
            contact.expires_ms = now() + 30 * 24 * 60 * 60 * 1000;
        }
        if case == "wrong_endpoint" {
            contact.endpoint = outsider.public_key();
        }
        if case == "remote_revoked" {
            store.append(
                &owner,
                &mission,
                Payload::MemberRevoked {
                    member: member.public_key(),
                    accepted: None,
                },
            )?;
        }
        if case == "local_revoked" {
            store.append(
                &owner,
                &mission,
                Payload::MemberRevoked {
                    member: outsider.public_key(),
                    accepted: None,
                },
            )?;
        }
        if case == "local_withdrawn" {
            store.withdraw(&outsider, &mission, &outsider.public_key())?;
        }
        let signer = if case == "wrong_signer" {
            &outsider
        } else {
            &member
        };
        store.save_discovery_config(&DiscoveryConfig {
            enabled: case != "disabled",
            lan: false,
            bootstrap: vec![format!("{PEER_PREFIX}{}", contact.sign(signer)?)],
            blocked: if case == "blocked" {
                vec![member.public_key()]
            } else {
                vec![]
            },
        })?;
        let config = NetworkConfig {
            mode: NetworkMode::Direct,
            relays: vec![],
            allow_lan: case != "lan_blocked",
            route_directory: None,
        };
        let local = if case.starts_with("local_") {
            outsider.public_key()
        } else {
            owner.public_key()
        };
        store.refresh_known_peer_routes(&local, &config)?;
        let contacts = store.contacts(&mission)?;
        assert_eq!(contacts.len(), usize::from(case == "valid"), "{case}");
        let expected_members = if matches!(case, "local_revoked" | "local_withdrawn") {
            3
        } else {
            2
        };
        assert_eq!(
            store.members(&mission)?.len(),
            expected_members,
            "{case}: no new member"
        );
        if case == "valid" {
            let mut newer = contact.clone();
            newer.addresses = vec!["127.0.0.1:8090".into()];
            newer.expires_ms += 1000;
            let newer = newer.sign(&member)?;
            store.save_contact(&mission, &newer)?;
            store.refresh_known_peer_routes(&local, &config)?;
            assert_eq!(
                store.contacts(&mission)?,
                vec![newer],
                "Old ticket cannot replace newer address"
            );
        }
    }
    Ok(())
}
