//! Incremental, authorized conversation delivery. Cursors use local insertion
//! order so a late replicated message is never skipped because its clock is old.
use crate::store::{MessageView, Store};
use anyhow::{Result, anyhow, ensure};
use harakiri_protocol::{
    Event, Payload,
    agents::{AgentStatus, AgentView},
};
use rusqlite::params;
use serde::Serialize;

#[derive(Serialize, ts_rs::TS)]
pub struct Updates {
    pub items: Vec<MessageView>,
    pub start_after: Option<String>,
    pub after: Option<String>,
    pub has_more: bool,
    pub scope: &'static str,
}

impl Store {
    pub fn read_message(&self, mission: &str, viewer: &str, id: &str) -> Result<MessageView> {
        ensure!(
            self.known_participant(mission, viewer)?,
            "message unavailable"
        );
        self.agent_message(mission, viewer, id)
    }

    /// Human catch-up is a local reading aid. It never marks messages read,
    /// acknowledges an agent instruction or infers understanding from delivery.
    pub fn catch_up(&self, mission: &str, viewer: &str, after: Option<&str>) -> Result<Updates> {
        ensure!(
            self.known_participant(mission, viewer)?,
            "conversation unavailable"
        );
        if after.is_none() {
            let mut query = self.connection.prepare(
                "SELECT e.id FROM events e JOIN message_details d ON d.event=e.id
                 WHERE e.mission=?1 AND e.fork=0 AND (e.audience='main' OR EXISTS(
                   SELECT 1 FROM audience_readers ar WHERE ar.mission=e.mission AND ar.audience=e.audience AND ar.author=?2))
                 ORDER BY e.rowid DESC LIMIT 1",
            )?;
            let latest = query
                .query_map(params![mission, viewer], |r| r.get::<_, String>(0))?
                .next()
                .transpose()?;
            return Ok(Updates {
                items: vec![],
                start_after: None,
                after: Some(latest.unwrap_or_else(|| mission.into())),
                has_more: false,
                scope: "local catch-up baseline; no message was marked read",
            });
        }
        self.observed_updates(mission, viewer, after, false, false)
    }

    pub(crate) fn agent_message(
        &self,
        mission: &str,
        viewer: &str,
        id: &str,
    ) -> Result<MessageView> {
        ensure!(
            harakiri_protocol::event::is_hash(id),
            "invalid message reference"
        );
        let event = self
            .event(id)?
            .ok_or_else(|| anyhow!("message unavailable"))?;
        ensure!(
            event.mission_id() == mission
                && self.readable_by(mission, &event.body.audience, viewer)?,
            "message unavailable"
        );
        ensure!(
            !self
                .connection
                .query_row("SELECT fork FROM events WHERE id=?1", [id], |r| r
                    .get::<_, bool>(0))?,
            "message unavailable"
        );
        self.brief_message(event, &self.agent_views(mission)?)
    }

    fn brief_message(&self, event: Event, agents: &[AgentView]) -> Result<MessageView> {
        let (kind, text) = crate::lifecycle::activity(&event.body.payload)
            .ok_or_else(|| anyhow!("message unavailable"))?;
        let author = agents
            .iter()
            .find(|a| a.identity.author == event.body.author);
        let provisional = if let Some(a) = author {
            matches!(
                a.status,
                AgentStatus::Conflict | AgentStatus::ReviewRequired
            ) || (matches!(a.status, AgentStatus::Revoked | AgentStatus::Withdrawn)
                && !self.accepted_private_record(&event)?)
        } else {
            self.provisional(&event.id)?
        };
        let (to, thread) = match &event.body.payload {
            Payload::MessageSent { to, thread, .. }
            | Payload::WorkstreamMessage { to, thread, .. } => (to.clone(), thread.clone()),
            Payload::AgentClarified { registration, .. } => (
                agents
                    .iter()
                    .find(|a| &a.id == registration)
                    .map(|a| a.identity.author.clone()),
                None,
            ),
            _ => (None, None),
        };
        Ok(MessageView {
            work: crate::work::link(&event),
            audience: crate::work::channel(&event),
            to,
            thread,
            replies: 0,
            unread: false,
            author_label: author.map(|a| a.identity.label.clone()),
            author_agent: author.map(|a| a.id.clone()),
            kind,
            agent_registration: None,
            provisional,
            id: event.id,
            author: event.body.author,
            text,
            created_at_ms: event.body.created_at_ms,
        })
    }

