//! Versioned, signed records. Transport and execution have no place in this crate.
pub mod agents;
pub mod codec;
pub mod event;
pub mod lifecycle;
pub mod limits;
pub mod policy;

pub use event::{ArtifactFile, Event, EventBody, Identity, MissionDefinition, Payload};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("record exceeds the protocol limits")]
    Limit,
    #[error("invalid or unsupported record encoding")]
    Encoding,
    #[error("invalid record signature")]
    Signature,
    #[error("invalid record: {0}")]
    Invalid(&'static str),
}

pub type Result<T> = std::result::Result<T, Error>;

pub mod claims;

pub mod artifacts;
pub mod work;

pub mod governance;
