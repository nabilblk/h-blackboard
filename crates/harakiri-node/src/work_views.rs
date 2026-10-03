//! Read projections retain concurrent revisions and independent attempts.
use crate::{
    store::Store,
    work::{action, channel, heads, stream_revision, task_revision},
};
use anyhow::{Result, anyhow, bail, ensure};
use harakiri_protocol::{Event, Payload, agents::AgentStatus, policy::Coordination, work::*};
use std::collections::BTreeMap;
type AssignmentRank = (bool, bool, u64, u64, String);
impl Store {
    fn work_author_unavailable(&self, mission: &str, author: &str) -> Result<bool> {
        if let Some(reg) = self.agent_registration(mission, author)? {
            let offer = self.offer(mission, &reg)?;
            return Ok(self.is_revoked(mission,&offer.body.author)? || self.agent_records(mission)?.values().any(|e|matches!(&e.body.payload,Payload::AgentWithdrawn{registration} if registration==&reg)));
        }
        self.is_revoked(mission, author)
    }
    pub fn workstreams(&self, mission: &str, viewer: &str) -> Result<Vec<WorkstreamView>> {
        ensure!(
            self.readable_by(mission, "main", viewer)?,
            "mission unavailable"
        );
        let records = self.work_records(mission)?;
        let current = self.control_state(mission)?;
        let history = self.control_history(mission)?;
        let mut items = Vec::new();
        for root in records
            .values()
            .filter(|e| matches!(action(e), Some((_, WorkAction::CreateWorkstream { .. }))))
        {
            let revisions = heads(
                records
                    .values()
                    .filter(|e| stream_revision(e, &root.id).is_some()),
            );
            let stale = revisions.iter().any(|e| {
                history
                    .at(action(e).expect("filtered work record").0)
                    .map_or(true, |p| {
                        p.lifecycle.terms_revision != current.lifecycle.terms_revision
                    })
            }) || self.conflicted(mission)?;
            let versions: Vec<_> = revisions
                .iter()
                .filter_map(|e| stream_revision(e, &root.id))
                .collect();
            let first = &versions[0];
            let unread = self.connection.query_row("SELECT count(*) FROM message_details d JOIN events e ON e.id=d.event WHERE e.mission=?1 AND d.channel=?2 AND d.kind='message' AND e.author<>?3 AND e.fork=0 AND NOT EXISTS(SELECT 1 FROM message_reads r WHERE r.event=e.id AND r.reader=?3)", rusqlite::params![mission, format!("workstream:{}",root.id),viewer], |r| r.get(0))?;
            items.push(WorkstreamView {
                id: root.id.clone(),
                name: first.name.clone(),
                goal: first.goal.clone(),
                heads: versions,
                stale,
                unread,
            });
        }
        Ok(items)
    }
    /// Called from the roster projection, so this must not call agent_views.
    pub(crate) fn work_assignments(
        &self,
        mission: &str,
    ) -> Result<BTreeMap<String, WorkstreamAssignmentView>> {
        let records = self.work_records(mission)?;
        let history = self.control_history(mission)?;
        let current = history.current()?;
        let owner = &history.root.body.author;
        let agents = self.agent_records(mission)?;
        let mut chosen: BTreeMap<String, (&Event, AssignmentRank)> = BTreeMap::new();
        for e in records.values() {
            let Some((control, WorkAction::AssignWorkstream { registration, .. })) = action(e)
            else {
                continue;
            };
            let p = history.at(control)?;
            if p.lifecycle.terms_revision != current.lifecycle.terms_revision
                || self.provisional(&e.id)?
            {
                continue;
            }
            let co = current.lifecycle.coordinator.as_ref().is_some_and(|c| {
                c.identity.author == e.body.author
                    && p.lifecycle
                        .coordinator
                        .as_ref()
                        .is_some_and(|old| old.appointment == c.appointment)
            });
            if e.body.author != *owner
                && !co
                && current
                    .definition
                    .policy
                    .as_ref()
                    .is_none_or(|p| p.coordination != Coordination::Peer)
            {
                continue;
            }
            if let Some(reg) = self.agent_registration(mission, &e.body.author)? {
                let offer = self.offer(mission, &reg)?;
                if self.is_revoked(mission,&offer.body.author)? || agents.values().any(|r| matches!(&r.body.payload,Payload::AgentWithdrawn{registration} if registration==&reg)) { continue; }
            }
            let rank = (
                e.body.author == *owner,
                co,
                history.get(control)?.body.sequence,
                e.body.sequence,
                e.id.clone(),
            );
            if chosen.get(registration).is_none_or(|(_, old)| rank > *old) {
                chosen.insert(registration.clone(), (e, rank));
            }
        }
        let mut views = BTreeMap::new();
        for (registration, (e, _)) in chosen {
            let (
                _,
                WorkAction::AssignWorkstream {
                    workstream,
                    goal_revision,
                    direction,
                    ..
                },
            ) = action(e).expect("filtered work record")
            else {
                unreachable!()
            };
            let (name, stale) = if let Some(id) = workstream {
                let revisions = heads(
                    records
                        .values()
                        .filter(|r| stream_revision(r, id).is_some()),
                );
                let valid = revisions.len() == 1
                    && goal_revision.as_ref() == Some(&revisions[0].id)
                    && history
                        .at(action(revisions[0])
                            .expect("filtered workstream revision")
                            .0)?
                        .lifecycle
                        .terms_revision
                        == current.lifecycle.terms_revision;
                (
                    revisions
                        .first()
                        .and_then(|r| stream_revision(r, id))
                        .map_or_else(|| "Workstream".into(), |r| r.name),
                    !valid,
                )
            } else {
                ("Main".into(), false)
            };
            views.insert(
                registration,
                WorkstreamAssignmentView {
                    id: e.id.clone(),
                    author: e.body.author.clone(),
                    workstream: workstream.clone(),
                    goal_revision: goal_revision.clone(),
                    name,
                    direction: direction.clone(),
                    stale,
                },
            );
        }
        Ok(views)
    }
    pub fn work_evidence(&self, mission: &str, viewer: &str, id: &str) -> Result<WorkEvidence> {
        ensure!(
            self.readable_by(mission, "main", viewer)?,
            "evidence unavailable"
        );
        let e = self
            .event(id)?
            .ok_or_else(|| anyhow!("evidence unavailable"))?;
        ensure!(
            e.mission_id() == mission && e.body.audience == "main",
            "evidence unavailable"
        );
        let (title, text, files) = match &e.body.payload {
            Payload::MessageSent { text, .. }
            | Payload::MessagePosted { text }
            | Payload::WorkstreamMessage { text, .. } => {
                ("Message evidence".into(), Some(text.clone()), vec![])
            }
            Payload::ArtifactPublished { title, files } => (title.clone(), None, files.clone()),
            Payload::ArtifactRecorded {
                action: harakiri_protocol::artifacts::ArtifactAction::Publish { document, .. },
                ..
            } => (
                document.title.clone(),
                Some(document.summary.clone()),
                document.files.clone(),
            ),
            _ => bail!("evidence unavailable"),
        };
        Ok(WorkEvidence {
            id: e.id.clone(),
            title,
            conversation: channel(&e),
            text,
            files,
        })
    }
    pub fn tasks(&self, mission: &str, viewer: &str, query: TaskQuery) -> Result<TaskPage> {
        ensure!(
            self.readable_by(mission, "main", viewer)?,
            "mission unavailable"
        );
        for id in [&query.after, &query.task] {
            ensure!(
                id.as_deref().is_none_or(harakiri_protocol::event::is_hash),
                "invalid task cursor"
            );
        }
        ensure!(
            query.search.as_ref().is_none_or(|s| s.len() <= 512)
                && query.owner.as_ref().is_none_or(|s| s.len() <= 120),
            "task filter too long"
        );
        ensure!(
            query
                .workstream
                .as_deref()
                .is_none_or(|s| s == "main" || harakiri_protocol::event::is_hash(s)),
            "invalid workstream filter"
        );
        ensure!(
            query.status.as_deref().is_none_or(|s| matches!(
                s,
                "planned"
                    | "in_progress"
                    | "blocked"
                    | "paused"
                    | "submitted"
                    | "complete"
                    | "cancelled"
                    | "conflict"
            )),
            "invalid task status"
        );
        let records = self.work_records(mission)?;
        let history = self.control_history(mission)?;
        let current = self.control_state(mission)?;
        let agents = self.agent_views(mission)?;
        let mut result = Vec::new();
        for root in records
            .values()
            .filter(|e| matches!(action(e), Some((_, WorkAction::CreateTask { .. }))))
        {
            if query.task.as_ref().is_some_and(|id| id != &root.id) {
                continue;
            }
            let revision_events = heads(
                records
                    .values()
                    .filter(|e| task_revision(e, &root.id).is_some()),
            );
            let versions: Vec<_> = revision_events
                .iter()
                .filter_map(|e| task_revision(e, &root.id))
                .collect();
            let definition = versions[0].definition.clone();
            if query
                .workstream
                .as_ref()
                .is_some_and(|w| definition.workstream.as_deref().unwrap_or("main") != w)
            {
                continue;
            }
            let stale = self.conflicted(mission)?
                || revision_events.iter().any(|e| {
                    history
                        .at(action(e).expect("filtered work record").0)
                        .map_or(true, |s| {
                            s.lifecycle.terms_revision != current.lifecycle.terms_revision
                        })
                });
            let mut attempts = Vec::new();
            for allocation in records.values() {
                let Some((_, a)) = action(allocation) else {
                    continue;
                };
                let (registrations, approach) = match a {
                    WorkAction::CreateTask { assignees, .. } if allocation.id == root.id => (
                        assignees.clone(),
                        "Follow the task’s completion criteria.".to_string(),
                    ),
                    WorkAction::AssignTask {
                        task,
                        registration,
                        approach,
                    } if task == &root.id => (vec![registration.clone()], approach.clone()),
                    _ => continue,
                };
                for registration in registrations {
                    let report_events=heads(records.values().filter(|e|matches!(action(e),Some((_,WorkAction::ReportAttempt{allocation:a,registration:r,..})) if a==&allocation.id && r==&registration)));
                    let mut reports = Vec::new();
                    for e in report_events {
                        let (
                            control,
                            WorkAction::ReportAttempt {
                                task_revision,
                                status,
                                summary,
                                evidence,
                                ..
                            },
                        ) = action(e).expect("filtered work record")
                        else {
                            unreachable!()
                        };
                        let mut evidence_stale = false;
                        for id in evidence {
                            evidence_stale |= self.artifact_evidence_stale(mission, id)?;
                        }
                        let stale = stale
                            || evidence_stale
                            || versions.len() != 1
                            || versions[0].id != *task_revision
                            || history.at(control)?.lifecycle.terms_revision
                                != current.lifecycle.terms_revision
                            || self.provisional(&e.id)?
                            || self.work_author_unavailable(mission, &e.body.author)?;
                        reports.push(AttemptReport {
                            id: e.id.clone(),
                            author: e.body.author.clone(),
                            status: status.clone(),
                            summary: summary.clone(),
                            evidence: evidence.clone(),
                            stale,
                        });
                    }
                    let status = if reports.len() > 1 {
                        "conflict".into()
                    } else if let Some(r) = reports.first() {
                        r.status.as_str().to_string()
                    } else {
                        "planned".into()
                    };
                    let unavailable =
                        agents
                            .iter()
                            .find(|a| a.id == registration)
                            .is_none_or(|a| {
                                matches!(
                                    a.status,
                                    AgentStatus::Withdrawn
                                        | AgentStatus::Revoked
                                        | AgentStatus::ReviewRequired
                                        | AgentStatus::Conflict
                                )
                            });
                    attempts.push(AttemptView {
                        allocation: allocation.id.clone(),
                        registration,
                        assigned_by: allocation.body.author.clone(),
                        approach: approach.clone(),
                        reports,
                        status,
                        unavailable,
                    });
                }
            }
            let stale = stale || attempts.iter().any(|a| a.reports.iter().any(|r| r.stale));
            let status = if versions.len() > 1 || attempts.iter().any(|a| a.status == "conflict") {
                "conflict"
            } else if attempts.iter().any(|a| a.status == "in_progress") {
                "in_progress"
            } else if attempts.iter().any(|a| a.status == "blocked") {
                "blocked"
            } else if attempts.iter().any(|a| a.status == "paused") {
                "paused"
            } else if !attempts.is_empty() && attempts.iter().all(|a| a.status == "cancelled") {
                "cancelled"
            } else if !attempts.is_empty()
                && attempts
                    .iter()
                    .all(|a| matches!(a.status.as_str(), "complete" | "cancelled"))
            {
                "complete"
            } else if attempts.iter().any(|a| a.status == "submitted") {
                "submitted"
            } else {
                "planned"
            }
            .to_string();
            if query.status.as_ref().is_some_and(|s| s != &status) {
                continue;
            }
            let owner_text = attempts
                .iter()
                .filter_map(|a| agents.iter().find(|v| v.id == a.registration))
                .map(|a| format!("{} {}", a.identity.label, a.identity.contributor_name))
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase();
            if query
                .owner
                .as_ref()
                .is_some_and(|s| !owner_text.contains(&s.to_lowercase()))
            {
                continue;
            }
            if query.search.as_ref().is_some_and(|s| {
                !format!("{} {}", definition.title, definition.description)
                    .to_lowercase()
                    .contains(&s.to_lowercase())
            }) {
                continue;
            }
            result.push(TaskView {
                id: root.id.clone(),
                creator: root.body.author.clone(),
                definition,
                heads: versions,
                attempts,
                status,
                stale,
            });
        }
        let total = result.len();
        let mut items = Vec::new();
        let mut bytes = 0;
        let mut after = None;
        for item in result
            .into_iter()
            .filter(|t| query.after.as_ref().is_none_or(|id| &t.id > id))
        {
            let size = serde_json::to_vec(&item)?.len();
            ensure!(size <= 1024 * 1024, "task detail exceeds response limit");
            if items.len() >= 32 || bytes + size > 1024 * 1024 {
                after = items.last().map(|t: &TaskView| t.id.clone());
                break;
            }
            bytes += size;
            items.push(item);
        }
        Ok(TaskPage {
            items,
            after,
            total,
        })
    }
}
