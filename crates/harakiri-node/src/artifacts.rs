//! Signed artifact records and authority checks. Files are immutable; a claim of
//! publication, verification or acceptance never implies execution permission.
use crate::store::Store;
use anyhow::{Result, anyhow, ensure};
use harakiri_protocol::{
    Event, Identity, Payload,
    agents::{AgentRole, AgentStatus},
    artifacts::*,
    lifecycle::{ControlAction, MissionPhase},
    policy::Coordination,
};
use rusqlite::params;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

pub type Records = BTreeMap<String, Event>;
pub fn is_record(p: &Payload) -> bool {
    matches!(
        p,
        Payload::ArtifactRecorded { .. } | Payload::ArtifactPublished { .. }
    )
}
pub fn revision(e: &Event) -> Option<(String, ArtifactDocument, Vec<String>)> {
    match &e.body.payload {
        Payload::ArtifactRecorded {
            action:
                ArtifactAction::Publish {
                    artifact,
                    parents,
                    document,
                },
            ..
        } => Some((
            artifact.clone().unwrap_or_else(|| e.id.clone()),
            document.clone(),
            parents.clone(),
        )),
        Payload::ArtifactPublished { title, files } => Some((
            e.id.clone(),
            ArtifactDocument {
                title: title.clone(),
                summary: title.clone(),
                kind: ArtifactKind::Document,
                stage: ArtifactStage::Draft,
                limitations: "Legacy publication: no input or review metadata.".into(),
                entrypoint: files.first().map(|f| f.path.clone()),
                inputs: vec![],
                files: files.clone(),
            },
            vec![],
        )),
        _ => None,
    }
}
pub fn conversation(e: &Event) -> &str {
    match &e.body.payload {
        Payload::ArtifactRecorded { conversation, .. } => conversation,
        _ => &e.body.audience,
    }
}
pub fn control(e: &Event) -> &str {
    match &e.body.payload {
        Payload::ArtifactRecorded { control, .. } => control,
        _ => e.mission_id(),
    }
}
pub fn heads<'a>(records: &'a Records, artifact: &str) -> Vec<&'a Event> {
    let revisions: Vec<_> = records
        .values()
        .filter_map(|e| {
            revision(e)
                .filter(|(id, _, _)| id == artifact)
                .map(|(_, _, p)| (e, p))
        })
        .collect();
    let parents: BTreeSet<_> = revisions.iter().flat_map(|(_, p)| p.iter()).collect();
    revisions
        .iter()
        .filter(|(e, _)| !parents.contains(&e.id))
        .map(|(e, _)| *e)
        .collect()
}
pub fn scope(conversation: &str) -> &str {
    if conversation.starts_with("private:") {
        conversation
    } else {
        "main"
    }
}

