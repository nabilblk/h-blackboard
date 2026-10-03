//! Contact hints are claims, not authority. Only the locally chosen relay set
//! is dialed. Private/LAN IP routes require an explicit local network preference.
use anyhow::{Result, ensure};
use harakiri_protocol::{Identity, claims};
use iroh::{EndpointAddr, RelayMode};
use serde::{Deserialize, Serialize};
use std::{
    net::{IpAddr, SocketAddr},
    str::FromStr,
};

pub const CONTACT_DOMAIN: &[u8] = b"harakiri/contact/1";
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct Contact {
    pub endpoint: String,
    pub addresses: Vec<String>,
    pub relays: Vec<String>,
    pub expires_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct NetworkConfig {
    pub mode: NetworkMode,
    pub relays: Vec<String>,
    pub allow_lan: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum NetworkMode {
    Offline,
    Direct,
    PublicRelays,
    Custom,
}
impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            mode: NetworkMode::Offline,
            relays: vec![],
            allow_lan: false,
        }
    }
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}
impl NetworkConfig {
    pub fn relay_mode(&self) -> Result<RelayMode> {
        ensure!(self.relays.len() <= 4, "too many relays");
        match self.mode {
            NetworkMode::Offline | NetworkMode::Direct => {
                ensure!(self.relays.is_empty(), "unexpected relays");
                Ok(RelayMode::Disabled)
            }
            NetworkMode::PublicRelays => {
                ensure!(self.relays.is_empty(), "unexpected relays");
                Ok(RelayMode::Default)
            }
            NetworkMode::Custom => {
                ensure!(!self.relays.is_empty(), "relay required");
                let mut urls = Vec::new();
                for s in &self.relays {
                    let u = iroh::RelayUrl::from_str(s)?;
                    ensure!(
                        s.len() <= 512
                            && u.scheme() == "https"
                            && u.username().is_empty()
                            && u.password().is_none()
                            && u.query().is_none()
                            && u.fragment().is_none()
                            && u.path() == "/",
                        "invalid relay URL"
                    );
                    // Operator configuration is deliberate authority to contact this
                    // service. Peer tickets can never add a new HTTP destination.
                    urls.push(u);
                }
                Ok(RelayMode::custom(urls))
            }
        }
    }
    pub fn allowed_relays(&self) -> Result<Vec<String>> {
        Ok(self
            .relay_mode()?
            .relay_map()
            .urls::<Vec<_>>()
            .into_iter()
            .map(|u| u.to_string())
            .collect())
    }
}
impl Contact {
    pub fn current(addr: &EndpointAddr) -> Self {
        Self {
            endpoint: addr.id.to_string(),
            addresses: addr.ip_addrs().take(8).map(ToString::to_string).collect(),
            relays: addr.relay_urls().take(4).map(ToString::to_string).collect(),
            expires_ms: now() + 24 * 60 * 60 * 1000,
        }
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(
            harakiri_protocol::event::is_hash(&self.endpoint)
                && self.addresses.len() <= 8
                && self.relays.len() <= 4
                && self.expires_ms <= 9_007_199_254_740_991,
            "invalid contact"
        );
        for a in &self.addresses {
            ensure!(a.len() <= 80, "address length");
            let _: SocketAddr = a.parse()?;
        }
        for r in &self.relays {
            ensure!(r.len() <= 512, "relay length");
        }
        Ok(())
    }
    pub fn address(&self, config: &NetworkConfig) -> Result<EndpointAddr> {
        self.validate()?;
        ensure!(self.expires_ms > now(), "contact expired");
        let mut addr = EndpointAddr::new(self.endpoint.parse()?);
        for value in &self.addresses {
            let ip: SocketAddr = value.parse()?;
            if permitted_ip(ip, config.allow_lan) {
                addr = addr.with_ip_addr(ip);
            }
        }
        let allowed = config.allowed_relays()?;
        for url in &self.relays {
            if allowed.contains(url) {
                addr = addr.with_relay_url(url.parse()?);
            }
        }
        ensure!(
            !addr.is_empty(),
            "no contact route allowed by local network settings"
        );
        Ok(addr)
    }
    pub fn sign(&self, identity: &Identity) -> Result<String> {
        self.validate()?;
        Ok(identity.claim(CONTACT_DOMAIN, self)?)
    }
    pub fn verify(s: &str) -> Result<(String, Self)> {
        let (author, c): (String, Self) = claims::verify(CONTACT_DOMAIN, s)?;
        c.validate()?;
        Ok((author, c))
    }
}
fn permitted_ip(addr: SocketAddr, lan: bool) -> bool {
    if addr.port() == 0 {
        return false;
    }
    match addr.ip() {
        IpAddr::V4(ip) => {
            !ip.is_unspecified()
                && !ip.is_multicast()
                && !ip.is_broadcast()
                && (lan
                    || !(ip.is_private()
                        || ip.is_link_local()
                        || ip.is_loopback()
                        || ip.octets()[0] == 0
                        || ip.octets()[0] >= 224
                        || (ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]))))
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return permitted_ip(SocketAddr::new(v4.into(), addr.port()), lan);
            }
            !ip.is_unspecified()
                && !ip.is_multicast()
                && (lan
                    || !(ip.is_loopback()
                        || ip.is_unique_local()
                        || ip.is_unicast_link_local()
                        || ip.segments()[0] == 0x2002
                        || (ip.segments()[0] == 0x2001 && ip.segments()[1] == 0)))
        }
    }
}
