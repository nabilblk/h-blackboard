//! Durable, audience-scoped pagination over the append-only accepted log.
//!
//! Writer heads are useful acknowledgments, but are not pagination cursors: an
//! unknown head must never keep replaying the same bounded prefix. A cursor is
//! an exact accepted event in the serving replica's insertion order. It moves
//! only after the receiver has validated the entire page. Concurrent imports
//! always append, including forks, so they cannot fall behind a saved cursor.
use crate::store::{Head, Store};
use anyhow::{Result, ensure};
use harakiri_protocol::{event::is_hash, limits};
use rusqlite::{OptionalExtension, params};

pub struct HistoryPage {
    pub events: Vec<Vec<u8>>,
    pub after: Option<String>,
    pub more: bool,
    pub reset: bool,
}

impl Store {
    pub fn history_page(
        &self,
        mission: &str,
        audience: &str,
        after: Option<&str>,
    ) -> Result<HistoryPage> {
        ensure!(after.is_none_or(is_hash), "invalid history cursor");
        let position: Option<i64> = match after {
            Some(id) => self
                .connection
                .query_row(
                    "SELECT rowid FROM events WHERE mission=?1 AND audience=?2 AND id=?3",
                    params![mission, audience, id],
                    |r| r.get(0),
                )
                .optional()?,
            None => None,
        };
        // A peer may have restored an older backup. Replay safely; never use
        // a row number supplied by another replica, or reveal another scope.
        let reset = after.is_some() && position.is_none();
        let mut query = self.connection.prepare(
            "SELECT id,bytes FROM events WHERE mission=?1 AND audience=?2 AND rowid>?3 ORDER BY rowid LIMIT ?4",
        )?;
        let mut rows = query.query(params![
            mission,
            audience,
            position.unwrap_or(0),
            (limits::MAX_BATCH_EVENTS + 1) as i64
        ])?;
        let mut page = HistoryPage {
            events: vec![],
            after: if reset {
                None
            } else {
                after.map(str::to_owned)
            },
            more: false,
            reset,
        };
        let mut size = 0;
        while let Some(row) = rows.next()? {
            let bytes: Vec<u8> = row.get(1)?;
            size += bytes.len() * 2 + 4;
            if page.events.len() == limits::MAX_BATCH_EVENTS || size > limits::MAX_FRAME_BYTES / 2 {
                page.more = true;
                break;
            }
            page.after = Some(row.get(0)?);
            page.events.push(bytes);
        }
        Ok(page)
    }

    pub fn sync_cursors(
        &self,
        mission: &str,
        audience: &str,
        endpoint: &str,
    ) -> Result<(Option<String>, Option<String>)> {
        Ok(self.connection.query_row(
            "SELECT pull_cursor,push_cursor FROM sync_progress WHERE mission=?1 AND audience=?2 AND endpoint=?3",
            params![mission, audience, endpoint], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?.unwrap_or_default())
    }

    pub fn save_sync_cursor(
        &mut self,
        mission: &str,
        audience: &str,
        endpoint: &str,
        incoming: bool,
        cursor: Option<&str>,
    ) -> Result<()> {
        ensure!(cursor.is_none_or(is_hash), "invalid history cursor");
        if let Some(id) = cursor {
            let event = self
                .event(id)?
                .ok_or_else(|| anyhow::anyhow!("unverified history cursor"))?;
            ensure!(
                event.mission_id() == mission && event.body.audience == audience,
                "cross-scope history cursor"
            );
        }
        let column = if incoming {
            "pull_cursor"
        } else {
            "push_cursor"
        };
        self.connection.execute(
            &format!("INSERT INTO sync_progress(mission,audience,endpoint,{column}) VALUES(?1,?2,?3,?4) ON CONFLICT(mission,audience,endpoint) DO UPDATE SET {column}=excluded.{column}"),
            params![mission, audience, endpoint, cursor],
        )?;
        Ok(())
    }

    pub fn record_sync_progress(
        &mut self,
        mission: &str,
        audience: &str,
        endpoint: &str,
        advanced: bool,
        now: u64,
    ) -> Result<()> {
        self.connection.execute(
            "UPDATE delivery SET last_progress_ms=CASE WHEN ?4 THEN ?5 ELSE last_progress_ms END,
             stalled_exchanges=CASE WHEN dirty=0 OR ?4 THEN 0 ELSE stalled_exchanges+1 END,
             last_converged_ms=CASE WHEN dirty=0 THEN ?5 ELSE last_converged_ms END,
             last_error=CASE WHEN dirty=1 AND NOT ?4 AND stalled_exchanges>=2 THEN 'no_progress' ELSE last_error END
             WHERE mission=?1 AND audience=?2 AND endpoint=?3",
            params![mission, audience, endpoint, advanced, i64::try_from(now)?],
        )?;
        Ok(())
    }

    /// The peer's authenticated acknowledgment claims this exact ancestor.
    /// It does not establish a remote process state or independent verification.
    pub fn acknowledged_event(
        &self,
        mission: &str,
        audience: &str,
        id: &str,
        heads: &[Head],
    ) -> Result<bool> {
        let Some(target) = self.event(id)? else {
            return Ok(false);
        };
        if target.mission_id() != mission || target.body.audience != audience {
            return Ok(false);
        }
        for head in heads.iter().filter(|h| h.author == target.body.author) {
            let mut next = Some(head.id.clone());
            for _ in 0..limits::MAX_HISTORY_EVENTS {
                let Some(current) = next else { break };
                let Some(event) = self.event(&current)? else {
                    break;
                };
                if event.mission_id() != mission
                    || event.body.audience != audience
                    || event.body.author != head.author
                {
                    break;
                }
                if event.id == id {
                    return Ok(true);
                }
                if event.body.sequence <= target.body.sequence {
                    break;
                }
                next = event.body.previous;
            }
        }
        Ok(false)
    }
}
