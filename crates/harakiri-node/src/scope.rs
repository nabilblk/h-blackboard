//! Audience authorization and revocation projections. Private identifiers never
//! occur in Main's writer chains, cursors, counts or delivery acknowledgments.
use crate::store::{Head, Store};
use anyhow::{Result, anyhow, ensure};
use harakiri_protocol::{Event, Payload};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::Serialize;

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct MemberView {
    pub author: String,
    pub endpoint: String,
    pub revoked: bool,
    pub withdrawn: bool,
}
#[derive(Debug, Serialize, ts_rs::TS)]
pub struct AudienceView {
    pub id: String,
    pub readers: Vec<String>,
    pub conflicted: bool,
    pub agent_registration: Option<String>,
    pub label: Option<String>,
    pub unread: u32,
    pub writable: bool,
}
#[derive(Debug, Serialize, ts_rs::TS)]
pub struct DeliveryView {
    pub endpoint: String,
    pub pending: bool,
    pub last_success_ms: Option<i64>,
    pub last_error: Option<String>,
}

impl Store {
    pub fn private_recovery(
        &self,
        mission: &str,
        audience: &str,
        viewer: &str,
    ) -> Result<serde_json::Value> {
        ensure!(
            audience != "main" && self.audience_has(mission, audience, viewer)?,
            "private conversation required"
        );
        let root = self
            .audience_root(mission, audience)?
            .ok_or_else(|| anyhow!("conversation unavailable"))?;
        if root.body.author != viewer {
            return Ok(serde_json::json!([]));
        }
        let mut result = Vec::new();
        for member in self.root_readers(&root)? {
            if member == viewer {
                continue;
            }
            let cut:bool=self.connection.query_row("SELECT EXISTS(SELECT 1 FROM audience_cuts WHERE mission=?1 AND audience=?2 AND member=?3)",params![mission,audience,member],|r|r.get(0))?;
            if cut {
                continue;
            }
            let mut cause: Option<String> = self
                .connection
                .query_row(
                    "SELECT event FROM revocations WHERE mission=?1 AND member=?2",
                    params![mission, member],
                    |r| r.get(0),
                )
                .optional()?;
            if cause.is_none()
                && let Some(reg) = self.agent_registration(mission, &member)?
            {
                let offer = self.offer(mission, &reg)?;
                cause = self
                    .connection
                    .query_row(
                        "SELECT event FROM revocations WHERE mission=?1 AND member=?2",
                        params![mission, offer.body.author],
                        |r| r.get(0),
                    )
                    .optional()?;
                if cause.is_none() {
                    cause=self.agent_records(mission)?.values().find(|e|matches!(&e.body.payload,Payload::AgentWithdrawn{registration} if registration==&reg)).map(|e|e.id.clone());
                }
            }
            if let Some(revocation) = cause {
                result.push(serde_json::json!({"member":member,"revocation":revocation}));
            }
        }
        Ok(serde_json::Value::Array(result))
    }
    pub(crate) fn accepted_private_record(&self, e: &Event) -> Result<bool> {
        if e.body.audience == "main" {
            return Ok(false);
        }
        let accepted: Option<String> = self
            .connection
            .query_row(
                "SELECT accepted FROM audience_cuts WHERE mission=?1 AND audience=?2 AND member=?3",
                params![e.mission_id(), e.body.audience, e.body.author],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        Ok(match accepted {
            Some(id) => self.event(&id)?.is_some_and(|cut| {
                cut.body.author == e.body.author && cut.body.sequence >= e.body.sequence
            }),
            None => false,
        })
    }

    pub fn owner(&self, mission: &str) -> Result<String> {
        Ok(self
            .connection
            .query_row("SELECT owner FROM missions WHERE id=?1", [mission], |r| {
                r.get(0)
            })?)
    }
    pub fn members(&self, mission: &str) -> Result<Vec<MemberView>> {
        let mut q = self.connection.prepare("SELECT author,endpoint,(EXISTS(SELECT 1 FROM revocations WHERE revocations.mission=members.mission AND member=author) OR EXISTS(SELECT 1 FROM revocation_notices WHERE revocation_notices.mission=members.mission AND member=author) OR EXISTS(SELECT 1 FROM withdrawals WHERE withdrawals.mission=members.mission AND withdrawals.author=members.author)), EXISTS(SELECT 1 FROM withdrawals WHERE withdrawals.mission=members.mission AND withdrawals.author=members.author) FROM members WHERE mission=?1 ORDER BY author LIMIT 1024")?;
        Ok(q.query_map([mission], |r| {
            Ok(MemberView {
                author: r.get(0)?,
                endpoint: r.get(1)?,
                revoked: r.get(2)?,
                withdrawn: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
    }
    pub fn is_revoked(&self, mission: &str, author: &str) -> Result<bool> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM revocations WHERE mission=?1 AND member=?2) OR EXISTS(SELECT 1 FROM revocation_notices WHERE mission=?1 AND member=?2) OR EXISTS(SELECT 1 FROM withdrawals WHERE mission=?1 AND author=?2)",
            params![mission, author],
            |r| r.get(0),
        )?)
    }
    pub fn audience_root(&self, mission: &str, audience: &str) -> Result<Option<Event>> {
        let id: Option<String> = self
            .connection
            .query_row(
                "SELECT root FROM audiences WHERE mission=?1 AND id=?2",
                params![mission, audience],
                |r| r.get(0),
            )
            .optional()?;
        id.map(|s| {
            self.event(&s)?
                .ok_or_else(|| anyhow!("missing audience root"))
        })
        .transpose()
    }
    pub fn audience_has(&self, mission: &str, audience: &str, author: &str) -> Result<bool> {
        Ok(self.connection.query_row("SELECT EXISTS(SELECT 1 FROM audience_readers WHERE mission=?1 AND audience=?2 AND author=?3)", params![mission,audience,author], |r| r.get(0))?)
    }
    pub fn can_read_scope(&self, mission: &str, audience: &str, endpoint: &str) -> Result<bool> {
        if !self.can_read(mission, endpoint)? {
            return Ok(false);
        }
        if audience == "main" {
            return Ok(true);
        }
        let Some(root) = self.audience_root(mission, audience)? else {
            return Ok(false);
        };
        let root_fork:bool=self.connection.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE mission=?1 AND audience=?2 AND author=?3 AND sequence=0 AND fork=1)",params![mission,audience,root.body.author],|r|r.get(0))?;
        if root_fork
            && !self
                .members(mission)?
                .iter()
                .any(|m| m.author == root.body.author && m.endpoint == endpoint && !m.revoked)
        {
            return Ok(false);
        }
        let readers = self.root_readers(&root)?;
        self.endpoint_reads(mission, &readers, endpoint)
    }
    pub(crate) fn root_readers(&self, root: &Event) -> Result<Vec<String>> {
        match &root.body.payload {
            Payload::AudienceCreated { readers } => Ok(readers.clone()),
            Payload::AgentConversationCreated { registration } => {
                let offer = self.offer(root.mission_id(), registration)?;
                let Payload::AgentOffered { identity, .. } = offer.body.payload else {
                    unreachable!()
                };
                Ok(vec![root.body.author.clone(), identity.author])
            }
            _ => anyhow::bail!("invalid audience root"),
        }
    }
    pub(crate) fn endpoint_reads(
        &self,
        mission: &str,
        readers: &[String],
        endpoint: &str,
    ) -> Result<bool> {
        let members = self.members(mission)?;
        if members
            .iter()
            .any(|m| m.endpoint == endpoint && !m.revoked && readers.contains(&m.author))
        {
            return Ok(true);
        }
        for reader in readers {
            if let Some(registration) = self.agent_registration(mission, reader)?
                && let Ok(a) = self.communicative_agent(mission, &registration)
                && members
                    .iter()
                    .any(|m| m.author == a.contributor && m.endpoint == endpoint && !m.revoked)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub fn audiences_for(&self, mission: &str, endpoint: &str) -> Result<Vec<AudienceView>> {
        ensure!(self.can_read(mission, endpoint)?, "not admitted");
        let mut q = self
            .connection
            .prepare("SELECT id FROM audiences WHERE mission=?1 ORDER BY id LIMIT 1024")?;
        let ids = q
            .query_map([mission], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut result = Vec::new();
        for id in ids {
            if self.can_read_scope(mission, &id, endpoint)? {
                result.push(self.audience_view(mission, &id, None)?);
            }
        }
        Ok(result)
    }
    fn audience_view(&self, mission: &str, id: &str, viewer: Option<&str>) -> Result<AudienceView> {
        let root = self
            .audience_root(mission, id)?
            .ok_or_else(|| anyhow!("missing audience"))?;
        let readers = self.root_readers(&root)?;
        let registration = match &root.body.payload {
            Payload::AgentConversationCreated { registration } => Some(registration.clone()),
            _ => None,
        };
        let label = registration
            .as_ref()
            .map(|id| self.offer(mission, id))
            .transpose()?
            .and_then(|e| match e.body.payload {
                Payload::AgentOffered { identity, .. } => Some(identity.label),
                _ => None,
            });
        let conflicted = self.conflicted_scope(mission, id)?;
        let writable = !conflicted
            && !self.locally_withdrawn(mission)?
            && viewer.is_none_or(|v| self.is_revoked(mission, v).is_ok_and(|r| !r))
            && registration
                .as_ref()
                .is_none_or(|id| self.communicative_agent(mission, id).is_ok());
        let unread = if let Some(viewer) = viewer {
            self.connection.query_row("SELECT count(*) FROM events e JOIN message_details d ON d.event=e.id WHERE e.mission=?1 AND e.audience=?2 AND e.author<>?3 AND e.fork=0 AND d.kind='message' AND NOT EXISTS(SELECT 1 FROM message_reads r WHERE r.event=e.id AND r.reader=?3)",params![mission,id,viewer],|r|r.get(0))?
        } else {
            0
        };
        Ok(AudienceView {
            id: id.into(),
            readers,
            conflicted,
            agent_registration: registration,
            label,
            unread,
            writable,
        })
    }
    pub fn conflicted_scope(&self, mission: &str, audience: &str) -> Result<bool> {
        Ok(self.connection.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE mission=?1 AND (audience='main' OR audience=?2) AND fork=1)", params![mission,audience], |r| r.get(0))?)
    }
    pub(crate) fn validate_scoped(&self, event: &Event) -> Result<bool> {
        let b = &event.body;
        let mission = event.mission_id();
        match &b.payload {
            Payload::MemberAdmitted { member, .. } => {
                let count: u32 = self.connection.query_row(
                    "SELECT count(*) FROM members WHERE mission=?1",
                    [mission],
                    |r| r.get(0),
                )?;
                // Fork evidence is still retained at the limit.
                ensure!(
                    count < 1024 || self.members(mission)?.iter().any(|m| &m.author == member),
                    "member limit"
                );
            }
            Payload::AudienceCreated { readers } => {
                if let Some(root) = self.audience_root(mission, &b.audience)? {
                    ensure!(root.body.author == b.author, "audience identity collision");
                }
                for reader in readers {
                    let known: bool = self.connection.query_row(
                        "SELECT EXISTS(SELECT 1 FROM members WHERE mission=?1 AND author=?2)",
                        params![mission, reader],
                        |r| r.get(0),
                    )?;
                    if !known {
                        return Ok(false);
                    }
                }
                let count: u32 = self.connection.query_row(
                    "SELECT count(*) FROM audiences WHERE mission=?1",
                    [mission],
                    |r| r.get(0),
                )?;
                ensure!(
                    count < harakiri_protocol::limits::MAX_AUDIENCES as u32,
                    "audience limit"
                );
            }
            Payload::MemberRevoked { member, accepted } => {
                ensure!(member != &self.owner(mission)?, "cannot revoke the owner");
                if !self.members(mission)?.iter().any(|m| &m.author == member) {
                    return Ok(false);
                }
                if !self.check_frontier(mission, "main", member, accepted)? {
                    return Ok(false);
                }
                let prior: Option<String> = self
                    .connection
                    .query_row(
                        "SELECT event FROM revocations WHERE mission=?1 AND member=?2",
                        params![mission, member],
                        |r| r.get(0),
                    )
                    .optional()?;
                if let Some(prior) = prior {
                    ensure!(
                        self.event(&prior)?
                            .is_some_and(|e| e.body.sequence == b.sequence),
                        "already revoked"
                    );
                }
            }
            Payload::AudienceFrontier {
                member,
                revocation,
                accepted,
            } => {
                let Some(root) = self.audience_root(mission, &b.audience)? else {
                    return Ok(false);
                };
                ensure!(
                    root.body.author == b.author
                        && member != &b.author
                        && self.audience_has(mission, &b.audience, member)?,
                    "audience creator authority required"
                );
                let Some(revoke) = self.event(revocation)? else {
                    return Ok(false);
                };
                let mut valid =
                    matches!(&revoke.body.payload,Payload::MemberRevoked{member:m,..} if m==member);
                if !valid
                    && b.version >= 8
                    && let Some(reg) = self.agent_registration(mission, member)?
                {
                    let offer = self.offer(mission, &reg)?;
                    valid = matches!(&revoke.body.payload,Payload::MemberRevoked{member:m,..} if m==&offer.body.author)
                        || matches!(&revoke.body.payload,Payload::AgentWithdrawn{registration} if registration==&reg);
                }
                ensure!(
                    revoke.mission_id() == mission && valid,
                    "invalid revocation reference"
                );
                if !self.check_frontier(mission, &b.audience, member, accepted)? {
                    return Ok(false);
                }
                let prior:Option<String>=self.connection.query_row("SELECT event FROM audience_cuts WHERE mission=?1 AND audience=?2 AND member=?3",params![mission,b.audience,member],|r|r.get(0)).optional()?;
                if let Some(prior) = prior {
                    ensure!(
                        self.event(&prior)?
                            .is_some_and(|e| e.body.sequence == b.sequence),
                        "frontier already recorded"
                    );
                }
            }
            _ => {}
        }
        Ok(true)
    }
    fn check_frontier(
        &self,
        mission: &str,
        audience: &str,
        author: &str,
        id: &Option<String>,
    ) -> Result<bool> {
        if let Some(id) = id {
            let Some(event) = self.event(id)? else {
                return Ok(false);
            };
            ensure!(
                event.mission_id() == mission
                    && event.body.audience == audience
                    && event.body.author == author,
                "invalid accepted frontier"
            );
        }
        Ok(true)
    }
    pub fn provisional(&self, id: &str) -> Result<bool> {
        let e = self.event(id)?.ok_or_else(|| anyhow!("missing event"))?;
        if !self.is_revoked(e.mission_id(), &e.body.author)? {
            return Ok(false);
        }
        let accepted: Option<String> = if e.body.audience == "main" {
            self.connection
                .query_row(
                    "SELECT accepted FROM revocations WHERE mission=?1 AND member=?2 UNION ALL SELECT accepted FROM withdrawals WHERE mission=?1 AND author=?2 LIMIT 1",
                    params![e.mission_id(), e.body.author],
                    |r| r.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten()
        } else {
            self.connection.query_row("SELECT accepted FROM audience_cuts WHERE mission=?1 AND audience=?2 AND member=?3", params![e.mission_id(),e.body.audience,e.body.author],|r|r.get::<_,Option<String>>(0)).optional()?.flatten()
        };
        let Some(id) = accepted else { return Ok(true) };
        Ok(self.event(&id)?.is_none_or(|cut| {
            cut.mission_id() != e.mission_id()
                || cut.body.author != e.body.author
                || cut.body.audience != e.body.audience
                || e.body.sequence > cut.body.sequence
        }))
    }
    pub fn revocation_for(&self, mission: &str, endpoint: &str) -> Result<Option<Vec<u8>>> {
        let full:Option<Vec<u8>>=self.connection.query_row("SELECT events.bytes FROM revocations JOIN members ON members.mission=revocations.mission AND members.author=revocations.member JOIN events ON events.id=revocations.event WHERE members.mission=?1 AND members.endpoint=?2 LIMIT 1",params![mission,endpoint],|r|r.get(0)).optional()?;
        if full.is_some() {
            return Ok(full);
        }
        Ok(self.connection.query_row("SELECT bytes FROM revocation_notices JOIN members ON members.mission=revocation_notices.mission AND members.author=revocation_notices.member WHERE members.mission=?1 AND endpoint=?2 LIMIT 1",params![mission,endpoint],|r|r.get(0)).optional()?)
    }
    pub fn notice_revocation(
        &mut self,
        bytes: &[u8],
        mission: &str,
        local_author: &str,
    ) -> Result<()> {
        let event = Event::verify(bytes)?;
        ensure!(
            event.mission_id() == mission
                && event.body.author == self.owner(mission)?
                && event.body.authority.as_deref() == Some(mission)
                && event.body.audience == "main",
            "invalid revocation notice"
        );
        ensure!(
            matches!(&event.body.payload,Payload::MemberRevoked {member,..} if member==local_author && member!=&event.body.author),
            "not this member's revocation"
        );
        // A directly signed owner denial is enough to stop locally. It cannot
        // add authority or project history without its causal predecessors.
        self.connection.execute(
            "INSERT OR IGNORE INTO revocation_notices(mission,member,bytes) VALUES(?1,?2,?3)",
            params![mission, local_author, bytes],
        )?;
        Ok(())
    }
    pub fn local_audiences(&self, mission: &str, author: &str) -> Result<Vec<AudienceView>> {
        let mut q=self.connection.prepare("SELECT ar.audience FROM audience_readers ar LEFT JOIN events e ON e.mission=ar.mission AND e.audience=ar.audience WHERE ar.mission=?1 AND ar.author=?2 GROUP BY ar.audience ORDER BY max(e.rowid) DESC LIMIT 1024")?;
        let ids = q
            .query_map(params![mission, author], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.into_iter()
            .map(|id| self.audience_view(mission, &id, Some(author)))
            .collect()
    }
    pub fn deliveries(&self, mission: &str, audience: &str) -> Result<Vec<DeliveryView>> {
        let mut q=self.connection.prepare("SELECT endpoint,dirty,last_success_ms,last_error FROM delivery WHERE mission=?1 AND audience=?2 ORDER BY endpoint LIMIT 1024")?;
        Ok(q.query_map(params![mission, audience], |r| {
            Ok(DeliveryView {
                endpoint: r.get(0)?,
                pending: r.get(1)?,
                last_success_ms: r.get(2)?,
                last_error: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
    }
    pub fn acknowledge(
        &mut self,
        mission: &str,
        audience: &str,
        endpoint: &str,
        heads: &[Head],
        now: u64,
    ) -> Result<()> {
        ensure!(
            self.can_read_scope(mission, audience, endpoint)?,
            "not authorized"
        );
        // A concurrently appended local event must remain pending.
        let dirty = !self.delta_in(mission, audience, heads)?.is_empty();
        self.connection.execute("INSERT INTO delivery(mission,audience,endpoint,dirty,acknowledged,last_success_ms) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(mission,audience,endpoint) DO UPDATE SET dirty=excluded.dirty,acknowledged=excluded.acknowledged,last_success_ms=excluded.last_success_ms,last_error=NULL",params![mission,audience,endpoint,dirty,serde_json::to_string(heads)?,i64::try_from(now)?])?;
        Ok(())
    }
    pub fn delivery_failed(&mut self, mission: &str, audience: &str, endpoint: &str) -> Result<()> {
        self.connection.execute("UPDATE delivery SET last_error='unreachable' WHERE mission=?1 AND audience=?2 AND endpoint=?3",params![mission,audience,endpoint])?;
        Ok(())
    }
}

pub(crate) fn project(tx: &Transaction<'_>, e: &Event, fork: bool) -> Result<()> {
    if fork {
        return Ok(());
    }
    let m = e.mission_id();
    let a = &e.body.audience;
    match &e.body.payload {
        Payload::MissionCreated { endpoint, .. } | Payload::MemberAdmitted { endpoint, .. } => {
            tx.execute(
                "INSERT OR IGNORE INTO delivery(mission,audience,endpoint) VALUES(?1,'main',?2)",
                params![m, endpoint],
            )?;
        }
        Payload::AgentConversationCreated { registration } => {
            let (agent,contributor):(String,String)=tx.query_row("SELECT author,contributor FROM agent_registry WHERE mission=?1 AND registration=?2",params![m,registration],|r|Ok((r.get(0)?,r.get(1)?)))?;
            tx.execute(
                "INSERT INTO audiences(mission,id,root,creator) VALUES(?1,?2,?3,?4)",
                params![m, a, e.id, e.body.author],
            )?;
            for reader in [&e.body.author, &agent] {
                tx.execute(
                    "INSERT INTO audience_readers(mission,audience,author) VALUES(?1,?2,?3)",
                    params![m, a, reader],
                )?;
            }
            for host in [&e.body.author, &contributor] {
                tx.execute("INSERT OR IGNORE INTO delivery(mission,audience,endpoint) SELECT mission,?2,endpoint FROM members WHERE mission=?1 AND author=?3",params![m,a,host])?;
            }
        }
        Payload::AudienceCreated { readers } => {
            tx.execute(
                "INSERT INTO audiences(mission,id,root,creator) VALUES(?1,?2,?3,?4)",
                params![m, a, e.id, e.body.author],
            )?;
            for reader in readers {
                tx.execute(
                    "INSERT INTO audience_readers(mission,audience,author) VALUES(?1,?2,?3)",
                    params![m, a, reader],
                )?;
                tx.execute("INSERT OR IGNORE INTO delivery(mission,audience,endpoint) SELECT mission,?2,endpoint FROM members WHERE mission=?1 AND author=?3",params![m,a,reader])?;
            }
        }
        Payload::MemberRevoked { member, accepted } => {
            tx.execute(
                "INSERT INTO revocations(mission,member,event,accepted) VALUES(?1,?2,?3,?4)",
                params![m, member, e.id, accepted],
            )?;
        }
        Payload::AudienceFrontier {
            member, accepted, ..
        } => {
            tx.execute("INSERT INTO audience_cuts(mission,audience,member,event,accepted) VALUES(?1,?2,?3,?4,?5)",params![m,a,member,e.id,accepted])?;
        }
        _ => {}
    }
    Ok(())
}
