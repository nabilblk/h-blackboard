//! Invitations carry a bounded inspection capability. Admission is a separate,
//! explicit owner decision bound to the requesting node's signed identity.
use crate::{
    contact::{Contact, NetworkConfig, now},
    store::Store,
};
use anyhow::{Result, anyhow, ensure};
use harakiri_protocol::{Event, Identity, MissionDefinition, Payload, claims, event::is_hash};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

const INVITE_DOMAIN: &[u8] = b"harakiri/invitation/1";
const OFFER_DOMAIN: &[u8] = b"harakiri/join-offer/2";
const PREFIX: &str = "harakiri://join/";
const WEEK: u64 = 7 * 24 * 60 * 60 * 1000;

/// Both entry points authorize live review and a request, never admission.
pub struct Access {
    pub owner: String,
    pub mission: String,
    pub contact: Contact,
    pub expires_ms: u64,
    pub public: bool,
}
impl Access {
    pub fn parse(reference: &str) -> Result<Self> {
        if reference.starts_with(crate::discovery::PREFIX) {
            let (owner, ad) = crate::discovery::Advertisement::parse(reference)?;
            ensure!(ad.available(), "listing unavailable");
            Ok(Self {
                owner,
                mission: ad.mission,
                contact: ad.contact,
                expires_ms: ad.expires_ms,
                public: true,
            })
        } else {
            let (owner, i) = Invitation::parse(reference)?;
            Ok(Self {
                owner,
                mission: i.mission,
                contact: i.contact,
                expires_ms: i.expires_ms,
                public: false,
            })
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Invitation {
    pub version: u16,
    pub mission: String,
    pub contact: Contact,
    pub nonce: String,
    pub issued_ms: u64,
    pub expires_ms: u64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Offer {
    pub version: u16,
    pub mission: String,
    pub invitation: String,
    pub reviewed_revision: String,
    pub contact: Contact,
}
#[derive(Debug, Serialize, ts_rs::TS)]
pub struct InvitationReview {
    pub mission: String,
    pub owner: String,
    pub endpoint: String,
    pub expires_ms: u64,
    pub definition: MissionDefinition,
    pub reviewed_revision: String,
}
#[derive(Debug, Serialize, ts_rs::TS)]
pub struct JoinView {
    pub mission: String,
    pub author: String,
    pub endpoint: String,
    pub status: String,
}
#[derive(Debug, Serialize, ts_rs::TS)]
pub struct LocalJoinView {
    pub mission: String,
    pub name: String,
    pub status: String,
}

pub fn ticket_id(ticket: &str) -> String {
    blake3::hash(ticket.as_bytes()).to_hex().to_string()
}
impl Invitation {
    pub fn parse(ticket: &str) -> Result<(String, Self)> {
        ensure!(ticket.len() <= 16384, "invitation too large");
        let raw = ticket
            .strip_prefix(PREFIX)
            .ok_or_else(|| anyhow!("invalid invitation"))?;
        // One representation per capability: no upper-case or whitespace aliases.
        ensure!(
            raw.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "invalid invitation encoding"
        );
        let (owner, i): (String, Self) = claims::verify(INVITE_DOMAIN, raw)?;
        i.contact.validate()?;
        ensure!(
            i.version == 1
                && is_hash(&i.mission)
                && is_hash(&i.nonce)
                && i.issued_ms <= now() + 60_000
                && i.expires_ms > now()
                && i.expires_ms > i.issued_ms
                && i.expires_ms - i.issued_ms <= WEEK,
            "invalid or expired invitation"
        );
        Ok((owner, i))
    }
    pub fn review(ticket: &str, genesis: &[u8]) -> Result<InvitationReview> {
        let i = Access::parse(ticket)?;
        let owner = i.owner.clone();
        let root = Event::verify(genesis)?;
        ensure!(
            root.id == i.mission && root.body.author == owner,
            "invitation identity mismatch"
        );
        let Payload::MissionCreated {
            definition,
            endpoint,
            ..
        } = root.body.payload
        else {
            anyhow::bail!("not a mission")
        };
        ensure!(
            endpoint == i.contact.endpoint && definition.policy.is_some(),
            "unsupported mission policy"
        );
        ensure!(
            !i.public
                || definition.policy.as_ref().is_some_and(
                    |p| p.participation == harakiri_protocol::policy::Participation::Approval
                ),
            "private mission is not discoverable"
        );
        Ok(InvitationReview {
            mission: i.mission.clone(),
            reviewed_revision: i.mission,
            owner,
            endpoint,
            expires_ms: i.expires_ms,
            definition,
        })
    }
}
impl Offer {
    pub fn sign(
        identity: &Identity,
        ticket: &str,
        contact: Contact,
        reviewed_revision: String,
    ) -> Result<String> {
        let i = Access::parse(ticket)?;
        contact.validate()?;
        Ok(identity.claim(
            OFFER_DOMAIN,
            &Self {
                version: 2,
                mission: i.mission,
                invitation: ticket_id(ticket),
                reviewed_revision,
                contact,
            },
        )?)
    }
    pub fn verify(raw: &str) -> Result<(String, Self)> {
        let (author, o): (String, Self) = claims::verify(OFFER_DOMAIN, raw)?;
        ensure!(
            o.version == 2
                && is_hash(&o.mission)
                && is_hash(&o.invitation)
                && is_hash(&o.reviewed_revision),
            "invalid offer"
        );
        o.contact.validate()?;
        Ok((author, o))
    }
}

impl Store {
    pub fn network_config(&self) -> Result<NetworkConfig> {
        let value: Option<String> = self
            .connection
            .query_row("SELECT value FROM settings WHERE key='network'", [], |r| {
                r.get(0)
            })
            .optional()?;
        let c: NetworkConfig = value
            .map(|s| serde_json::from_str(&s))
            .transpose()?
            .unwrap_or_default();
        c.relay_mode()?;
        Ok(c)
    }
    pub fn save_network_config(&mut self, config: &NetworkConfig) -> Result<()> {
        config.relay_mode()?;
        self.connection.execute("INSERT INTO settings(key,value) VALUES('network',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[serde_json::to_string(config)?])?;
        Ok(())
    }
    pub fn issue_invitation(
        &mut self,
        identity: &Identity,
        mission: &str,
        mut contact: Contact,
    ) -> Result<String> {
        ensure!(
            self.owner(mission)? == identity.public_key() && !self.conflicted(mission)?,
            "owner authority required"
        );
        let root = self
            .event(mission)?
            .ok_or_else(|| anyhow!("missing mission"))?;
        ensure!(
            matches!(root.body.payload,Payload::MissionCreated { ref endpoint,.. } if endpoint==&contact.endpoint),
            "owner endpoint required"
        );
        self.connection.execute(
            "DELETE FROM invitations WHERE expires_ms<?1",
            [i64::try_from(now())?],
        )?;
        let count: u32 =
            self.connection
                .query_row("SELECT count(*) FROM invitations", [], |r| r.get(0))?;
        ensure!(count < 256, "invitation limit");
        ensure!(
            self.control_state(mission)?.lifecycle.phase
                != harakiri_protocol::lifecycle::MissionPhase::Archived,
            "archived mission cannot invite participants"
        );
        contact.expires_ms = now() + WEEK;
        let invitation = Invitation {
            version: 1,
            mission: mission.into(),
            contact,
            nonce: hex::encode(rand::random::<[u8; 32]>()),
            issued_ms: now(),
            expires_ms: now() + WEEK,
        };
        let ticket = format!("{PREFIX}{}", identity.claim(INVITE_DOMAIN, &invitation)?);
        Self::validate_ticket_length(&ticket)?;
        self.connection.execute(
            "INSERT INTO invitations(id,mission,expires_ms) VALUES(?1,?2,?3)",
            params![
                ticket_id(&ticket),
                mission,
                i64::try_from(invitation.expires_ms)?
            ],
        )?;
        Ok(ticket)
    }
    fn validate_ticket_length(ticket: &str) -> Result<()> {
        Invitation::parse(ticket)?;
        Ok(())
    }
    pub fn inspect_ticket(&self, ticket: &str) -> Result<Vec<u8>> {
        if ticket.starts_with(crate::discovery::PREFIX) {
            return self.inspect_listing(ticket);
        }
        let (owner, i) = Invitation::parse(ticket)?;
        ensure!(
            self.owner(&i.mission)? == owner && !self.conflicted(&i.mission)?,
            "unavailable invitation"
        );
        let enabled:bool=self.connection.query_row("SELECT EXISTS(SELECT 1 FROM invitations WHERE id=?1 AND mission=?2 AND revoked=0 AND expires_ms>?3)",params![ticket_id(ticket),i.mission,i64::try_from(now())?],|r|r.get(0))?;
        ensure!(enabled, "unavailable invitation");
        let event = self
            .event(&i.mission)?
            .ok_or_else(|| anyhow!("missing mission"))?;
        Invitation::review(ticket, event.bytes())?;
        Ok(event.bytes().to_vec())
    }
    pub fn revoke_invitations(&mut self, identity: &Identity, mission: &str) -> Result<()> {
        ensure!(
            self.owner(mission)? == identity.public_key(),
            "owner required"
        );
        self.connection.execute(
            "UPDATE invitations SET revoked=1 WHERE mission=?1",
            [mission],
        )?;
        Ok(())
    }
    pub fn receive_offer(&mut self, ticket: &str, raw: &str, remote: &str) -> Result<String> {
        self.inspect_ticket(ticket)?;
        let i = Access::parse(ticket)?;
        let (author, o) = Offer::verify(raw)?;
        ensure!(
            o.mission == i.mission
                && o.invitation == ticket_id(ticket)
                && o.contact.endpoint == remote
                && o.contact.expires_ms > now(),
            "offer binding mismatch"
        );
        if self.is_revoked(&i.mission, &author)? {
            return Ok("revoked".into());
        }
        let existing = self
            .members(&i.mission)?
            .into_iter()
            .find(|m| m.author == author);
        if let Some(member) = existing {
            ensure!(member.endpoint == remote, "endpoint mismatch");
            return Ok(if self.can_read(&i.mission, remote)? {
                "admitted"
            } else {
                "revoked"
            }
            .into());
        }
        let prior: Option<String> = self
            .connection
            .query_row(
                "SELECT status FROM join_requests WHERE mission=?1 AND author=?2",
                params![i.mission, author],
                |r| r.get(0),
            )
            .optional()?;
        if o.reviewed_revision != self.control_state(&i.mission)?.lifecycle.terms_revision {
            return Ok("review_required".into());
        }
        if let Some(status) = prior {
            if status == "review_required" || status == "pending" {
                self.connection.execute("UPDATE join_requests SET offer=?3,endpoint=?4,status='pending' WHERE mission=?1 AND author=?2",params![i.mission,author,raw,remote])?;
                return Ok("pending".into());
            }
            return Ok(status);
        }
        let count: u32 =
            self.connection
                .query_row("SELECT count(*) FROM join_requests", [], |r| r.get(0))?;
        let local: u32 = self.connection.query_row(
            "SELECT count(*) FROM join_requests WHERE mission=?1",
            [&i.mission],
            |r| r.get(0),
        )?;
        ensure!(count < 1024 && local < 128, "admission inbox full");
        self.connection.execute(
            "INSERT INTO join_requests(mission,author,endpoint,offer) VALUES(?1,?2,?3,?4)",
            params![i.mission, author, remote, raw],
        )?;
        Ok("pending".into())
    }
    pub fn requests(&self, mission: &str) -> Result<Vec<JoinView>> {
        let current = self.control_state(mission)?.lifecycle.terms_revision;
        let mut q=self.connection.prepare("SELECT author,endpoint,status,offer FROM join_requests WHERE mission=?1 ORDER BY rowid LIMIT 128")?;
        q.query_map([mission], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .map(|row| {
            let (author, endpoint, mut status, raw) = row?;
            if status == "pending"
                && !Offer::verify(&raw).is_ok_and(|(_, o)| o.reviewed_revision == current)
            {
                status = "review_required".into();
            }
            Ok(JoinView {
                mission: mission.into(),
                author,
                endpoint,
                status,
            })
        })
        .collect()
    }
    pub fn decide_join(
        &mut self,
        identity: &Identity,
        mission: &str,
        author: &str,
        admit: bool,
    ) -> Result<()> {
        ensure!(
            self.owner(mission)? == identity.public_key(),
            "owner required"
        );
        let (raw, status): (String, String) = self.connection.query_row(
            "SELECT offer,status FROM join_requests WHERE mission=?1 AND author=?2",
            params![mission, author],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        ensure!(status == "pending", "request is not pending");
        let (signer, offer) = Offer::verify(&raw)?;
        ensure!(
            signer == author && offer.mission == mission,
            "invalid stored offer"
        );
        if admit {
            ensure!(
                offer.reviewed_revision == self.control_state(mission)?.lifecycle.terms_revision,
                "contributor must review changed terms"
            );
            // The signed grant is authoritative. A crash before the inbox update
            // is recovered from membership, never by issuing a second grant.
            if !self.members(mission)?.iter().any(|m| m.author == author) {
                self.append(
                    identity,
                    mission,
                    Payload::MemberAdmitted {
                        member: author.into(),
                        endpoint: offer.contact.endpoint,
                    },
                )?;
            }
        }
        self.connection.execute(
            "UPDATE join_requests SET status=?3 WHERE mission=?1 AND author=?2",
            params![mission, author, if admit { "admitted" } else { "denied" }],
        )?;
        Ok(())
    }
    pub fn save_contact(&mut self, mission: &str, signed: &str) -> Result<()> {
        let (author, c) = Contact::verify(signed)?;
        ensure!(
            c.expires_ms > now() && c.expires_ms <= now() + WEEK,
            "expired contact"
        );
        ensure!(
            self.members(mission)?
                .iter()
                .any(|m| m.author == author && m.endpoint == c.endpoint && !m.revoked)
                && self.can_read(mission, &c.endpoint)?,
            "unknown contact"
        );
        self.connection.execute("INSERT INTO contacts(mission,author,signed,expires_ms) VALUES(?1,?2,?3,?4) ON CONFLICT(mission,author) DO UPDATE SET signed=excluded.signed,expires_ms=excluded.expires_ms WHERE excluded.expires_ms>=contacts.expires_ms",params![mission,author,signed,i64::try_from(c.expires_ms)?])?;
        Ok(())
    }
    pub fn contacts(&self, mission: &str) -> Result<Vec<String>> {
        let mut q=self.connection.prepare("SELECT signed FROM contacts WHERE mission=?1 AND expires_ms>?2
            AND NOT EXISTS(SELECT 1 FROM revocations WHERE revocations.mission=contacts.mission AND member=contacts.author)
            AND NOT EXISTS(SELECT 1 FROM revocation_notices WHERE revocation_notices.mission=contacts.mission AND member=contacts.author)
            AND NOT EXISTS(SELECT 1 FROM withdrawals WHERE withdrawals.mission=contacts.mission AND author=contacts.author)
            ORDER BY author LIMIT 1024")?;
        Ok(
            q.query_map(params![mission, i64::try_from(now())?], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?,
        )
    }
    pub fn remember_join(
        &mut self,
        ticket: &str,
        inspection: &crate::review::Inspection,
    ) -> Result<String> {
        let review = inspection.review(ticket, None)?;
        ensure!(
            !self.locally_withdrawn(&review.mission)?,
            "participation withdrawn"
        );
        let count: u32 =
            self.connection
                .query_row("SELECT count(*) FROM local_joins", [], |r| r.get(0))?;
        ensure!(count < 128, "join limit");
        let tx = self.connection.transaction()?;
        let changed=tx.execute("INSERT INTO local_joins(mission,ticket,genesis) VALUES(?1,?2,?3) ON CONFLICT(mission) DO UPDATE SET ticket=excluded.ticket,status='pending' WHERE local_joins.status IN ('pending','expired','review_required')",params![review.mission,ticket,hex::decode(&inspection.genesis)?])?;
        ensure!(changed == 1, "join already decided");
        tx.execute("INSERT INTO join_reviews(mission,proof) VALUES(?1,?2) ON CONFLICT(mission) DO UPDATE SET proof=excluded.proof",params![review.mission,inspection.proof])?;
        tx.commit()?;
        Ok(review.mission)
    }
    pub fn local_joins(&self) -> Result<Vec<LocalJoinView>> {
        let mut q = self.connection.prepare(
            "SELECT mission,genesis,status FROM local_joins ORDER BY rowid DESC LIMIT 128",
        )?;
        let rows = q.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Vec<u8>>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        rows.map(|r| {
            let (mission, bytes, status) = r?;
            let e = Event::verify(&bytes)?;
            let Payload::MissionCreated { definition, .. } = e.body.payload else {
                anyhow::bail!("invalid stored invitation")
            };
            Ok(LocalJoinView {
                mission,
                name: definition.name,
                status,
            })
        })
        .collect()
    }
    pub fn pending_tickets(&mut self) -> Result<Vec<String>> {
        let candidates = {
            let mut q=self.connection.prepare("SELECT mission,ticket FROM local_joins WHERE status='pending' ORDER BY rowid LIMIT 128")?;
            q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        let mut tickets = vec![];
        for (mission, ticket) in candidates {
            if Access::parse(&ticket).is_ok() {
                tickets.push(ticket);
            } else {
                self.join_status(&mission, "expired")?;
            }
        }
        Ok(tickets)
    }
    pub fn join_status(&mut self, mission: &str, status: &str) -> Result<()> {
        ensure!(
            [
                "pending",
                "admitted",
                "denied",
                "revoked",
                "expired",
                "withdrawn",
                "review_required"
            ]
            .contains(&status),
            "invalid join status"
        );
        self.connection.execute(
            "UPDATE local_joins SET status=?2 WHERE mission=?1 AND status!='withdrawn'",
            params![mission, status],
        )?;
        Ok(())
    }
}
