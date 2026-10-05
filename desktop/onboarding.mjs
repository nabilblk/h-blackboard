import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { Id, Runtime, Limits } from "./model.mjs";
import { Hash } from "./execution/contract.mjs";
import { OnboardingStore } from "./onboarding-store.mjs";

const setup = z
  .object({
    id: Id,
    mission: Hash,
    terms: Hash,
    role: z.enum(["agent", "coordinator"]),
    runtime: Runtime,
    label: z
      .string()
      .trim()
      .min(1)
      .max(90)
      .refine(
        (value) => !/[\x00-\x1f\x7f]/.test(value),
        "Use a single-line agent name.",
      ),
    count: z.number().int().min(1).max(32),
    limits: Limits,
    workspaceChoiceId: Id.nullable(),
  })
  .strict();
const permission = z
  .object({
    id: Id,
    contributionId: Id,
    control: Hash,
    direction: Hash,
    turns: z.number().int().min(1).max(10000),
    minutes: z.number().int().min(1).max(1440),
  })
  .strict();
export const OnboardingRequests = {
  setup,
  permission,
  state: z.object({ mission: Hash }).strict(),
  cancel: z.object({ id: Id }).strict(),
  preflight: z.object({}).strict(),
  installProvider: z.object({}).strict(),
  cancelInstall: z.object({}).strict(),
  takeInvitation: z.object({}).strict(),
};
const journal = z
  .object({
    id: Id,
    kind: z.enum(["setup", "permission"]),
    request: z.union([setup, permission]),
    mission: Hash,
    status: z.enum([
      "running",
      "interrupted",
      "complete",
      "cancelled",
      "failed",
    ]),
    message: z.string().max(2048),
    updatedAt: z.number(),
    contributions: z.array(Id).max(32),
    step: z.number().int().nonnegative(),
    allocation: Hash.nullable().optional(),
    workspace: z
      .object({
        path: z.string().max(4096),
        parentIdentity: z
          .object({ device: z.string(), inode: z.string() })
          .strict(),
      })
      .strict()
      .optional(),
    allocationBefore: z.array(Hash).optional(),
    grant: Hash.nullable().optional(),
  })
  .strict();

