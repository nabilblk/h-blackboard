use crate::{
    artifacts::{Records, control, conversation, heads, revision},
    store::Store,
};
use anyhow::{Result, anyhow, ensure};
use harakiri_protocol::{Event, Payload, artifacts::*};
use std::collections::{BTreeMap, BTreeSet};

impl Store {
    pub(crate) fn artifact_evidence_stale(&self, mission: &str, id: &str) -> Result<bool> {
        let records = self.artifact_records(mission)?;
        let Some(e) = records.get(id) else {
            return Ok(false);
        };
        let Some((root, _, _)) = revision(e) else {
            return Ok(false);
        };
        let current = heads(&records, &root);
        Ok(current.len() != 1
            || current[0].id != id
            || self.artifact_stale(e, &records, &mut BTreeSet::new())?)
    }
    pub(crate) fn artifact_stale(
        &self,
        e: &Event,
        records: &Records,
        seen: &mut BTreeSet<String>,
    ) -> Result<bool> {
        if seen.len() >= 64 || !seen.insert(e.id.clone()) {
            return Ok(true);
        }
        let history = self.control_history(e.mission_id())?;
        if history.at(control(e))?.lifecycle.terms_revision
            != history.current()?.lifecycle.terms_revision
            || self.provisional(&e.id)?
        {
            return Ok(true);
        }
        if let Some(reg) = self.agent_registration(e.mission_id(), &e.body.author)? {
            let offer = self.offer(e.mission_id(), &reg)?;
            let records = self.agent_records(e.mission_id())?;
            let reviewed = match &offer.body.payload {
                Payload::AgentOffered { control, .. } => control,
                _ => return Ok(true),
            };
            if self.is_revoked(e.mission_id(),&offer.body.author)? || records.values().any(|r|matches!(&r.body.payload,Payload::AgentWithdrawn{registration} if registration==&reg)) || history.at(reviewed)?.lifecycle.terms_revision!=history.current()?.lifecycle.terms_revision {return Ok(true);}
        }
        if let Some((_, doc, _)) = revision(e) {
            for input in &doc.inputs {
                let Some(r) = records.get(input) else {
                    return Ok(true);
                };
                let Some((id, _, _)) = revision(r) else {
                    return Ok(true);
                };
                let h = heads(records, &id);
                if h.len() != 1 || h[0].id != *input || self.artifact_stale(r, records, seen)? {
                    return Ok(true);
                }
            }
        }
        seen.remove(&e.id);
        Ok(false)
    }
    fn artifact_review_views(
        &self,
        e: &Event,
        records: &Records,
    ) -> Result<Vec<ArtifactReviewView>> {
        let mut latest: BTreeMap<String, &Event> = BTreeMap::new();
        for r in records.values() {
            if let Payload::ArtifactRecorded {
                action: ArtifactAction::Review { revision, .. },
                ..
            } = &r.body.payload
                && revision == &e.id
                && latest
                    .get(&r.body.author)
                    .is_none_or(|p| p.body.sequence < r.body.sequence)
            {
                latest.insert(r.body.author.clone(), r);
            }
        }
        latest
            .values()
            .map(|r| {
                let Payload::ArtifactRecorded {
                    action:
                        ArtifactAction::Review {
                            verdict,
                            summary,
                            conditions,
                            evidence,
                            ..
                        },
                    ..
                } = &r.body.payload
                else {
                    unreachable!()
                };
                let mut stale = self.artifact_stale(e, records, &mut BTreeSet::new())?
                    || self.artifact_stale(r, records, &mut BTreeSet::new())?;
                for id in evidence {
                    if let Some(input) = records.get(id) {
                        stale |= self.artifact_stale(input, records, &mut BTreeSet::new())?;
                    } else {
                        stale |= self.provisional(id)?;
                    }
                }
                Ok(ArtifactReviewView {
                    id: r.id.clone(),
                    author: r.body.author.clone(),
                    verdict: verdict.clone(),
                    summary: summary.clone(),
                    conditions: conditions.clone(),
                    evidence: evidence.clone(),
                    self_review: r.body.author == e.body.author,
                    stale,
                })
            })
            .collect()
    }
    fn artifact_acceptance(
        &self,
        e: &Event,
        records: &Records,
    ) -> Result<Option<ArtifactDecision>> {
        let owner = self.owner(e.mission_id())?;
        let latest=records.values().filter(|r|matches!(&r.body.payload,Payload::ArtifactRecorded{action:ArtifactAction::Accept{revision,..},..} if revision==&e.id)).max_by_key(|r|(r.body.author==owner,r.body.sequence));
        latest
            .map(|r| {
                let Payload::ArtifactRecorded {
                    action:
                        ArtifactAction::Accept {
                            accepted, reason, ..
                        },
                    ..
                } = &r.body.payload
                else {
                    unreachable!()
                };
                Ok(ArtifactDecision {
                    id: r.id.clone(),
                    author: r.body.author.clone(),
                    accepted: *accepted,
                    reason: reason.clone(),
                    stale: self.artifact_stale(e, records, &mut BTreeSet::new())?
                        || self.artifact_stale(r, records, &mut BTreeSet::new())?,
                })
            })
            .transpose()
    }
    fn artifact_highlighted(&self, e: &Event, records: &Records) -> Result<bool> {
        let owner = self.owner(e.mission_id())?;
        let state = self.control_state(e.mission_id())?;
        let highlights=records.values().filter(|r|matches!(&r.body.payload,Payload::ArtifactRecorded{action:ArtifactAction::Highlight{revision:id,..},..} if id==&e.id));
        let mut eligible = Vec::new();
        for r in highlights {
            if r.body.author == owner
                || (r.body.audience != "main"
                    && self
                        .agent_registration(e.mission_id(), &r.body.author)?
                        .is_none())
                || state.lifecycle.coordinator.as_ref().is_some_and(|c| {
                    c.identity.author == r.body.author
                        && self
                            .control_history(e.mission_id())
                            .ok()
                            .and_then(|h| {
                                h.at(control(r))
                                    .ok()
                                    .and_then(|s| s.lifecycle.coordinator.clone())
                            })
                            .is_some_and(|past| past.appointment == c.appointment)
                })
            {
                eligible.push(r);
            }
        }
        Ok(eligible
            .into_iter()
            .max_by_key(|r| (r.body.author == owner, r.body.sequence))
            .is_some_and(|r| {
                matches!(
                    r.body.payload,
                    Payload::ArtifactRecorded {
                        action: ArtifactAction::Highlight {
                            highlighted: true,
                            ..
                        },
                        ..
                    }
                )
            }))
    }
    fn artifact_summary(&self, root: &str, records: &Records) -> Result<ArtifactSummary> {
        let heads = heads(records, root);
        let e = heads
            .first()
            .ok_or_else(|| anyhow!("artifact unavailable"))?;
        let (_, doc, _) = revision(e).ok_or_else(|| anyhow!("artifact revision unavailable"))?;
        let reviews = self.artifact_review_views(e, records)?;
        let acceptance = self.artifact_acceptance(e, records)?;
        let stale = self.artifact_stale(e, records, &mut BTreeSet::new())?;
        let highlighted = self.artifact_highlighted(e, records)?;
        let review_status = if heads.len() > 1 {
            "conflict"
        } else if stale {
            "needs_review"
        } else if reviews
            .iter()
            .any(|r| !r.stale && r.verdict == ReviewVerdict::ChangesRequested)
        {
            "changes_requested"
        } else if reviews
            .iter()
            .any(|r| !r.stale && !r.self_review && r.verdict == ReviewVerdict::Verified)
        {
            "reviewed"
        } else if reviews
            .iter()
            .any(|r| !r.stale && r.verdict == ReviewVerdict::Verified)
        {
            "self_reviewed"
        } else {
            "unreviewed"
        };
        Ok(ArtifactSummary {
            id: root.into(),
            revision: e.id.clone(),
            heads: heads.iter().map(|e| e.id.clone()).collect(),
            conversation: conversation(e).into(),
            title: doc.title,
            summary: doc.summary,
            kind: doc.kind,
            stage: doc.stage,
            author: e.body.author.clone(),
            updated_at_ms: e.body.created_at_ms,
            revision_count: records
                .values()
                .filter(|e| revision(e).is_some_and(|(r, _, _)| r == root))
                .count(),
            file_count: doc.files.len(),
            entrypoint: doc.entrypoint,
            stale,
            review_status: review_status.into(),
            accepted: heads.len() == 1 && acceptance.is_some_and(|a| a.accepted && !a.stale),
            highlighted,
        })
    }
    pub fn artifacts(
        &self,
        mission: &str,
        viewer: &str,
        query: ArtifactQuery,
    ) -> Result<ArtifactPage> {
        ensure!(
            self.readable_by(mission, "main", viewer)?,
            "mission unavailable"
        );
        ensure!(
            query
                .after
                .as_deref()
                .is_none_or(harakiri_protocol::event::is_hash)
                && query.search.as_ref().is_none_or(|q| q.len() <= 512),
            "invalid artifact filter"
        );
        if let Some(channel) = &query.conversation {
            ensure!(
                self.readable_by(mission, channel, viewer)?,
                "conversation unavailable"
            );
        }
        let records = self.artifact_records(mission)?;
        let search = query.search.unwrap_or_default().to_lowercase();
        let mut roots = BTreeSet::new();
        for e in records.values() {
            if let Some((id, doc, _)) = revision(e)
                && self.readable_by(mission, conversation(e), viewer)?
                && query
                    .conversation
                    .as_ref()
                    .is_none_or(|c| c == conversation(e))
                && (search.is_empty()
                    || format!("{} {}", doc.title, doc.summary)
                        .to_lowercase()
                        .contains(&search))
            {
                roots.insert(id);
            }
        }
        let total = roots.len();
        let mut items = Vec::new();
        let mut bytes = 0;
        let mut after = None;
        for root in roots
            .into_iter()
            .filter(|r| query.after.as_ref().is_none_or(|a| r > a))
        {
            let item = self.artifact_summary(&root, &records)?;
            let size = serde_json::to_vec(&item)?.len();
            if items.len() >= 32 || bytes + size > 768 * 1024 {
                after = items.last().map(|i: &ArtifactSummary| i.id.clone());
                break;
            }
            bytes += size;
            items.push(item);
        }
        Ok(ArtifactPage {
            items,
            after,
            total,
        })
    }
    pub fn artifact_detail(&self, mission: &str, viewer: &str, id: &str) -> Result<ArtifactDetail> {
        let records = self.artifact_records(mission)?;
        let e = records
            .get(id)
            .ok_or_else(|| anyhow!("artifact revision unavailable"))?;
        ensure!(
            self.readable_by(mission, conversation(e), viewer)?,
            "artifact unavailable"
        );
        let (root, document, parents) =
            revision(e).ok_or_else(|| anyhow!("artifact revision required"))?;
        let artifact = self.artifact_summary(&root, &records)?;
        let mut history = Vec::new();
        for e in records.values() {
            if let Some((r, doc, parents)) = revision(e)
                && r == root
            {
                history.push(ArtifactRevisionSummary {
                    id: e.id.clone(),
                    author: e.body.author.clone(),
                    created_at_ms: e.body.created_at_ms,
                    title: doc.title,
                    parents,
                });
            }
        }
        history.sort_by(|a, b| a.id.cmp(&b.id));
        let state = self.control_state(mission)?;
        let writable = self
            .artifact_write_context(viewer, mission, &state.lifecycle.revision, conversation(e))
            .is_ok();
        let owner = self.owner(mission)? == viewer;
        let human_private = e.body.audience != "main"
            && self
                .audience_root(mission, &e.body.audience)?
                .is_some_and(|r| r.body.author == viewer)
            && self.agent_registration(mission, viewer)?.is_none();
        let coordinator = state
            .lifecycle
            .coordinator
            .as_ref()
            .is_some_and(|c| c.identity.author == viewer);
        let mut available_files = Vec::new();
        for f in &document.files {
            if self.materialized(id, &f.hash)? {
                available_files.push(f.path.clone());
            }
        }
        Ok(ArtifactDetail {
            artifact,
            revision: id.into(),
            author: e.body.author.clone(),
            document,
            parents,
            stale: self.artifact_stale(e, &records, &mut BTreeSet::new())?,
            history,
            reviews: self.artifact_review_views(e, &records)?,
            acceptance: self.artifact_acceptance(e, &records)?,
            highlighted: self.artifact_highlighted(e, &records)?,
            available_files,
            may_publish: writable,
            may_review: writable,
            may_accept: writable && (owner || human_private),
            may_highlight: writable && (owner || coordinator || human_private),
        })
    }
}
