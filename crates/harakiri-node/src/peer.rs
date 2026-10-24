//! Scoped replication over authenticated Iroh connections. The default builder
//! deliberately enables neither vendor address lookup nor public relays.
use crate::{
    admission::{Access, Offer},
    contact::{Contact, now},
    store::{Head, Store},
};
use anyhow::{Result, anyhow, bail, ensure};
use harakiri_protocol::{ArtifactFile, Event, Identity, Payload, limits};
use iroh::{
    Endpoint, EndpointAddr,
    endpoint::{Connection, presets},
    protocol::{AcceptError, ProtocolHandler, Router},
};
use iroh_blobs::{
    BlobsProtocol, Hash,
    provider::events::{
        AbortReason, ConnectMode, EventMask, EventSender, ObserveMode, ProviderMessage,
        RequestMode, ThrottleMode,
    },
    store::fs::FsStore,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::Semaphore, task::JoinHandle, time::timeout};

pub const ALPN: &[u8] = b"harakiri/sync/14";
pub type SharedStore = Arc<Mutex<Store>>;

#[derive(Debug)]
struct BoundedBlobs(BlobsProtocol);

impl ProtocolHandler for BoundedBlobs {
    async fn accept(&self, connection: Connection) -> std::result::Result<(), AcceptError> {
        let serving = self.0.accept(connection.clone());
        tokio::pin!(serving);
        tokio::select! {
            result = &mut serving => result,
            _ = tokio::time::sleep(Duration::from_secs(30)) => {
                // Close first, then allow the provider to emit ConnectionClosed.
                // Simply dropping its future would leak authorization slots.
                connection.close(1u32.into(), b"transfer window expired");
                serving.await
            }
        }
    }

