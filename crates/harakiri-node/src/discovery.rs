//! Public, expiring availability claims. These never grant membership and never
//! carry mission history. A listing's signer is not proven to own the mission
//! until live inspection verifies its signed genesis.
use crate::{
    contact::{Contact, now},
    store::Store,
};
use anyhow::{Result, anyhow, ensure};
use harakiri_protocol::{Identity, Payload, claims, event::is_hash, policy::Participation};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

pub const PREFIX: &str = "harakiri://discover/";
pub const PEER_PREFIX: &str = "harakiri://peer/";
pub const DOMAIN: &[u8] = b"harakiri/advertisement/1";
pub const TTL: u64 = 30 * 60 * 1000;
pub const MAX_LISTINGS: usize = 256;
pub const PAGE: usize = 8;

#[derive(Debug, Clone, Default, Serialize, Deserialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct DiscoveryConfig {
    pub enabled: bool,
    pub lan: bool,
    pub bootstrap: Vec<String>,
    pub blocked: Vec<String>,
}
impl DiscoveryConfig {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.bootstrap.len() <= 8 && self.blocked.len() <= 64,
            "discovery config limit"
        );
        ensure!(
            !self.lan || self.enabled,
            "LAN discovery requires discovery consent"
        );
        for peer in &self.bootstrap {
            parse_peer(peer)?;
        }
        ensure!(
            self.blocked.iter().all(|s| is_hash(s)),
            "invalid blocked publisher"
        );
        Ok(())
    }
}
pub fn parse_peer(ticket: &str) -> Result<(String, Contact)> {
    ensure!(ticket.len() <= 4096, "peer ticket limit");
    Contact::verify(
        ticket
            .strip_prefix(PEER_PREFIX)
            .ok_or_else(|| anyhow!("invalid peer ticket"))?,
    )
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct Advertisement {
    pub version: u16,
    pub mission: String,
    pub title: String,
    pub summary: String,
    pub capabilities: Vec<String>,
    pub contact: Contact,
    pub revision: u32,
    pub active: bool,
    pub issued_ms: u64,
    pub expires_ms: u64,
}
impl Advertisement {
    pub fn parse(reference: &str) -> Result<(String, Self)> {
        ensure!(reference.len() <= 16384, "listing limit");
        let raw = reference
            .strip_prefix(PREFIX)
            .ok_or_else(|| anyhow!("invalid listing"))?;
        ensure!(
            raw.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "invalid encoding"
        );
        let (publisher, ad): (String, Self) = claims::verify(DOMAIN, raw)?;
        ad.validate()?;
        Ok((publisher, ad))
    }
    pub fn validate(&self) -> Result<()> {
        let label = |s: &str, max: usize| {
            !s.trim().is_empty() && s.len() <= max && !s.chars().any(|c| c.is_control())
        };
        ensure!(
            self.version == 1
                && is_hash(&self.mission)
                && self.revision > 0
                && label(&self.title, 120)
                && label(&self.summary, 2000)
                && self.capabilities.len() <= 8
                && self.capabilities.iter().all(|s| label(s, 80))
                && self.issued_ms <= now() + 60_000
                && self.expires_ms > self.issued_ms
                && self.expires_ms - self.issued_ms <= TTL,
            "invalid advertisement"
        );
        self.contact.validate()?;
        ensure!(
            self.contact.expires_ms >= self.expires_ms,
            "contact expires before listing"
        );
        Ok(())
    }
    pub fn available(&self) -> bool {
        self.active && self.expires_ms > now()
    }
}
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct ListingView {
    pub publisher: String,
    pub advertisement: Advertisement,
    pub reference: String,
    pub status: String,
}
#[derive(Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct FeedPage {
    pub items: Vec<String>,
    pub after: Option<String>,
}

