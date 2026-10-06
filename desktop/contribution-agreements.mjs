import { z } from "zod";
import { readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { Id } from "./model.mjs";
import { Hash } from "./execution/contract.mjs";
import {
  executionBinding,
  currentPermissions,
} from "./execution/permissions.mjs";
import { OnboardingStore } from "./onboarding-store.mjs";

// Human instructions, local to this host. They do not replace signed grants,
// contributor consent, reservations, the native authority checks or VM leases.
export const agreementRequest = z
  .object({
    id: Id,
    mission: Hash,
    terms: Hash,
    coordinator: Hash.nullable(),
    plan: Hash.nullable(),
    registration: Hash,
    contributionId: Id.nullable(),
    ownerPermission: z.boolean(),
    minutes: z.number().int().min(1).max(1440),
    turns: z.number().int().min(1).max(10000),
    followDirections: z.boolean(),
  })
  .strict();
export const reviewedStartRequest = z
  .object({
    id: Id,
    mission: Hash,
    revision: Hash,
    readiness: Hash.nullable(),
    approvals: z.array(agreementRequest).max(32),
  })
  .strict();
export const AgreementRequests = {
  approveContribution: agreementRequest,
  agreements: z.object({ mission: Hash }).strict(),
  cancelAgreement: z.object({ id: Id }).strict(),
  continueAgreement: z.object({ id: Id }).strict(),
  reviewedStart: reviewedStartRequest,
  startState: z.object({ mission: Hash }).strict(),
  cancelStart: z.object({ id: Id }).strict(),
};
const recordSchema = z
  .object({
    id: Id,
    request: agreementRequest,
    createdAt: z.number(),
    lastObservedAt: z.number().optional(),
    expiresAt: z.number(),
    coordinator: Hash.nullable(),
    plan: Hash.nullable(),
    awaitingInitialPlan: z.boolean(),
    binding: Hash.nullable(),
    direction: Hash.nullable(),
    contributor: Hash,
    status: z.enum(["active", "stopped", "expired", "review", "interrupted"]),
    resumeGrant: Hash.nullable().default(null),
    message: z.string().max(2048),
    waitingFor: z
      .enum([
        "mission_start",
        "mission_resume",
        "direction",
        "new_work",
        "contributor",
        "setup",
        "capacity",
        "owner_permission",
      ])
      .nullable()
      .default(null),
    grants: z.array(Hash).max(4096),
    allocation: Hash.nullable(),
    allocationBefore: z.array(Hash).nullable(),
    allocationTurns: z.number().int().positive().nullable().default(null),
    pending: z
      .object({
        execution: Hash,
        generation: z.number().int(),
        control: Hash,
        direction: Hash,
      })
      .nullable(),
  })
  .strict();
const startSchema = z
  .object({
    id: Id,
    request: reviewedStartRequest,
    phase: z.enum(["reviewed", "started", "complete", "cancelled"]),
    revision: Hash.nullable(),
    createdAt: z.number(),
    terms: Hash,
    coordinator: Hash.nullable(),
    plan: Hash.nullable(),
  })
  .strict();
const readable = (store) =>
  readdirSync(store.directory)
    .filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))
    .map((f) => store.read(f.slice(0, -5)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const reviewRequired = (message) =>
  Object.assign(new Error(message), { code: "approval_review" });
const approvalEnded = (message) =>
  Object.assign(new Error(message), { code: "approval_ended" });

export class ContributionAgreements {
  closed = false;
  deadlines = new Map();
  starting = new Map();
  constructor({ directory, node, executions, clock = Date.now }) {
    this.store = new OnboardingStore(directory + "/agreements", recordSchema);
    this.starts = new OnboardingStore(directory + "/starts", startSchema);
    Object.assign(this, { node, executions, clock });
  }
  list(mission) {
    return readable(this.store).filter((a) => a.request.mission === mission);
  }
  startState(mission) {
    return readable(this.starts)
      .filter((j) => j.request.mission === mission)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  local(id) {
    return (
      readable(this.store)
        .filter((a) => a.request.contributionId === id)
        .sort((a, b) => a.createdAt - b.createdAt)
        .at(-1) ?? null
    );
  }
  save(a, patch) {
    const current = this.store.read(a.id);
    if (current && current.status !== "active" && !patch.status)
      a.status = current.status;
    Object.assign(a, patch, {
      lastObservedAt: Math.max(
        a.createdAt,
        a.lastObservedAt ?? 0,
        this.clock(),
      ),
    });
    if (a.status !== "active") a.waitingFor = null;
    this.store.write(a);
    return a;
  }
  async mission(id) {
    const state = await this.node.state();
    const mission = state.missions.find((m) => m.id === id);
    if (!mission || mission.conflicted)
      throw new Error(
        "Mission unavailable or conflicted. Review its shared history.",
      );
    return { mission, owner: state.identity.owner };
  }
  async agent(mission, registration) {
    let after = null;
    do {
      const page = await this.node.handle("agents", { mission, after });
      const found = page.items.find((a) => a.id === registration);
      if (found) return found;
      after = page.after;
    } while (after);
    throw new Error("This agent is no longer available in the mission.");
  }
  async approve(input) {
    const r = agreementRequest.parse(input);
    if (this.closed) throw new Error("Desktop is closing.");
    const previous = this.store.read(r.id);
    if (previous) {
      if (!same(previous.request, r))
        throw new Error("Approval changed. Review it as a new action.");
      return previous;
    }
    const { mission, owner } = await this.mission(r.mission);
    if (
      mission.lifecycle.terms_revision !== r.terms ||
      ["closed", "archived"].includes(mission.lifecycle.phase)
    )
      throw new Error(
        "Mission terms changed or work has ended. Review the mission again.",
      );
    if (r.ownerPermission && owner !== mission.owner)
      throw new Error("Only this mission's owner can authorize resources.");
    if (!r.ownerPermission && !r.contributionId)
      throw new Error("Choose a contribution on this Mac.");
    const agent = await this.agent(r.mission, r.registration);
    if (
      (mission.lifecycle.coordinator?.appointment ?? null) !== r.coordinator ||
      (mission.lifecycle.plan?.id ?? null) !== r.plan
    )
      throw new Error(
        "The Coordinator or plan changed. Read the current mission before approving.",
      );
    let binding = null;
    if (r.contributionId) {
      const { contribution } = await this.node.executionContext(
        r.contributionId,
      );
      if (
        contribution.sharedAgent?.registration !== r.registration ||
        contribution.mission.missionId !== r.mission
      )
        throw new Error("Contribution does not match the reviewed agent.");
      binding = executionBinding(contribution);
    }
    for (const other of this.list(r.mission))
      if (
        other.request.registration === r.registration &&
        other.status === "active"
      )
        this.save(other, {
          status: "stopped",
          message: "Replaced by your new contribution review.",
        });
    const createdAt = this.clock();
    const a = this.store.write({
      id: r.id,
      request: r,
      createdAt,
      expiresAt: createdAt + r.minutes * 60000,
      coordinator: mission.lifecycle.coordinator?.appointment ?? null,
      plan: r.plan,
      awaitingInitialPlan:
        r.plan === null &&
        mission.definition.policy?.coordination === "coordinated",
      contributor: agent.contributor,
      binding,
      direction: agent.direction?.id ?? null,
      resumeGrant: r.contributionId
        ? (this.executions.store.read(r.contributionId)?.grant ?? null)
        : null,
      status: "active",
      message: "Approved. Waiting for authorized work.",
      grants: [],
      allocation: null,
      allocationBefore: null,
      pending: null,
    });
    return a;
  }
  async cancel(id) {
    const a = this.store.read(id);
    if (!a) throw new Error("Unknown contribution approval.");
    this.save(a, {
      status: "stopped",
      message:
        "You stopped this contribution. It will not restart automatically.",
    });
    // Persist revocation before waiting for an in-flight reconciliation.
    await this.pending?.catch(() => {});
    if (a.request.contributionId)
      await this.executions.stop(a.request.contributionId);
    else {
      const ledger = await this.node.handle("governance", {
        mission: a.request.mission,
      });
      const { mission } = await this.mission(a.request.mission);
      for (const grant of ledger.grants.filter(
        (g) => this.store.read(a.id).grants.includes(g.id) && !g.sealed,
      ))
        await this.node.handle("govern", {
          mission: mission.id,
          control: mission.lifecycle.revision,
          action: {
            type: "stop_grant",
            grant: grant.id,
            reason: "Owner ended the contribution approval.",
          },
        });
    }
  }
  async cancelLocal(id) {
    for (const a of readable(this.store).filter(
      (a) => a.request.contributionId === id && a.status === "active",
    ))
      this.save(a, {
        status: "stopped",
        message: "You stopped this agent. Automatic continuation is off.",
      });
    await this.pending?.catch(() => {});
  }
  async continue(id) {
    const a = this.store.read(id);
    if (!a || a.status !== "interrupted")
      throw new Error(
        "Approval changed or ended. Review a new contribution approval.",
      );
    const { mission } = await this.mission(a.request.mission);
    await this.check(a, mission, true);
    if (this.store.read(id)?.status !== "interrupted")
      throw new Error("This contribution was stopped. Review a new approval.");
    this.save(a, {
      status: "active",
      resumeGrant: a.request.contributionId
        ? (this.executions.store.read(a.request.contributionId)?.grant ?? null)
        : null,
      message: "Continuing within your original expiry and limits.",
    });
  }
  async check(a, mission, allowInterrupted = false) {
    const savedStatus = this.store.read(a.id)?.status;
    if (
      this.closed ||
      (savedStatus !== "active" &&
        !(allowInterrupted && savedStatus === "interrupted"))
    )
      throw new Error("Contribution stopped.");
    if (this.remaining(a) <= 0)
      throw approvalEnded(
        "Your contribution window ended. Review a new window to continue.",
      );
    if (
      mission.lifecycle.terms_revision !== a.request.terms ||
      (mission.lifecycle.coordinator?.appointment ?? null) !== a.coordinator
    )
      throw reviewRequired(
        "Instructions or Coordinator changed. Review your contribution again.",
      );
    if (
      !a.awaitingInitialPlan &&
      (mission.lifecycle.plan?.id ?? null) !== a.plan
    )
      throw reviewRequired(
        "The accepted plan changed. Review your contribution again.",
      );
    if (a.awaitingInitialPlan && mission.lifecycle.phase === "active")
      this.save(a, {
        plan: mission.lifecycle.plan?.id ?? null,
        awaitingInitialPlan: false,
      });
    if (a.request.contributionId) {
      const { contribution } = await this.node.executionContext(
        a.request.contributionId,
      );
      if (executionBinding(contribution) !== a.binding)
        throw reviewRequired(
          "Local limits or isolation policy changed. Review your contribution.",
        );
    }
  }
  startReviewed(input) {
    const request = reviewedStartRequest.parse(input);
    const running = this.starting.get(request.id);
    if (running) {
      if (!same(request, running.request))
        return Promise.reject(new Error("Start review changed."));
      return running.promise;
    }
    const promise = this.performStart(request).finally(() =>
      this.starting.delete(request.id),
    );
    this.starting.set(request.id, { request, promise });
    return promise;
  }
  async performStart(input) {
    const r = reviewedStartRequest.parse(input);
    let job = this.starts.read(r.id);
    if (job && !same(job.request, r))
      throw new Error("Start review changed. Open a fresh review.");
    if (job?.phase === "complete") return job;
    if (job?.phase === "cancelled")
      throw new Error("This review was cancelled. Open a new Start review.");
    const { mission, owner } = await this.mission(r.mission);
    if (owner !== mission.owner) throw new Error("Mission owner required.");
    if (!job) {
      if (
        mission.lifecycle.revision !== r.revision ||
        mission.lifecycle.start_blockers.length
      )
        throw new Error(
          "Mission changed or is not ready. Review the current plan.",
        );
      if (
        r.approvals.some(
          (a) =>
            a.mission !== r.mission ||
            a.terms !== mission.lifecycle.terms_revision ||
            !a.ownerPermission,
        )
      )
        throw new Error("Approval must match the reviewed mission.");
      job = this.starts.write({
        id: r.id,
        request: r,
        phase: "reviewed",
        revision: null,
        createdAt: this.clock(),
        terms: mission.lifecycle.terms_revision,
        coordinator: mission.lifecycle.coordinator?.appointment ?? null,
        plan: mission.lifecycle.plan?.id ?? null,
      });
    }
    for (const approval of r.approvals) await this.approve(approval);
    if (job.phase === "reviewed") {
      const current = (await this.mission(r.mission)).mission;
      if (
        current.lifecycle.terms_revision !== job.terms ||
        (current.lifecycle.coordinator?.appointment ?? null) !==
          job.coordinator ||
        (current.lifecycle.plan?.id ?? null) !== job.plan
      )
        throw new Error(
          "Mission terms, Coordinator or plan changed. Open a fresh Start review.",
        );
      if (
        current.lifecycle.phase === "active" &&
        (current.lifecycle.readiness?.id ?? null) === r.readiness
      ) {
        // A lost response may have left the reviewed mission Active. The
        // terms, appointment and exact plan were checked above. Never issue
        // another Start merely because its response was lost.
        if (
          current.lifecycle.plan?.id !== current.lifecycle.readiness?.plan &&
          r.readiness !== null
        )
          throw new Error(
            "Start outcome changed. Inspect the current mission; no second Start was sent.",
          );
      } else {
        if (current.lifecycle.revision !== r.revision)
          throw new Error("Mission changed. Review the current plan.");
        await this.node.handle("startMission", {
          mission: r.mission,
          revision: r.revision,
          readiness: r.readiness,
        });
      }
      job = this.starts.write({
        ...job,
        phase: "started",
        revision: (await this.mission(r.mission)).mission.lifecycle.revision,
      });
    }
    await this.tick();
    return this.starts.write({ ...job, phase: "complete" });
  }
  async cancelStart(id) {
    await this.starting.get(id)?.promise.catch(() => {});
    const job = this.starts.read(id);
    if (!job) throw new Error("Unknown Start review.");
    for (const approval of job.request.approvals)
      if (this.store.read(approval.id)) await this.cancel(approval.id);
    return this.starts.write({ ...job, phase: "cancelled" });
  }
  tick() {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.reconcile().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  async reconcile() {
    for (const a of readable(this.store).filter((a) => a.status === "active")) {
      try {
        await this.advance(a);
      } catch (e) {
        if (this.store.read(a.id)?.status === "active")
          this.save(a, {
            status:
              this.clock() >= a.expiresAt || e.code === "approval_ended"
                ? "expired"
                : e.code === "approval_review"
                  ? "review"
                  : "interrupted",
            message: e.message.slice(0, 2048),
          });
      }
    }
  }
  async advance(a) {
    const { mission, owner } = await this.mission(a.request.mission);
    if (["closed", "archived"].includes(mission.lifecycle.phase))
      return this.save(a, {
        status: "stopped",
        message: "Mission finished. Your saved work remains available.",
      });
    await this.check(a, mission);
    if (mission.lifecycle.phase !== "active") {
      this.save(a, {
        waitingFor:
          mission.lifecycle.phase === "paused"
            ? "mission_resume"
            : "mission_start",
        message:
          mission.lifecycle.phase === "paused"
            ? "Mission paused. Waiting for the owner's Resume."
            : "Ready. Waiting for the owner to Start.",
      });
      return;
    }
    const agent = await this.agent(mission.id, a.request.registration);
    if (agent.status !== "direction_assigned" || !agent.direction) {
      this.save(a, {
        waitingFor: "direction",
        message: "Waiting for the Coordinator or owner to assign a direction.",
      });
      return;
    }
    if (
      !a.request.followDirections &&
      a.direction &&
      a.direction !== agent.direction.id
    )
      throw reviewRequired("Direction changed. Review it before continuing.");
    if (!a.direction) this.save(a, { direction: agent.direction.id });
    let ledger = await this.node.handle("governance", { mission: mission.id });
    const localId = a.request.contributionId;
    const localRecord = localId ? this.executions.store.read(localId) : null;
    if (
      localId &&
      localRecord &&
      ["ready", "stopped"].includes(localRecord.status)
    ) {
      const unused = ledger.grants.filter(
        (g) =>
          g.registration === agent.id &&
          !g.sealed &&
          g.id !== localRecord.grant &&
          g.reserved === 0 &&
          (g.revoked ||
            g.control !== mission.lifecycle.revision ||
            g.direction !== agent.direction.id ||
            Math.min(g.expires_ms, g.issued_ms + g.offline_ms) <= this.clock()),
      );
      if (unused.length) {
        const channel = this.node.openResourceLedger(localId);
        try {
          for (const g of unused) await channel.seal(g.id);
        } finally {
          channel.close();
        }
        ledger = await this.node.handle("governance", { mission: mission.id });
      }
      if (
        localRecord.status === "stopped" &&
        localRecord.wake &&
        /permission.*expired|Permission turn allowance completed/i.test(
          localRecord.reason,
        ) &&
        !(await this.executions.hasNewWork(localId))
      ) {
        this.save(a, {
          waitingFor: "new_work",
          message:
            "Session saved. Waiting for new messages or work; no model turn is being spent.",
        });
        return;
      }
    }
    if (a.request.ownerPermission) {
      if (owner !== mission.owner)
        throw new Error("This device no longer owns the mission.");
      await this.issue(a, mission, agent, ledger);
      ledger = await this.node.handle("governance", { mission: mission.id });
    }
    const id = a.request.contributionId;
    if (!id) {
      this.save(a, {
        waitingFor: "contributor",
        message:
          "Work authorized. Waiting for this agent's contributor to approve and run.",
      });
      return;
    }
    const record = this.executions.store.read(id);
    if (
      !record ||
      ["preparing", "login_required", "failed"].includes(record.status)
    ) {
      this.save(a, {
        waitingFor: "setup",
        message: "Finish this agent's setup and provider sign-in.",
      });
      return;
    }
    if (record.status === "recovery_required")
      throw new Error(
        "Confirm the previous process stopped before continuing.",
      );
    if (!["ready", "stopped"].includes(record.status)) {
      this.save(a, { waitingFor: null, message: record.reason });
      return;
    }
    const oldGrant = ledger.grants.find((g) => g.id === record.grant);
    if (
      record.status === "stopped" &&
      record.grant !== a.resumeGrant &&
      oldGrant?.purpose !== "planning" &&
      !/Permission (turn allowance completed|completed)|permission expired|Direction changed|Mission is not authorized/i.test(
        record.reason,
      )
    )
      throw new Error(
        record.reason + " Review and continue this contribution.",
      );
    if (
      [...this.executions.jobs.keys()].filter((id) =>
        ["reserving", "launching", "running", "stopping"].includes(
          this.executions.store.read(id)?.status,
        ),
      ).length +
        this.executions.busy.size >=
      (this.executions.provider.maximum ?? 1)
    ) {
      this.save(a, {
        waitingFor: "capacity",
        message:
          "Queued for capacity on this Mac. Other agents are using its environment slots.",
      });
      return;
    }
    const current = await this.node.executionContext(id);
    const used = ledger.grants
      .filter((g) => a.grants.includes(g.id))
      .reduce((n, g) => n + g.charged + g.reserved, 0);
    if (used >= a.request.turns)
      throw approvalEnded("Your approved turn allowance is complete.");
    const grant = currentPermissions(current, record, this.clock()).find(
      (g) => g.purpose === "work",
    );
    if (!grant) {
      this.save(a, {
        waitingFor: "owner_permission",
        message:
          "Ready. Waiting for an owner permission within your contribution limits.",
      });
      return;
    }
    // Persist the exact permission before consent/start; a crash or duplicate
    // tick cannot spend a second permission or silently extend the window.
    if (!a.grants.includes(grant.id))
      this.save(a, { grants: [...a.grants, grant.id] });
    await this.check(a, (await this.mission(mission.id)).mission);
    if (!grant.consent)
      await this.node.handle("consentGrant", {
        mission: mission.id,
        grant: grant.id,
        contributionId: id,
      });
    await this.check(a, (await this.mission(mission.id)).mission);
    await this.executions.start(id, grant.id);
    this.save(a, {
      waitingFor: null,
      message:
        "Approved. The local host is starting or resuming work within your limits.",
    });
  }
  async issue(a, mission, agent, ledger) {
    const govern = (action) =>
      this.node.handle("govern", {
        mission: mission.id,
        control: mission.lifecycle.revision,
        action,
      });
    if (a.pending) {
      const recovered = ledger.grants.find(
        (g) =>
          g.execution === a.pending.execution &&
          g.generation === a.pending.generation,
      );
      if (recovered)
        this.save(a, {
          grants: [...new Set([...a.grants, recovered.id])],
          pending: null,
        });
    }
    const previous = ledger.grants
      .filter((g) => g.registration === agent.id)
      .at(-1);
    if (previous && !previous.sealed) return;
    const used = ledger.grants
      .filter((g) => a.grants.includes(g.id))
      .reduce((n, g) => n + g.charged + g.reserved, 0);
    if (used >= a.request.turns)
      throw approvalEnded("The approved contribution allowance is complete.");
    const remaining = a.request.turns - used;
    let capacity = ledger.allocations.find((v) => v.id === a.allocation);
    if (
      capacity &&
      (capacity.sealed ||
        capacity.reclaimed ||
        (capacity.turns !== null &&
          capacity.turns <= capacity.charged + capacity.reserved))
    ) {
      this.save(a, {
        allocation: null,
        allocationBefore: null,
        allocationTurns: null,
      });
      capacity = null;
    }
    if (!a.allocation) {
      if (a.allocationBefore) {
        const candidates = ledger.allocations.filter(
          (v) =>
            !a.allocationBefore.includes(v.id) &&
            v.node === agent.contributor &&
            v.turns === (a.allocationTurns ?? a.request.turns) &&
            v.slots === 1,
        );
        if (candidates.length !== 1)
          throw new Error(
            "Allocation response is uncertain. Review resources before continuing.",
          );
        capacity = candidates[0];
        this.save(a, { allocation: capacity.id, allocationBefore: null });
      } else {
        const existing = ledger.allocations.find(
          (v) =>
            v.node === agent.contributor &&
            !v.sealed &&
            !v.reclaimed &&
            v.active < v.slots &&
            (v.turns === null || v.turns - v.charged - v.reserved > 0),
        );
        if (existing) {
          capacity = existing;
          this.save(a, { allocation: existing.id });
        } else {
          const budget = mission.definition.policy?.budget;
          const assigned = ledger.allocations.reduce(
            (n, v) => n + (v.reclaimed ? v.charged : (v.turns ?? Infinity)),
            0,
          );
          const turns = Math.min(
            remaining,
            budget?.mode === "limited" && budget.turns != null
              ? budget.turns - assigned
              : remaining,
          );
          if (turns < 1)
            throw new Error(
              "Mission resources are allocated. Review remaining allowances before continuing.",
            );
          this.save(a, {
            allocationBefore: ledger.allocations.map((v) => v.id),
            allocationTurns: turns,
          });
          const result = await govern({
            type: "allocate",
            node: agent.contributor,
            turns,
            slots: 1,
          });
          capacity = { turns, charged: 0, reserved: 0 };
          this.save(a, { allocation: result.event, allocationBefore: null });
        }
      }
    }
    await this.check(a, (await this.mission(mission.id)).mission);
    const expires = Math.min(a.expiresAt, this.clock() + 10 * 60000);
    if (expires - this.clock() < 15000) return;
    const pending = a.pending ?? {
      execution: previous?.execution ?? hash(a.id),
      generation: previous ? previous.generation + 1 : 1,
      control: mission.lifecycle.revision,
      direction: agent.direction.id,
    };
    if (
      pending.control !== mission.lifecycle.revision ||
      pending.direction !== agent.direction.id
    )
      throw new Error(
        "Interrupted permission belongs to an earlier direction. Review before continuing.",
      );
    this.save(a, { pending });
    const result = await govern({
      type: "grant",
      purpose: "work",
      previous: previous?.seal ?? null,
      allocation: a.allocation,
      registration: agent.id,
      direction: pending.direction,
      execution: pending.execution,
      generation: pending.generation,
      turns: Math.min(
        5,
        remaining,
        capacity?.turns != null
          ? capacity.turns - capacity.charged - capacity.reserved
          : remaining,
      ),
      expires_ms: expires,
      offline_ms: Math.max(1, expires - this.clock() - 10000),
    });
    this.save(a, { grants: [...a.grants, result.event], pending: null });
  }
  constrain(id, context) {
    const grant = context.grant;
    if (!grant) return context;
    const a = readable(this.store).find(
      (a) => a.request.contributionId === id && a.grants.includes(grant.id),
    );
    if (!a) return context; // Explicit legacy one-run consent stays one-run.
    if (
      a.status !== "active" ||
      this.remaining(a) <= 0 ||
      context.context.lifecycle.terms_revision !== a.request.terms ||
      (context.context.lifecycle.coordinator?.appointment ?? null) !==
        a.coordinator ||
      (!a.awaitingInitialPlan &&
        (context.context.lifecycle.plan?.id ?? null) !== a.plan) ||
      executionBinding(context.contribution) !== a.binding
    )
      throw new Error(
        "Contribution approval ended or changed. Review before continuing.",
      );
    const used = context.governance.grants
      .filter((g) => a.grants.includes(g.id))
      .reduce(
        (n, g) => n + g.charged + (g.id === grant.id ? 0 : g.reserved),
        0,
      );
    if (used >= a.request.turns)
      throw new Error("Contribution turn allowance completed.");
    return {
      ...context,
      grant: {
        ...grant,
        expires_ms: Math.min(grant.expires_ms, a.expiresAt),
        turns: Math.min(grant.turns, grant.charged + a.request.turns - used),
      },
    };
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.pending?.catch(() => {});
    await Promise.allSettled([...this.starting.values()].map((v) => v.promise));
  }
  remaining(a) {
    const now = this.clock();
    let limit = this.deadlines.get(a.id);
    if (!limit) {
      limit = {
        end: performance.now() + Math.max(0, a.expiresAt - now),
        wall: a.lastObservedAt ?? a.createdAt,
      };
      this.deadlines.set(a.id, limit);
    }
    if (now + 1000 < limit.wall)
      throw reviewRequired(
        "The device clock moved backwards. Review the contribution window before continuing.",
      );
    limit.wall = Math.max(limit.wall, now);
    return Math.min(a.expiresAt - now, limit.end - performance.now());
  }
  start() {
    this.timer = setInterval(() => void this.tick().catch(() => {}), 3000);
    this.timer.unref?.();
  }
}
