//! Public contribution metadata and direction, separate from execution grants.
//! Workspace paths, credentials and local allowances never enter these records.
use crate::{Error, Result, event::is_hash};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    Agent,
    Coordinator,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentIdentity {
    pub author: String,
    pub label: String,
    pub runtime: String,
    pub role: AgentRole,
    pub contributor_name: String,
}

pub fn label(value: &str, max: usize) -> bool {
    !value.trim().is_empty()
        && value.len() <= max
        && !value.chars().any(|c| {
            c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}
impl AgentIdentity {
    pub fn validate(&self) -> Result<()> {
        if !is_hash(&self.author)
            || !label(&self.label, 120)
            || !label(&self.contributor_name, 120)
            || !matches!(self.runtime.as_str(), "claude" | "codex" | "grok")
        {
            return Err(Error::Invalid("agent identity"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    WaitingForStart,
    WaitingForDirection,
    WaitingForAppointment,
    DirectionAssigned,
    Paused,
    ReviewRequired,
    Withdrawn,
    Revoked,
    Conflict,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct DirectionView {
    pub id: String,
    pub author: String,
    pub text: String,
    /// Assignment is never an acknowledgment or evidence of execution.
    pub source: String,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct AgentView {
    /// The immutable registration record, scoped to one mission.
    pub id: String,
    pub identity: AgentIdentity,
    pub contributor: String,
    pub terms_revision: String,
    pub status: AgentStatus,
    pub direction: Option<DirectionView>,
    /// Receipt of the exact current direction; never evidence of execution.
    pub acknowledgment: Option<String>,
    pub assignment: Option<crate::work::WorkstreamAssignmentView>,
}

#[derive(Debug, Serialize, TS)]
pub struct AgentPage {
    pub items: Vec<AgentView>,
    pub after: Option<String>,
    pub total: usize,
}