impl Store {
    pub fn discovery_config(&self) -> Result<DiscoveryConfig> {
        let value: Option<String> = self
            .connection
            .query_row(
                "SELECT value FROM settings WHERE key='discovery'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let config: DiscoveryConfig = value
            .map(|s| serde_json::from_str(&s))
            .transpose()?
            .unwrap_or_default();
        config.validate()?;
        Ok(config)
    }
    pub fn save_discovery_config(&mut self, config: &DiscoveryConfig) -> Result<()> {
        config.validate()?;
        let tx = self.connection.transaction()?;
        tx.execute("INSERT INTO settings(key,value) VALUES('discovery',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[serde_json::to_string(config)?])?;
        for key in &config.blocked {
            tx.execute("DELETE FROM advertisements WHERE publisher=?1", [key])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn cache_listing(&mut self, reference: &str) -> Result<()> {
        let (publisher, ad) = Advertisement::parse(reference)?;
        ensure!(ad.expires_ms > now(), "expired listing");
        ensure!(
            !self.discovery_config()?.blocked.contains(&publisher),
            "blocked publisher"
        );
        let existing: Option<(u32, String)> = self
            .connection
            .query_row(
                "SELECT revision,reference FROM advertisements WHERE publisher=?1 AND mission=?2",
                params![publisher, ad.mission],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((revision, prior)) = existing {
            if ad.revision < revision || prior == reference {
                return Ok(());
            }
            if ad.revision == revision {
                self.connection.execute(
                    "UPDATE advertisements SET conflict=1 WHERE publisher=?1 AND mission=?2",
                    params![publisher, ad.mission],
                )?;
                return Ok(());
            }
        } else {
            // Keep stale cards briefly for the human, but evict expired caches
            // before admitting a new public claim. Owned publications persist.
            self.connection.execute(
                "DELETE FROM advertisements WHERE expires_ms<?1 AND owned=0",
                [i64::try_from(now())?],
            )?;
            let (total, author): (u32, u32) = self.connection.query_row(
                "SELECT count(*),coalesce(sum(publisher=?1),0) FROM advertisements",
                [&publisher],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            ensure!(
                total < MAX_LISTINGS as u32 && author < 8,
                "discovery cache full"
            );
        }
        self.connection.execute("INSERT INTO advertisements(publisher,mission,revision,expires_ms,reference) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(publisher,mission) DO UPDATE SET revision=excluded.revision,expires_ms=excluded.expires_ms,reference=excluded.reference,conflict=0",params![publisher,ad.mission,ad.revision,i64::try_from(ad.expires_ms)?,reference])?;
        Ok(())
    }
    pub fn publish_listing(
        &mut self,
        identity: &Identity,
        mission: &str,
        summary: String,
        capabilities: Vec<String>,
        active: bool,
        mut contact: Contact,
    ) -> Result<String> {
        ensure!(
            self.owner(mission)? == identity.public_key() && !self.conflicted(mission)?,
            "owner required"
        );
        ensure!(
            !active || self.discovery_config()?.enabled,
            "enable discovery before publishing"
        );
        let root = self
            .event(mission)?
            .ok_or_else(|| anyhow!("unknown mission"))?;
        let Payload::MissionCreated {
            definition,
            endpoint,
            ..
        } = root.body.payload
        else {
            anyhow::bail!("not a mission")
        };
        ensure!(
            definition
                .policy
                .is_some_and(|p| p.participation == Participation::Approval)
                && endpoint == contact.endpoint,
            "private mission cannot be advertised"
        );
        let previous: u32 = self
            .connection
            .query_row(
                "SELECT revision FROM advertisements WHERE publisher=?1 AND mission=?2",
                params![identity.public_key(), mission],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0);
        let issued_ms = now();
        let expires_ms = issued_ms + TTL;
        contact.expires_ms = expires_ms;
        let ad = Advertisement {
            version: 1,
            mission: mission.into(),
            title: self.control_state(mission)?.definition.name,
            summary,
            capabilities,
            contact,
            revision: previous
                .checked_add(1)
                .ok_or_else(|| anyhow!("revision limit"))?,
            active,
            issued_ms,
            expires_ms,
        };
        ad.validate()?;
        let reference = format!("{PREFIX}{}", identity.claim(DOMAIN, &ad)?);
        self.cache_listing(&reference)?;
        self.connection.execute(
            "UPDATE advertisements SET owned=1 WHERE publisher=?1 AND mission=?2",
            params![identity.public_key(), mission],
        )?;
        Ok(reference)
    }
    pub fn listing_views(&self) -> Result<Vec<ListingView>> {
        let mut q = self.connection.prepare("SELECT publisher,reference,conflict FROM advertisements ORDER BY publisher,mission LIMIT 256")?;
        q.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, bool>(2)?,
            ))
        })?
        .map(|row| {
            let (publisher, reference, conflict) = row?;
            let (_, ad) = Advertisement::parse(&reference)?;
            let status = if conflict {
                "conflict"
            } else if !ad.active {
                "unlisted"
            } else if ad.expires_ms <= now() {
                "stale"
            } else {
                "available"
            };
            Ok(ListingView {
                publisher,
                advertisement: ad,
                reference,
                status: status.into(),
            })
        })
        .collect()
    }
    pub fn inspect_listing(&self, reference: &str) -> Result<Vec<u8>> {
        let (owner, ad) = Advertisement::parse(reference)?;
        ensure!(
            ad.available()
                && self.discovery_config()?.enabled
                && self.owner(&ad.mission)? == owner
                && !self.conflicted(&ad.mission)?,
            "unavailable listing"
        );
        let valid: bool = self.connection.query_row("SELECT EXISTS(SELECT 1 FROM advertisements WHERE publisher=?1 AND mission=?2 AND reference=?3 AND owned=1 AND conflict=0)",params![owner,ad.mission,reference],|r|r.get(0))?;
        ensure!(valid, "listing superseded or unavailable");
        let e = self
            .event(&ad.mission)?
            .ok_or_else(|| anyhow!("unknown mission"))?;
        crate::admission::Invitation::review(reference, e.bytes())?;
        Ok(e.bytes().to_vec())
    }
    pub fn discovery_page(&self, after: Option<&str>) -> Result<FeedPage> {
        ensure!(self.discovery_config()?.enabled, "discovery disabled");
        ensure!(valid_cursor(after), "invalid discovery cursor");
        let mut q=self.connection.prepare("SELECT publisher||':'||mission,reference FROM advertisements WHERE expires_ms>?1 AND conflict=0 AND (?2 IS NULL OR publisher||':'||mission>?2) ORDER BY publisher,mission LIMIT 9")?;
        let mut rows = q
            .query_map(params![i64::try_from(now())?, after], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let more = rows.len() > PAGE;
        rows.truncate(PAGE);
        let after = if more {
            rows.last().map(|r| r.0.clone())
        } else {
            None
        };
        Ok(FeedPage {
            items: rows.into_iter().map(|r| r.1).collect(),
            after,
        })
    }
    pub fn renew_publications(
        &mut self,
        identity: &Identity,
        contact: Contact,
        force: bool,
    ) -> Result<()> {
        for view in self.listing_views()? {
            let ad = view.advertisement;
            if view.publisher == identity.public_key()
                && ad.active
                && (force
                    || ad.expires_ms < now() + TTL / 2
                    || ad.contact.addresses != contact.addresses
                    || ad.contact.relays != contact.relays)
            {
                self.publish_listing(
                    identity,
                    &ad.mission,
                    ad.summary,
                    ad.capabilities,
                    true,
                    contact.clone(),
                )?;
            }
        }
        Ok(())
    }
}

pub fn valid_cursor(after: Option<&str>) -> bool {
    after.is_none_or(|s| {
        s.len() == 129
            && s.is_ascii()
            && s.as_bytes()[64] == b':'
            && is_hash(&s[..64])
            && is_hash(&s[65..])
    })
}