    async fn shutdown(&self) {
        self.0.shutdown().await;
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Observe {
        mission: String,
        reports: Vec<String>,
    },
    Catalog {
        items: Vec<String>,
        after: Option<String>,
    },
    Withdraw {
        notice: String,
    },
    Inspect {
        ticket: String,
        nonce: String,
    },
    Join {
        ticket: String,
        offer: String,
    },
    Exchange {
        mission: String,
        contact: String,
    },
    Pull {
        mission: String,
        audience: String,
        heads: Vec<Head>,
    },
    PullPage {
        mission: String,
        audience: String,
        after: Option<String>,
        heads: Vec<Head>,
        sent: Option<String>,
    },
    Push {
        mission: String,
        audience: String,
        events: Vec<String>,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Response {
    Observations {
        reports: Vec<String>,
    },
    Catalog {
        page: crate::discovery::FeedPage,
    },
    WithdrawalAccepted,
    Inspection {
        inspection: crate::review::Inspection,
    },
    JoinStatus {
        status: String,
    },
    Peers {
        contacts: Vec<String>,
        audiences: Vec<String>,
        #[serde(default)]
        withdrawals: Vec<String>,
    },
    Records {
        events: Vec<String>,
    },
    RecordPage {
        events: Vec<String>,
        after: Option<String>,
        more: bool,
        reset: bool,
        has_sent: bool,
    },
    Accepted {
        inserted: usize,
        heads: Vec<Head>,
    },
    Revoked {
        event: String,
    },
    Rejected,
}

pub fn with_store<T>(store: &SharedStore, f: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
    let mut guard = store
        .lock()
        .map_err(|_| anyhow!("node store unavailable"))?;
    f(&mut guard)
}

#[derive(Clone)]
struct SyncProtocol {
    identity: Identity,
    store: SharedStore,
    local: String,
    slots: Arc<Semaphore>,
    catalog_rate: Arc<Mutex<(std::time::Instant, u32)>>,
    budget: Arc<Mutex<crate::abuse::Budget>>,
    connections: crate::abuse::Connections,
}

impl std::fmt::Debug for SyncProtocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SyncProtocol")
    }
}

impl SyncProtocol {
    fn handle(&self, remote: &str, request: Request) -> Result<Response> {
        if matches!(request, Request::Catalog { .. }) {
            let mut rate = self
                .catalog_rate
                .lock()
                .map_err(|_| anyhow!("discovery unavailable"))?;
            if rate.0.elapsed() >= Duration::from_secs(60) {
                *rate = (std::time::Instant::now(), 0);
            }
            ensure!(rate.1 < 60, "discovery rate limit");
            rate.1 += 1;
        }
        with_store(&self.store, |store| {
            let mission = match &request {
                Request::Observe { mission, .. }
                | Request::Pull { mission, .. }
                | Request::PullPage { mission, .. }
                | Request::Push { mission, .. }
                | Request::Exchange { mission, .. } => Some(mission),
                _ => None,
            };
            if let Some(mission) = mission
                && store.can_read(mission, &self.local)?
                && let Some(bytes) = store.revocation_for(mission, remote)?
            {
                return Ok(Response::Revoked {
                    event: hex::encode(bytes),
                });
            }
            match request {
                Request::Observe { mission, reports } => {
                    ensure!(
                        store.can_read(&mission, remote)?
                            && store.can_read(&mission, &self.local)?
                            && reports.len() <= 512,
                        "observation access denied"
                    );
                    for raw in reports {
                        // A report may arrive before its grant or registration.
                        // Ignore it and let the next exchange repair visibility.
                        let _ = store.receive_observation(&mission, &raw);
                    }
                    Ok(Response::Observations {
                        reports: store.observation_claims(&mission),
                    })
                }
                Request::Catalog { items, after } => {
                    ensure!(
                        store.discovery_config()?.enabled && items.len() <= crate::discovery::PAGE,
                        "discovery unavailable"
                    );
                    for item in items {
                        let _ = store.cache_listing(&item);
                    }
                    Ok(Response::Catalog {
                        page: store.discovery_page(after.as_deref())?,
                    })
                }
                Request::Withdraw { notice } => {
                    let (_, n) = crate::withdrawal::Withdrawal::verify(&notice)?;
                    ensure!(n.endpoint == remote, "withdrawal endpoint mismatch");
                    store.receive_withdrawal(&notice)?;
                    Ok(Response::WithdrawalAccepted)
                }
                Request::Inspect { ticket, nonce } => Ok(Response::Inspection {
                    inspection: store.inspect_current(&self.identity, &ticket, &nonce)?,
                }),
                Request::Join { ticket, offer } => Ok(Response::JoinStatus {
                    status: store.receive_offer(&ticket, &offer, remote)?,
                }),
                Request::Exchange { mission, contact } => {
                    ensure!(
                        store.can_read(&mission, remote)?
                            && store.can_read(&mission, &self.local)?,
                        "not authorized"
                    );
                    let (_, c) = Contact::verify(&contact)?;
                    ensure!(c.endpoint == remote, "contact endpoint mismatch");
                    store.save_contact(&mission, &contact)?;
                    let audiences = store
                        .audiences_for(&mission, remote)?
                        .into_iter()
                        .filter_map(|a| {
                            store
                                .can_read_scope(&mission, &a.id, &self.local)
                                .ok()
                                .filter(|b| *b)?;
                            store
                                .audience_root(&mission, &a.id)
                                .ok()
                                .flatten()
                                .map(|e| hex::encode(e.bytes()))
                        })
                        .collect();
                    Ok(Response::Peers {
                        contacts: store.contacts(&mission)?,
                        audiences,
                        withdrawals: store.withdrawal_notices(&mission)?,
                    })
                }
                Request::Pull {
                    mission,
                    audience,
                    heads,
                } => {
                    ensure!(
                        store.can_read_scope(&mission, &audience, remote)?
                            && store.can_read_scope(&mission, &audience, &self.local)?,
                        "not authorized"
                    );
                    let events = store
                        .delta_in(&mission, &audience, &heads)?
                        .iter()
                        .map(hex::encode)
                        .collect();
                    store.acknowledge(&mission, &audience, remote, &heads, now())?;
                    Ok(Response::Records { events })
                }
                Request::PullPage {
                    mission,
                    audience,
                    after,
                    heads,
                    sent,
                } => {
                    ensure!(
                        store.can_read_scope(&mission, &audience, remote)?
                            && store.can_read_scope(&mission, &audience, &self.local)?,
                        "not authorized"
                    );
                    // Validate supplied heads before recording the peer's claim.
                    store.verified_heads(&mission, &audience, &heads)?;
                    ensure!(
                        sent.as_deref()
                            .is_none_or(harakiri_protocol::event::is_hash),
                        "invalid sent cursor"
                    );
                    let has_sent = match sent {
                        None => true,
                        Some(id) => store.event(&id)?.is_some_and(|e| {
                            e.mission_id() == mission && e.body.audience == audience
                        }),
                    };
                    let page = store.history_page(&mission, &audience, after.as_deref())?;
                    store.acknowledge(&mission, &audience, remote, &heads, now())?;
                    Ok(Response::RecordPage {
                        events: page.events.iter().map(hex::encode).collect(),
                        after: page.after,
                        more: page.more,
                        reset: page.reset,
                        has_sent,
                    })
                }
                Request::Push {
                    mission,
                    audience,
                    events,
                } => {
                    ensure!(
                        store.can_read_scope(&mission, &audience, remote)?
                            && store.can_read_scope(&mission, &audience, &self.local)?,
                        "not authorized"
                    );
                    let bytes = decode_events(&events, &mission, &audience)?;
                    let result = store.import(&bytes)?;
                    Ok(Response::Accepted {
                        inserted: result.inserted,
                        heads: store.heads_in(&mission, &audience)?,
                    })
                }
            }
        })
    }
}

impl ProtocolHandler for SyncProtocol {
    async fn accept(&self, connection: Connection) -> std::result::Result<(), AcceptError> {
        let Ok(_permit) = self.slots.clone().try_acquire_owned() else {
            connection.close(1u32.into(), b"unavailable");
            return Ok(());
        };
        let remote = connection.remote_id().to_string();
        let Some(_peer_permit) = self.connections.acquire(&remote) else {
            connection.close(1u32.into(), b"peer connection limit");
            return Ok(());
        };
        let result = timeout(Duration::from_secs(limits::REQUEST_TIMEOUT_SECS), async {
            let (mut send, mut recv) = connection.accept_bi().await?;
            let bytes = recv.read_to_end(limits::MAX_FRAME_BYTES).await?;
            ensure!(
                self.budget
                    .lock()
                    .map_err(|_| anyhow!("request budget unavailable"))?
                    .allow(&remote, bytes.len(), false),
                "peer request budget exceeded"
            );
            let response = serde_json::from_slice(&bytes)
                .ok()
                .and_then(|request| {
                    if matches!(request, Request::Catalog { .. })
                        && !self.budget.lock().ok()?.allow(&remote, 0, true)
                    {
                        return None;
                    }
                    self.handle(&connection.remote_id().to_string(), request)
                        .ok()
                })
                .unwrap_or(Response::Rejected);
            let bytes = serde_json::to_vec(&response)?;
            ensure!(bytes.len() <= limits::MAX_FRAME_BYTES, "response limit");
            send.write_all(&bytes).await?;
            send.finish()?;
            // Do not close until the peer consumes the response.
            let _ = send.stopped().await;
            Ok::<_, anyhow::Error>(())
        })
        .await;
        if !matches!(result, Ok(Ok(()))) {
            connection.close(1u32.into(), b"unavailable");
        }
        Ok(())
    }
}

fn decode_events(events: &[String], mission: &str, audience: &str) -> Result<Vec<Vec<u8>>> {
    ensure!(events.len() <= limits::MAX_BATCH_EVENTS, "batch too large");
    events
        .iter()
        .map(|hex| {
            ensure!(hex.len() <= limits::MAX_EVENT_BYTES * 2, "record too large");
            let bytes = hex::decode(hex)?;
            let event = Event::verify(&bytes)?;
            ensure!(
                event.mission_id() == mission && event.body.audience == audience,
                "cross-scope record"
            );
            Ok(bytes)
        })
        .collect()
}

/// Test/host code supplies the endpoint and key custody explicitly. No global
/// discovery, default user profile, credentials or agent process is opened here.
pub struct FileInput<'a> {
    pub title: &'a str,
    pub path: &'a str,
    pub media_type: &'a str,
    pub bytes: &'a [u8],
}

