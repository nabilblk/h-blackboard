//! The native host owns network consent and the service lifetime. No agent has
//! access to this control surface. Reconciliation is bounded and replay-safe.
use crate::discovery::{Advertisement, DiscoveryConfig, PEER_PREFIX};
use crate::discovery_health::{DiscoveryHealth, DiscoveryOutcome};
use crate::{
    contact::{Contact, NetworkConfig, NetworkMode},
    peer::{PeerNode, SharedStore, with_store},
};
use anyhow::{Result, ensure};
use harakiri_protocol::Identity;
use iroh::{Endpoint, SecretKey, endpoint::presets};
use iroh_mdns_address_lookup::{DiscoveryEvent, MdnsAddressLookup};
use n0_future::StreamExt;
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::task::JoinHandle;

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct NetworkView {
    pub config: NetworkConfig,
    pub running: bool,
    pub error: Option<String>,
}
pub struct Network {
    root: PathBuf,
    identity: Identity,
    transport: SecretKey,
    store: SharedStore,
    config: NetworkConfig,
    pub peer: Option<Arc<PeerNode>>,
    worker: Option<JoinHandle<()>>,
    discovery_worker: Option<JoinHandle<()>>,
    discovery_health: Arc<Mutex<DiscoveryHealth>>,
    error: Option<String>,
}
impl Network {
    pub async fn open(
        root: &Path,
        identity: Identity,
        transport: SecretKey,
        store: SharedStore,
    ) -> Result<Self> {
        let config = with_store(&store, |s| s.network_config())?;
        let mut network = Self {
            root: root.into(),
            identity,
            transport,
            store,
            config: NetworkConfig::default(),
            peer: None,
            worker: None,
            discovery_worker: None,
            discovery_health: Arc::new(Mutex::new(DiscoveryHealth::default())),
            error: None,
        };
        // Local records remain usable if the network cannot bind after restart.
        if network.configure(config).await.is_err() {
            network.error = Some("connection_unavailable".into());
        }
        Ok(network)
    }
    pub fn view(&self) -> NetworkView {
        NetworkView {
            config: self.config.clone(),
            running: self.peer.is_some(),
            error: self.error.clone(),
        }
    }
    pub fn discovery_health(&self) -> DiscoveryHealth {
        self.discovery_health
            .lock()
            .expect("discovery health lock")
            .clone()
    }
    pub fn active(&self) -> Result<&Arc<PeerNode>> {
        self.peer
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("networking disabled"))
    }
    pub fn config(&self) -> &NetworkConfig {
        &self.config
    }
    pub async fn configure(&mut self, config: NetworkConfig) -> Result<()> {
        let relays = config.relay_mode()?;
        let discovery = with_store(&self.store, |s| s.discovery_config())?;
        with_store(&self.store, |s| {
            s.save_network_config(&NetworkConfig::default())
        })?;
        self.stop().await?;
        self.config = NetworkConfig::default();
        self.error = None;
        if config.mode != NetworkMode::Offline {
            let endpoint = Endpoint::builder(presets::Minimal)
                .secret_key(self.transport.clone())
                .relay_mode(relays)
                .bind()
                .await?;
            let peer = Arc::new(
                PeerNode::with_shared_store(
                    &self.root,
                    self.identity.clone(),
                    endpoint,
                    self.store.clone(),
                )
                .await?,
            );
            let setup = (|| -> Result<Option<MdnsAddressLookup>> {
                if discovery.enabled && discovery.lan && config.allow_lan {
                    let m = MdnsAddressLookup::builder()
                        .service_name("harakiri-v1")
                        .addr_filter(iroh::address_lookup::AddrFilter::ip_only())
                        .build(peer.endpoint.id())?;
                    peer.endpoint.address_lookup()?.add(m.clone());
                    Ok(Some(m))
                } else {
                    Ok(None)
                }
            })();
            let mdns = match setup {
                Ok(m) => m,
                Err(e) => {
                    peer.shutdown().await?;
                    return Err(e);
                }
            };
            if discovery.enabled {
                let contact = Contact::current(&peer.endpoint.addr());
                if contact.address(&config).is_ok()
                    && let Err(error) = with_store(&self.store, |s| {
                        s.renew_publications(&self.identity, contact, true)
                    })
                {
                    peer.shutdown().await?;
                    return Err(error);
                }
            }
            self.worker = Some(tokio::spawn(reconcile(peer.clone(), config.clone())));
            if discovery.enabled {
                *self.discovery_health.lock().expect("discovery health lock") = DiscoveryHealth {
                    running: true,
                    lan: mdns.is_some(),
                    peers: vec![],
                };
                self.discovery_worker = Some(tokio::spawn(discover(
                    peer.clone(),
                    config.clone(),
                    discovery,
                    mdns,
                    self.discovery_health.clone(),
                )));
            }
            self.peer = Some(peer);
        }
        if let Err(error) = with_store(&self.store, |s| s.save_network_config(&config)) {
            self.stop().await?;
            return Err(error);
        }
        self.config = config;
        Ok(())
    }
    pub async fn issue(&self, mission: &str) -> Result<String> {
        let peer = self.active()?;
        if matches!(
            self.config.mode,
            NetworkMode::PublicRelays | NetworkMode::Custom
        ) {
            tokio::time::timeout(Duration::from_secs(4), peer.endpoint.online()).await?;
        }
        let contact = Contact::current(&peer.endpoint.addr());
        ensure!(
            contact.address(&self.config).is_ok(),
            "no allowed route available"
        );
        with_store(&self.store, |s| {
            s.issue_invitation(&self.identity, mission, contact)
        })
    }
    pub async fn stop(&mut self) -> Result<()> {
        if let Some(worker) = self.discovery_worker.take() {
            worker.abort();
            let _ = worker.await;
        }
        *self.discovery_health.lock().expect("discovery health lock") = DiscoveryHealth::default();
        if let Some(worker) = self.worker.take() {
            worker.abort();
            let _ = worker.await;
        }
        if let Some(peer) = self.peer.take() {
            peer.shutdown().await?;
        }
        Ok(())
    }
    pub async fn configure_discovery(&mut self, config: DiscoveryConfig) -> Result<()> {
        config.validate()?;
        ensure!(
            !config.blocked.contains(&self.identity.public_key()),
            "cannot block your own publisher"
        );
        ensure!(
            !config.lan || self.config.allow_lan,
            "allow LAN routes before enabling LAN discovery"
        );
        with_store(&self.store, |s| s.save_discovery_config(&config))?;
        self.configure(self.config.clone()).await
    }
    pub fn peer_ticket(&self) -> Result<String> {
        Ok(format!("{PEER_PREFIX}{}", self.active()?.contact()?))
    }
    pub async fn publish(
        &self,
        mission: &str,
        summary: String,
        capabilities: Vec<String>,
        active: bool,
    ) -> Result<String> {
        let contact = if active {
            let peer = self.active()?;
            if matches!(
                self.config.mode,
                NetworkMode::PublicRelays | NetworkMode::Custom
            ) {
                tokio::time::timeout(Duration::from_secs(4), peer.endpoint.online()).await?;
            }
            let c = Contact::current(&peer.endpoint.addr());
            c.address(&self.config)?;
            c
        } else {
            Contact {
                endpoint: self.transport.public().to_string(),
                addresses: vec![],
                relays: vec![],
                expires_ms: crate::contact::now() + crate::discovery::TTL,
            }
        };
        with_store(&self.store, |s| {
            s.publish_listing(
                &self.identity,
                mission,
                summary,
                capabilities,
                active,
                contact,
            )
        })
    }
}

