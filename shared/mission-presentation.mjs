import { agentContributorLabel, agentLifecycle } from "./agent-lifecycle.mjs";

// Presentation only. No action here grants authority. Native commands always
// recheck membership, the current revision, local consent and execution limits.
const runtimeNames = {
  grok: "Grok Build",
  claude: "Claude Code",
  codex: "Codex",
};
const phases = {
  preparing: "Preparing",
  active: "Active",
  paused: "Paused",
  closed: "Closed",
  archived: "Archived",
};
const groups = {
  setup: "setup",
  sign_in: "setup",
  starting: "setup",
  running: "working",
  idle: "waiting",
  ready: "waiting",
  waiting: "waiting",
  awaiting_approval: "waiting",
  awaiting_owner: "waiting",
  awaiting_direction: "waiting",
  review_required: "waiting",
  stopping: "stopping",
  stopped: "stopped",
  ended: "stopped",
  withdrawn: "stopped",
  recovery_required: "unknown",
  unknown: "unknown",
};
const labels = {
  setup: "Setting up",
  working: "Working",
  waiting: "Waiting",
  stopping: "Stopping",
  stopped: "Stopped",
  unknown: "Unknown",
};

export function agentPresentation(input) {
  const {
    agent,
    contribution,
    execution,
    observation,
    mission,
    viewer,
    now = Date.now(),
  } = input;
  const lifecycle = agentLifecycle(input);
  const local = !!contribution;
  const isOwner = viewer === mission.owner;
  const phase = mission.lifecycle.phase;
  const ended = ["closed", "archived"].includes(phase);
  const fresh = local
    ? !!execution && !execution.error && now - execution.observedAt <= 15000
    : !!observation &&
      observation.expiresAt > now &&
      observation.report.control === mission.lifecycle.revision;
  const record = fresh && local ? execution.record : null;
  const observed = local
    ? record?.status
    : fresh
      ? observation.report.state
      : null;
  // A confirmed termination is a fact even while mission authorization is paused.
  const stopped = observed === "stopped";
  const state =
    stopped && phase === "active" && execution?.agreement?.status === "active"
      ? "waiting"
      : stopped
        ? "stopped"
        : (groups[lifecycle.state] ?? "unknown");
  const planning =
    phase === "preparing" &&
    !!agent &&
    mission.lifecycle.coordinator?.identity.author === agent.identity.author;
  let cause = lifecycle.action ?? lifecycle.state;
  let reason = lifecycle.reason || "Inspect the latest execution report.";
  let responsible = agentContributorLabel(agent, mission, local);
  let action = null;
  const link = (label, destination = "agent") => ({
    label,
    destination,
    agent: agent?.id ?? null,
    contribution: contribution?.id ?? null,
  });
  let urgent =
    observed === "recovery_required" ||
    (["paused", "closed", "archived"].includes(phase) &&
      [
        "running",
        "waiting",
        "idle",
        "reserving",
        "launching",
        "starting",
      ].includes(observed));
  if (!fresh) {
    cause = "observation_missing";
    reason = local
      ? "Current activity on this Mac is unknown."
      : `Current activity is unknown. Waiting for a fresh report from ${responsible}.`;
    if (local) action = link("Inspect agent");
    urgent = ["paused", "closed", "archived"].includes(phase);
  } else if (observed === "recovery_required") {
    cause = "stop_unconfirmed";
    reason = local
      ? "The last stop could not be confirmed on this Mac."
      : `Waiting for ${responsible} to confirm the stop.`;
    if (local) action = link("Confirm stop");
  } else if (urgent || state === "stopping") {
    cause = "stop_pending";
    reason = local
      ? "Waiting for this Mac to confirm the stop."
      : `Waiting for ${responsible} to confirm the stop.`;
    if (local && urgent) action = link("Inspect stop");
  } else if (
    ["working", "setup"].includes(state) &&
    [
      "running",
      "starting",
      "reserving",
      "launching",
      "preparing",
      "setup",
    ].includes(observed)
  ) {
    cause = observed === "running" ? "executing" : "preparing_environment";
    reason =
      observed === "running"
        ? planning
          ? "Preparing the mission plan."
          : "Executing the approved work."
        : "Preparing the isolated environment.";
  } else if (ended) {
    cause = "mission_ended";
    reason = stopped
      ? `Mission ${phase}; this agent is stopped. Saved work is available.`
      : "Mission execution is closed; inspect saved work.";
  } else if (phase === "paused") {
    cause = "mission_paused";
    reason = stopped
      ? "Process stopped. The mission is paused."
      : "Waiting for the mission owner to resume.";
    responsible = isOwner ? "you" : "the mission owner";
  } else if (lifecycle.action === "review" || observed === "review_required") {
    cause = "terms_changed";
    reason = local
      ? "Mission instructions changed. Review them before continuing."
      : `Waiting for ${responsible} to review changed instructions.`;
    if (local) action = link("Review changed instructions");
  } else if (lifecycle.action === "login" || observed === "sign_in") {
    cause =
      execution?.authentication?.failure === "expired"
        ? "sign_in_expired"
        : "sign_in";
    const runtime =
      runtimeNames[agent?.identity.runtime ?? contribution?.runtime] ??
      "the provider";
    reason = local
      ? cause === "sign_in_expired"
        ? `${runtime} sign-in expired. Your environment is saved.`
        : `Sign in to ${runtime} inside this agent’s environment.`
      : `Waiting for ${responsible} to sign in to ${runtime}.`;
    if (local)
      action = link(
        cause === "sign_in_expired"
          ? "Get a fresh sign-in"
          : `Sign in to ${runtime}`,
      );
  } else if (lifecycle.action === "prepare") {
    cause = "setup_required";
    if (local)
      action = link(
        record?.status === "failed" ? "Continue setup" : "Prepare agent",
      );
  } else if (execution?.agreement?.status === "active") {
    cause = execution.agreement.waitingFor ?? "approved_wait";
    responsible = [
      "mission_start",
      "mission_resume",
      "owner_permission",
    ].includes(cause)
      ? isOwner
        ? "you"
        : "the mission owner"
      : cause === "direction"
        ? "the Coordinator or mission owner"
        : cause === "capacity" || cause === "new_work"
          ? "automatic within your approval"
          : responsible;
    reason =
      execution.agreement.message ||
      "Waiting for authorized work within your approval.";
  } else if (
    phase === "preparing" &&
    (!planning || !mission.lifecycle.start_blockers.length)
  ) {
    cause = "mission_start";
    responsible = isOwner ? "you" : "the mission owner";
    reason = "Waiting for the mission owner to review and start.";
  } else if (
    agent?.status === "waiting_for_direction" ||
    observed === "awaiting_direction"
  ) {
    cause = "direction";
    responsible = isOwner
      ? "you or the Coordinator"
      : "the Coordinator or mission owner";
    reason = "Waiting for a direction in this mission.";
    if (isOwner) action = link("Give direction");
  } else if (
    observed === "awaiting_owner" ||
    (lifecycle.action === "permission" && !isOwner)
  ) {
    cause = "owner_permission";
    responsible = isOwner ? "you" : "the mission owner";
    reason = "Waiting for the mission owner to authorize this contribution.";
    if (isOwner) action = link("Review authorization");
  } else if (observed === "awaiting_approval") {
    cause = "local_approval";
    reason = `Waiting for ${responsible} to approve execution on their Mac.`;
  } else if (
    local &&
    ["permission", "approve", "run", "resume"].includes(lifecycle.action)
  ) {
    cause = planning ? "planning_approval" : "local_approval";
    reason = planning
      ? "Allow a bounded session to prepare the plan."
      : "Review how this agent may continue on this Mac.";
    action = link(planning ? "Review planning session" : "Review contribution");
  } else if (local && lifecycle.attention) action = link("Inspect agent");
  if (
    !local &&
    ["ready", "stopped", "idle", "setup", "starting"].includes(observed) &&
    !urgent &&
    !ended &&
    phase !== "paused" &&
    !["mission_start", "direction"].includes(cause)
  ) {
    reason =
      observed === "idle"
        ? "Session is waiting for new work."
        : observed === "stopped"
          ? "Contributor reports this process stopped."
          : observed === "setup" || observed === "starting"
            ? `Environment setup is in progress on ${responsible}’s device.`
            : `Waiting for execution on ${responsible}’s device.`;
  }
  return {
    state,
    label: labels[state],
    cause,
    reason,
    responsible,
    action,
    urgent,
    local,
    fresh,
    technicalState: observed ?? lifecycle.state,
    observedAt: local
      ? (execution?.observedAt ?? null)
      : (observation?.report.issued_ms ?? null),
    source: local ? "Observed on this Mac" : "Contributor’s signed report",
    reference: local ? contribution.id : (agent?.id ?? null),
    attention: !!action || urgent,
    stopConfirmed: stopped,
  };
}