pub struct PeerNode {
    pub endpoint: Endpoint,
    pub store: SharedStore,
    pub identity: Identity,
    pub(crate) blobs: FsStore,
    router: Router,
    blob_policy: JoinHandle<()>,
    pub(crate) route_cache: Mutex<HashMap<String, (std::time::Instant, Option<EndpointAddr>)>>,
}

impl PeerNode {
    pub async fn open(root: &Path, identity: Identity, endpoint: Endpoint) -> Result<Self> {
        std::fs::create_dir_all(root)?;
        let store = Arc::new(Mutex::new(Store::open(&root.join("node.sqlite"))?));
        Self::with_shared_store(root, identity, endpoint, store).await
    }

    pub async fn with_shared_store(
        root: &Path,
        identity: Identity,
        endpoint: Endpoint,
        store: SharedStore,
    ) -> Result<Self> {
        let blobs = FsStore::load(root.join("blobs")).await?;
        let (events, blob_policy) = blob_policy(store.clone());
        let router = Router::builder(endpoint.clone())
            .accept(
                crate::compatibility::ALPN,
                crate::compatibility::Compatibility::default(),
            )
            .accept(
                ALPN,
                SyncProtocol {
                    identity: identity.clone(),
                    store: store.clone(),
                    local: endpoint.id().to_string(),
                    slots: Arc::new(Semaphore::new(limits::MAX_CONNECTIONS)),
                    catalog_rate: Arc::new(Mutex::new((std::time::Instant::now(), 0))),
                    budget: Arc::new(Mutex::new(crate::abuse::Budget::default())),
                    connections: crate::abuse::Connections::default(),
                },
            )
            .accept(
                iroh_blobs::ALPN,
                BoundedBlobs(BlobsProtocol::new(&blobs, Some(events))),
            )
            .spawn();
        Ok(Self {
            endpoint,
            store,
            identity,
            blobs,
            router,
            blob_policy,
            route_cache: Mutex::new(HashMap::new()),
        })
    }