async fn discover(
    peer: Arc<PeerNode>,
    network: NetworkConfig,
    config: DiscoveryConfig,
    mdns: Option<MdnsAddressLookup>,
    health: Arc<Mutex<DiscoveryHealth>>,
) {
    let mut nearby = std::collections::BTreeMap::<String, Contact>::new();
    let mut cursors = std::collections::BTreeMap::<String, Option<String>>::new();
    let mut nearby_names = std::collections::BTreeMap::<String, String>::new();
    let mut next_nearby = 0u64;
    let mut events = match &mdns {
        Some(m) => Some(m.subscribe().await),
        None => None,
    };
    let mut interval = tokio::time::interval(Duration::from_secs(5));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut round = 0usize;
    loop {
        tokio::select! {
            event=async {match &mut events {Some(e)=>e.next().await,None=>std::future::pending().await}} => {
                match event {
                    Some(DiscoveryEvent::Discovered{endpoint_info,..}) => {
                        let c=Contact::current(&endpoint_info.into_endpoint_addr());
                        if c.endpoint!=peer.endpoint.id().to_string() && (nearby.len()<32 || nearby.contains_key(&c.endpoint)) {nearby_names.entry(c.endpoint.clone()).or_insert_with(|| { next_nearby=next_nearby.wrapping_add(1); format!("Nearby peer {next_nearby}") }); nearby.insert(c.endpoint.clone(),c);}
                    }
                    Some(DiscoveryEvent::Expired{endpoint_id})=>{nearby.remove(&endpoint_id.to_string());cursors.remove(&endpoint_id.to_string());nearby_names.remove(&endpoint_id.to_string());}
                    None=>{events=None;}
                    _=>{}
                }
            }
            _=interval.tick()=> {
                nearby.retain(|_,c|c.expires_ms>crate::contact::now());
                nearby_names.retain(|key,_|nearby.contains_key(key));
                let own_contact=Contact::current(&peer.endpoint.addr());
                if own_contact.address(&network).is_ok() {
                    let _=with_store(&peer.store,|s|s.renew_publications(&peer.identity,own_contact,false));
                }
                let mut contacts=config.bootstrap.iter().enumerate().filter_map(|(i,raw)|crate::discovery::parse_peer(raw).ok().map(|(_,c)|(format!("Community peer {}",i+1),c))).collect::<Vec<_>>();
                contacts.extend(nearby.values().filter_map(|c|nearby_names.get(&c.endpoint).map(|name|(name.clone(),c.clone()))));
                contacts.retain(|(_,c)|c.endpoint!=peer.endpoint.id().to_string());
                contacts.sort_by(|a,b|a.1.endpoint.cmp(&b.1.endpoint)); contacts.dedup_by(|a,b|a.1.endpoint==b.1.endpoint);
                health.lock().expect("discovery health lock").retain(&contacts.iter().map(|(name,_)|name.clone()).collect::<Vec<_>>());
                let listings=with_store(&peer.store,|s|s.listing_views()).unwrap_or_default().into_iter().filter(|v|v.status=="available"||v.status=="unlisted").map(|v|v.reference).collect::<Vec<_>>();
                let items=(0..listings.len().min(crate::discovery::PAGE)).map(|i|listings[(round*crate::discovery::PAGE+i)%listings.len()].clone()).collect::<Vec<_>>();
                // At most two bounded community requests per pass. Cursors
                // wrap at the end; missed notifications cannot lose a listing.
                for offset in 0..contacts.len().min(2) {
                    let (name,c)=&contacts[(round*2+offset)%contacts.len()];
                    let report=|outcome,received| health.lock().expect("discovery health lock").record(name,outcome,received,crate::contact::now());
                    let Ok(addr)=c.address(&network) else {
                        report(if c.expires_ms<=crate::contact::now() {DiscoveryOutcome::ExpiredAddress} else {DiscoveryOutcome::RouteBlocked},0);
                        continue;
                    };
                    let request=crate::peer::Request::Catalog{items:items.clone(),after:cursors.get(&c.endpoint).cloned().flatten()};
                    report(DiscoveryOutcome::Contacting,0);
                    if let Ok(crate::peer::Response::Catalog{page})=peer.request(addr,&request).await {
                        if page.items.len()>crate::discovery::PAGE || !crate::discovery::valid_cursor(page.after.as_deref()) {report(DiscoveryOutcome::InvalidCatalog,0);continue;}
                        let valid=page.items.iter().all(|r|Advertisement::parse(r).is_ok());
                        if !valid {report(DiscoveryOutcome::InvalidCatalog,0);continue;}
                        let received=page.items.len();
                        // A blocked publisher may be intentionally omitted by the cache.
                        let saved=with_store(&peer.store,|s| {for reference in page.items {let _=s.cache_listing(&reference);} Ok(())});
                        if saved.is_err() {report(DiscoveryOutcome::CacheError,0);continue;}
                        cursors.insert(c.endpoint.clone(),page.after);
                        report(DiscoveryOutcome::Ok,received);
                    } else {report(DiscoveryOutcome::Unreachable,0);}
                }
                round=round.wrapping_add(1);
            }
        }
    }
}

