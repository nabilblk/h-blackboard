// Joining establishes identity. This policy separately grants planning or work.
export function preparationChange(mission) {
  return {
    startupRevision: mission.startupRevision + 1,
    coordinatorReady: null,
  };
}

export function participation(mission, agent) {
  const base = { revision: mission.startupRevision };
  if (mission.archived || mission.state === "closed")
    return {
      ...base,
      state: "closed",
      reason: "The mission is closed or archived.",
    };
  if (mission.state === "paused" || agent.control === "pause")
    return { ...base, state: "paused", reason: "Work is paused by the human." };
  if (mission.state === "preparing")
    return mission.coordinatorId === agent.id
      ? {
          ...base,
          state: "planning",
          reason:
            "Prepare the shared plan and acknowledge readiness. Wait for the human to start execution.",
        }
      : {
          ...base,
          state: "waiting",
          reason: "The mission is preparing. Wait for the human to start it.",
        };
  if (
    mission.state === "active" &&
    (mission.coordinationMode === "peer" ||
      mission.coordinatorId === agent.id ||
      agent.admission?.revision === mission.startupRevision)
  )
    return {
      ...base,
      state: "authorized",
      reason: "Work is authorized. Read current instructions before acting.",
      instruction:
        (agent.admission?.revision === mission.startupRevision &&
        agent.admission.source !== "mission-start"
          ? agent.admission.instruction
          : "") ||
        mission.plan ||
        mission.objective,
    };
  return {
    ...base,
    state: "waiting",
    reason:
      "Waiting for a direction from the coordinator or human. No task is required.",
  };
}

export function startupStatus(mission, agents) {
  const coordinator = agents.find((a) => a.id === mission.coordinatorId);
  const ready = !!(
    coordinator &&
    mission.coordinatorReady?.agentId === coordinator.id &&
    mission.coordinatorReady?.revision === mission.startupRevision
  );
  let reason = "Ready for the human to start the mission.";
  let canStart =
    !mission.archived &&
    mission.state !== "active" &&
    mission.state !== "closed";
  if (mission.coordinationMode === "coordinated") {
    if (!coordinator) {
      canStart = false;
      reason =
        "Appoint a coordinator, or explicitly choose peer collaboration.";
    } else if (!ready) {
      canStart = false;
      reason =
        "Waiting for the coordinator to publish a plan and acknowledge readiness.";
    } else if (
      coordinator.control === "pause" ||
      ["error", "offline"].includes(coordinator.status) ||
      Date.now() - coordinator.lastSeen >= 45000
    ) {
      canStart = false;
      reason =
        "The coordinator is unavailable. Reconnect it or appoint another coordinator.";
    }
  }
  return {
    canStart,
    coordinatorReady: ready,
    reason,
    connected: agents.filter((a) => Date.now() - a.lastSeen < 45000).length,
    waiting: agents.filter((a) => participation(mission, a).state === "waiting")
      .length,
  };
}

export const planningOperations = new Set([
  "plan_update",
  "coordinator_ready",
  "agent_admit",
  "stream_create",
  "stream_update",
  "assignment_create",
  "agents_request",
  "task_create",
  "task_update",
]);

// JSON records predate an explicit coordination mode. Migrate once, preserving
// existing execution and admission; never fabricate a coordinator acknowledgment.
export function migrateStartup(board) {
  if (board.db.prepare("SELECT 1 FROM settings WHERE key='startup-v1'").get())
    return;
  board.db.exec("BEGIN IMMEDIATE");
  try {
    if (
      board.db.prepare("SELECT 1 FROM settings WHERE key='startup-v1'").get()
    ) {
      board.db.exec("COMMIT");
      return;
    }
    for (const row of board.db
      .prepare("SELECT data FROM records WHERE type='mission'")
      .all()) {
      const mission = JSON.parse(row.data);
      if (mission.coordinationMode) continue;
      board.put({
        ...mission,
        coordinationMode: mission.coordinatorId ? "coordinated" : "peer",
        startupRevision: 1,
        coordinatorReady: null,
        startedAt: mission.createdAt,
      });
      for (const agent of board.list(mission.id, "agent"))
        board.put({
          ...agent,
          admission: {
            revision: 1,
            instruction: agent.direction || mission.plan || mission.objective,
            issuedBy: "human",
            source: "existing-mission",
            at: Date.now(),
          },
        });
    }
    board.db.prepare("INSERT INTO settings VALUES('startup-v1','1')").run();
    board.db.exec("COMMIT");
  } catch (error) {
    board.db.exec("ROLLBACK");
    throw error;
  }
}