    pub async fn local_endpoint(seed: [u8; 32]) -> Result<Endpoint> {
        Ok(Endpoint::builder(presets::Minimal)
            .secret_key(iroh::SecretKey::from_bytes(&seed))
            .relay_mode(iroh::RelayMode::Disabled)
            .bind()
            .await?)
    }

    pub fn append(&self, mission: &str, payload: Payload) -> Result<Event> {
        with_store(&self.store, |s| s.append(&self.identity, mission, payload))
    }

    pub async fn request(&self, peer: EndpointAddr, request: &Request) -> Result<Response> {
        timeout(Duration::from_secs(limits::REQUEST_TIMEOUT_SECS), async {
            let connection = match self.endpoint.connect(peer.clone(), ALPN).await {
                Ok(connection) => connection,
                Err(original) => {
                    // Only use the stable handshake to diagnose a failed sync
                    // protocol. Never downgrade record validation or authority.
                    if let Ok(Ok(reply)) =
                        timeout(Duration::from_secs(3), self.compatibility(peer)).await
                        && !reply.compatible
                    {
                        bail!("peer protocol incompatible");
                    }
                    return Err(original.into());
                }
            };
            let (mut send, mut recv) = connection.open_bi().await?;
            let bytes = serde_json::to_vec(request)?;
            ensure!(bytes.len() <= limits::MAX_FRAME_BYTES, "request limit");
            send.write_all(&bytes).await?;
            send.finish()?;
            let bytes = recv.read_to_end(limits::MAX_FRAME_BYTES).await?;
            let response: Response = serde_json::from_slice(&bytes)?;
            connection.close(0u32.into(), b"done");
            if let Response::Revoked { event } = &response {
                ensure!(
                    event.len() <= limits::MAX_EVENT_BYTES * 2,
                    "revocation size"
                );
                let mission = match request {
                    Request::Observe { mission, .. }
                    | Request::Pull { mission, .. }
                    | Request::PullPage { mission, .. }
                    | Request::Push { mission, .. }
                    | Request::Exchange { mission, .. } => mission,
                    _ => bail!("unexpected revocation"),
                };
                with_store(&self.store, |s| {
                    s.notice_revocation(&hex::decode(event)?, mission, &self.identity.public_key())
                })?;
            }
            Ok(response)
        })
        .await?
    }

