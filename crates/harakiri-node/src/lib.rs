//! Native node foundation; independent from the legacy web service.
pub mod ipc;
pub mod peer;
pub mod store;

pub mod admission;
pub mod agents;
pub mod communication;
pub mod contact;
pub mod discovery;
pub mod lifecycle;
pub mod network;
pub mod review;
pub mod scope;
pub mod withdrawal;

pub mod work;

mod artifact_io;
mod artifact_views;
pub mod artifacts;
mod work_views;

pub mod governance;
pub mod observations;
