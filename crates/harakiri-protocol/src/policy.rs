//! Mission policy is separate from permission to execute on a contributor's
//! device. G1 persists the terms; it issues no executable grants.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum Coordination {
    Coordinated,
    Peer,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum Participation {
    Private,
    Approval,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum MissionBudget {
    Unlimited {},
    Limited {
        turns: Option<u32>,
        concurrency: Option<u16>,
        deadline_ms: Option<u64>,
        tokens: Option<u64>,
        model_cost_microusd: Option<u64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
pub struct MissionPolicy {
    pub coordination: Coordination,
    pub participation: Participation,
    pub budget: MissionBudget,
}

impl MissionPolicy {
    pub fn validate(&self) -> Result<()> {
        if let MissionBudget::Limited {
            turns,
            concurrency,
            deadline_ms,
            tokens,
            model_cost_microusd,
        } = self.budget
        {
            let positive =
                |v: Option<u64>| v.is_none_or(|n| (1..=9_007_199_254_740_991).contains(&n));
            if [
                turns.map(u64::from),
                concurrency.map(u64::from),
                deadline_ms,
                tokens,
                model_cost_microusd,
            ]
            .iter()
            .all(Option::is_none)
                || !positive(turns.map(u64::from))
                || !positive(concurrency.map(u64::from))
                || !positive(deadline_ms)
                || !positive(tokens)
                || !positive(model_cost_microusd)
                || concurrency.is_some_and(|n| n > 1024)
            {
                return Err(Error::Invalid("budget"));
            }
        }
        Ok(())
    }
}