    pub async fn compatibility(&self, peer: EndpointAddr) -> Result<crate::compatibility::Reply> {
        let connection = self
            .endpoint
            .connect(peer, crate::compatibility::ALPN)
            .await?;
        let result = async {
            let (mut send, mut recv) = connection.open_bi().await?;
            send.write_all(&serde_json::to_vec(&crate::compatibility::Hello {
                protocol: limits::VERSION,
            })?)
            .await?;
            send.finish()?;
            let bytes = recv.read_to_end(256).await?;
            Ok::<_, anyhow::Error>(serde_json::from_slice(&bytes)?)
        }
        .await;
        connection.close(0u32.into(), b"handshake complete");
        result
    }
    pub async fn pull(&self, peer: EndpointAddr, mission: &str) -> Result<usize> {
        self.pull_scope(peer, mission, "main").await
    }
    pub async fn pull_scope(
        &self,
        peer: EndpointAddr,
        mission: &str,
        audience: &str,
    ) -> Result<usize> {
        if audience != "main" {
            with_store(&self.store, |s| {
                ensure!(
                    s.can_read_scope(mission, audience, &self.endpoint.id().to_string())?,
                    "not a reader"
                );
                Ok(())
            })?;
        }
        let mut inserted = 0;
        for _ in 0..=limits::MAX_HISTORY_EVENTS / limits::MAX_BATCH_EVENTS {
            let (count, more, _) = self.pull_page(peer.clone(), mission, audience).await?;
            inserted += count;
            if !more {
                return Ok(inserted);
            }
        }
        bail!("synchronization work limit reached")
    }

    async fn pull_page(
        &self,
        peer: EndpointAddr,
        mission: &str,
        audience: &str,
    ) -> Result<(usize, bool, bool)> {
        let endpoint = peer.id.to_string();
        let ((cursor, sent), heads) = with_store(&self.store, |s| {
            Ok((
                s.sync_cursors(mission, audience, &endpoint)?,
                s.heads_in(mission, audience)?,
            ))
        })?;
        let Response::RecordPage {
            events,
            after,
            more,
            reset,
            has_sent,
        } = self
            .request(
                peer,
                &Request::PullPage {
                    mission: mission.into(),
                    audience: audience.into(),
                    after: cursor.clone(),
                    heads,
                    sent,
                },
            )
            .await?
        else {
            bail!("peer refused synchronization");
        };
        ensure!(!more || !events.is_empty(), "non-progressing peer history");
        let bytes = decode_events(&events, mission, audience)?;
        let expected = bytes
            .last()
            .map(|b| Event::verify(b).map(|e| e.id))
            .transpose()?;
        ensure!(
            if events.is_empty() {
                after == if reset { None } else { cursor.clone() }
            } else {
                after == expected
            },
            "invalid history page cursor"
        );
        ensure!(!more || after != cursor, "non-progressing peer history");
        let count = with_store(&self.store, |s| {
            ensure!(!s.locally_withdrawn(mission)?, "participation withdrawn");
            let result = s.import(&bytes)?;
            // A crash before the cursor commit repeats a verified page. A
            // failed/partial import never skips its remaining causal records.
            s.save_sync_cursor(mission, audience, &endpoint, true, after.as_deref())?;
            if !has_sent {
                // The peer lost a previously acknowledged prefix (for example
                // an older backup). Replay outbound history from its root too.
                s.save_sync_cursor(mission, audience, &endpoint, false, None)?;
            }
            Ok(result.inserted)
        })?;
        Ok((count, more, count > 0 || after != cursor))
    }

