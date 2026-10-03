//! Optional organization of public mission work. Reports are not execution receipts.
use crate::{Error, Result, agents::label, event::is_hash};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TaskDefinition {
    pub title: String,
    pub description: String,
    pub criteria: Vec<String>,
    pub workstream: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AttemptStatus {
    Planned,
    InProgress,
    Blocked,
    Paused,
    Submitted,
    Complete,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkAction {
    CreateWorkstream {
        name: String,
        goal: String,
    },
    ReviseWorkstream {
        workstream: String,
        bases: Vec<String>,
        name: String,
        goal: String,
    },
    AssignWorkstream {
        registration: String,
        workstream: Option<String>,
        goal_revision: Option<String>,
        direction: String,
    },
    CreateTask {
        definition: TaskDefinition,
        assignees: Vec<String>,
    },
    ReviseTask {
        task: String,
        bases: Vec<String>,
        definition: TaskDefinition,
    },
    AssignTask {
        task: String,
        registration: String,
        approach: String,
    },
    ReportAttempt {
        task: String,
        task_revision: String,
        allocation: String,
        registration: String,
        bases: Vec<String>,
        status: AttemptStatus,
        summary: String,
        evidence: Vec<String>,
    },
}

fn text(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.len() <= max && !s.contains('\0')
}
fn ids(v: &[String], max: usize) -> bool {
    v.len() <= max
        && v.iter().all(|s| is_hash(s))
        && v.iter().collect::<std::collections::BTreeSet<_>>().len() == v.len()
}
impl TaskDefinition {
    fn valid(&self) -> bool {
        label(&self.title, 240)
            && text(&self.description, 4096)
            && self.criteria.len() <= 16
            && self.criteria.iter().all(|s| text(s, 1024))
            && self.workstream.as_deref().is_none_or(is_hash)
    }
}
impl WorkAction {
    pub fn validate(&self) -> Result<()> {
        let valid = match self {
            Self::CreateWorkstream { name, goal } => label(name, 80) && text(goal, 4096),
            Self::ReviseWorkstream {
                workstream,
                bases,
                name,
                goal,
            } => {
                is_hash(workstream)
                    && !bases.is_empty()
                    && ids(bases, 256)
                    && label(name, 80)
                    && text(goal, 4096)
            }
            Self::AssignWorkstream {
                registration,
                workstream,
                goal_revision,
                direction,
            } => {
                is_hash(registration)
                    && workstream.as_deref().is_none_or(is_hash)
                    && goal_revision.as_deref().is_none_or(is_hash)
                    && workstream.is_some() == goal_revision.is_some()
                    && text(direction, 2048)
            }
            Self::CreateTask {
                definition,
                assignees,
            } => definition.valid() && ids(assignees, 32),
            Self::ReviseTask {
                task,
                bases,
                definition,
            } => is_hash(task) && !bases.is_empty() && ids(bases, 256) && definition.valid(),
            Self::AssignTask {
                task,
                registration,
                approach,
            } => is_hash(task) && is_hash(registration) && text(approach, 2048),
            Self::ReportAttempt {
                task,
                task_revision,
                allocation,
                registration,
                bases,
                summary,
                evidence,
                ..
            } => {
                is_hash(task_revision)
                    && is_hash(task)
                    && is_hash(allocation)
                    && is_hash(registration)
                    && ids(bases, 256)
                    && text(summary, 4096)
                    && ids(evidence, 16)
            }
        };
        if valid {
            Ok(())
        } else {
            Err(Error::Invalid("work action"))
        }
    }
    pub fn references(&self) -> Vec<&str> {
        match self {
            Self::CreateWorkstream { .. } => vec![],
            Self::ReviseWorkstream {
                workstream, bases, ..
            } => std::iter::once(workstream.as_str())
                .chain(bases.iter().map(String::as_str))
                .collect(),
            Self::AssignWorkstream {
                registration,
                workstream,
                goal_revision,
                ..
            } => std::iter::once(registration.as_str())
                .chain(workstream.as_deref())
                .chain(goal_revision.as_deref())
                .collect(),
            Self::CreateTask {
                definition,
                assignees,
            } => definition
                .workstream
                .as_deref()
                .into_iter()
                .chain(assignees.iter().map(String::as_str))
                .collect(),
            Self::ReviseTask {
                task,
                bases,
                definition,
            } => std::iter::once(task.as_str())
                .chain(bases.iter().map(String::as_str))
                .chain(definition.workstream.as_deref())
                .collect(),
            Self::AssignTask {
                task, registration, ..
            } => vec![task, registration],
            Self::ReportAttempt {
                task,
                task_revision,
                allocation,
                registration,
                bases,
                evidence,
                ..
            } => vec![task.as_str(), task_revision, allocation, registration]
                .into_iter()
                .chain(bases.iter().map(String::as_str))
                .chain(evidence.iter().map(String::as_str))
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct WorkstreamRevision {
    pub id: String,
    pub author: String,
    pub name: String,
    pub goal: String,
}
#[derive(Debug, Clone, Serialize, TS)]
pub struct WorkstreamView {
    pub id: String,
    pub name: String,
    pub goal: String,
    pub heads: Vec<WorkstreamRevision>,
    pub stale: bool,
    pub unread: u32,
}
#[derive(Debug, Clone, Serialize, TS)]
pub struct WorkstreamAssignmentView {
    pub id: String,
    pub author: String,
    pub workstream: Option<String>,
    pub goal_revision: Option<String>,
    pub name: String,
    pub direction: String,
    pub stale: bool,
}
#[derive(Debug, Clone, Serialize, TS)]
pub struct TaskRevision {
    pub id: String,
    pub author: String,
    pub definition: TaskDefinition,
}
#[derive(Debug, Clone, Serialize, TS)]
pub struct AttemptReport {
    pub id: String,
    pub author: String,
    pub status: AttemptStatus,
    pub summary: String,
    pub evidence: Vec<String>,
    pub stale: bool,
}
#[derive(Debug, Clone, Serialize, TS)]
pub struct AttemptView {
    pub allocation: String,
    pub registration: String,
    pub assigned_by: String,
    pub approach: String,
    pub reports: Vec<AttemptReport>,
    pub status: String,
    pub unavailable: bool,
}
#[derive(Debug, Clone, Serialize, TS)]
pub struct TaskView {
    pub id: String,
    pub creator: String,
    pub definition: TaskDefinition,
    pub heads: Vec<TaskRevision>,
    pub attempts: Vec<AttemptView>,
    pub status: String,
    pub stale: bool,
}
#[derive(Debug, Clone, Default, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TaskQuery {
    pub after: Option<String>,
    pub task: Option<String>,
    pub workstream: Option<String>,
    pub status: Option<String>,
    pub search: Option<String>,
    pub owner: Option<String>,
}
#[derive(Debug, Serialize, TS)]
pub struct TaskPage {
    pub items: Vec<TaskView>,
    pub after: Option<String>,
    pub total: usize,
}

impl AttemptStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::InProgress => "in_progress",
            Self::Blocked => "blocked",
            Self::Paused => "paused",
            Self::Submitted => "submitted",
            Self::Complete => "complete",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Serialize, TS)]
pub struct WorkEvidence {
    pub id: String,
    pub title: String,
    pub conversation: String,
    pub text: Option<String>,
    pub files: Vec<crate::ArtifactFile>,
}

#[derive(Debug, Serialize, TS)]
pub struct WorkLink {
    pub kind: String,
    pub id: String,
}
