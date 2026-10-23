//! Explicitly approved, replaceable endpoint lookup. Directory responses can
//! refresh a route, never membership, mission authority or execution consent.
use crate::{
    contact::{Contact, NetworkConfig},
    peer::PeerNode,
};
use anyhow::{Result, anyhow, ensure};
use iroh::{
    EndpointAddr,
    address_lookup::{AddressLookup, AddressLookupBuilder, PkarrResolver},
};
use n0_future::StreamExt;
use std::time::Duration;

impl PeerNode {
    pub async fn resolve_contact(
        &self,
        contact: &Contact,
        config: &NetworkConfig,
    ) -> Result<EndpointAddr> {
        contact.validate()?;
        let Some(url) = config.route_directory.as_ref() else {
            return contact.address(config);
        };
        if let Some((at, cached)) = self
            .route_cache
            .lock()
            .map_err(|_| anyhow!("route cache unavailable"))?
            .get(&contact.endpoint)
            && at.elapsed() < Duration::from_secs(60)
        {
            return cached.as_ref().map_or_else(
                || contact.address(config),
                |address| Contact::current(address).address(config),
            );
        }
        let result = self.lookup_route(contact, config, url).await;
        let mut cache = self
            .route_cache
            .lock()
            .map_err(|_| anyhow!("route cache unavailable"))?;
        if cache.len() >= 1024 {
            cache.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(60));
        }
        if cache.len() < 1024 {
            cache.insert(
                contact.endpoint.clone(),
                (std::time::Instant::now(), result.as_ref().ok().cloned()),
            );
        }
        result.or_else(|_| contact.address(config))
    }
    async fn lookup_route(
        &self,
        contact: &Contact,
        config: &NetworkConfig,
        url: &str,
    ) -> Result<EndpointAddr> {
        let resolver = PkarrResolver::builder(url.parse()?).into_address_lookup(&self.endpoint)?;
        let endpoint = contact.endpoint.parse()?;
        let mut stream = resolver
            .resolve(endpoint)
            .ok_or_else(|| anyhow!("route unavailable"))?;
        let item = tokio::time::timeout(Duration::from_secs(3), stream.next())
            .await?
            .ok_or_else(|| anyhow!("route unavailable"))??;
        ensure!(item.endpoint_id() == endpoint, "route identity mismatch");
        // Never install an unfiltered resolver on the transport: a remote record
        // cannot introduce a private IP or an operator-unapproved relay URL.
        Contact::current(&item.into_endpoint_addr()).address(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contact::{NetworkMode, now};
    use harakiri_protocol::Identity;

    #[tokio::test]
    async fn cached_routes_respect_current_lan_policy_and_lookup_opt_out() -> Result<()> {
        let root = tempfile::tempdir()?;
        let node = PeerNode::open(
            root.path(),
            Identity::from_seed([91; 32]),
            PeerNode::local_endpoint([92; 32]).await?,
        )
        .await?;
        let mut contact = Contact::current(&node.endpoint.addr());
        contact.addresses = vec!["127.0.0.1:9912".into()];
        contact.relays.clear();
        let mut config = NetworkConfig {
            mode: NetworkMode::Direct,
            relays: vec![],
            allow_lan: true,
            route_directory: Some("https://example.invalid/pkarr".into()),
        };
        let cached = contact.address(&config)?;
        contact.expires_ms = now() - 1;
        node.route_cache.lock().unwrap().insert(
            contact.endpoint.clone(),
            (std::time::Instant::now(), Some(cached)),
        );
        assert!(node.resolve_contact(&contact, &config).await.is_ok());
        config.allow_lan = false;
        assert!(
            node.resolve_contact(&contact, &config).await.is_err(),
            "a prior lookup cannot bypass changed local LAN policy"
        );
        config.allow_lan = true;
        config.route_directory = None;
        assert!(
            node.resolve_contact(&contact, &config).await.is_err(),
            "disabled lookup ignores cached directory routes and rejects an expired ticket"
        );
        node.shutdown().await?;
        Ok(())
    }
}
