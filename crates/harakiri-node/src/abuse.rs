//! Resource budgets are containment, not a claim of Sybil resistance. Limits
//! apply before deserializing peer input and never authorize a mission read.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Debug)]
pub struct Budget {
    since: Instant,
    peers: HashMap<String, (usize, usize, usize)>,
    requests: usize,
    bytes: usize,
}
impl Default for Budget {
    fn default() -> Self {
        Self {
            since: Instant::now(),
            peers: HashMap::new(),
            requests: 0,
            bytes: 0,
        }
    }
}
impl Budget {
    pub fn allow(&mut self, peer: &str, bytes: usize, catalog: bool) -> bool {
        if self.since.elapsed() >= Duration::from_secs(60) {
            *self = Self::default();
        }
        if self.requests >= 4096
            || self.bytes.saturating_add(bytes) > 128 * 1024 * 1024
            || self.peers.len() >= 1024 && !self.peers.contains_key(peer)
        {
            return false;
        }
        let state = self.peers.entry(peer.into()).or_default();
        if state.0 >= 480
            || state.1.saturating_add(bytes) > 64 * 1024 * 1024
            || catalog && state.2 >= 12
        {
            return false;
        }
        state.0 += 1;
        state.1 += bytes;
        state.2 += usize::from(catalog);
        self.requests += 1;
        self.bytes += bytes;
        true
    }
}

#[derive(Debug, Clone, Default)]
pub struct Connections(Arc<Mutex<HashMap<String, usize>>>);
pub struct Permit {
    peers: Connections,
    peer: String,
}
impl Connections {
    pub fn acquire(&self, peer: &str) -> Option<Permit> {
        let mut peers = self.0.lock().ok()?;
        let count = peers.entry(peer.into()).or_default();
        if *count >= 4 {
            return None;
        }
        *count += 1;
        Some(Permit {
            peers: self.clone(),
            peer: peer.into(),
        })
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        if let Ok(mut peers) = self.peers.0.lock()
            && let Some(count) = peers.get_mut(&self.peer)
        {
            *count -= 1;
            if *count == 0 {
                peers.remove(&self.peer);
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_noisy_peer_cannot_use_another_peers_budget() {
        let mut budget = Budget::default();
        for _ in 0..12 {
            assert!(budget.allow("noisy", 100, true));
        }
        assert!(!budget.allow("noisy", 100, true));
        assert!(budget.allow("other", 100, true));
        assert!(!budget.allow("noisy", 65 * 1024 * 1024, false));
        let mut blobs = BlobBudget::default();
        assert!(blobs.allow("noisy", 128 * 1024 * 1024));
        assert!(!blobs.allow("noisy", 1));
        assert!(blobs.allow("other", 32 * 1024 * 1024));
        let connections = Connections::default();
        let permits: Vec<_> = (0..4)
            .map(|_| connections.acquire("noisy").unwrap())
            .collect();
        assert!(connections.acquire("noisy").is_none());
        assert!(connections.acquire("other").is_some());
        drop(permits);
        assert!(connections.acquire("noisy").is_some());
    }
}

#[derive(Debug)]
pub struct BlobBudget {
    since: Instant,
    peers: HashMap<String, u64>,
    bytes: u64,
}
impl Default for BlobBudget {
    fn default() -> Self {
        Self {
            since: Instant::now(),
            peers: HashMap::new(),
            bytes: 0,
        }
    }
}
impl BlobBudget {
    pub fn allow(&mut self, peer: &str, bytes: u64) -> bool {
        if self.since.elapsed() >= Duration::from_secs(60) {
            *self = Self::default();
        }
        if self.bytes.saturating_add(bytes) > 512 * 1024 * 1024
            || self.peers.len() >= 1024 && !self.peers.contains_key(peer)
        {
            return false;
        }
        let sent = self.peers.entry(peer.into()).or_default();
        if sent.saturating_add(bytes) > 128 * 1024 * 1024 {
            return false;
        }
        *sent += bytes;
        self.bytes += bytes;
        true
    }
}
