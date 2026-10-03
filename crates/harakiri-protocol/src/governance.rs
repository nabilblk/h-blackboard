//! Resource authority is a signed ledger, not a mutable shared counter. Records
//! describe permission and attributed receipts; they never attest to a process.
use crate::{Error, Result, event::is_hash};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const MAX_RECORDS: usize = 4096;
pub const MAX_GRANT_MS: u64 = 86_400_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum GovernanceAction {
    Allocate {
        node: String,
        turns: Option<u32>,
        slots: u16,
    },
    Reclaim {
        seal: String,
    },
    Grant {
        previous: Option<String>,
        allocation: String,
        registration: String,
        direction: String,
        execution: String,
        generation: u32,
        turns: u32,
        expires_ms: u64,
        offline_ms: u64,
    },
    Consent {
        grant: String,
        binding: String,
    },
    Reserve {
        grant: String,
        consent: String,
        nonce: String,
    },
    Receipt {
        reservation: String,
        used: Option<u32>,
        stopped: bool,
        summary: String,
    },
    /// Owner accepts the uncertainty explicitly, charging the full reservation.
    /// This is NOT proof that an unreachable process has stopped.
    Resolve {
        reservation: String,
        reason: String,
    },
    RetireGrant {
        grant: String,
        reason: String,
    },
    SealGrant {
        grant: String,
        settlements: Vec<String>,
    },
    SealAllocation {
        allocation: String,
        grants: Vec<String>,
    },
    Criterion {
        index: u16,
        wording: String,
        met: bool,
        summary: String,
        evidence: Vec<String>,
    },
}
impl GovernanceAction {
    pub fn references(&self) -> Vec<&str> {
        match self {
            Self::Allocate { .. } | Self::Criterion { .. } => vec![],
            Self::Reclaim { seal } => vec![seal],
            Self::Grant {
                previous,
                allocation,
                registration,
                direction,
                ..
            } => [
                allocation.as_str(),
                registration.as_str(),
                direction.as_str(),
            ]
            .into_iter()
            .chain(previous.as_deref())
            .collect(),
            Self::Consent { grant, .. } | Self::RetireGrant { grant, .. } => vec![grant],
            Self::SealGrant { grant, settlements } => std::iter::once(grant.as_str())
                .chain(settlements.iter().map(String::as_str))
                .collect(),
            Self::Reserve { grant, consent, .. } => vec![grant, consent],
            Self::Receipt { reservation, .. } | Self::Resolve { reservation, .. } => {
                vec![reservation]
            }
            Self::SealAllocation { allocation, grants } => std::iter::once(allocation.as_str())
                .chain(grants.iter().map(String::as_str))
                .collect(),
        }
    }
    pub fn validate(&self) -> Result<()> {
        let text = |s: &str, n| !s.trim().is_empty() && s.len() <= n && !s.contains('\0');
        let valid = self.references().iter().all(|s| is_hash(s))
            && match self {
                Self::Allocate { node, turns, slots } => {
                    is_hash(node) && turns.is_none_or(|n| n > 0) && (1..=1024).contains(slots)
                }
                Self::Grant {
                    execution,
                    generation,
                    turns,
                    expires_ms,
                    offline_ms,
                    ..
                } => {
                    is_hash(execution)
                        && *generation > 0
                        && *turns > 0
                        && *expires_ms <= 9_007_199_254_740_991
                        && (1..=MAX_GRANT_MS).contains(offline_ms)
                }
                Self::Consent { binding, .. } => is_hash(binding),
                Self::Reserve { nonce, .. } => is_hash(nonce),
                Self::Receipt { used, summary, .. } => {
                    used.is_none_or(|n| n <= 1) && text(summary, 2048)
                }
                Self::Resolve { reason, .. } | Self::RetireGrant { reason, .. } => {
                    text(reason, 2048)
                }
                Self::Criterion {
                    index,
                    wording,
                    met,
                    summary,
                    evidence,
                } => {
                    *index < 32
                        && text(wording, 1024)
                        && text(summary, 4096)
                        && evidence.len() <= 32
                        && (!met || !evidence.is_empty())
                        && evidence.iter().all(|s| is_hash(s))
                        && evidence
                            .iter()
                            .collect::<std::collections::BTreeSet<_>>()
                            .len()
                            == evidence.len()
                }
                Self::SealGrant { settlements, .. } => settlements.len() <= 512,
                Self::SealAllocation { grants, .. } => grants.len() <= 256,
                _ => true,
            };
        if !valid {
            return Err(Error::Invalid("governance action"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct AllocationView {
    pub id: String,
    pub node: String,
    pub turns: Option<u32>,
    pub slots: u16,
    pub charged: u32,
    pub reserved: u32,
    pub active: u16,
    pub sealed: Option<String>,
    pub reclaimed: bool,
}
#[derive(Debug, Clone, Serialize, TS)]
pub struct GrantView {
    pub id: String,
    pub allocation: String,
    pub registration: String,
    pub node: String,
    pub execution: String,
    pub generation: u32,
    pub turns: u32,
    pub expires_ms: u64,
    pub offline_ms: u64,
    pub control: String,
    pub direction: String,
    pub consent: Option<String>,
    pub risk_accepted: Option<String>,
    pub sealed: bool,
    pub seal: Option<String>,
    pub charged: u32,
    pub reserved: u32,
}
#[derive(Debug, Clone, Serialize, TS)]
pub struct ReservationView {
    pub id: String,
    pub grant: String,
    pub node: String,
    pub nonce: String,
    pub receipt: Option<String>,
    pub used: Option<u32>,
    pub stopped: bool,
    pub resolution: Option<String>,
    pub summary: Option<String>,
}
#[derive(Debug, Clone, Serialize, TS)]
pub struct CriterionView {
    pub index: u16,
    pub wording: String,
    pub met: bool,
    pub report: Option<String>,
    pub author: Option<String>,
    pub summary: Option<String>,
    pub evidence: Vec<String>,
    pub stale: bool,
}
#[derive(Debug, Clone, Serialize, TS)]
pub struct GovernanceView {
    pub allocations: Vec<AllocationView>,
    pub grants: Vec<GrantView>,
    pub reservations: Vec<ReservationView>,
    pub criteria: Vec<CriterionView>,
    pub handover_blockers: Vec<String>,
    pub execution_available: bool,
}