    pub fn contact(&self) -> Result<String> {
        Contact::current(&self.endpoint.addr()).sign(&self.identity)
    }
    pub async fn inspect(
        &self,
        ticket: &str,
        config: &crate::contact::NetworkConfig,
    ) -> Result<crate::review::Inspection> {
        let i = Access::parse(ticket)?;
        let nonce = hex::encode(rand::random::<[u8; 32]>());
        let Response::Inspection { inspection } = self
            .request(
                self.resolve_contact(&i.contact, config).await?,
                &Request::Inspect {
                    ticket: ticket.into(),
                    nonce: nonce.clone(),
                },
            )
            .await?
        else {
            bail!("invitation unavailable")
        };
        inspection.review(ticket, Some(&nonce))?;
        Ok(inspection)
    }
    pub async fn poll_join(
        &self,
        ticket: &str,
        config: &crate::contact::NetworkConfig,
    ) -> Result<String> {
        let i = Access::parse(ticket)?;
        ensure!(
            !with_store(&self.store, |s| s.locally_withdrawn(&i.mission))?,
            "participation withdrawn"
        );
        let contact = Contact::current(&self.endpoint.addr());
        let revision = with_store(&self.store, |s| {
            s.reviewed_join_revision(&i.mission, ticket)
        })?;
        let offer = Offer::sign(&self.identity, ticket, contact, revision)?;
        let addr = self.resolve_contact(&i.contact, config).await?;
        let Response::JoinStatus { status } = self
            .request(
                addr.clone(),
                &Request::Join {
                    ticket: ticket.into(),
                    offer,
                },
            )
            .await?
        else {
            bail!("join unavailable")
        };
        ensure!(
            [
                "pending",
                "admitted",
                "denied",
                "revoked",
                "withdrawn",
                "review_required"
            ]
            .contains(&status.as_str()),
            "invalid join status"
        );
        if status == "admitted" {
            ensure!(
                !with_store(&self.store, |s| s.locally_withdrawn(&i.mission))?,
                "participation withdrawn"
            );
            // Permission to import Main came from the reviewed invitation and
            // this explicit local request. Every imported record still verifies.
            self.pull(addr.clone(), &i.mission).await?;
            self.exchange(addr, &i.mission).await?;
            with_store(&self.store, |s| {
                ensure!(
                    s.can_read(&i.mission, &self.endpoint.id().to_string())?,
                    "missing admission"
                );
                Ok(())
            })?;
        }
        with_store(&self.store, |s| s.join_status(&i.mission, &status))?;
        Ok(status)
    }
    pub async fn sync_scope(
        &self,
        peer: EndpointAddr,
        mission: &str,
        audience: &str,
    ) -> Result<()> {
        let endpoint = peer.id.to_string();
        let (_, _, pulled) = self.pull_page(peer.clone(), mission, audience).await?;
        let (cursor, page) = with_store(&self.store, |s| {
            let cursor = s.sync_cursors(mission, audience, &endpoint)?.1;
            Ok((
                cursor.clone(),
                s.history_page(mission, audience, cursor.as_deref())?,
            ))
        })?;
        let response = self
            .request(
                peer.clone(),
                &Request::Push {
                    mission: mission.into(),
                    audience: audience.into(),
                    events: page.events.iter().map(hex::encode).collect(),
                },
            )
            .await?;
        let Response::Accepted { heads, inserted } = response else {
            bail!("sync refused")
        };
        ensure!(inserted <= page.events.len(), "invalid import count");
        with_store(&self.store, |s| {
            s.save_sync_cursor(mission, audience, &endpoint, false, page.after.as_deref())?;
            s.acknowledge(mission, audience, &endpoint, &heads, now())?;
            s.record_sync_progress(
                mission,
                audience,
                &endpoint,
                pulled || inserted > 0 || page.after != cursor,
                now(),
            )
        })?;
        Ok(())
    }
    pub async fn exchange(&self, peer: EndpointAddr, mission: &str) -> Result<Vec<String>> {
        let reports = with_store(&self.store, |s| Ok(s.observation_claims(mission)))?;
        if let Ok(Response::Observations { reports }) = self
            .request(
                peer.clone(),
                &Request::Observe {
                    mission: mission.into(),
                    reports,
                },
            )
            .await
        {
            ensure!(reports.len() <= 512, "observation limit");
            with_store(&self.store, |s| {
                for raw in reports {
                    let _ = s.receive_observation(mission, &raw);
                }
                Ok(())
            })?;
        }
        let contact = self.contact()?;
        with_store(&self.store, |s| s.save_contact(mission, &contact))?;
        let Response::Peers {
            contacts,
            audiences,
            withdrawals,
        } = self
            .request(
                peer.clone(),
                &Request::Exchange {
                    mission: mission.into(),
                    contact,
                },
            )
            .await?
        else {
            bail!("exchange refused")
        };
        ensure!(
            contacts.len() <= 1024
                && audiences.len() <= limits::MAX_AUDIENCES
                && withdrawals.len() <= 1024,
            "exchange limit"
        );
        with_store(&self.store, |s| {
            for n in withdrawals {
                ensure!(
                    crate::withdrawal::Withdrawal::verify(&n)?.1.mission == mission,
                    "cross-mission notice"
                );
                s.receive_withdrawal(&n)?;
            }
            for c in contacts {
                // An in-flight contact may refer to a just-withdrawn member.
                let _ = s.save_contact(mission, &c);
            }
            let mut scopes = vec![];
            for raw in audiences {
                ensure!(
                    raw.len() <= limits::MAX_EVENT_BYTES * 2,
                    "audience size limit"
                );
                let bytes = hex::decode(raw)?;
                let root = Event::verify(&bytes)?;
                ensure!(root.mission_id() == mission, "cross-mission audience");
                let readers = s.root_readers(&root)?;
                ensure!(
                    s.endpoint_reads(mission, &readers, &self.endpoint.id().to_string())?,
                    "unsolicited private history"
                );
                ensure!(
                    s.endpoint_reads(mission, &readers, &peer.id.to_string())?,
                    "peer is not a reader"
                );
                s.import(&[bytes])?;
                scopes.push(root.body.audience);
            }
            Ok(scopes)
        })
    }

