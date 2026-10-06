//! Local observations of catalog exchange, never a claim of global discovery.
//! Only bounded labels, counters, times and typed failures cross IPC. Signed
//! tickets, transport addresses and remote error prose stay out of diagnostics.
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryOutcome {
    Waiting,
    Contacting,
    Ok,
    ExpiredAddress,
    RouteBlocked,
    Unreachable,
    InvalidCatalog,
    CacheError,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct DiscoveryPeerHealth {
    pub name: String,
    pub outcome: DiscoveryOutcome,
    pub checking: bool,
    pub last_attempt_ms: Option<u64>,
    pub last_success_ms: Option<u64>,
    pub received: usize,
}

#[derive(Debug, Default, Clone, Serialize, ts_rs::TS)]
pub struct DiscoveryHealth {
    pub running: bool,
    pub lan: bool,
    pub peers: Vec<DiscoveryPeerHealth>,
}

impl DiscoveryHealth {
    pub fn retain(&mut self, names: &[String]) {
        self.peers.retain(|p| names.contains(&p.name));
        for name in names.iter().take(40) {
            if !self.peers.iter().any(|p| p.name == *name) {
                self.peers.push(DiscoveryPeerHealth {
                    name: name.clone(),
                    outcome: DiscoveryOutcome::Waiting,
                    checking: false,
                    last_attempt_ms: None,
                    last_success_ms: None,
                    received: 0,
                });
            }
        }
    }
    pub fn record(&mut self, name: &str, outcome: DiscoveryOutcome, received: usize, now: u64) {
        if let Some(peer) = self.peers.iter_mut().find(|p| p.name == name) {
            peer.last_attempt_ms = Some(now);
            peer.checking = outcome == DiscoveryOutcome::Contacting;
            // Retries can immediately follow a timeout. Preserve the last
            // completed result while the next attempt is in flight.
            if outcome != DiscoveryOutcome::Contacting || peer.outcome == DiscoveryOutcome::Waiting
            {
                peer.outcome = outcome;
            }
            if outcome == DiscoveryOutcome::Ok {
                peer.last_success_ms = Some(now);
                peer.received = received.min(crate::discovery::PAGE);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn observations_keep_last_success_without_hiding_failure_and_remain_bounded() {
        let mut health = DiscoveryHealth::default();
        health.retain(
            &(0..100)
                .map(|i| format!("Community peer {i}"))
                .collect::<Vec<_>>(),
        );
        assert_eq!(health.peers.len(), 40);
        health.record("Community peer 0", DiscoveryOutcome::Ok, 8, 1000);
        health.record("Community peer 0", DiscoveryOutcome::Unreachable, 0, 2000);
        assert_eq!(health.peers[0].last_success_ms, Some(1000));
        assert_eq!(health.peers[0].last_attempt_ms, Some(2000));
        assert_eq!(health.peers[0].outcome, DiscoveryOutcome::Unreachable);
        health.record("Community peer 0", DiscoveryOutcome::Contacting, 0, 2100);
        assert_eq!(health.peers[0].outcome, DiscoveryOutcome::Unreachable);
        assert!(health.peers[0].checking);
        health.retain(&["Community peer 1".into()]);
        assert_eq!(health.peers.len(), 1);
        assert_eq!(health.peers[0].last_success_ms, None);
    }
}
