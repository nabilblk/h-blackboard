//! Safety limits are protocol limits, independent of a mission's compute budget.
pub const VERSION: u16 = 10;
pub const MAX_AUDIENCES: usize = 1024;
pub const MAX_AGENTS: usize = 512;
pub const MAX_AGENT_RECORDS: usize = 4096;
pub const MAX_CONTROL_EVENTS: usize = 2048;
// A Coordinator cannot consume the owner’s entire control history allowance.
pub const MAX_COORDINATOR_EVENTS: usize = 1536;
pub const MAX_EVENT_BYTES: usize = 64 * 1024;
pub const MAX_BATCH_EVENTS: usize = 64;
pub const MAX_FRAME_BYTES: usize = 6 * 1024 * 1024;
pub const MAX_PENDING_EVENTS: usize = 256;
pub const MAX_HISTORY_EVENTS: usize = 100_000;
pub const MAX_CONNECTIONS: usize = 32;
pub const MAX_BLOB_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_FILES: usize = 32;
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024;
pub const MAX_NESTING: usize = 12;
pub const REQUEST_TIMEOUT_SECS: u64 = 10;
pub const DOMAIN: &[u8] = b"harakiri/event/1";

pub const MAX_WORK_RECORDS: usize = 8192;
pub const MAX_WORKSTREAMS: usize = 128;
pub const MAX_TASKS: usize = 512;
pub const MAX_WORK_OBJECT_BYTES: usize = 384 * 1024;
pub const MAX_TASK_ATTEMPTS: usize = 128;