    pub(crate) fn agent_updates(
        &self,
        mission: &str,
        viewer: &str,
        after: Option<&str>,
        priority_only: bool,
    ) -> Result<Updates> {
        self.observed_updates(mission, viewer, after, priority_only, true)
    }

    fn observed_updates(
        &self,
        mission: &str,
        viewer: &str,
        after: Option<&str>,
        priority_only: bool,
        agent_only: bool,
    ) -> Result<Updates> {
        let agents = self.agent_views(mission)?;
        let cursor = if let Some(id) = after {
            ensure!(
                harakiri_protocol::event::is_hash(id),
                "invalid message cursor"
            );
            let e = self
                .event(id)?
                .ok_or_else(|| anyhow!("message unavailable"))?;
            ensure!(
                e.mission_id() == mission && self.readable_by(mission, &e.body.audience, viewer)?,
                "message unavailable"
            );
            self.connection
                .query_row("SELECT rowid FROM events WHERE id=?1", [id], |r| {
                    r.get::<_, i64>(0)
                })?
        } else {
            // A newly joined participant reads current context and recent
            // history, not every historical post as a new instruction. Late
            // replication after this local registration still has a later
            // insertion row and remains deliverable regardless of its clock.
            let registration = agents
                .iter()
                .find(|a| a.identity.author == viewer)
                .ok_or_else(|| anyhow!("agent unavailable"))?;
            self.connection.query_row(
                "SELECT rowid FROM events WHERE id=?1",
                [&registration.id],
                |r| r.get::<_, i64>(0),
            )?
        };
        // Public workstreams are readable by every mission participant. Private
        // conversations require exact membership, including for the Coordinator.
        let mut query = self.connection.prepare(
            "SELECT e.bytes FROM events e
            JOIN message_details d ON d.event=e.id
            LEFT JOIN events parent ON parent.id=d.thread
            WHERE e.mission=?1 AND e.fork=0 AND e.rowid>?3 AND (?6=0 OR d.kind IN ('message','clarification'))
              AND (e.audience='main' OR EXISTS(SELECT 1 FROM audience_readers ar
                   WHERE ar.mission=e.mission AND ar.audience=e.audience AND ar.author=?2))
              AND (?4=0 OR (e.author<>?2 AND (d.recipient=?2 OR parent.author=?2 OR e.audience<>'main'
                   OR EXISTS(SELECT 1 FROM json_each(?5) h WHERE h.value=e.author))))
            ORDER BY e.rowid ASC LIMIT 33",
        )?;
        let mut humans = self
            .members(mission)?
            .into_iter()
            .filter(|m| !m.revoked && !m.withdrawn)
            .map(|m| m.author)
            .collect::<Vec<_>>();
        humans.push(self.owner(mission)?);
        let records = query
            .query_map(
                params![
                    mission,
                    viewer,
                    cursor,
                    priority_only,
                    serde_json::to_string(&humans)?,
                    agent_only
                ],
                |r| r.get::<_, Vec<u8>>(0),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut items = Vec::new();
        let mut bytes = 0;
        let mut more = false;
        for raw in records {
            let event = Event::verify(&raw)?;
            let message = self.brief_message(event, &agents)?;
            let size = serde_json::to_vec(&message)?.len();
            if items.len() == 32 || (!items.is_empty() && bytes + size > 48 * 1024) {
                more = true;
                break;
            }
            bytes += size;
            items.push(message);
        }
        Ok(Updates {
            scope: if !agent_only {
                "saved changes visible to this person, in local arrival order; not agent read receipts"
            } else if priority_only {
                "human instructions, addressed messages and replies to this agent; independent insertion cursor"
            } else {
                "messages observed after local agent registration; earlier history remains readable in conversations"
            },
            start_after: after.map(str::to_owned),
            after: items
                .last()
                .map(|m| m.id.clone())
                .or_else(|| after.map(str::to_owned)),
            items,
            has_more: more,
        })
    }
}