export class OnboardingService {
  active = new Map();
  starting = new Map();
  permissions = new Map();
  closed = false;
  constructor({ directory, node, executions, provider }) {
    this.store = new OnboardingStore(directory, journal);
    this.node = node;
    this.executions = executions;
    this.provider = provider;
  }
  save(job, patch = {}) {
    Object.assign(job, patch, { updatedAt: Date.now() });
    this.store.write(job);
  }
  state(mission) {
    return readdirSync(this.store.directory)
      .filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))
      .map((f) => this.store.read(f.slice(0, -5)))
      .filter((j) => j.mission === mission)
      .map((j) => ({
        ...j,
        status:
          j.status === "running" && !this.active.has(j.id)
            ? "interrupted"
            : j.status,
        message:
          j.status === "running" && !this.active.has(j.id)
            ? "Setup interrupted. Review and continue from the saved step."
            : j.message,
      }));
  }
  async mission(id, terms) {
    const state = await this.node.state();
    const mission = state.missions.find((m) => m.id === id);
    if (
      !mission ||
      mission.conflicted ||
      ["closed", "archived"].includes(mission.lifecycle.phase)
    )
      throw new Error("This mission cannot accept setup or execution.");
    if (terms && mission.lifecycle.terms_revision !== terms)
      throw new Error(
        "The mission instructions changed. Review the new terms before continuing.",
      );
    return { mission, owner: state.identity.owner };
  }
  async setup(input) {
    const request = setup.parse(input);
    if (this.closed) throw new Error("Setup is closing.");
    const pending = this.starting.get(request.id);
    if (pending) {
      if (JSON.stringify(pending.request) !== JSON.stringify(request))
        throw new Error("Setup terms changed while saving.");
      return pending.promise;
    }
    const promise = this.beginSetup(request);
    this.starting.set(request.id, { request, promise });
    try {
      return await promise;
    } finally {
      this.starting.delete(request.id);
    }
  }
  async beginSetup(input) {
    const request = setup.parse(input);
    const existing = this.store.read(request.id);
    if (
      existing &&
      JSON.stringify(existing.request) !== JSON.stringify(request)
    )
      throw new Error(
        "This setup already has reviewed terms. Start a new setup to change them.",
      );
    if (this.active.has(request.id) || existing?.status === "complete")
      return existing;
    if (
      request.role === "coordinator" &&
      (request.count !== 1 || request.limits.concurrency !== 1)
    )
      throw new Error("Prepare one Coordinator at a time.");
    await this.mission(request.mission, request.terms);
    const job = existing ?? {
      id: request.id,
      kind: "setup",
      request,
      mission: request.mission,
      status: "running",
      message: "Saving reviewed contribution terms.",
      updatedAt: Date.now(),
      contributions: Array.from({ length: request.count }, () => randomUUID()),
      step: 0,
    };
    if (request.workspaceChoiceId && !job.workspace) {
      const { path, parentIdentity } = this.node.contributors.reviewed(
        this.node.contributors.choices,
        request.workspaceChoiceId,
        "The workspace choice",
      );
      job.workspace = { path, parentIdentity };
    }
    this.save(job, { status: "running" });
    const control = { cancelled: false, contribution: null, done: null };
    this.active.set(job.id, control);
    control.done = this.continueSetup(job, control)
      .catch((error) => {
        this.save(job, {
          status: control.cancelled ? "cancelled" : "failed",
          message: error.message.slice(0, 2048),
        });
      })
      .finally(() => this.active.delete(job.id));
    return job;
  }
  async continueSetup(job, control) {
    const r = job.request;
    for (let i = job.step; i < job.contributions.length; i++) {
      if (control.cancelled)
        throw new Error(
          "Setup cancelled. Prepared agents and their files are retained.",
        );
      const { mission, owner } = await this.mission(r.mission, r.terms);
      const id = job.contributions[i];
      control.contribution = id;
      this.save(job, {
        message: `Setting up ${i + 1} of ${r.count}. Each agent has a separate environment and login.`,
      });
      let contribution = this.node.contributors.store
        .read()
        .contributions.find((c) => c.id === id);
      if (!contribution) {
        const review = await this.node.handle("reviewContribution", {
          mission: r.mission,
          role: r.role,
        });
        const workspaceChoiceId = job.workspace
          ? this.node.contributors.resumeWorkspace(job.workspace)
          : this.node.contributors.managedWorkspace().id;
        await this.node.handle(
          "prepareContribution",
          {
            reviewId: review.reviewId,
            workspaceChoiceId,
            runtime: r.runtime,
            limits: r.limits,
          },
          { contributionId: id },
        );
        contribution = this.node.contributors.store
          .read()
          .contributions.find((c) => c.id === id);
      }
      if (
        contribution.status !== "prepared" ||
        contribution.sharedAgent?.withdrawn
      )
        throw new Error(
          "This agent was withdrawn. Create a new reviewed contribution.",
        );
      if (!contribution.sharedAgent)
        await this.node.handle("shareAgent", {
          mission: r.mission,
          contributionId: id,
          label: r.count === 1 ? r.label : `${r.label}-${i + 1}`,
        });
      if (control.cancelled)
        throw new Error("Setup cancelled. Prepared identities are retained.");
      if (
        r.role === "coordinator" &&
        owner === mission.owner &&
        !mission.lifecycle.coordinator
      )
        await this.node.handle("appointCoordinator", {
          mission: r.mission,
          revision: mission.lifecycle.revision,
          contributionId: id,
        });
      const record = this.executions.store.read(id);
      if (!record || ["failed", "preparing"].includes(record.status))
        await this.executions.prepare(id);
      else if (!["ready", "login_required", "stopped"].includes(record.status))
        throw new Error(
          "This agent has an existing run. Confirm it stopped before continuing setup.",
        );
      // Provisioning does not need to keep every guest resident. This allows
      // bulk setup larger than concurrent execution capacity without overflow.
      if (!(await this.provider.terminate({ contribution })).stopped) {
        this.executions.store.update(id, {
          status: "recovery_required",
          reason:
            "Setup finished, but the environment’s stop is unconfirmed. Recover before continuing.",
        });
        throw new Error(
          "Environment stop is unconfirmed. Recover this agent before continuing setup.",
        );
      }
      this.save(job, { step: i + 1 });
      if (control.cancelled)
        throw new Error(
          "Setup cancelled. Prepared identities and files are retained.",
        );
    }
    this.save(job, {
      status: "complete",
      message:
        "Agents added. Sign in to each isolated environment, then review the permission to run.",
    });
  }
  async cancel(id) {
    const job = this.store.read(id);
    if (!job) throw new Error("Unknown setup.");
    if (job.kind !== "setup")
      throw new Error(
        "Use the agent’s Stop action to end execution. Recorded permissions are retained for review.",
      );
    const active = this.active.get(id);
    if (active) {
      active.cancelled = true;
      if (
        active.contribution &&
        this.executions.preparations.has(active.contribution)
      )
        await this.executions.cancelSetup(active.contribution);
      await active.done;
    } else
      this.save(job, {
        status: "cancelled",
        message:
          "Setup cancelled. Prepared agents and saved files are retained.",
      });
  }
  async permission(input) {
    const request = permission.parse(input);
    if (this.closed) throw new Error("Setup is closing.");
    if (this.permissions.has(request.contributionId))
      throw new Error("An approval for this agent is already being recorded.");
    const promise = this.approvePermission(request);
    this.permissions.set(request.contributionId, promise);
    try {
      return await promise;
    } finally {
      this.permissions.delete(request.contributionId);
    }
  }
  async approvePermission(input) {
    const r = permission.parse(input);
    if (this.active.has(r.id))
      throw new Error("This approval is already in progress.");
    const previousJob = this.store.read(r.id);
    if (
      previousJob &&
      JSON.stringify(previousJob.request) !== JSON.stringify(r)
    )
      throw new Error("Review the changed permission as a new action.");
    if (previousJob?.status === "complete") return previousJob;
    const c = this.executions.contribution(r.contributionId);
    const { mission, owner } = await this.mission(
      c.mission.missionId,
      c.nodeBinding?.revision,
    );
    if (owner !== mission.owner)
      throw new Error(
        "The mission owner must issue this permission. You can approve an existing permission on your own device.",
      );
    if (r.control !== mission.lifecycle.revision)
      throw new Error(
        "Mission control changed. Review the current plan and direction again.",
      );
    const current = await this.node.executionContext(c.id);
    const planning = mission.lifecycle.phase === "preparing";
    if (
      planning
        ? mission.lifecycle.coordinator?.identity.author !==
            current.context.agent.identity.author || r.direction !== r.control
        : mission.lifecycle.phase !== "active" ||
          current.context.agent.direction?.id !== r.direction
    )
      throw new Error(
        "This agent has no current authority for the requested operation.",
      );
    if (planning && (r.turns > 8 || r.minutes > 15))
      throw new Error(
        "Planning is limited to eight turns and fifteen minutes.",
      );
    const record = this.executions.store.read(c.id);
    if (!record || !["ready", "stopped"].includes(record.status))
      throw new Error(
        "Prepare, sign in and confirm any previous run stopped first.",
      );
    const job = previousJob ?? {
      id: r.id,
      kind: "permission",
      request: r,
      mission: mission.id,
      status: "running",
      message: "Preparing the reviewed run permission.",
      updatedAt: Date.now(),
      contributions: [c.id],
      step: 0,
    };
    this.save(job, { status: "running" });
    this.active.set(r.id, {});
    try {
      let ledger = await this.node.handle("governance", {
        mission: mission.id,
      });
      if (!job.allocation) {
        let allocation = ledger.allocations.find(
          (a) =>
            a.node === owner &&
            !a.sealed &&
            !a.reclaimed &&
            a.active < a.slots &&
            (a.turns === null || a.turns - a.charged - a.reserved >= r.turns),
        );
        if (!allocation && job.allocationBefore) {
          const matches = ledger.allocations.filter(
            (a) =>
              !job.allocationBefore.includes(a.id) &&
              a.node === owner &&
              a.turns === r.turns &&
              a.slots === 1,
          );
          if (matches.length !== 1)
            throw new Error(
              "Allocation outcome is uncertain. Inspect Budget before retrying; no additional resources were allocated.",
            );
          allocation = matches[0];
        }
        if (!allocation) {
          this.save(job, {
            allocationBefore: ledger.allocations.map((a) => a.id),
          });
          const value = await this.node.handle("govern", {
            mission: mission.id,
            control: r.control,
            action: { type: "allocate", node: owner, turns: r.turns, slots: 1 },
          });
          this.save(job, { allocation: value.event });
        } else this.save(job, { allocation: allocation.id });
      }
      const execution =
        record.execution ?? createHash("sha256").update(r.id).digest("hex");
      const generation = record.execution ? record.generation + 1 : 1;
      ledger = await this.node.handle("governance", { mission: mission.id });
      let grant = ledger.grants.find(
        (g) => g.execution === execution && g.generation === generation,
      );
      if (!grant && !job.grant) {
        const prior = ledger.grants.find((g) => g.id === record.grant);
        if (prior && !prior.seal)
          throw new Error(
            "Confirm the previous execution and accounting stopped before resuming.",
          );
        const value = await this.node.handle("govern", {
          mission: mission.id,
          control: r.control,
          action: {
            type: "grant",
            purpose: planning ? "planning" : "work",
            previous: prior?.seal ?? null,
            allocation: job.allocation,
            registration: c.sharedAgent.registration,
            direction: r.direction,
            execution,
            generation,
            turns: r.turns,
            expires_ms: Date.now() + r.minutes * 60000,
            offline_ms: r.minutes * 60000 - 10000,
          },
        });
        this.save(job, { grant: value.event });
      } else if (grant) this.save(job, { grant: grant.id });
      const confirmed = (
        await this.node.handle("governance", { mission: mission.id })
      ).grants.find((g) => g.id === job.grant);
      if (!confirmed?.consent)
        await this.node.handle("consentGrant", {
          mission: mission.id,
          grant: job.grant,
          contributionId: c.id,
        });
      // Persist launch intent before calling the enforcing manager. A retry
      // never dispatches a second run for this reviewed permission.
      const latest = this.executions.store.read(c.id);
      if (latest.grant !== job.grant)
        await this.executions.start(c.id, job.grant);
      this.save(job, {
        status: "complete",
        message:
          "Approval recorded. Inspect the agent’s current execution status.",
      });
      return job;
    } catch (error) {
      this.save(job, {
        status: "failed",
        message: error.message.slice(0, 2048),
      });
      throw error;
    } finally {
      this.active.delete(r.id);
    }
  }
  async close() {
    this.closed = true;
    await this.provider.installer?.cancel();
    await Promise.allSettled([...this.starting.values()].map((p) => p.promise));
    await Promise.allSettled(
      [...this.active]
        .filter(([, active]) => active.done)
        .map(([id]) => this.cancel(id)),
    );
    await Promise.allSettled(this.permissions.values());
  }
}
