//! Durable outputs. Publication, review and acceptance are distinct statements.
use crate::{
    ArtifactFile, Error, Result,
    event::{is_audience, is_hash},
    limits,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const MAX_ARTIFACTS: usize = 512;
pub const MAX_REVISIONS: usize = 256;
pub const MAX_RECORDS: usize = 8192;
pub const MAX_UPLOAD_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    Plan,
    Report,
    Application,
    Data,
    Code,
    Document,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactStage {
    Draft,
    Complete,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum ReviewVerdict {
    Verified,
    ChangesRequested,
    Inconclusive,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum ReviewMethod {
    SourceInspection,
    ExecutedTests,
    BrowserCheck,
    VisualInspection,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum CheckResult {
    Passed,
    Failed,
    NotRun,
}

/// An attributed report of what was checked, not a host execution attestation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ReviewCheck {
    pub method: ReviewMethod,
    pub result: CheckResult,
    pub details: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ArtifactDocument {
    pub title: String,
    pub summary: String,
    pub kind: ArtifactKind,
    pub stage: ArtifactStage,
    pub limitations: String,
    pub entrypoint: Option<String>,
    pub inputs: Vec<String>,
    pub files: Vec<ArtifactFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ArtifactAction {
    Publish {
        artifact: Option<String>,
        parents: Vec<String>,
        document: ArtifactDocument,
    },
    Review {
        revision: String,
        verdict: ReviewVerdict,
        summary: String,
        conditions: String,
        evidence: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        checks: Vec<ReviewCheck>,
    },
    Accept {
        revision: String,
        accepted: bool,
        reason: String,
    },
    Highlight {
        revision: String,
        highlighted: bool,
    },
}
pub fn text(s: &str, max: usize, empty: bool) -> bool {
    (empty || !s.trim().is_empty()) && s.len() <= max && !s.contains('\0')
}
pub fn ids(values: &[String], max: usize) -> bool {
    values.len() <= max
        && values.iter().all(|v| is_hash(v))
        && values.iter().collect::<BTreeSet<_>>().len() == values.len()
}
pub fn conversation(s: &str) -> bool {
    is_audience(s) || s.strip_prefix("workstream:").is_some_and(is_hash)
}
pub fn valid_file(file: &ArtifactFile) -> bool {
    text(&file.path, 240, false)
        && !file.path.chars().any(char::is_control)
        && !file.path.contains('\\')
        && file
            .path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != ".." && !p.contains(':'))
        && is_hash(&file.hash)
        && file.size <= limits::MAX_BLOB_BYTES
        && text(&file.media_type, 100, false)
        && file.media_type.bytes().all(|b| b.is_ascii_graphic())
}
impl ArtifactDocument {
    pub fn validate(&self) -> Result<()> {
        if !text(&self.title, 240, false)
            || !text(&self.summary, 2048, false)
            || !text(&self.limitations, 4096, true)
            || !ids(&self.inputs, 16)
            || self.files.is_empty()
            || self.files.len() > limits::MAX_FILES
            || self.files.iter().any(|f| !valid_file(f))
            || self
                .files
                .iter()
                .map(|f| &f.path)
                .collect::<BTreeSet<_>>()
                .len()
                != self.files.len()
            || self.files.iter().map(|f| f.size).sum::<u64>() > MAX_UPLOAD_BYTES as u64
            || self
                .entrypoint
                .as_ref()
                .is_some_and(|p| !self.files.iter().any(|f| &f.path == p))
        {
            return Err(Error::Invalid("artifact document"));
        }
        Ok(())
    }
}
impl ArtifactAction {
    pub fn validate(&self) -> Result<()> {
        let valid = match self {
            Self::Publish {
                artifact,
                parents,
                document,
            } => {
                document.validate()?;
                artifact.as_deref().is_none_or(is_hash)
                    && ids(parents, MAX_REVISIONS)
                    && (artifact.is_none() == parents.is_empty())
            }
            Self::Review {
                revision,
                summary,
                conditions,
                evidence,
                verdict,
                checks,
                ..
            } => {
                is_hash(revision)
                    && text(summary, 4096, false)
                    && text(conditions, 4096, false)
                    && ids(evidence, 16)
                    && checks.len() <= 8
                    && checks.iter().all(|c| text(&c.details, 1024, false))
                    && (*verdict != ReviewVerdict::Verified
                        || checks.is_empty()
                        || (checks.iter().any(|c| c.result == CheckResult::Passed)
                            && checks.iter().all(|c| c.result != CheckResult::Failed)))
            }
            Self::Accept {
                revision, reason, ..
            } => is_hash(revision) && text(reason, 2048, false),
            Self::Highlight { revision, .. } => is_hash(revision),
        };
        if !valid {
            return Err(Error::Invalid("artifact action"));
        }
        Ok(())
    }
    pub fn references(&self) -> Vec<&str> {
        match self {
            Self::Publish {
                artifact,
                parents,
                document,
            } => artifact
                .iter()
                .chain(parents)
                .chain(&document.inputs)
                .map(String::as_str)
                .collect(),
            Self::Review {
                revision, evidence, ..
            } => std::iter::once(revision)
                .chain(evidence)
                .map(String::as_str)
                .collect(),
            Self::Accept { revision, .. } | Self::Highlight { revision, .. } => vec![revision],
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ArtifactQuery {
    pub after: Option<String>,
    pub conversation: Option<String>,
    pub search: Option<String>,
}
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct ArtifactSummary {
    pub id: String,
    pub revision: String,
    pub heads: Vec<String>,
    pub conversation: String,
    pub title: String,
    pub summary: String,
    pub kind: ArtifactKind,
    pub stage: ArtifactStage,
    pub author: String,
    pub updated_at_ms: Option<u64>,
    pub revision_count: usize,
    pub file_count: usize,
    pub entrypoint: Option<String>,
    pub stale: bool,
    pub review_status: String,
    pub accepted: bool,
    pub highlighted: bool,
}
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct ArtifactPage {
    pub items: Vec<ArtifactSummary>,
    pub after: Option<String>,
    pub total: usize,
}
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct ArtifactRevisionSummary {
    pub id: String,
    pub author: String,
    pub created_at_ms: Option<u64>,
    pub title: String,
    pub parents: Vec<String>,
}
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct ArtifactReviewView {
    pub id: String,
    pub author: String,
    pub verdict: ReviewVerdict,
    pub summary: String,
    pub conditions: String,
    pub evidence: Vec<String>,
    pub checks: Vec<ReviewCheck>,
    pub self_review: bool,
    pub stale: bool,
}
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct ArtifactDecision {
    pub id: String,
    pub author: String,
    pub accepted: bool,
    pub reason: String,
    pub stale: bool,
}
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct ArtifactDetail {
    pub artifact: ArtifactSummary,
    pub revision: String,
    pub author: String,
    pub document: ArtifactDocument,
    pub parents: Vec<String>,
    pub stale: bool,
    pub history: Vec<ArtifactRevisionSummary>,
    pub reviews: Vec<ArtifactReviewView>,
    pub acceptance: Option<ArtifactDecision>,
    pub highlighted: bool,
    pub available_files: Vec<String>,
    pub may_publish: bool,
    pub may_review: bool,
    pub may_accept: bool,
    pub may_highlight: bool,
}

/// Byte transfer is scoped by the trusted host. No filesystem path crosses IPC.
#[derive(Debug, Deserialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ArtifactFileRef {
    pub revision: String,
    pub path: String,
}
#[derive(Debug, Deserialize, ts_rs::TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ArtifactTransfer {
    Begin {
        control: String,
        conversation: String,
        path: String,
        media_type: String,
        size: u64,
    },
    Chunk {
        upload: String,
        offset: u64,
        hex: String,
    },
    Cancel {
        upload: String,
    },
    Publish {
        control: String,
        conversation: String,
        artifact: Option<String>,
        parents: Vec<String>,
        document: ArtifactDocument,
        uploads: Vec<String>,
        retain: Vec<ArtifactFileRef>,
    },
    Read {
        revision: String,
        path: String,
        offset: u64,
    },
}
