//! Bounded, expiring byte transfers. Opaque upload handles bind to an actor,
//! mission and reviewed conversation. Renderer and agent input never name paths
//! on the host. Only verified/materialized manifests grant blob serve rights.
use crate::{
    artifacts,
    network::Network,
    peer::{SharedStore, with_store},
};
use anyhow::{Result, anyhow, ensure};
use harakiri_protocol::{ArtifactFile, Identity, artifacts::*, limits};
use iroh_blobs::{Hash, store::fs::FsStore};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

struct Upload {
    actor: String,
    mission: String,
    control: String,
    conversation: String,
    file: ArtifactFile,
    bytes: Vec<u8>,
    created: Instant,
}
pub struct ArtifactIo {
    root: PathBuf,
    uploads: BTreeMap<String, Upload>,
    downloads: BTreeMap<String, (Instant, Vec<u8>)>,
}
impl ArtifactIo {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            uploads: BTreeMap::new(),
            downloads: BTreeMap::new(),
        }
    }
    pub async fn transfer(
        &mut self,
        network: &Network,
        store: &SharedStore,
        identity: &Identity,
        mission: &str,
        input: ArtifactTransfer,
    ) -> Result<Value> {
        self.uploads
            .retain(|_, u| u.created.elapsed() < Duration::from_secs(600));
        self.downloads
            .retain(|_, (t, _)| t.elapsed() < Duration::from_secs(60));
        let actor = identity.public_key();
        match input {
            ArtifactTransfer::Begin {
                control,
                conversation,
                path,
                media_type,
                size,
            } => {
                with_store(store, |s| {
                    s.artifact_write_context(&actor, mission, &control, &conversation)
                })?;
                let file = ArtifactFile {
                    path,
                    media_type,
                    size,
                    hash: "0".repeat(64),
                };
                ensure!(valid_file(&file), "invalid file metadata");
                ensure!(
                    self.uploads.len() < 64
                        && self.uploads.values().filter(|u| u.actor == actor).count() < 32
                        && self.uploads.values().map(|u| u.file.size).sum::<u64>() + size
                            <= MAX_UPLOAD_BYTES as u64,
                    "upload capacity reached; cancel unused uploads"
                );
                let id = hex::encode(rand::random::<[u8; 32]>());
                self.uploads.insert(
                    id.clone(),
                    Upload {
                        actor,
                        mission: mission.into(),
                        control,
                        conversation,
                        file,
                        bytes: Vec::new(),
                        created: Instant::now(),
                    },
                );
                Ok(json!({"upload":id}))
            }
            ArtifactTransfer::Chunk {
                upload,
                offset,
                hex: encoded,
            } => {
                ensure!(
                    encoded.len() <= 96 * 1024 && encoded.len().is_multiple_of(2),
                    "chunk too large"
                );
                let u = self
                    .uploads
                    .get_mut(&upload)
                    .ok_or_else(|| anyhow!("upload expired"))?;
                ensure!(
                    u.actor == actor && u.mission == mission,
                    "upload unavailable"
                );
                with_store(store, |s| {
                    s.artifact_write_context(&actor, mission, &u.control, &u.conversation)
                })?;
                let bytes = hex::decode(encoded)?;
                ensure!(
                    offset == u.bytes.len() as u64 && offset + bytes.len() as u64 <= u.file.size,
                    "upload offset or size mismatch"
                );
                u.bytes.extend_from_slice(&bytes);
                Ok(json!({"offset":u.bytes.len(),"complete":u.bytes.len() as u64==u.file.size}))
            }
            ArtifactTransfer::Cancel { upload } => {
                if let Some(u) = self.uploads.get(&upload) {
                    ensure!(
                        u.actor == actor && u.mission == mission,
                        "upload unavailable"
                    );
                    self.uploads.remove(&upload);
                }
                Ok(Value::Null)
            }
            ArtifactTransfer::Publish {
                control,
                conversation,
                artifact,
                parents,
                mut document,
                uploads,
                retain,
            } => {
                ensure!(
                    document.files.is_empty(),
                    "file manifests are supplied by verified transfers"
                );
                ensure!(
                    ids(&uploads, 32) && uploads.len() + retain.len() <= limits::MAX_FILES,
                    "file limit"
                );
                with_store(store, |s| {
                    s.artifact_write_context(&actor, mission, &control, &conversation)
                })?;
                let mut files = Vec::new();
                let mut data = Vec::new();
                let mut total = 0usize;
                for id in &uploads {
                    let u = self
                        .uploads
                        .get(id)
                        .ok_or_else(|| anyhow!("upload expired"))?;
                    ensure!(
                        u.actor == actor
                            && u.mission == mission
                            && u.control == control
                            && u.conversation == conversation
                            && u.bytes.len() as u64 == u.file.size,
                        "upload is incomplete or belongs to different instructions"
                    );
                    let mut file = u.file.clone();
                    file.hash = blake3::hash(&u.bytes).to_hex().to_string();
                    total += u.bytes.len();
                    files.push(file);
                    data.push(u.bytes.clone());
                }
                for r in retain {
                    let file = with_store(store, |s| {
                        s.artifact_file(mission, &actor, &r.revision, &r.path)
                    })?;
                    total += file.size as usize;
                    ensure!(total <= MAX_UPLOAD_BYTES, "artifact size limit");
                    let bytes = self
                        .read(network, store, &actor, mission, &r.revision, &file)
                        .await?;
                    files.push(file);
                    data.push(bytes);
                }
                document.files = files;
                document.validate()?;
                for bytes in &data {
                    self.put(network, bytes).await?;
                }
                // Recheck current authority after transfers, before signing.
                let e = with_store(store, |s| {
                    let e = s.artifact_action(
                        identity,
                        mission,
                        &control,
                        &conversation,
                        ArtifactAction::Publish {
                            artifact,
                            parents,
                            document: document.clone(),
                        },
                    )?;
                    for f in &document.files {
                        s.mark_materialized(&e.id, &f.hash)?;
                    }
                    Ok(e)
                })?;
                for id in uploads {
                    self.uploads.remove(&id);
                }
                Ok(json!({"event":e.id}))
            }
            ArtifactTransfer::Read {
                revision,
                path,
                offset,
            } => {
                let file = with_store(store, |s| {
                    s.artifact_file(mission, &actor, &revision, &path)
                })?;
                ensure!(offset <= file.size, "invalid file offset");
                let bytes = self
                    .read(network, store, &actor, mission, &revision, &file)
                    .await?;
                let start = usize::try_from(offset)?;
                let end = (start + 48 * 1024).min(bytes.len());
                Ok(
                    json!({"hex":hex::encode(&bytes[start..end]),"offset":end,"complete":end==bytes.len(),"size":bytes.len(),"hash":file.hash,"media_type":file.media_type}),
                )
            }
        }
    }
    async fn put(&self, network: &Network, bytes: &[u8]) -> Result<()> {
        let (blobs, owned) = match &network.peer {
            Some(p) => (p.blobs.clone(), false),
            None => (FsStore::load(self.root.join("blobs")).await?, true),
        };
        let result = async {
            let tag = blobs.add_slice(bytes).await?;
            blobs
                .tags()
                .set(format!("artifact-{}", tag.hash), tag.hash)
                .await?;
            blobs.sync_db().await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if owned {
            blobs.shutdown().await?;
        }
        result
    }
    async fn read(
        &mut self,
        network: &Network,
        store: &SharedStore,
        actor: &str,
        mission: &str,
        id: &str,
        file: &ArtifactFile,
    ) -> Result<Vec<u8>> {
        let key = format!("{actor}:{mission}:{id}:{}", file.path);
        if let Some((_, bytes)) = self.downloads.get(&key) {
            return Ok(bytes.clone());
        }
        let available = with_store(store, |s| s.materialized(id, &file.hash))?;
        let hash = Hash::from_bytes(
            hex::decode(&file.hash)?
                .try_into()
                .map_err(|_| anyhow!("invalid hash"))?,
        );
        let mut bytes = None;
        if available {
            let (blobs, owned) = match &network.peer {
                Some(p) => (p.blobs.clone(), false),
                None => (FsStore::load(self.root.join("blobs")).await?, true),
            };
            bytes = blobs.get_bytes(hash).await.ok().map(|b| b.to_vec());
            if owned {
                blobs.shutdown().await?;
            }
        }
        if bytes.is_none() {
            let peer = network.active().map_err(|_| {
                anyhow!("File is not saved on this device. Enable networking to retrieve it.")
            })?;
            with_store(store, |s| {
                ensure!(
                    s.can_read_scope(
                        mission,
                        artifacts::scope(
                            &s.event(id)?
                                .ok_or_else(|| anyhow!("revision unavailable"))?
                                .body
                                .audience
                        ),
                        &peer.endpoint.id().to_string()
                    )?,
                    "file download unavailable"
                );
                Ok(())
            })?;
            let contacts = with_store(store, |s| s.contacts(mission))?;
            let result = tokio::time::timeout(Duration::from_secs(8), async {
                for signed in contacts.iter().take(16) {
                    let Ok((_, contact)) = crate::contact::Contact::verify(signed) else {
                        continue;
                    };
                    if contact.endpoint == peer.endpoint.id().to_string() {
                        continue;
                    }
                    let Ok(addr) = contact.address(network.config()) else {
                        continue;
                    };
                    if let Ok(Ok(b)) = tokio::time::timeout(
                        Duration::from_secs(2),
                        peer.fetch_file_as(addr, actor, id, file),
                    )
                    .await
                    {
                        return Some(b);
                    }
                }
                None
            })
            .await
            .ok()
            .flatten();
            bytes = result;
        }
        let bytes=bytes.ok_or_else(||anyhow!("File unavailable from connected peers. Its signed revision is preserved; retry when a holder reconnects."))?;
        ensure!(
            bytes.len() as u64 == file.size && blake3::hash(&bytes).to_hex().as_str() == file.hash,
            "file integrity failure"
        );
        let retained: usize = self.downloads.values().map(|(_, b)| b.len()).sum();
        if retained + bytes.len() > MAX_UPLOAD_BYTES || self.downloads.len() >= 16 {
            self.downloads.clear();
        }
        self.downloads.insert(key, (Instant::now(), bytes.clone()));
        Ok(bytes)
    }
}