    pub async fn publish_file(
        &self,
        mission: &str,
        title: String,
        path: String,
        media_type: String,
        bytes: &[u8],
    ) -> Result<Event> {
        self.publish_file_to(
            mission,
            "main",
            FileInput {
                title: &title,
                path: &path,
                media_type: &media_type,
                bytes,
            },
        )
        .await
    }
    pub async fn publish_file_to(
        &self,
        mission: &str,
        audience: &str,
        file: FileInput<'_>,
    ) -> Result<Event> {
        ensure!(
            file.bytes.len() as u64 <= limits::MAX_BLOB_BYTES,
            "artifact too large"
        );
        with_store(&self.store, |s| {
            ensure!(
                s.can_read_scope(mission, audience, &self.endpoint.id().to_string())?
                    && !s.conflicted_scope(mission, audience)?,
                "not authorized"
            );
            Ok(())
        })?;
        let tag = self.blobs.add_slice(file.bytes).await?;
        self.blobs
            .tags()
            .set(format!("artifact-{}", tag.hash), tag.hash)
            .await?;
        // Commit blob metadata before acknowledging its signed manifest.
        self.blobs.sync_db().await?;
        with_store(&self.store, |s| {
            let event = s.append_to(
                &self.identity,
                mission,
                audience,
                Payload::ArtifactPublished {
                    title: file.title.into(),
                    files: vec![ArtifactFile {
                        path: file.path.into(),
                        hash: hex::encode(tag.hash.as_bytes()),
                        size: file.bytes.len() as u64,
                        media_type: file.media_type.into(),
                    }],
                },
            )?;
            s.mark_materialized(&event.id, &tag.hash.to_string())?;
            Ok(event)
        })
    }

    pub async fn fetch_file(
        &self,
        peer: EndpointAddr,
        revision: &str,
        file: &ArtifactFile,
    ) -> Result<Vec<u8>> {
        self.fetch_file_as(peer, &self.identity.public_key(), revision, file)
            .await
    }
    pub(crate) async fn fetch_file_as(
        &self,
        peer: EndpointAddr,
        viewer: &str,
        revision: &str,
        file: &ArtifactFile,
    ) -> Result<Vec<u8>> {
        with_store(&self.store, |s| {
            let e = s
                .event(revision)?
                .ok_or_else(|| anyhow!("artifact revision unavailable"))?;
            let actual = s.artifact_file(e.mission_id(), viewer, revision, &file.path)?;
            ensure!(actual == *file, "file does not match revision");
            Ok(())
        })?;
        ensure!(file.size <= limits::MAX_BLOB_BYTES, "artifact too large");
        let hash = Hash::from_bytes(
            hex::decode(&file.hash)?
                .try_into()
                .map_err(|_| anyhow!("invalid hash"))?,
        );
        timeout(Duration::from_secs(30), async {
            let connection = self.endpoint.connect(peer, iroh_blobs::ALPN).await?;
            let (size, _) = iroh_blobs::get::request::get_verified_size(&connection, &hash).await?;
            ensure!(
                size == file.size,
                "artifact size does not match signed manifest"
            );
            self.blobs.remote().fetch(connection.clone(), hash).await?;
            let bytes = self.blobs.get_bytes(hash).await?;
            ensure!(
                bytes.len() as u64 == file.size && Hash::new(&bytes) == hash,
                "artifact integrity failure"
            );
            self.blobs
                .tags()
                .set(format!("artifact-{hash}"), hash)
                .await?;
            self.blobs.sync_db().await?;
            with_store(&self.store, |s| s.mark_materialized(revision, &file.hash))?;
            connection.close(0u32.into(), b"done");
            Ok(bytes.to_vec())
        })
        .await?
    }

