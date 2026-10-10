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
        policy: policyDigest(contribution.runtime, contribution.networkAccess),
        ...(contribution.networkRevision
          ? { networkRevision: contribution.networkRevision }
          : {}),
      }),
    )
    .digest("hex");
}

// Fresh human approval may follow a policy change before an older, consented
// grant ever launched. Seal that unusable permission so it cannot strand the
// allocation. The signed ledger still refuses unsettled reservations.
export async function retireSupersededConsent(node, contribution, ledger) {
  const binding = executionBinding(contribution);
  const stale = ledger.grants.filter(
    (g) =>
      g.registration === contribution.sharedAgent?.registration &&
      !g.sealed &&
      g.reserved === 0 &&
      g.consent &&
      g.consent_binding &&
      g.consent_binding !== binding,
  );
  if (!stale.length) return ledger;
  const channel = node.openResourceLedger(contribution.id);
  try {
    for (const grant of stale) {
      const current = node.contributors.store
        .read()
        .contributions.find((c) => c.id === contribution.id);
      if (!current || executionBinding(current) !== binding)
        throw new Error(
          "Local access changed during approval. Review it again.",
        );
      await channel.seal(grant.id);
    }
  } finally {
    channel.close();
  }
  return node.handle("governance", { mission: contribution.mission.missionId });
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