impl Store {
    pub(crate) fn artifact_records(&self, mission: &str) -> Result<Arc<Records>> {
        if let Some(c) = self.artifact_cache.borrow().get(mission) {
            return Ok(c.clone());
        }
        let mut q=self.connection.prepare("SELECT bytes FROM events JOIN artifact_records ON artifact_records.event=events.id WHERE mission=?1 LIMIT 8193")?;
        let rows = q
            .query_map([mission], |r| r.get::<_, Vec<u8>>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(rows.len() <= MAX_RECORDS, "artifact history limit");
        let mut records = Records::new();
        for bytes in rows {
            let e = Event::verify(&bytes)?;
            records.insert(e.id.clone(), e);
        }
        let records = Arc::new(records);
        let mut cache = self.artifact_cache.borrow_mut();
        if cache.len() >= 4
            && let Some(key) = cache.keys().next().cloned()
        {
            cache.remove(&key);
        }
        cache.insert(mission.into(), records.clone());
        Ok(records)
    }
    /// Local writes bind the actual current control/direction and reader. Staging
    /// uses the same gate so a withdrawn worker cannot keep consuming disk.
    pub fn artifact_write_context(
        &self,
        actor: &str,
        mission: &str,
        current: &str,
        channel: &str,
    ) -> Result<Option<String>> {
        let state = self.control_state(mission)?;
        ensure!(
            state.lifecycle.phase != MissionPhase::Archived,
            "archived mission is read only"
        );
        ensure!(
            state.lifecycle.revision == current
                && !self.conflicted_scope(mission, scope(channel))?,
            "mission changed; review before publishing"
        );
        ensure!(
            self.readable_by(mission, channel, actor)?
                && !self.locally_withdrawn(mission)?
                && !self.is_revoked(mission, actor)?,
            "artifact access unavailable"
        );
        if let Some(root) = self.audience_root(mission, scope(channel))?
            && let Payload::AgentConversationCreated { registration } = root.body.payload
        {
            self.communicative_agent(mission, &registration)?;
        }
        if let Some(reg) = self.agent_registration(mission, actor)? {
            let a = self.communicative_agent(mission, &reg)?;
            let co = state
                .lifecycle
                .coordinator
                .as_ref()
                .is_some_and(|c| c.identity.author == actor)
                && a.identity.role == AgentRole::Coordinator;
            ensure!(
                a.status == AgentStatus::DirectionAssigned
                    || (co && state.lifecycle.phase == MissionPhase::Preparing),
                "wait for Start and current direction"
            );
            return Ok(a.direction.map(|d| d.id));
        }
        Ok(None)
    }
    pub fn artifact_action(
        &mut self,
        identity: &Identity,
        mission: &str,
        current: &str,
        channel: &str,
        action: ArtifactAction,
    ) -> Result<Event> {
        let authorization =
            self.artifact_write_context(&identity.public_key(), mission, current, channel)?;
        action.validate()?;
        if let ArtifactAction::Publish {
            artifact: Some(id),
            parents,
            ..
        } = &action
        {
            let records = self.artifact_records(mission)?;
            let actual = heads(&records, id)
                .into_iter()
                .map(|e| e.id.clone())
                .collect::<BTreeSet<_>>();
            ensure!(
                !actual.is_empty() && parents.iter().cloned().collect::<BTreeSet<_>>() == actual,
                "artifact changed; review all current revisions before editing"
            );
        }
        self.append_to(
            identity,
            mission,
            scope(channel),
            Payload::ArtifactRecorded {
                control: current.into(),
                authorization,
                conversation: channel.into(),
                action,
            },
        )
    }
    pub(crate) fn validate_artifact(&self, e: &Event) -> Result<bool> {
        let Payload::ArtifactRecorded {
            control: current,
            authorization,
            conversation: channel,
            action,
        } = &e.body.payload
        else {
            return Ok(true);
        };
        let mission = e.mission_id();
        if self.event(current)?.is_none() {
            return Ok(false);
        }
        let history = self.control_history(mission)?;
        let state = history.at(current)?;
        ensure!(
            state.lifecycle.phase != MissionPhase::Archived,
            "archived mission is read only"
        );
        let owner = e.body.author == history.root.body.author;
        if let Some(stream) = channel.strip_prefix("workstream:") {
            let Some(w) = self.event(stream)? else {
                return Ok(false);
            };
            ensure!(
                w.mission_id() == mission
                    && matches!(
                        crate::work::action(&w),
                        Some((
                            _,
                            harakiri_protocol::work::WorkAction::CreateWorkstream { .. }
                        ))
                    ),
                "unknown workstream"
            );
        }
        let agent = self.agent_registration(mission, &e.body.author)?;
        let co = state
            .lifecycle
            .coordinator
            .as_ref()
            .is_some_and(|c| c.identity.author == e.body.author);
        if let Some(reg) = &agent {
            let offer = self.offer(mission, reg)?;
            let Payload::AgentOffered {
                control: reviewed,
                identity,
            } = &offer.body.payload
            else {
                unreachable!()
            };
            ensure!(
                history.at(reviewed)?.lifecycle.terms_revision == state.lifecycle.terms_revision,
                "agent terms changed"
            );
            ensure!(
                (identity.role == AgentRole::Coordinator) == co,
                "Coordinator appointment mismatch"
            );
            ensure!(
                state.lifecycle.phase == MissionPhase::Active
                    || (co && state.lifecycle.phase == MissionPhase::Preparing),
                "artifact work is paused or preparing"
            );
            if !co {
                let Some(id) = authorization else {
                    return Err(anyhow!("artifact requires direction"));
                };
                let Some(d) = self.event(id)? else {
                    return Ok(false);
                };
                ensure!(
                    d.mission_id() == mission && d.body.audience == "main",
                    "invalid artifact direction"
                );
                let valid = match &d.body.payload {
                    Payload::AgentDirected {
                        registration,
                        control,
                        ..
                    } => registration == reg && control == current,
                    Payload::MissionControlled {
                        action: ControlAction::Start { participants, .. },
                        ..
                    } => {
                        d.id == *current
                            && (participants.contains(reg)
                                || state
                                    .definition
                                    .policy
                                    .as_ref()
                                    .is_some_and(|p| p.coordination == Coordination::Peer))
                    }
                    Payload::WorkRecorded {
                        control,
                        action:
                            harakiri_protocol::work::WorkAction::AssignWorkstream {
                                registration, ..
                            },
                        ..
                    } => {
                        registration == reg
                            && history.at(control)?.lifecycle.terms_revision
                                == state.lifecycle.terms_revision
                    }
                    _ => false,
                };
                ensure!(valid, "artifact requires assigned direction");
            }
        }
        let private_human = e.body.audience != "main"
            && self
                .audience_root(mission, &e.body.audience)?
                .is_some_and(|r| r.body.author == e.body.author)
            && agent.is_none();
        let mut dependencies = Records::new();
        for id in action.references() {
            let Some(r) = self.event(id)? else {
                return Ok(false);
            };
            ensure!(
                r.mission_id() == mission
                    && (r.body.audience == "main" || r.body.audience == e.body.audience),
                "artifact reference crosses a private boundary"
            );
            ensure!(
                self.readable_by(mission, conversation(&r), &e.body.author)?,
                "artifact input unavailable"
            );
            if matches!(r.body.payload, Payload::ArtifactRecorded { .. }) {
                ensure!(
                    history.get(control(&r))?.body.sequence <= history.get(current)?.body.sequence,
                    "future artifact input"
                );
            }
            dependencies.insert(id.to_string(), r);
        }
        let records = self.artifact_records(mission)?;
        if let ArtifactAction::Review { revision, .. }
        | ArtifactAction::Accept { revision, .. }
        | ArtifactAction::Highlight { revision, .. } = action
        {
            let mut bytes = serde_json::to_vec(&e.body.payload)?.len();
            for record in records.values() {
                if matches!(&record.body.payload,Payload::ArtifactRecorded{action:ArtifactAction::Review{revision:id,..}|ArtifactAction::Accept{revision:id,..}|ArtifactAction::Highlight{revision:id,..},..} if id==revision)
                {
                    bytes += serde_json::to_vec(&record.body.payload)?.len();
                }
            }
            ensure!(
                bytes <= 512 * 1024,
                "revision review history capacity reached"
            );
        }
        ensure!(
            records.len() < MAX_RECORDS
                && records.values().map(|e| e.bytes().len()).sum::<usize>() + e.bytes().len()
                    <= 16 * 1024 * 1024,
            "artifact history capacity reached"
        );
        match action {
            ArtifactAction::Publish {
                artifact,
                parents,
                document,
            } => {
                let id = artifact.as_deref().unwrap_or(&e.id);
                if let Some(root) = artifact {
                    let source = &dependencies[root];
                    let Some((source_id, _, _)) = revision(source) else {
                        return Err(anyhow!("artifact root required"));
                    };
                    ensure!(
                        source_id == *root && conversation(source) == channel,
                        "artifact identity or conversation changed"
                    );
                    // Any authorized participant can improve shared work. All
                    // concurrent versions survive; local editors name all heads.
                    for parent in parents {
                        ensure!(
                            revision(&dependencies[parent]).is_some_and(|(r, _, _)| r == *root),
                            "parent belongs to another artifact"
                        );
                    }
                } else {
                    ensure!(
                        records
                            .values()
                            .filter(|e| revision(e).is_some_and(|(r, _, _)| r == e.id))
                            .count()
                            < MAX_ARTIFACTS,
                        "artifact count limit"
                    );
                }
                let prior: Vec<_> = records
                    .values()
                    .filter(|e| revision(e).is_some_and(|(r, _, _)| r == id))
                    .collect();
                ensure!(
                    prior.len() < MAX_REVISIONS
                        && prior.iter().map(|e| e.bytes().len()).sum::<usize>() + e.bytes().len()
                            <= 1024 * 1024,
                    "artifact revision history capacity reached"
                );
                for input in &document.inputs {
                    ensure!(
                        revision(&dependencies[input]).is_some_and(|(r, _, _)| r != id),
                        "inputs must reference exact revisions of another artifact"
                    );
                }
            }
            ArtifactAction::Review {
                revision: id,
                evidence,
                ..
            } => {
                let r = &dependencies[id];
                ensure!(
                    revision(r).is_some() && conversation(r) == channel,
                    "review revision or conversation mismatch"
                );
                for id in evidence {
                    let r = &dependencies[id];
                    ensure!(
                        revision(r).is_some()
                            || matches!(
                                r.body.payload,
                                Payload::MessagePosted { .. }
                                    | Payload::MessageSent { .. }
                                    | Payload::WorkstreamMessage { .. }
                            ),
                        "review evidence must be a message or artifact revision"
                    );
                }
            }
            ArtifactAction::Accept { revision: id, .. } => {
                ensure!(owner || private_human, "human acceptance required");
                ensure!(
                    revision(&dependencies[id]).is_some()
                        && conversation(&dependencies[id]) == channel,
                    "acceptance revision mismatch"
                );
            }
            ArtifactAction::Highlight { revision: id, .. } => {
                ensure!(
                    owner || co || private_human,
                    "owner or Coordinator highlight required"
                );
                ensure!(
                    revision(&dependencies[id]).is_some()
                        && conversation(&dependencies[id]) == channel,
                    "highlight revision mismatch"
                );
            }
        }
        Ok(true)
    }
    pub fn artifact_file(
        &self,
        mission: &str,
        viewer: &str,
        id: &str,
        path: &str,
    ) -> Result<harakiri_protocol::ArtifactFile> {
        let e = self
            .event(id)?
            .ok_or_else(|| anyhow!("artifact revision unavailable"))?;
        ensure!(
            e.mission_id() == mission && self.readable_by(mission, conversation(&e), viewer)?,
            "artifact unavailable"
        );
        let (_, doc, _) = revision(&e).ok_or_else(|| anyhow!("artifact revision required"))?;
        doc.files
            .into_iter()
            .find(|f| f.path == path)
            .ok_or_else(|| anyhow!("file not in revision"))
    }
    pub fn materialized(&self, id: &str, hash: &str) -> Result<bool> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM available_files WHERE event=?1 AND hash=?2)",
            params![id, hash],
            |r| r.get(0),
        )?)
    }
    pub fn mark_materialized(&mut self, id: &str, hash: &str) -> Result<()> {
        ensure!(
            self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM files WHERE event=?1 AND hash=?2)",
                params![id, hash],
                |r| r.get::<_, bool>(0)
            )?,
            "file not in manifest"
        );
        self.connection.execute(
            "INSERT OR IGNORE INTO available_files(event,hash) VALUES(?1,?2)",
            params![id, hash],
        )?;
        Ok(())
    }
}
