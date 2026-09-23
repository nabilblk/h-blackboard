import { randomBytes, createHash } from "node:crypto";
import {
  inventorySchema,
  runnerJoinSchema,
  runnerTickSchema,
  RUNNER_PROTOCOL_VERSION,
  RUNNER_TTL,
} from "../shared/runner-protocol.mjs";

const hash = (value) =>
  createHash("sha256")
    .update(value || "")
    .digest("hex");
const token = () => randomBytes(32).toString("base64url");
const id = (prefix) => `${prefix}_${randomBytes(12).toString("hex")}`;
const must = (value, message, status = 400) => {
  if (!value) throw Object.assign(new Error(message), { status });
};
const parse = (row) => row && JSON.parse(row.data);

export class Runners {
  constructor(board) {
    this.board = board;
    this.db = board.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runner_pairings(hash TEXT PRIMARY KEY, channel TEXT NOT NULL, expires INTEGER NOT NULL, registration TEXT, result TEXT);
      CREATE TABLE IF NOT EXISTS runners(id TEXT PRIMARY KEY, channel TEXT NOT NULL, credential TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY, agent TEXT UNIQUE NOT NULL, runner TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS executions_runner ON executions(runner);
    `);
  }
  pair(channel) {
    const value = token();
    const expiresAt = Date.now() + 15 * 60000;
    this.db
      .prepare(
        "INSERT INTO runner_pairings(hash,channel,expires) VALUES(?,?,?)",
      )
      .run(hash(value), channel.id, expiresAt);
    return { token: value, expiresAt };
  }
  join(raw) {
    const input = runnerJoinSchema.parse(raw);
    const pairing = this.db
      .prepare("SELECT * FROM runner_pairings WHERE hash=?")
      .get(hash(input.pairing_token));
    must(
      pairing && pairing.expires > Date.now(),
      "Launcher connection link is invalid or expired.",
      401,
    );
    const mission = this.board.get(pairing.channel);
    must(
      mission && !mission.archived && mission.state !== "closed",
      "Restore or reopen the mission before connecting a launcher.",
      409,
    );
    const registration = JSON.stringify([
      input.registration_id,
      input.name,
      input.provider,
    ]);
    if (pairing.result) {
      must(
        pairing.registration === registration,
        "This launcher connection link has already been used.",
        409,
      );
      return JSON.parse(pairing.result);
    }
    const runner = {
      id: id("ru"),
      channelId: mission.id,
      name: input.name,
      provider: input.provider,
      lastSeen: Date.now(),
    };
    const credential = token();
    const result = {
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      runnerId: runner.id,
      channelId: mission.id,
      token: credential,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO runners VALUES(?,?,?,?)")
        .run(runner.id, mission.id, hash(credential), JSON.stringify(runner));
      this.db
        .prepare(
          "UPDATE runner_pairings SET registration=?,result=? WHERE hash=?",
        )
        .run(registration, JSON.stringify(result), pairing.hash);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.board.emit("change", mission.id);
    return result;
  }
  auth(credential) {
    const runner = parse(
      this.db
        .prepare("SELECT data FROM runners WHERE credential=?")
        .get(hash(credential)),
    );
    must(runner, "Invalid launcher credential.", 401);
    return runner;
  }
  put(execution) {
    this.db
      .prepare(
        "INSERT INTO executions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(
        execution.id,
        execution.agentId,
        execution.runnerId,
        JSON.stringify(execution),
      );
    return execution;
  }
  inventory(runner, raw) {
    const { executions, reconnect_command } = inventorySchema.parse(raw);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of executions) {
        const actor = this.board.auth(item.agent_token);
        must(
          !actor.human &&
            actor.id === item.agent_id &&
            actor.channelId === runner.channelId,
          "Session identity does not belong to this launcher mission.",
          403,
        );
        const existing = parse(
          this.db
            .prepare("SELECT data FROM executions WHERE agent=? OR id=?")
            .get(item.agent_id, item.execution_id),
        );
        must(
          !existing ||
            (existing.runnerId === runner.id &&
              existing.agentId === item.agent_id &&
              existing.id === item.execution_id),
          "This agent or execution already belongs to another launcher. Reconnect the original launcher.",
          409,
        );
        if (existing) {
          must(
            existing.workspaceRef === item.workspace_ref &&
              existing.checkpointRef === item.checkpoint_ref,
            "Resume cannot silently replace the saved workspace or checkpoint.",
            409,
          );
          continue;
        }
        this.put({
          id: item.execution_id,
          agentId: item.agent_id,
          runnerId: runner.id,
          workspaceRef: item.workspace_ref,
          checkpointRef: item.checkpoint_ref,
          resumeCommand: item.resume_command || null,
          generation: 0,
          observedGeneration: 0,
          state: "unknown",
          error: null,
          requestedAt: null,
          observedAt: null,
        });
      }
      if (reconnect_command)
        this.db
          .prepare("UPDATE runners SET data=? WHERE id=?")
          .run(
            JSON.stringify({ ...runner, reconnectCommand: reconnect_command }),
            runner.id,
          );
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.board.emit("change", runner.channelId);
    return { registered: executions.length };
  }
  list(runnerId) {
    return this.db
      .prepare("SELECT data FROM executions WHERE runner=? ORDER BY rowid")
      .all(runnerId)
      .map(parse);
  }
  tick(runner, raw) {
    const { observations } = runnerTickSchema.parse(raw);
    const executions = new Map(this.list(runner.id).map((x) => [x.id, x]));
    let changed = Date.now() - runner.lastSeen > RUNNER_TTL;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const observation of observations) {
        const execution = executions.get(observation.execution_id);
        must(execution, "Execution does not belong to this launcher.", 403);
        must(
          observation.generation <= execution.generation,
          "Unknown execution generation.",
          409,
        );
        if (observation.generation < execution.observedGeneration) continue;
        changed ||=
          execution.state !== observation.state ||
          execution.error !== observation.error ||
          execution.observedGeneration !== observation.generation;
        const next = this.put({
          ...execution,
          observedGeneration: observation.generation,
          state: observation.state,
          error: observation.error,
          observedAt: Date.now(),
        });
        executions.set(next.id, next);
      }
      this.db
        .prepare("UPDATE runners SET data=? WHERE id=?")
        .run(JSON.stringify({ ...runner, lastSeen: Date.now() }), runner.id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    if (changed) this.board.emit("change", runner.channelId);
    const mission = this.board.get(runner.channelId);
    return {
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      executions: [...executions.values()].map((e) => ({
        execution_id: e.id,
        generation: e.generation,
        workspace_ref: e.workspaceRef,
        checkpoint_ref: e.checkpointRef,
        // The runner may reconnect during pause/preparation. The worker still
        // enforces admission before making a model call.
        resume_allowed: !mission.archived && mission.state !== "closed",
      })),
    };
  }
  resume(channel, agentIds) {
    must(
      !channel.archived && channel.state !== "closed",
      "Restore or reopen the mission before resuming agents.",
      409,
    );
    const results = [];
    for (const agentId of new Set(agentIds)) {
      const agent = this.board.record(channel, agentId, "agent");
      const e = parse(
        this.db
          .prepare("SELECT data FROM executions WHERE agent=?")
          .get(agent.id),
      );
      must(
        e,
        "Connect a launcher on the agent's machine to resume its saved session.",
        409,
      );
      const runner = parse(
        this.db.prepare("SELECT data FROM runners WHERE id=?").get(e.runnerId),
      );
      must(
        runner?.provider.capabilities.resume,
        "This execution provider cannot resume sessions.",
        409,
      );
      must(
        Date.now() - runner.lastSeen < RUNNER_TTL,
        "The launcher is offline. Reconnect it on the execution machine first.",
        409,
      );
      if (
        e.generation > e.observedGeneration ||
        (Date.now() - agent.lastSeen < 45000 &&
          !["offline", "error"].includes(agent.status))
      ) {
        results.push(this.view(agent.id));
        continue;
      }
      this.put({ ...e, generation: e.generation + 1, requestedAt: Date.now() });
      results.push(this.view(agent.id));
    }
    return { executions: results };
  }
  view(agentId) {
    const e = parse(
      this.db.prepare("SELECT data FROM executions WHERE agent=?").get(agentId),
    );
    if (!e) return null;
    const runner = parse(
      this.db.prepare("SELECT data FROM runners WHERE id=?").get(e.runnerId),
    );
    return {
      executionId: e.id,
      runnerId: e.runnerId,
      runnerName: runner.name,
      runnerOnline: Date.now() - runner.lastSeen < RUNNER_TTL,
      provider: runner.provider,
      generation: e.generation,
      observedGeneration: e.observedGeneration,
      state: e.generation > e.observedGeneration ? "queued" : e.state,
      error: e.generation > e.observedGeneration ? null : e.error,
      requestedAt: e.requestedAt,
      observedAt: e.observedAt,
      resumeCommand: e.resumeCommand,
      launcherCommand: runner.reconnectCommand || null,
    };
  }
}
