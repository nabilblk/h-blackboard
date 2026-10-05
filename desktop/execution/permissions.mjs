import { createHash } from "node:crypto";
import { policyDigest } from "./contract.mjs";

export function executionBinding(contribution) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: contribution.id,
        workspace: contribution.workspaceIdentity,
        runtime: contribution.runtime,
        limits: contribution.limits,
        terms: contribution.nodeBinding,
        policy: policyDigest(contribution.runtime),
      }),
    )
    .digest("hex");
}

// Selection hints only. executionContext, consent, the signed ledger and the
// monotonic lease are checked again immediately before reservation and launch.
export function currentPermissions(
  { contribution, context, governance },
  record,
  now = Date.now(),
) {
  return governance.grants.filter((grant) => {
    if (
      grant.registration !== contribution.sharedAgent?.registration ||
      grant.control !== context.lifecycle.revision ||
      ((grant.consent || grant.consent_binding != null) &&
        grant.consent_binding !== executionBinding(contribution)) ||
      grant.sealed ||
      grant.revoked ||
      grant.id === record?.grant ||
      grant.turns <= grant.charged + grant.reserved ||
      Math.min(grant.expires_ms, grant.issued_ms + grant.offline_ms) <= now ||
      grant.issued_ms > now + 30000 ||
      (grant.execution === record?.execution &&
        grant.generation <= record.generation)
    )
      return false;
    if (grant.purpose === "planning")
      return (
        context.lifecycle.phase === "preparing" &&
        context.agent.status === "waiting_for_start" &&
        context.lifecycle.coordinator?.identity.author ===
          context.agent.identity.author
      );
    return (
      grant.purpose === "work" &&
      context.lifecycle.phase === "active" &&
      context.agent.status === "direction_assigned" &&
      context.agent.direction?.id === grant.direction
    );
  });
}

export class DirectionChanged extends Error {
  constructor(previous, current) {
    super(
      "Direction changed. The previous execution must stop; review the new direction and approve a fresh permission to resume the saved session.",
    );
    this.code = "direction_changed";
    this.previous = previous;
    this.current = current;
  }
}
