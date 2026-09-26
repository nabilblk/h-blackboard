import { z } from "zod";

const id = z.string().min(1).max(100);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const dollars = z.number().finite().min(0).max(1_000_000);
const reason = z.string().trim().min(1).max(4000);
const channel = { channel_id: id };
const limits = z
  .object({
    tokens: integer.nullable().default(null),
    costUsd: dollars.nullable().default(null),
    turns: integer.nullable().default(null),
    concurrency: z.number().int().min(1).max(1000).nullable().default(null),
    deadline: z.number().int().positive().nullable().default(null),
  })
  .strict();
const usage = z
  .object({
    tokens: integer.nullable(),
    costUsd: dollars.nullable(),
    quality: z.enum(["reported", "estimated", "unknown"]),
    source: z.string().trim().min(1).max(240),
  })
  .strict()
  .refine(
    (v) => v.quality !== "unknown" || (v.tokens === null && v.costUsd === null),
    "Unknown usage cannot contain measured values.",
  );
export const budgetOperations = {
  budget_run_read: {
    read: true,
    description:
      "Read the durable allowance, usage and reconciliation history of one execution run, including after a pause or archive.",
    schema: z.object({ ...channel, run_id: id }).strict(),
  },
  budget_read: {
    read: true,
    description:
      "Read mission limits, consumed and reserved allowance, unknown usage, enforcement capabilities and recent execution runs. Budget values are provider-reported/estimated usage, not a subscription invoice.",
    schema: z
      .object({
        ...channel,
        offset: integer.default(0),
        limit: z.number().int().min(1).max(100).default(50),
      })
      .strict(),
  },
  budget_update: {
    description:
      "Human: set or remove mission limits using the current budget version. Existing usage/reservations are never reset. Raising a limit does not override preparation or a human pause. Per-turn allowance is reserved before execution, not a hard provider cap.",
    schema: z
      .object({
        ...channel,
        version: integer,
        limits,
        per_turn: z
          .object({ tokens: integer.positive(), costUsd: dollars.positive() })
          .strict(),
        finalization_percent: z.number().int().min(0).max(50).default(10),
        reason,
      })
      .strict(),
  },
  budget_allocate: {
    description:
      "Coordinator or human: designate agents permitted to use the protected finalization reserve for verification and synthesis. Does not increase limits, admit, or start agents.",
    schema: z
      .object({
        ...channel,
        version: integer,
        agent_ids: z.array(id).max(1000),
        reason,
      })
      .strict(),
  },
  budget_request: {
    description:
      "Ask the human to extend or reconcile a budget with a concrete reason and requested resources. Does not change limits or launch work.",
    schema: z.object({ ...channel, reason }).strict(),
  },
  budget_reserve: {
    description:
      "Reserve allowance atomically before one runtime turn. Managed launchers do this automatically; interactive agents must do it before external work. Reuse run_id on retries. A grant is not permission to bypass mission controls. Unknown and disconnected runs keep their reservations.",
    schema: z
      .object({
        ...channel,
        run_id: id,
        purpose: z.enum(["work", "finalization"]).default("work"),
      })
      .strict(),
  },
  budget_settle: {
    description:
      "Report usage for your finished run exactly once. Missing values must be null, never fabricated zero. Unknown dimensions retain allowance until human reconciliation. The process must have stopped before settling; a heartbeat loss is insufficient.",
    schema: z
      .object({
        ...channel,
        run_id: id,
        usage,
        outcome: z.enum(["completed", "failed", "interrupted"]),
      })
      .strict(),
  },
  budget_reconcile: {
    description:
      "Human: reconcile a stopped/uncertain run with documented usage or an explicit estimate. Releases the corresponding unknown reservations. Do not reconcile a process still running. Previous reports remain in the audit history.",
    schema: z
      .object({
        ...channel,
        run_id: id,
        version: integer.positive(),
        usage,
        reason,
        confirmed_stopped: z.literal(true),
      })
      .strict(),
  },
};
const ensure = (test, message, status = 400) => {
  if (!test) throw Object.assign(new Error(message), { status });
};
const round = (n) => Math.round(n * 1e8) / 1e8;
export const defaultPolicy = () => ({
  version: 0,
  limits: {
    tokens: null,
    costUsd: null,
    turns: null,
    concurrency: null,
    deadline: null,
  },
  perTurn: { tokens: 100000, costUsd: 1 },
  finalizationPercent: 10,
  finalizers: [],
  history: [],
});

