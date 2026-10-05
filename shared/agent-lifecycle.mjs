// Presentation only. The host revalidates authority and consent before acting.
// Process observations take precedence over desired mission state.
export function agentContributorLabel(agent, mission, local = false) {
  if (local) return "you";
  const name = agent?.identity?.contributor_name?.trim();
  // Older signed preparations contain the sender's default display name.
  // Never show that first-person label as the receiving person's identity.
  if (name && name.toLowerCase() !== "you") return name;
  if (agent?.contributor && agent.contributor === mission.owner)
    return "the mission owner";
  return agent?.contributor
    ? `Participant ${agent.contributor.slice(0, 8)}`
    : "another contributor";
}

export function agentLifecycle({
  agent,
  contribution,
  execution,
  observation,
  mission,
  now = Date.now(),
}) {
  const local = !!contribution;
  const ownerHere =
    local && !!agent?.contributor && agent.contributor === mission.owner;
  const result = (state, label, reason, action = null, attention = false) => ({
    state,
    label,
    reason,
    action,
    attention,
    local,
    observedAt: execution?.observedAt ?? null,
  });
  const record = execution?.record;
  if (
    !local &&
    observation &&
    observation.expiresAt > now &&
    observation.report.control === mission.lifecycle?.revision
  ) {
    const state = observation.report.state;
    const labels = {
      setup: "Setting up",
      sign_in: "Sign-in needed",
      ready: "Ready · waiting",
      awaiting_approval: "Waiting for contributor approval",
      awaiting_owner: "Waiting for owner authorization",
      awaiting_direction: "Waiting for direction",
      review_required: "Contributor review needed",
      starting: "Starting",
      running: "Running",
      idle: "Idle",
      stopping: "Stopping",
      stopped: "Stopped",
      recovery_required: "Stop unconfirmed",
    };
    const ended = ["closed", "archived"].includes(mission.lifecycle.phase);
    return result(
      ended && state === "stopped" ? "ended" : state,
      ended && state === "stopped"
        ? "Work ended"
        : labels[state] || "Reported status",
      `${agentContributorLabel(agent, mission)} reports this status. Last update ${Math.max(0, Math.floor((now - observation.report.issued_ms) / 1000))}s ago.`,
      null,
      state === "recovery_required" ||
        (ended && ["running", "starting", "idle"].includes(state)),
    );
  }
  if (!local)
    return result(
      "unknown",
      "Status unknown",
      `Execution is controlled by ${agentContributorLabel(agent, mission)}. ${observation ? "The last report expired; disconnection does not confirm a stop." : "No live execution report is available."}`,
    );
  if (!execution || execution.error || now - execution.observedAt > 15000)
    return result(
      "unknown",
      "Status unknown",
      execution?.error || "Refreshing this device’s execution status.",
      "inspect",
      true,
    );
  const reason = record?.reason;
  if (record?.status === "recovery_required")
    return result("unknown", "Stop unconfirmed", reason, "recover", true);
  if (record?.status === "stopping")
    return result("stopping", "Stopping", reason);
  if (["reserving", "launching"].includes(record?.status))
    return result(
      "starting",
      "Starting",
      reason || "Starting the approved turn.",
    );
  if (record?.status === "running")
    return result(
      "running",
      "Running",
      mission.lifecycle.phase === "paused"
        ? "Mission paused; waiting for this run to stop."
        : ["closed", "archived"].includes(mission.lifecycle.phase)
          ? "Mission ended; waiting for confirmed process termination."
          : reason,
      null,
      ["closed", "archived"].includes(mission.lifecycle.phase),
    );
  if (record?.status === "waiting") return result("idle", "Idle", reason);
  if (contribution.status === "revoked" || contribution.sharedAgent?.withdrawn)
    return result(
      "withdrawn",
      "Withdrawn",
      "Local consent withdrawn. Saved work remains available.",
    );
  if (
    contribution.nodeBinding?.revision !== mission.lifecycle.terms_revision ||
    agent?.status === "review_required"
  )
    return result(
      "waiting",
      "Review required",
      "Mission instructions changed. Review the new terms before preparing a replacement.",
      "review",
      true,
    );
  if (record?.status === "preparing")
    return result("setup", "Setting up", reason, "cancel_setup");
  if (
    execution.authentication &&
    ["starting", "waiting"].includes(execution.authentication.status)
  )
    return result(
      "setup",
      "Sign-in in progress",
      "Complete the provider’s sign-in in this agent’s details.",
      "login",
      true,
    );
  if (!record || record.status === "failed")
    return result(
      "setup",
      record ? "Setup interrupted" : "Setup needed",
      reason || "Prepare this agent’s isolated environment.",
      "prepare",
      true,
    );
  if (execution.authentication?.status === "failed")
    return result(
      "setup",
      "Sign-in needs attention",
      execution.authentication.text,
      "login",
      true,
    );
  if (record.status === "login_required")
    return result("setup", "Sign-in needed", reason, "login", true);
  if (mission.lifecycle.phase === "paused")
    return result(
      "waiting",
      "Waiting",
      "The mission owner has paused this mission.",
      "mission",
    );
  if (["closed", "archived"].includes(mission.lifecycle.phase))
    return result(
      "waiting",
      "Work ended",
      "This mission is closed to execution. Saved work remains available.",
    );
  if (
    record.status === "stopped" &&
    mission.lifecycle.readiness &&
    mission.lifecycle.phase === "preparing"
  )
    return result(
      "ready",
      "Plan ready",
      "Waiting for the mission owner to review the plan and Start.",
      "mission",
    );
  if (execution.agreement?.status === "active")
    return result(
      "waiting",
      "Ready · waiting",
      execution.agreement.message ||
        "Your approved contribution will continue when work is authorized.",
    );
  if (record.status === "stopped")
    return result("stopped", "Stopped", reason, "resume", true);
  if (agent?.status === "waiting_for_appointment")
    return result(
      "waiting",
      "Waiting",
      "Waiting for the mission owner to appoint a Coordinator.",
      "mission",
    );
  const planning =
    mission.lifecycle.phase === "preparing" &&
    !!mission.lifecycle.coordinator &&
    mission.lifecycle.coordinator?.identity.author === agent?.identity.author;
  if (mission.lifecycle.phase === "preparing" && !planning)
    return result(
      "waiting",
      "Waiting",
      ownerHere
        ? "Waiting for you to review and start the mission."
        : "Waiting for the mission owner to start the mission.",
      "mission",
    );
  if (agent?.status === "waiting_for_direction")
    return result(
      "waiting",
      "Waiting",
      "Waiting for direction from the Coordinator or mission owner.",
      "direction",
    );
  if (execution.permissionProblem)
    return result(
      "waiting",
      "Needs review",
      execution.permissionProblem,
      "inspect",
      true,
    );
  const permission = execution.permissions?.at(-1);
  if (!permission)
    return result(
      "waiting",
      "Waiting",
      ownerHere
        ? planning
          ? "Review and approve a short planning session on this Mac."
          : "Review and approve this agent’s next run on this Mac."
        : "Waiting for the mission owner to issue a current run permission.",
      "permission",
      ownerHere,
    );
  if (!permission.consent)
    return result(
      "waiting",
      "Approval needed",
      "Waiting for your approval on this device.",
      "approve",
      true,
    );
  return result(
    "ready",
    "Ready to start",
    planning
      ? "Ready to prepare the mission plan."
      : "Ready to run under the current direction.",
    "run",
    true,
  );
}

export function lifecycleSummary(states) {
  const counts = new Map();
  for (const item of states)
    counts.set(item.label, (counts.get(item.label) || 0) + 1);
  return [...counts]
    .map(([label, count]) => `${count} ${label.toLowerCase()}`)
    .join(" · ");
}