async fn reconcile(peer: Arc<PeerNode>, config: NetworkConfig) {
    let mut round = 0usize;
    loop {
        // No key, invitation, message or transport address enters diagnostics.
        let _ = cycle(&peer, &config, round).await;
        round = round.wrapping_add(1);
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
async fn cycle(peer: &Arc<PeerNode>, config: &NetworkConfig, round: usize) -> Result<()> {
    let withdrawals = with_store(&peer.store, |s| s.pending_withdrawals())?;
    if !withdrawals.is_empty() {
        let (mission, notice, targets) = &withdrawals[round % withdrawals.len()];
        if !targets.is_empty() {
            let c = &targets[round % targets.len()];
            if let Ok(addr) = c.address(config)
                && matches!(
                    peer.request(
                        addr,
                        &crate::peer::Request::Withdraw {
                            notice: notice.clone()
                        }
                    )
                    .await,
                    Ok(crate::peer::Response::WithdrawalAccepted)
                )
            {
                let _ = with_store(&peer.store, |s| {
                    s.acknowledge_withdrawal(mission, &c.endpoint)
                });
            }
        }
    }
    let tickets = with_store(&peer.store, |s| s.pending_tickets())?;
    if !tickets.is_empty() {
        let ticket = &tickets[round % tickets.len()];
        // Joining never launches anything. Retry after interruption; a signed
        // admission is immutable and repeated pulls cannot create another member.
        let _ = tokio::time::timeout(Duration::from_secs(12), peer.poll_join(ticket, config)).await;
    }
    let missions = with_store(&peer.store, |s| s.missions())?;
    let own = peer.contact()?;
    let mut jobs = vec![];
    for mission in missions {
        if !with_store(&peer.store, |s| {
            s.can_read(&mission.id, &peer.endpoint.id().to_string())
        })? {
            continue;
        }
        with_store(&peer.store, |s| s.save_contact(&mission.id, &own))?;
        for signed in with_store(&peer.store, |s| s.contacts(&mission.id))? {
            let (_, contact) = Contact::verify(&signed)?;
            if contact.endpoint != peer.endpoint.id().to_string() {
                jobs.push((mission.id.clone(), contact));
            }
        }
    }
    // Round-robin prevents an unreachable peer or a busy mission starving the
    // others. Four simultaneous jobs maximum; each pass has a time ceiling.
    let mut tasks = tokio::task::JoinSet::new();
    for offset in 0..jobs.len().min(4) {
        let (mission, contact) = jobs[(round * 4 + offset) % jobs.len()].clone();
        let peer = peer.clone();
        let config = config.clone();
        tasks.spawn(async move {
            let result = tokio::time::timeout(Duration::from_secs(12), async {
                let addr = contact.address(&config)?;
                peer.sync_scope(addr.clone(), &mission, "main").await?;
                let scopes = peer.exchange(addr.clone(), &mission).await?;
                // Both sides advertise their readable roots; four private
                // streams per pass, with no identifiers in Main acknowledgments.
                for offset in 0..scopes.len().min(4) {
                    peer.sync_scope(
                        addr.clone(),
                        &mission,
                        &scopes[(round * 4 + offset) % scopes.len()],
                    )
                    .await?;
                }
                Ok::<_, anyhow::Error>(())
            })
            .await;
            if !matches!(result, Ok(Ok(()))) {
                let _ = with_store(&peer.store, |s| {
                    s.delivery_failed(&mission, "main", &contact.endpoint)
                });
            }
        });
    }
    while tasks.join_next().await.is_some() {}
    Ok(())
}