export class Budgets {
  constructor(board) {
    this.board = board;
    board.db
      .exec(`CREATE TABLE IF NOT EXISTS budget_policies(channel TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budget_runs(id TEXT PRIMARY KEY,channel TEXT NOT NULL,agent TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS budget_runs_channel ON budget_runs(channel);
      CREATE INDEX IF NOT EXISTS budget_agent_active ON budget_runs(channel,agent,json_extract(data,'$.status'));`);
  }
  policy(c) {
    const row = this.board.db
      .prepare("SELECT data FROM budget_policies WHERE channel=?")
      .get(c.id);
    return row ? JSON.parse(row.data) : defaultPolicy();
  }
  runs(c) {
    return this.board.db
      .prepare(
        "SELECT data FROM budget_runs WHERE channel=? ORDER BY rowid DESC",
      )
      .all(c.id)
      .map((r) => JSON.parse(r.data));
  }
  run(c, id) {
    const row = this.board.db
      .prepare("SELECT data FROM budget_runs WHERE channel=? AND id=?")
      .get(c.id, id);
    ensure(row, "Execution run not found in this mission.", 404);
    return JSON.parse(row.data);
  }
  saveRun(c, run) {
    this.board.db
      .prepare(
        "INSERT INTO budget_runs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(run.id, c.id, run.agentId, JSON.stringify(run));
    return run;
  }
  snapshot(c) {
    const policy = this.policy(c);
    const totals = this.board.db
      .prepare(
        `SELECT
      COUNT(*) AS turns,
      COALESCE(SUM(json_extract(data,'$.usage.tokens')),0) AS tokens,
      COALESCE(SUM(json_extract(data,'$.usage.costUsd')),0) AS cost,
      COALESCE(SUM(CASE WHEN json_extract(data,'$.usage.tokens') IS NULL THEN json_extract(data,'$.allowance.tokens') ELSE 0 END),0) AS reservedTokens,
      COALESCE(SUM(CASE WHEN json_extract(data,'$.usage.costUsd') IS NULL THEN json_extract(data,'$.allowance.costUsd') ELSE 0 END),0) AS reservedCost,
      COALESCE(SUM(json_extract(data,'$.status')='reserved'),0) AS active,
      COALESCE(SUM(json_extract(data,'$.status')='settled' AND (json_extract(data,'$.usage.tokens') IS NULL OR json_extract(data,'$.usage.costUsd') IS NULL)),0) AS unknown,
      COALESCE(SUM(json_extract(data,'$.usage.quality')='reported'),0) AS reported,
      COALESCE(SUM(json_extract(data,'$.usage.quality')='estimated'),0) AS estimated,
      COALESCE(SUM(json_extract(data,'$.usage.quality')='unknown'),0) AS unreported
      FROM budget_runs WHERE channel=?`,
      )
      .get(c.id);
    const consumed = {
      tokens: totals.tokens,
      costUsd: round(totals.cost),
      turns: totals.turns,
    };
    const reserved = {
      tokens: totals.reservedTokens,
      costUsd: round(totals.reservedCost),
      turns: 0,
    };
    const quality = {
      reported: totals.reported,
      estimated: totals.estimated,
      unknown: totals.unreported,
    };
    const active = totals.active,
      unknown = totals.unknown;
    const available = {},
      workAvailable = {};
    for (const key of ["tokens", "costUsd", "turns"]) {
      const limit = policy.limits[key];
      available[key] =
        limit === null
          ? null
          : Math.max(0, round(limit - consumed[key] - reserved[key]));
      const protectedAmount =
        limit === null
          ? 0
          : key === "costUsd"
            ? round((limit * policy.finalizationPercent) / 100)
            : Math.floor((limit * policy.finalizationPercent) / 100);
      workAvailable[key] =
        limit === null
          ? null
          : Math.max(0, round(available[key] - protectedAmount));
    }
    const deadlineReached =
      policy.limits.deadline !== null && Date.now() >= policy.limits.deadline;
    const exhausted =
      deadlineReached ||
      Object.values(available).some((n) => n !== null && n <= 0);
    return {
      ...policy,
      consumed,
      reserved,
      available,
      workAvailable,
      active,
      unknownRuns: unknown,
      totalRuns: totals.turns,
      quality,
      deadlineReached,
      exhausted,
      enforcement: {
        admission: "atomic",
        concurrency: "managed turns",
        tokensAndCost:
          "allowance checked before a turn; actual usage reconciled after it, so a turn may overrun",
        interactive: "self-reported; unrelated local tools are not controlled",
        usage:
          "runtime-reported model usage, not provider billing or subscription quota",
      },
    };
  }
  // An outstanding turn already owns its allowance. New turns must use reserve().
  stopReason(c, actor, snapshot) {
    const policy = snapshot || this.policy(c);
    if (Object.values(policy.limits).some((value) => value !== null)) {
      const row = this.board.db
        .prepare("SELECT data FROM agent_execution WHERE agent=?")
        .get(actor.id);
      if (row && JSON.parse(row.data).budgetProtocol !== 1)
        return "This managed launcher predates budget enforcement. Resume it with the updated CLI before continuing.";
    }
    if (policy.limits.deadline && Date.now() >= policy.limits.deadline)
      return "Mission budget deadline reached.";
    const snap = snapshot || this.snapshot(c);
    if (
      ["tokens", "costUsd", "turns"].some(
        (k) => policy.limits[k] !== null && snap.consumed[k] > policy.limits[k],
      )
    )
      return "Mission budget exceeded. Ask the human for an extension.";
    const open = this.board.db
      .prepare(
        "SELECT 1 FROM budget_runs WHERE channel=? AND agent=? AND json_extract(data,'$.status')='reserved' LIMIT 1",
      )
      .get(c.id, actor.id);
    if (!open && snap.exhausted)
      return "Mission budget exhausted. Publish existing work or request an extension.";
    return null;
  }
  read(c, p) {
    const snapshot = this.snapshot(c);
    const runs = this.board.db
      .prepare(
        "SELECT data FROM budget_runs WHERE channel=? ORDER BY rowid DESC LIMIT ? OFFSET ?",
      )
      .all(c.id, p.limit, p.offset)
      .map((row) => JSON.parse(row.data));
    return {
      ...snapshot,
      runs,
      nextOffset:
        p.offset + p.limit < snapshot.totalRuns ? p.offset + p.limit : null,
    };
  }
  execute(actor, c, op, p) {
    const b = this.board;
    if (op === "budget_request") {
      return b.message(c, actor, `Budget request\n${p.reason}`, {
        kind: "question",
        audience: "human",
      });
    }
    if (op === "budget_update" || op === "budget_allocate") {
      const previous = this.policy(c);
      b.version(previous, p.version);
      let next;
      if (op === "budget_update") {
        b.human(actor);
        next = {
          ...previous,
          limits: p.limits,
          perTurn: p.per_turn,
          finalizationPercent: p.finalization_percent,
        };
      } else {
        ensure(
          actor.human || c.coordinatorId === actor.id,
          "Only the coordinator or human allocates the finalization reserve.",
          403,
        );
        p.agent_ids.forEach((id) => b.record(c, id, "agent"));
        next = { ...previous, finalizers: [...new Set(p.agent_ids)] };
      }
      const { history: _, ...before } = previous;
      next.version++;
      next.history = [
        ...previous.history,
        {
          version: next.version,
          at: Date.now(),
          authorId: actor.id,
          reason: p.reason,
          previous: before,
        },
      ];
      b.db
        .prepare(
          "INSERT INTO budget_policies VALUES(?,?) ON CONFLICT(channel) DO UPDATE SET data=excluded.data",
        )
        .run(c.id, JSON.stringify(next));
      b.message(
        c,
        actor,
        `${op === "budget_update" ? "Budget updated" : "Finalization reserve allocated"}\n${p.reason}`,
        { kind: "decision" },
      );
      return this.snapshot(c);
    }
    if (op === "budget_reserve") {
      ensure(!actor.human, "A turn must belong to a registered agent.");
      const existing = b.db
        .prepare("SELECT data FROM budget_runs WHERE id=?")
        .get(p.run_id);
      if (existing) {
        const run = JSON.parse(existing.data);
        ensure(
          run.channelId === c.id &&
            run.agentId === actor.id &&
            run.purpose === p.purpose,
          "Run ID is already bound to a different execution.",
          409,
        );
        return {
          granted: run.status === "reserved",
          run,
          reason:
            run.status === "reserved"
              ? null
              : "This execution was already settled; use a new run ID.",
        };
      }
      const snap = this.snapshot(c);
      const finalization = p.purpose === "finalization";
      ensure(
        !finalization || snap.finalizers.includes(actor.id),
        "Ask the coordinator or human for access to the finalization reserve.",
        403,
      );
      const available = finalization ? snap.available : snap.workAvailable;
      let reason = null;
      if (snap.deadlineReached) reason = "Mission budget deadline reached.";
      else if (
        this.board.db
          .prepare(
            "SELECT 1 FROM budget_runs WHERE channel=? AND agent=? AND json_extract(data,'$.status')='reserved' LIMIT 1",
          )
          .get(c.id, actor.id)
      )
        reason =
          "This agent has an unsettled execution. Reconcile it before starting another.";
      else if (
        snap.limits.concurrency !== null &&
        snap.active >= snap.limits.concurrency
      )
        reason = "All concurrent turn slots are reserved.";
      else if (Object.values(available).some((n) => n !== null && n <= 0))
        reason =
          "No allowance remains for this turn. Request an extension or finalization allocation.";
      if (reason) return { granted: false, reason };
      const allowance = {
        tokens: Math.min(snap.perTurn.tokens, available.tokens ?? Infinity),
        costUsd: Math.min(snap.perTurn.costUsd, available.costUsd ?? Infinity),
      };
      const run = this.saveRun(c, {
        id: p.run_id,
        channelId: c.id,
        agentId: actor.id,
        streamId: b.get(actor.id).streamId,
        purpose: p.purpose,
        allowance,
        status: "reserved",
        version: 1,
        startedAt: Date.now(),
        finishedAt: null,
        usage: null,
        history: [],
      });
      return { granted: true, run };
    }
    const run = this.run(c, p.run_id);
    ensure(
      actor.human || run.agentId === actor.id,
      "Only the owner of a run may report its usage.",
      403,
    );
    if (op === "budget_reconcile") {
      b.human(actor);
      b.version(run, p.version);
    } else if (run.status !== "reserved") {
      ensure(
        JSON.stringify(run.usage) === JSON.stringify(p.usage) &&
          run.outcome === p.outcome,
        "Run already settled with a different report. Ask the human to reconcile it.",
        409,
      );
      return run;
    }
    const history = [
      ...run.history,
      {
        at: Date.now(),
        authorId: actor.id,
        reason: p.reason || p.outcome,
        previousUsage: run.usage,
        previousStatus: run.status,
      },
    ];
    const updated = this.saveRun(c, {
      ...run,
      version: run.version + 1,
      status: "settled",
      outcome: p.outcome || run.outcome || "interrupted",
      usage: p.usage,
      finishedAt: Date.now(),
      history,
    });
    if (op === "budget_reconcile")
      b.message(c, actor, `Execution usage reconciled\n${p.reason}`, {
        kind: "decision",
      });
    return updated;
  }
}
