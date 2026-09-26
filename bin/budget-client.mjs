import { randomUUID } from "node:crypto";
import { call } from "../server/remote.mjs";
import { unknownUsage } from "./usage.mjs";

// The session file is a small durable outbox. Store the report before sending
// it, so a lost HTTP response cannot double charge or lose completed usage.
export class TurnBudget {
  constructor(state, persist) {
    this.state = state;
    this.persist = persist;
  }
  async reserve(context) {
    const purpose = context.budget?.finalizers.includes(this.state.agentId)
      ? "finalization"
      : "work";
    const pending = (this.state.pendingBudget ||= {
      id: randomUUID(),
      purpose,
      phase: "reserving",
    });
    await this.persist();
    let result;
    try {
      result = await call(
        this.state,
        "budget_reserve",
        { run_id: pending.id, purpose: pending.purpose },
        `reserve:${pending.id}`,
      );
    } catch (error) {
      if (![403, 409].includes(error.status)) throw error;
      delete this.state.pendingBudget;
      await this.persist();
      return { granted: false, reason: error.message };
    }
    if (!result.granted) {
      delete this.state.pendingBudget;
      await this.persist();
      return result;
    }
    pending.phase = "reserved";
    await this.persist();
    return result;
  }
  async starting() {
    this.state.pendingBudget.phase = "running";
    await this.persist();
  }
  async process(pid) {
    this.state.pendingBudget.pid = pid;
    await this.persist();
  }
  async settle(usage, outcome) {
    const pending = this.state.pendingBudget;
    if (!pending) return;
    pending.report = { run_id: pending.id, usage, outcome };
    pending.phase = "settling";
    await this.persist();
    await call(
      this.state,
      "budget_settle",
      pending.report,
      `settle:${pending.id}`,
    );
    delete this.state.pendingBudget;
    await this.persist();
  }
  async recover() {
    const pending = this.state.pendingBudget;
    if (!pending) return;
    let run;
    try {
      run = await call(this.state, "budget_run_read", { run_id: pending.id });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    if (pending.phase === "running" && pending.pid) {
      try {
        process.kill(pending.pid, 0);
        throw new Error(
          "Previous runtime process is still present. Stop it before resuming this identity.",
        );
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    // A human reconciliation explicitly confirms the process is stopped. It
    // takes precedence over an old launcher report, without overwriting it.
    if (
      run?.status === "settled" &&
      (pending.phase !== "settling" || run.history.at(-1)?.authorId === "human")
    ) {
      delete this.state.pendingBudget;
      await this.persist();
      return;
    }
    if (pending.phase === "settling")
      return this.settle(pending.report.usage, pending.report.outcome);
    if (pending.phase === "running") {
      if (!pending.pid || !run)
        throw new Error(
          "Previous execution cannot be confirmed stopped. Inspect it and reconcile its budget reservation before resuming.",
        );
      return this.settle(
        unknownUsage("Previous runtime stopped without a durable usage report"),
        "interrupted",
      );
    }
    // Read rather than requesting permission again: the mission may have
    // been paused or archived after a grant whose response was lost.
    if (run?.status === "reserved")
      return this.settle(
        {
          tokens: 0,
          costUsd: 0,
          quality: "reported",
          source: "Launcher recovered before process start",
        },
        "interrupted",
      );
    delete this.state.pendingBudget;
    await this.persist();
  }
}
