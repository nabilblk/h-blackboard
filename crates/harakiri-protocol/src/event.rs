use crate::{Error, Result, codec, limits};
use coset::{CborSerializable, CoseSign1, CoseSign1Builder, HeaderBuilder, iana};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};

/// Key custody belongs to the host. Agents get scoped operations, never this key.
#[derive(Clone)]
pub struct Identity(pub(crate) SigningKey);

impl Identity {
    /// Host-only deterministic credential for a prepared contribution. The
    /// owner key remains in OS-protected custody; this separate identity cannot
    /// sign owner-control records. Never expose this method over an agent bridge.
    pub fn coordinator_identity(&self, mission: &str, contribution: &str) -> Result<Self> {
        if !is_hash(mission) || contribution.is_empty() || contribution.len() > 80 {
            return Err(Error::Invalid("contribution identity"));
        }
        let mut kdf =
            blake3::Hasher::new_derive_key("Harakiri Blackboard prepared Coordinator identity v1");
        kdf.update(&self.0.to_bytes());
        kdf.update(mission.as_bytes());
        kdf.update(contribution.as_bytes());
        Ok(Self::from_seed(*kdf.finalize().as_bytes()))
    }
    pub fn generate() -> Self {
        Self::from_seed(rand::random())
    }
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self(SigningKey::from_bytes(&seed))
    }
    pub fn public_key(&self) -> String {
        hex::encode(self.0.verifying_key().as_bytes())
    }

    pub fn sign(&self, body: EventBody) -> Result<Event> {
        if body.author != self.public_key() {
            return Err(Error::Signature);
        }
        body.validate()?;
        let protected = HeaderBuilder::new()
            .algorithm(iana::Algorithm::EdDSA)
            .key_id(self.0.verifying_key().as_bytes().to_vec())
            .build();
        let signed = CoseSign1Builder::new()
            .protected(protected)
            .payload(codec::encode(&body)?)
            .create_signature(limits::DOMAIN, |bytes| {
                self.0.sign(bytes).to_bytes().to_vec()
            })
            .build()
            .to_vec()
            .map_err(|_| Error::Encoding)?;
        Event::verify(&signed)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct MissionDefinition {
    pub name: String,
    pub objective: String,
    pub scope: String,
    pub criteria: Vec<String>,
    /// Absent only in G0 fixtures. Missing policy never grants execution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub policy: Option<crate::policy::MissionPolicy>,
}

impl MissionDefinition {
    pub fn validate(&self) -> Result<()> {
        if let Some(policy) = &self.policy {
            policy.validate()?;
        }
        if !bounded(&self.name, 1, 120)
            || !bounded(&self.objective, 1, 4096)
            || !bounded(&self.scope, 0, 8192)
            || self.criteria.len() > 32
            || self.criteria.iter().any(|s| !bounded(s, 1, 1024))
        {
            return Err(Error::Invalid("mission definition"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ArtifactFile {
    pub path: String,
    pub hash: String,
    pub size: u64,
    pub media_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Payload {
    MissionCreated {
        definition: MissionDefinition,
        endpoint: String,
        nonce: String,
    },
    MemberAdmitted {
        member: String,
        endpoint: String,
    },
    MemberRevoked {
        member: String,
        accepted: Option<String>,
    },
    AudienceCreated {
        readers: Vec<String>,
    },
    AudienceFrontier {
        member: String,
        revocation: String,
        accepted: Option<String>,
    },
    MessagePosted {
        text: String,
    },
    /// Explicit addressing is routing metadata, never an execution grant.
    MessageSent {
        text: String,
        to: Option<String>,
        thread: Option<String>,
    },
    /// A private conversation stays with this exact agent, across handovers.
    AgentConversationCreated {
        registration: String,
    },
    AgentAcknowledged {
        registration: String,
        control: String,
        direction: String,
    },
    GovernanceRecorded {
        control: String,
        action: crate::governance::GovernanceAction,
    },
    CoordinatorPlanArtifact {
        control: String,
        revision: String,
    },
    WorkRecorded {
        control: String,
        authorization: Option<String>,
        action: crate::work::WorkAction,
    },
    WorkstreamMessage {
        workstream: String,
        text: String,
        to: Option<String>,
        thread: Option<String>,
    },
    ArtifactPublished {
        title: String,
        files: Vec<ArtifactFile>,
    },
    ArtifactRecorded {
        control: String,
        authorization: Option<String>,
        conversation: String,
        action: crate::artifacts::ArtifactAction,
    },
    MissionControlled {
        previous: String,
        action: crate::lifecycle::ControlAction,
    },
    CoordinatorPlanned {
        control: String,
        text: String,
    },
    CoordinatorReadied {
        control: String,
        plan: String,
    },
    AgentOffered {
        control: String,
        identity: crate::agents::AgentIdentity,
    },
    AgentWithdrawn {
        registration: String,
    },
    AgentDirected {
        registration: String,
        control: String,
        text: String,
    },
}

impl Payload {
    pub fn owner_only(&self) -> bool {
        matches!(
            self,
            Self::MissionCreated { .. }
                | Self::MemberAdmitted { .. }
                | Self::MemberRevoked { .. }
                | Self::MissionControlled { .. }
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EventBody {
    pub version: u16,
    /// Genesis has no parent mission; its signed hash becomes the mission ID.
    pub mission: Option<String>,
    pub author: String,
    /// Main or a private audience's random identifier. Writer chains are separate.
    pub audience: String,
    pub sequence: u64,
    pub previous: Option<String>,
    /// Exact owner admission event, or genesis for the owner.
    pub authority: Option<String>,
    /// Display metadata only; never authority or a conflict-resolution clock.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at_ms: Option<u64>,
    pub payload: Payload,
}

fn bounded(value: &str, min: usize, max: usize) -> bool {
    value.len() >= min && value.len() <= max && !value.contains('\0')
}

pub fn is_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|x| x.is_ascii_digit() || (b'a'..=b'f').contains(&x))
}

pub fn is_audience(value: &str) -> bool {
    value == "main" || value.strip_prefix("private:").is_some_and(is_hash)
}

impl EventBody {
    pub fn validate(&self) -> Result<()> {
        if ![1, 2, 3, 4, 5, 6, 7, 8, limits::VERSION].contains(&self.version)
            || (self.version < 3
                && matches!(
                    self.payload,
                    Payload::MissionControlled { .. }
                        | Payload::CoordinatorPlanned { .. }
                        | Payload::CoordinatorReadied { .. }
                ))
            || !is_audience(&self.audience)
            || (self.version == 1
                && (self.audience != "main"
                    || matches!(
                        self.payload,
                        Payload::MemberRevoked { .. }
                            | Payload::AudienceCreated { .. }
                            | Payload::AudienceFrontier { .. }
                    )))
            || !is_hash(&self.author)
            || self.sequence > 9_007_199_254_740_991
            || self.mission.as_ref().is_some_and(|v| !is_hash(v))
            || self.previous.as_ref().is_some_and(|v| !is_hash(v))
            || self.authority.as_ref().is_some_and(|v| !is_hash(v))
            || self
                .created_at_ms
                .is_some_and(|v| v > 9_007_199_254_740_991)
        {
            return Err(Error::Invalid("header"));
        }
        if (self.sequence == 0) != self.previous.is_none() {
            return Err(Error::Invalid("writer chain"));
        }
        match &self.payload {
            Payload::MissionCreated {
                definition: d,
                endpoint,
                nonce,
            } => {
                d.validate()?;
                if self.mission.is_some()
                    || self.audience != "main"
                    || self.previous.is_some()
                    || self.authority.is_some()
                    || !is_hash(endpoint)
                    || !is_hash(nonce)
                    || !bounded(&d.name, 1, 120)
                    || !bounded(&d.objective, 1, 4096)
                    || !bounded(&d.scope, 0, 8192)
                    || d.criteria.len() > 32
                    || d.criteria.iter().any(|s| !bounded(s, 1, 1024))
                {
                    return Err(Error::Invalid("genesis"));
                }
            }
            payload => {
                if self.mission.is_none() || self.authority.is_none() {
                    return Err(Error::Invalid("missing mission or authority"));
                }
                match payload {
                    Payload::GovernanceRecorded { control, action }
                        if self.version >= 8 && self.audience == "main" && is_hash(control) =>
                    {
                        action.validate()?;
                        if self.version < 9
                            && matches!(
                                action,
                                crate::governance::GovernanceAction::Grant {
                                    purpose: crate::governance::GrantPurpose::Planning,
                                    ..
                                }
                            )
                        {
                            return Err(Error::Invalid("planning permission requires v9"));
                        }
                    }
                    Payload::CoordinatorPlanArtifact { control, revision }
                        if self.version >= 8
                            && self.audience == "main"
                            && is_hash(control)
                            && is_hash(revision) => {}
                    Payload::ArtifactRecorded {
                        control,
                        authorization,
                        conversation,
                        action,
                    } if self.version >= 7
                        && is_hash(control)
                        && authorization.as_deref().is_none_or(is_hash)
                        && crate::artifacts::conversation(conversation)
                        && (if conversation.starts_with("private:") {
                            conversation == &self.audience
                        } else {
                            self.audience == "main"
                        }) =>
                    {
                        action.validate()?;
                    }
                    Payload::WorkRecorded {
                        control,
                        action,
                        authorization,
                    } if authorization.as_deref().is_none_or(is_hash)
                        && self.version >= 6
                        && self.audience == "main"
                        && is_hash(control) =>
                    {
                        action.validate()?;
                        if self.version < 8
                            && matches!(action,crate::work::WorkAction::ReviseWorkstream{bases,..}|crate::work::WorkAction::ReviseTask{bases,..}|crate::work::WorkAction::ReportAttempt{bases,..} if bases.len()>32)
                        {
                            return Err(Error::Invalid("legacy work parents"));
                        }
                    }
                    Payload::WorkstreamMessage {
                        workstream,
                        text,
                        to,
                        thread,
                    } if self.version >= 6
                        && self.audience == "main"
                        && is_hash(workstream)
                        && bounded(text, 1, limits::MAX_MESSAGE_BYTES)
                        && !text.trim().is_empty()
                        && to.as_deref().is_none_or(is_hash)
                        && thread.as_deref().is_none_or(is_hash) => {}
                    Payload::MessageSent { text, to, thread }
                        if self.version >= 5
                            && bounded(text, 1, limits::MAX_MESSAGE_BYTES)
                            && !text.trim().is_empty()
                            && to.as_deref().is_none_or(is_hash)
                            && thread.as_deref().is_none_or(is_hash) => {}
                    Payload::AgentConversationCreated { registration }
                        if self.version >= 5
                            && self.audience != "main"
                            && self.sequence == 0
                            && is_hash(registration) => {}
                    Payload::AgentAcknowledged {
                        registration,
                        control,
                        direction,
                    } if self.version >= 5
                        && self.audience == "main"
                        && is_hash(registration)
                        && is_hash(control)
                        && is_hash(direction) => {}
                    Payload::MissionControlled { previous, action }
                        if self.version >= 3 && self.audience == "main" && is_hash(previous) =>
                    {
                        action.validate()?;
                        if self.version < 8
                            && matches!(
                                action,
                                crate::lifecycle::ControlAction::Handover { .. }
                                    | crate::lifecycle::ControlAction::SetPlanArtifact { .. }
                                    | crate::lifecycle::ControlAction::Close { .. }
                                    | crate::lifecycle::ControlAction::Archive { .. }
                                    | crate::lifecycle::ControlAction::Restore {}
                            )
                        {
                            return Err(Error::Invalid("legacy lifecycle action"));
                        }
                        if self.version < 4
                            && matches!(action, crate::lifecycle::ControlAction::Start { participants, .. } if !participants.is_empty())
                        {
                            return Err(Error::Invalid("legacy start participants"));
                        }
                    }
                    Payload::AgentOffered { control, identity }
                        if self.version >= 4 && self.audience == "main" && is_hash(control) =>
                    {
                        identity.validate()?;
                    }
                    Payload::AgentWithdrawn { registration }
                        if self.version >= 4
                            && self.audience == "main"
                            && is_hash(registration) => {}
                    Payload::AgentDirected {
                        registration,
                        control,
                        text,
                    } if self.version >= 4
                        && self.audience == "main"
                        && is_hash(registration)
                        && is_hash(control)
                        && bounded(text, 1, 2048)
                        && !text.trim().is_empty() => {}
                    Payload::CoordinatorPlanned { control, text }
                        if self.version >= 3
                            && self.audience == "main"
                            && is_hash(control)
                            && bounded(text, 1, limits::MAX_MESSAGE_BYTES) => {}
                    Payload::CoordinatorReadied { control, plan }
                        if self.version >= 3
                            && self.audience == "main"
                            && is_hash(control)
                            && is_hash(plan) => {}
                    Payload::MemberAdmitted { member, endpoint }
                        if self.audience == "main" && is_hash(member) && is_hash(endpoint) => {}
                    Payload::MemberRevoked { member, accepted }
                        if self.audience == "main"
                            && is_hash(member)
                            && accepted.as_ref().is_none_or(|s| is_hash(s)) => {}
                    Payload::AudienceCreated { readers }
                        if self.audience != "main"
                            && self.sequence == 0
                            && (2..=16).contains(&readers.len())
                            && readers.contains(&self.author)
                            && readers.iter().all(|s| is_hash(s))
                            && readers
                                .iter()
                                .collect::<std::collections::BTreeSet<_>>()
                                .len()
                                == readers.len() => {}
                    Payload::AudienceFrontier {
                        member,
                        revocation,
                        accepted,
                    } if self.audience != "main"
                        && is_hash(member)
                        && is_hash(revocation)
                        && accepted.as_ref().is_none_or(|s| is_hash(s)) => {}
                    Payload::MessagePosted { text }
                        if bounded(text, 1, limits::MAX_MESSAGE_BYTES) => {}
                    Payload::ArtifactPublished { title, files } => {
                        if !bounded(title, 1, 240)
                            || files.is_empty()
                            || files.len() > limits::MAX_FILES
                        {
                            return Err(Error::Invalid("artifact"));
                        }
                        let mut paths = std::collections::HashSet::new();
                        for file in files {
                            if !bounded(&file.path, 1, 240)
                                || file.path.contains('\\')
                                || file.path.split('/').any(|part| {
                                    part.is_empty()
                                        || part == "."
                                        || part == ".."
                                        || part.contains(':')
                                })
                                || !paths.insert(&file.path)
                                || !is_hash(&file.hash)
                                || file.size > limits::MAX_BLOB_BYTES
                                || !bounded(&file.media_type, 1, 100)
                            {
                                return Err(Error::Invalid("artifact file"));
                            }
                        }
                    }
                    _ => return Err(Error::Invalid("payload")),
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct Event {
    pub id: String,
    pub body: EventBody,
    bytes: Vec<u8>,
}

impl Event {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn mission_id(&self) -> &str {
        self.body.mission.as_deref().unwrap_or(&self.id)
    }

    pub fn verify(bytes: &[u8]) -> Result<Self> {
        codec::check(bytes)?;
        let signed = CoseSign1::from_slice(bytes).map_err(|_| Error::Encoding)?;
        let key_bytes: [u8; 32] = signed
            .protected
            .header
            .key_id
            .as_slice()
            .try_into()
            .map_err(|_| Error::Signature)?;
        let expected_header = HeaderBuilder::new()
            .algorithm(iana::Algorithm::EdDSA)
            .key_id(key_bytes.to_vec())
            .build();
        if signed.protected.header != expected_header || signed.unprotected != Default::default() {
            return Err(Error::Encoding);
        }
        codec::check(
            signed
                .protected
                .original_data
                .as_deref()
                .ok_or(Error::Encoding)?,
        )?;
        let key = VerifyingKey::from_bytes(&key_bytes).map_err(|_| Error::Signature)?;
        signed.verify_signature(limits::DOMAIN, |sig, data| {
            let sig = Signature::from_slice(sig).map_err(|_| Error::Signature)?;
            key.verify_strict(data, &sig).map_err(|_| Error::Signature)
        })?;
        let body: EventBody = codec::decode(signed.payload.as_deref().ok_or(Error::Encoding)?)?;
        if body.author != hex::encode(key_bytes) {
            return Err(Error::Signature);
        }
        body.validate()?;
        Ok(Self {
            id: blake3::hash(bytes).to_hex().to_string(),
            body,
            bytes: bytes.to_vec(),
        })
    }
}
