//! Expiring contributor reports. Never mission events, evidence or authority.
use crate::store::Store;
use anyhow::{Result, ensure};
use harakiri_protocol::{Identity, Payload, claims};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

const DOMAIN: &[u8] = b"harakiri/execution-observation/1";
const TTL: u64 = 30_000;
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum ObservedState {
    Setup,
    SignIn,
    Ready,
    AwaitingApproval,
    AwaitingOwner,
    AwaitingDirection,
    ReviewRequired,
    Starting,
    Running,
    Idle,
    Stopping,
    Stopped,
    RecoveryRequired,
}
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub mission: String,
    pub registration: String,
    pub control: String,
    pub grant: Option<String>,
    pub state: ObservedState,
    pub issued_ms: u64,
}
#[derive(Clone, Serialize, ts_rs::TS)]
pub struct ObservationView {
    pub report: Observation,
    pub contributor: String,
    pub remaining_ms: u64,
}
pub struct Cached {
    raw: String,
    report: Observation,
    contributor: String,
    until: Instant,
}
pub type Observations = BTreeMap<String, Cached>;
impl Store {
    pub fn receive_observation(&mut self, mission: &str, raw: &str) -> Result<()> {
        ensure!(raw.len() <= 8192, "observation size limit");
        let (contributor, report) = claims::verify::<Observation>(DOMAIN, raw)?;
        ensure!(report.mission == mission, "cross-mission observation");
        let now = crate::store::now()?;
        ensure!(
            report.issued_ms <= now + 5_000 && now < report.issued_ms.saturating_add(TTL),
            "observation expired"
        );
        let offer = self
            .event(&report.registration)?
            .ok_or_else(|| anyhow::anyhow!("unknown agent"))?;
        ensure!(
            offer.mission_id() == report.mission
                && offer.body.author == contributor
                && matches!(offer.body.payload, Payload::AgentOffered { .. }),
            "observation author mismatch"
        );
        self.communicative_agent(&report.mission, &report.registration)?;
        ensure!(
            !self.is_revoked(&report.mission, &contributor)?,
            "contributor revoked"
        );
        let control = self.control_state(&report.mission)?;
        ensure!(
            control.lifecycle.revision == report.control,
            "stale observation control"
        );
        if matches!(
            report.state,
            ObservedState::Starting | ObservedState::Running | ObservedState::Idle
        ) {
            let ledger = self.governance(&report.mission, &contributor)?;
            ensure!(
                ledger
                    .grants
                    .iter()
                    .any(|g| Some(&g.id) == report.grant.as_ref()
                        && g.registration == report.registration
                        && !g.sealed),
                "observation permission unavailable"
            );
        }
        if let Some(old) = self.observations.get(&report.registration)
            && old.report.issued_ms >= report.issued_ms
        {
            // Replaying an identical report never refreshes receipt age.
            return Ok(());
        }
        self.observations.retain(|_, v| v.until > Instant::now());
        ensure!(self.observations.len() < 4096, "observation cache full");
        let until = Instant::now()
            + Duration::from_millis(TTL.min(report.issued_ms.saturating_add(TTL) - now));
        self.observations.insert(
            report.registration.clone(),
            Cached {
                raw: raw.into(),
                report,
                contributor,
                until,
            },
        );
        Ok(())
    }
    pub fn publish_observation(
        &mut self,
        identity: &Identity,
        mut report: Observation,
    ) -> Result<()> {
        report.issued_ms = crate::store::now()?;
        self.receive_observation(&report.mission, &identity.claim(DOMAIN, &report)?)
    }
    pub fn observation_views(&self, mission: &str) -> Result<Vec<ObservationView>> {
        let control = self.control_state(mission)?;
        Ok(self
            .observations
            .values()
            .filter(|v| {
                v.report.mission == mission
                    && v.report.control == control.lifecycle.revision
                    && v.until > Instant::now()
                    && self
                        .communicative_agent(mission, &v.report.registration)
                        .is_ok()
            })
            .map(|v| ObservationView {
                report: v.report.clone(),
                contributor: v.contributor.clone(),
                remaining_ms: v
                    .until
                    .saturating_duration_since(Instant::now())
                    .as_millis() as u64,
            })
            .collect())
    }
    pub fn observation_claims(&self, mission: &str) -> Vec<String> {
        self.observations
            .values()
            .filter(|v| v.report.mission == mission && v.until > Instant::now())
            .take(512)
            .map(|v| v.raw.clone())
            .collect()
    }
}
