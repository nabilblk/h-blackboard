//! Withdrawal is a durable local stop first, followed by a signed, retryable
//! notice. It cannot erase delivered history or stop an unreachable peer.
use crate::{admission::Access, contact::Contact, store::Store};
use anyhow::{Result, anyhow, ensure};
use harakiri_protocol::{Identity, claims, event::is_hash};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
pub const DOMAIN: &[u8] = b"harakiri/withdrawal/1";

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Withdrawal {
    pub version: u16,
    pub mission: String,
    pub endpoint: String,
    pub accepted: Option<String>,
}
impl Withdrawal {
    pub fn verify(raw: &str) -> Result<(String, Self)> {
        ensure!(raw.len() <= 2048, "withdrawal limit");
        let (author, n): (String, Self) = claims::verify(DOMAIN, raw)?;
        ensure!(
            n.version == 1
                && is_hash(&n.mission)
                && is_hash(&n.endpoint)
                && n.accepted.as_deref().is_none_or(is_hash),
            "invalid withdrawal"
        );
        Ok((author, n))
    }
}
#[derive(Debug, Serialize, ts_rs::TS)]
pub struct WithdrawalView {
    pub mission: String,
    pub pending_notifications: usize,
}
impl Store {
    pub fn locally_withdrawn(&self, mission: &str) -> Result<bool> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM local_withdrawals WHERE mission=?1)",
            [mission],
            |r| r.get(0),
        )?)
    }
    pub fn withdrawal_views(&self) -> Result<Vec<WithdrawalView>> {
        let mut q = self
            .connection
            .prepare("SELECT mission,targets FROM local_withdrawals ORDER BY mission LIMIT 1024")?;
        q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .map(|row| {
                let (mission, targets) = row?;
                let targets: Vec<Contact> = serde_json::from_str(&targets)?;
                Ok(WithdrawalView {
                    mission,
                    pending_notifications: targets.len(),
                })
            })
            .collect()
    }
    pub fn withdraw(&mut self, identity: &Identity, mission: &str, endpoint: &str) -> Result<()> {
        if self.locally_withdrawn(mission)? {
            return Ok(());
        }
        let joined: Option<String> = self
            .connection
            .query_row(
                "SELECT ticket FROM local_joins WHERE mission=?1",
                [mission],
                |r| r.get(0),
            )
            .optional()?;
        let owner = self.owner(mission).ok();
        ensure!(
            owner.as_deref() != Some(&identity.public_key()),
            "owner handover is required before withdrawal"
        );
        ensure!(
            joined.is_some()
                || self
                    .members(mission)?
                    .iter()
                    .any(|m| m.author == identity.public_key() && m.endpoint == endpoint),
            "not a local participant"
        );
        let mut targets = vec![];
        for raw in self.contacts(mission)? {
            let (_, c) = Contact::verify(&raw)?;
            if c.endpoint != endpoint {
                targets.push(c);
            }
        }
        if let Some(ticket) = joined
            && let Ok(access) = Access::parse(&ticket)
            && !targets
                .iter()
                .any(|c| c.endpoint == access.contact.endpoint)
        {
            targets.push(access.contact);
        }
        let n = Withdrawal {
            version: 1,
            mission: mission.into(),
            endpoint: endpoint.into(),
            accepted: self.head(mission, &identity.public_key())?.map(|h| h.id),
        };
        let signed = identity.claim(DOMAIN, &n)?;
        let tx = self.connection.transaction()?;
        tx.execute(
            "INSERT INTO local_withdrawals(mission,notice,targets) VALUES(?1,?2,?3)",
            params![mission, signed, serde_json::to_string(&targets)?],
        )?;
        tx.execute("INSERT OR IGNORE INTO withdrawals(mission,author,endpoint,signed,accepted) VALUES(?1,?2,?3,?4,?5)",params![mission,identity.public_key(),endpoint,signed,n.accepted])?;
        tx.execute(
            "UPDATE local_joins SET status='withdrawn' WHERE mission=?1",
            [mission],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn receive_withdrawal(&mut self, raw: &str) -> Result<()> {
        let (author, n) = Withdrawal::verify(raw)?;
        ensure!(
            self.owner(&n.mission)? != author,
            "owner cannot withdraw without handover"
        );
        let known:bool=self.connection.query_row("SELECT EXISTS(SELECT 1 FROM members WHERE mission=?1 AND author=?2 AND endpoint=?3) OR EXISTS(SELECT 1 FROM join_requests WHERE mission=?1 AND author=?2 AND endpoint=?3)",params![n.mission,author,n.endpoint],|r|r.get(0))?;
        ensure!(known, "unknown participant");
        if let Some(id) = &n.accepted
            && let Some(e) = self.event(id)?
        {
            ensure!(
                e.mission_id() == n.mission && e.body.author == author && e.body.audience == "main",
                "invalid withdrawal frontier"
            );
        }
        let tx = self.connection.transaction()?;
        tx.execute("INSERT OR IGNORE INTO withdrawals(mission,author,endpoint,signed,accepted) VALUES(?1,?2,?3,?4,?5)",params![n.mission,author,n.endpoint,raw,n.accepted])?;
        tx.execute(
            "UPDATE join_requests SET status='withdrawn' WHERE mission=?1 AND author=?2",
            params![n.mission, author],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn withdrawal_notices(&self, mission: &str) -> Result<Vec<String>> {
        let mut q = self.connection.prepare(
            "SELECT signed FROM withdrawals WHERE mission=?1 ORDER BY author LIMIT 1024",
        )?;
        Ok(q.query_map([mission], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }
    pub fn pending_withdrawals(&self) -> Result<Vec<(String, String, Vec<Contact>)>> {
        let mut q=self.connection.prepare("SELECT mission,notice,targets FROM local_withdrawals WHERE targets!='[]' ORDER BY mission LIMIT 1024")?;
        q.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .map(|row| {
            let (m, n, t) = row?;
            Ok((m, n, serde_json::from_str(&t)?))
        })
        .collect()
    }
    pub fn acknowledge_withdrawal(&mut self, mission: &str, endpoint: &str) -> Result<()> {
        let (_, _, mut targets) = self
            .pending_withdrawals()?
            .into_iter()
            .find(|(m, _, _)| m == mission)
            .ok_or_else(|| anyhow!("unknown withdrawal"))?;
        targets.retain(|c| c.endpoint != endpoint);
        self.connection.execute(
            "UPDATE local_withdrawals SET targets=?2 WHERE mission=?1",
            params![mission, serde_json::to_string(&targets)?],
        )?;
        Ok(())
    }
}