// Also consumed by desktop notifications. IDs describe the underlying request,
// not whether a banner or panel has been read.
export function resultsReadyForReview(mission, criteria = []) {
  return (
    ["active", "paused"].includes(mission.lifecycle.phase) &&
    criteria.length > 0 &&
    criteria.every((c) => c.met && !c.stale)
  );
}

export function missionDecisions({
  mission,
  viewer,
  requests = [],
  criteria = [],
  startJobs = [],
}) {
  if (
    mission.conflicted ||
    viewer !== mission.owner ||
    ["closed", "archived"].includes(mission.lifecycle.phase)
  )
    return [];
  const decisions = [];
  const unfinished = startJobs.find(
    (j) => !["complete", "cancelled"].includes(j.phase),
  );
  if (unfinished)
    decisions.push({
      id: `start-review:${unfinished.id}`,
      kind: "start",
      priority: 5,
      title: "Finish your saved Start review",
      reason:
        "Mission Start and local approvals are saved separately. Continue or cancel the unfinished step.",
      responsible: "you",
      action: {
        label: "Continue Start review",
        destination: "controls",
        review: true,
      },
    });
  const pending = requests.filter((r) => r.status === "pending");
  if (pending.length)
    decisions.push({
      id: `admission:${pending
        .map((r) => r.author)
        .sort()
        .join(":")}`,
      kind: "admission",
      priority: 30,
      title: `${pending.length} ${pending.length === 1 ? "person wants" : "people want"} to join`,
      reason: "Review who can access this mission.",
      responsible: "you",
      action: { label: "Review people", destination: "people" },
    });
  if (
    !unfinished &&
    ["preparing", "paused"].includes(mission.lifecycle.phase) &&
    !mission.lifecycle.start_blockers.length
  )
    decisions.push({
      id: `start:${mission.lifecycle.revision}`,
      kind: "start",
      priority: 20,
      title:
        mission.lifecycle.phase === "paused"
          ? "Review the plan to resume"
          : mission.definition.policy?.coordination === "coordinated"
            ? "Plan ready for your review"
            : "Ready for your Start review",
      reason: "Review the plan and the agents authorized to run.",
      responsible: "you",
      action: {
        label:
          mission.lifecycle.phase === "paused"
            ? "Review and resume"
            : mission.definition.policy?.coordination === "coordinated"
              ? "Review plan"
              : "Review and start",
        destination: "controls",
        review: true,
      },
    });
  if (
    !unfinished &&
    mission.lifecycle.phase === "paused" &&
    mission.lifecycle.plan &&
    mission.lifecycle.start_blockers.includes("coordinator_not_ready")
  )
    decisions.push({
      id: `resume-plan:${mission.lifecycle.revision}`,
      kind: "start",
      priority: 20,
      title: "Review the plan to resume",
      reason:
        "Confirm the plan, then let the Coordinator prepare a fresh readiness acknowledgment. You approve Start separately.",
      responsible: "you",
      action: {
        label: "Review plan to resume",
        destination: "controls",
        review: true,
      },
    });
  if (resultsReadyForReview(mission, criteria))
    decisions.push({
      id: `results:${mission.lifecycle.revision}`,
      kind: "results",
      priority: 40,
      title: "Results are ready for your review",
      reason:
        "Criteria are reported met. Inspect the evidence before accepting results.",
      responsible: "you",
      action: { label: "Review results", destination: "results" },
    });
  return decisions;
}

