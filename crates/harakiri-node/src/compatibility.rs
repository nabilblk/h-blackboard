//! Stable, information-minimal version handshake. It confers no mission access.
use iroh::{
    endpoint::Connection,
    protocol::{AcceptError, ProtocolHandler},
};
use std::{sync::Arc, time::Duration};
use tokio::sync::Semaphore;

pub const ALPN: &[u8] = b"harakiri/compat/1";
#[derive(Debug, Clone)]
pub struct Compatibility {
    slots: Arc<Semaphore>,
}
impl Default for Compatibility {
    fn default() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(4)),
        }
    }
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hello {
    pub protocol: u16,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reply {
    pub protocol: u16,
    pub compatible: bool,
}
impl ProtocolHandler for Compatibility {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        let Ok(_permit) = self.slots.clone().try_acquire_owned() else {
            connection.close(1u32.into(), b"busy");
            return Ok(());
        };
        let result = tokio::time::timeout(Duration::from_secs(2), async {
            let (mut send, mut recv) = connection.accept_bi().await?;
            let bytes = recv.read_to_end(256).await?;
            let hello: Hello = serde_json::from_slice(&bytes)?;
            let protocol = harakiri_protocol::limits::VERSION;
            send.write_all(&serde_json::to_vec(&Reply {
                protocol,
                compatible: hello.protocol == protocol,
            })?)
            .await?;
            send.finish()?;
            let _ = send.stopped().await;
            Ok::<_, anyhow::Error>(())
        })
        .await;
        if !matches!(result, Ok(Ok(()))) {
            connection.close(1u32.into(), b"invalid handshake");
        }
        Ok(())
    }
}
