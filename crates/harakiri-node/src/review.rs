//! A live, nonce-bound owner attestation of current mission terms. Pre-admission
//! review discloses no Main messages, private records or arbitrary writer history.
use crate::{
    admission::{Access, Invitation, InvitationReview, ticket_id},
    contact::now,
    store::Store,
};
use anyhow::{Result, ensure};
use harakiri_protocol::{Identity, MissionDefinition, claims, event::is_hash};
use serde::{Deserialize, Serialize};

const DOMAIN: &[u8] = b"harakiri/mission-review/1";
const TTL: u64 = 5 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Inspection {
    pub genesis: String,
    pub proof: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Terms {
    version: u16,
    mission: String,
    reference: String,
    nonce: String,
    revision: String,
    definition: MissionDefinition,
    issued_ms: u64,
    expires_ms: u64,
}
impl Inspection {
    pub fn review(&self, reference: &str, nonce: Option<&str>) -> Result<InvitationReview> {
        ensure!(
            self.genesis.len() <= harakiri_protocol::limits::MAX_EVENT_BYTES * 2,
            "oversize genesis"
        );
        let root = hex::decode(&self.genesis)?;
        let mut review = Invitation::review(reference, &root)?;
        let (owner, t): (String, Terms) = claims::verify(DOMAIN, &self.proof)?;
        t.definition.validate()?;
        ensure!(
            t.version == 1
                && t.mission == review.mission
                && owner == review.owner
                && t.reference == ticket_id(reference)
                && is_hash(&t.revision)
                && is_hash(&t.nonce)
                && t.issued_ms <= now() + 60_000
                && t.expires_ms > now()
                && t.expires_ms > t.issued_ms
                && t.expires_ms - t.issued_ms <= TTL
                && nonce.is_none_or(|n| n == t.nonce)
                && t.definition.policy.is_some(),
            "invalid or stale mission review"
        );
        // Discovery/private admission policy cannot change through instructions.
        ensure!(
            t.definition.policy.as_ref().map(|p| &p.participation)
                == review.definition.policy.as_ref().map(|p| &p.participation),
            "review admission policy mismatch"
        );
        review.definition = t.definition;
        review.reviewed_revision = t.revision;
        review.expires_ms = review.expires_ms.min(t.expires_ms);
        Ok(review)
    }
}
impl Store {
    pub fn inspect_current(
        &self,
        identity: &Identity,
        reference: &str,
        nonce: &str,
    ) -> Result<Inspection> {
        ensure!(is_hash(nonce), "invalid review challenge");
        let access = Access::parse(reference)?;
        ensure!(
            access.owner == identity.public_key(),
            "owner inspection required"
        );
        let root = self.inspect_ticket(reference)?;
        let p = self.control_state(&access.mission)?;
        let issued_ms = now();
        let proof = identity.claim(
            DOMAIN,
            &Terms {
                version: 1,
                mission: access.mission,
                reference: ticket_id(reference),
                nonce: nonce.into(),
                revision: p.lifecycle.terms_revision,
                definition: p.definition,
                issued_ms,
                expires_ms: issued_ms + TTL,
            },
        )?;
        Ok(Inspection {
            genesis: hex::encode(root),
            proof,
        })
    }
    /// Recover the exact local approval after a restart; receipt expiry limits
    /// initial acceptance, not this durable record of what the person approved.
    pub fn reviewed_join_revision(&self, mission: &str, reference: &str) -> Result<String> {
        let proof: String = self.connection.query_row(
            "SELECT proof FROM join_reviews WHERE mission=?1",
            [mission],
            |r| r.get(0),
        )?;
        let (owner, t): (String, Terms) = claims::verify(DOMAIN, &proof)?;
        let a = Access::parse(reference)?;
        ensure!(
            owner == a.owner
                && t.version == 1
                && t.mission == mission
                && t.reference == ticket_id(reference)
                && is_hash(&t.revision),
            "invalid stored review"
        );
        Ok(t.revision)
    }
}