    pub async fn shutdown(&self) -> Result<()> {
        // BlobsProtocol::shutdown, invoked by Router, owns store shutdown.
        // Flush first; sending a second shutdown request targets a closed actor.
        let sync_result = self.blobs.sync_db().await;
        let router_result = self.router.shutdown().await;
        self.blob_policy.abort();
        sync_result?;
        router_result?;
        Ok(())
    }
}

fn blob_policy(store: SharedStore) -> (EventSender, JoinHandle<()>) {
    let mask = EventMask {
        connected: ConnectMode::Intercept,
        get: RequestMode::Intercept,
        get_many: RequestMode::Disabled,
        push: RequestMode::Disabled,
        observe: ObserveMode::Intercept,
        throttle: ThrottleMode::Intercept,
    };
    let (sender, mut receiver) = EventSender::channel(64, mask);
    let task = tokio::spawn(async move {
        let mut connections: HashMap<u64, (String, u64)> = HashMap::new();
        let mut budget = crate::abuse::BlobBudget::default();
        while let Some(event) = receiver.recv().await {
            match event {
                ProviderMessage::ClientConnected(message) => {
                    let allowed = if connections.len() < limits::MAX_CONNECTIONS {
                        if let Some(endpoint) = message.endpoint_id
                            && connections
                                .values()
                                .filter(|(peer, _)| peer == &endpoint.to_string())
                                .count()
                                < 4
                            && with_store(&store, |s| s.known_endpoint(&endpoint.to_string()))
                                .unwrap_or(false)
                        {
                            connections.insert(message.connection_id, (endpoint.to_string(), 0));
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    };
                    let _ = message
                        .tx
                        .send(if allowed {
                            Ok(())
                        } else {
                            Err(AbortReason::Permission)
                        })
                        .await;
                }
                ProviderMessage::GetRequestReceived(message) => {
                    let hash = hex::encode(message.request.hash.as_bytes());
                    let allowed = message.request.ranges.is_blob()
                        && connections
                            .get(&message.connection_id)
                            .is_some_and(|(endpoint, _)| {
                                with_store(&store, |s| s.can_read_blob(endpoint, &hash))
                                    .unwrap_or(false)
                            });
                    let _ = message
                        .tx
                        .send(if allowed {
                            Ok(())
                        } else {
                            Err(AbortReason::Permission)
                        })
                        .await;
                }
                ProviderMessage::ObserveRequestReceived(message) => {
                    let _ = message.tx.send(Err(AbortReason::Permission)).await;
                }
                ProviderMessage::Throttle(message) => {
                    let allowed = connections.get_mut(&message.connection_id).is_some_and(
                        |(endpoint, sent)| {
                            *sent = sent.saturating_add(message.size);
                            *sent <= limits::MAX_BLOB_BYTES * 2 + 65536
                                && budget.allow(endpoint, message.size)
                        },
                    );
                    let _ = message
                        .tx
                        .send(if allowed {
                            Ok(())
                        } else {
                            Err(AbortReason::RateLimited)
                        })
                        .await;
                }
                ProviderMessage::ConnectionClosed(message) => {
                    connections.remove(&message.connection_id);
                }
                _ => {}
            }
        }
    });
    (sender, task)
}