export function missionPresentation({
  mission,
  viewer,
  agents = [],
  contributions = [],
  states = {},
  observations = {},
  requests = [],
  criteria = [],
  acceptedResult = null,
  startJobs = [],
  loaded = true,
  blocked = false,
  access = null,
  now = Date.now(),
}) {
  const phase = mission.lifecycle.phase;
  const ended = ["closed", "archived"].includes(phase);
  const isOwner = viewer === mission.owner;
  const contributionByAgent = new Map(
    contributions
      .filter((c) => c.mission.missionId === mission.id)
      .map((c) => [c.sharedAgent?.registration, c]),
  );
  const rows = agents.map((agent) => {
    const contribution = contributionByAgent.get(agent.id);
    return {
      agent,
      status: agentPresentation({
        agent,
        contribution,
        execution: contribution ? states[contribution.id] : undefined,
        observation: observations[agent.id],
        mission,
        viewer,
        now,
      }),
    };
  });
  const decisions = missionDecisions({
    mission,
    viewer,
    requests,
    criteria,
    startJobs,
  });
  const waiting = [];
  for (const { agent, status } of rows) {
    const item = {
      id: `agent:${agent.id}:${status.cause}`,
      kind: "agent",
      title: agent.identity.label,
      reason: status.reason,
      responsible: status.responsible,
      priority: status.urgent ? 0 : 50,
      action: status.action ?? {
        label: "Inspect agent",
        destination: "agent",
        agent: agent.id,
      },
      urgent: status.urgent,
    };
    if (status.action) decisions.push(item);
    else if (
      ["waiting", "unknown", "setup", "stopping"].includes(status.state) ||
      status.urgent
    )
      waiting.push(item);
  }
  const coordinator = rows.find(
    ({ agent }) =>
      agent.identity.author === mission.lifecycle.coordinator?.identity.author,
  );
  if (
    !ended &&
    loaded &&
    phase === "preparing" &&
    mission.definition.policy?.coordination === "coordinated" &&
    !mission.lifecycle.coordinator
  ) {
    const item = {
      id: `setup:${mission.lifecycle.revision}`,
      kind: "setup",
      priority: 10,
      title: isOwner
        ? "Set up your Coordinator"
        : "Waiting for the mission owner",
      reason: isOwner
        ? "Choose an agent to prepare the plan. You approve planning and mission Start separately."
        : "The owner needs to appoint a Coordinator before planning can begin.",
      responsible: isOwner ? "you" : "the mission owner",
      action: {
        label: isOwner ? "Set up Coordinator" : "Inspect mission",
        destination: isOwner ? "setup" : "controls",
        role: "coordinator",
      },
    };
    (isOwner ? decisions : waiting).push(item);
  }
  if (mission.conflicted)
    decisions.unshift({
      id: "history-conflict",
      kind: "conflict",
      priority: -1,
      title: "History needs recovery",
      reason: "Conflicting signed records prevent new work.",
      responsible: isOwner ? "you" : "the mission owner",
      action: { label: "Inspect history", destination: "technical" },
      urgent: true,
    });
  const ordered = decisions.sort(
    (a, b) => a.priority - b.priority || a.id.localeCompare(b.id),
  );
  const counts = {
    working: 0,
    setup: 0,
    waiting: 0,
    stopped: 0,
    stopping: 0,
    unknown: 0,
  };
  for (const row of rows) counts[row.status.state]++;
  const activity = rows.length
    ? Object.entries(counts)
        .filter(([, n]) => n)
        .map(
          ([key, n]) =>
            `${n} ${key === "setup" ? "setting up" : key === "unknown" ? "activity unknown" : key}`,
        )
        .join(" · ")
    : loaded
      ? "No agents added yet"
      : "Checking agent activity…";
  let summary = activity;
  if (phase === "preparing" && coordinator?.status.technicalState === "running")
    summary = "Coordinator is preparing the plan";
  else if (phase === "preparing" && !mission.lifecycle.start_blockers.length)
    summary = isOwner
      ? mission.definition.policy?.coordination === "coordinated"
        ? "Plan ready for your review"
        : "Ready for your Start review"
      : "Waiting for the owner to start";
  else if (phase === "preparing" && coordinator)
    summary = coordinator.status.reason;
  else if (
    phase === "preparing" &&
    !mission.lifecycle.coordinator &&
    mission.definition.policy?.coordination === "coordinated"
  )
    summary = isOwner
      ? "Set up a Coordinator to prepare the plan"
      : "Waiting for the owner to appoint a Coordinator";
  const unconfirmed = rows.filter(
    (r) =>
      !r.status.stopConfirmed &&
      r.status.technicalState !== "ready" &&
      r.status.technicalState !== "login_required",
  ).length;
  if (phase === "paused" || ended)
    summary = unconfirmed
      ? `${phase === "paused" ? "Pause requested" : phases[phase]} · ${rows.filter((r) => r.status.stopConfirmed).length} stopped, ${unconfirmed} unconfirmed`
      : phase === "paused"
        ? "Mission paused"
        : acceptedResult
          ? `${phases[phase]} · result accepted`
          : phases[phase];
  const urgent = ordered.find((d) => d.urgent) ?? waiting.find((d) => d.urgent);
  if (urgent && phase === "active")
    summary = `${urgent.title} · ${urgent.reason}`;
  if (mission.conflicted) summary = "History needs recovery";
  if (blocked && !mission.conflicted)
    summary =
      access === "revoked"
        ? "Your membership was revoked · saved history is available"
        : access === "withdrawn"
          ? "You withdrew · saved history is available"
          : "Your access ended · saved history is available";
  const next = ordered[0] ?? null;
  return {
    phase,
    phaseLabel: phases[phase],
    summary,
    activity,
    rows,
    counts,
    decisions: blocked ? [] : ordered,
    waiting,
    next: blocked ? null : next,
    urgent: !!urgent,
    acceptedResult,
  };
}
