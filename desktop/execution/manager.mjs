import { authoringPack } from "../../shared/authoring-packs.mjs";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { effectiveConfiguration, browserReceipt } from "./provenance.mjs";
import {
  appendFileSync,
  statSync,
  renameSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Id, NetworkAccess, CapabilityPack } from "../model.mjs";
import { currentPermissions } from "./permissions.mjs";
import {
  cleanLoginOutput,
  loginPresentation,
  loginURL,
} from "./authentication.mjs";
import { createWakeTracker } from "./wake.mjs";
import {
  executionDiagnostics,
  retainedDiagnosticEvents,
} from "./diagnostics.mjs";
import { buildTurnBriefing } from "./prompt.mjs";
import { ContextDelivery } from "./delivery.mjs";
import { AgentFacade, AgentTools } from "./facade.mjs";
import {
  OperationJournal,
  OperationStart,
  OperationProgress,
} from "./operations.mjs";
import { CheckpointStore } from "./checkpoints.mjs";
import { ArtifactBrowserRequest } from "../artifact-browser.mjs";
import {
  WorkWait,
  newRecord,
  permissionLease,
  validateProvider,
  runtimePolicy,
  policyDigest,
  providerPolicy,
} from "./contract.mjs";

const inflight = new Set([
  "reserving",
  "launching",
  "running",
  "waiting",
  "stopping",
  "recovery_required",
]);
const hash = () => randomBytes(32).toString("hex");

/** Owns local intent and process truth; the replicated ledger owns allowance.
 * Neither peer messages nor renderer fields can instantiate a provider. */
export class ExecutionManager {
  jobs = new Map();
  busy = new Set();
  operations = new Map();
  preparations = new Map();
  authentications = new Map();
  closed = false;
  constructor({
    store,
    provider,
    node,
    exportWorkspace,
    importWorkspace,
    browseArtifact,
    pollMs = 2000,
  }) {
    this.store = store;
    this.provider = validateProvider(provider);
    this.node = node;
    this.exportWorkspace = exportWorkspace;
    this.importWorkspace = importWorkspace;
    this.browseArtifact = browseArtifact;
    this.pollMs = pollMs;
    this.operationJournal = new OperationJournal(store.directory);
    this.checkpoints = new CheckpointStore(store.directory);
  }
  contribution(id) {
    Id.parse(id);
    const local = this.node.contributors?.store
      .read()
      .contributions.find((c) => c.id === id);
    if (!local) throw new Error("Unknown contribution on this device.");
    return local;
  }
  log(id, type, message) {
    const limit = ["effective_configuration", "browser_receipt"].includes(type)
      ? 32768
      : 2048;
    let content = String(message);
    if (content.length > limit) {
      // Preserve parseable structured records, explicitly reporting omissions.
      // Browser receipts are also returned in full to the agent for publication.
      try {
        JSON.parse(content);
        content = JSON.stringify({
          truncated: true,
          characters: content.length,
          reason: "Execution event exceeds the retained record limit.",
        });
      } catch {
        content = content.slice(0, limit);
      }
    }
    const path = join(this.store.directory, `${Id.parse(id)}.events.jsonl`);
    if ((statSync(path, { throwIfNoEntry: false })?.size || 0) > 1024 * 1024)
      renameSync(path, `${path}.previous`);
    appendFileSync(
      path,
      JSON.stringify({
        at: Date.now(),
        type,
        message: content,
      }) + "\n",
      { mode: 0o600 },
    );
  }
  async state(id) {
    const contribution = this.contribution(id);
    let record = this.store.read(id);
    if (record?.status === "stopped" && !record.grant && !record.session) {
      record = this.store.update(id, {
        status: "failed",
        reason:
          "This environment was closed before its first run. Prepare it again to verify setup and guest sign-in; its files are retained.",
      });
    }
    if (record?.status === "preparing" && !this.busy.has(id)) {
      record = this.store.update(id, {
        status: "failed",
        reason:
          "Environment preparation was interrupted. Prepare it again to verify every component.",
      });
    }
    if (
      record &&
      inflight.has(record.status) &&
      !this.jobs.has(id) &&
      !this.busy.has(id)
    ) {
      await this.stop(id, "Recovered after an interrupted desktop session.");
      record = this.store.read(id);
    }
    if (
      record &&
      !inflight.has(record.status) &&
      !this.busy.has(id) &&
      record.policy !==
        policyDigest(contribution.runtime, contribution.networkAccess)
    ) {
      // A crash between local consent and journal writes cannot restore the
      // old network policy. Preparation below validates the stopped guest.
      record = this.store.update(id, {
        status: "failed",
        reason:
          "Internet access changed. Prepare the environment and review permission before running.",
      });
    }
    if (
      record &&
      ["ready", "login_required"].includes(record.status) &&
      !this.busy.has(id) &&
      !this.authentications.get(id)?.handle
    ) {
      try {
        const current = await this.provider.inspect({ contribution });
        if (current.running && current.stopped)
          record = this.store.update(id, {
            status: current.authenticated ? "ready" : "login_required",
            reason: current.authenticated
              ? "Guest login is present. Choose a current permission to run."
              : "Sign in to the selected runtime inside this isolated environment.",
          });
      } catch {
        /* A stopped VM can be checked during explicit start/login. */
      }
    }
    let events = [];
    try {
      events = readFileSync(
        join(this.store.directory, `${id}.events.jsonl`),
        "utf8",
      )
        .trim()
        .split("\n")
        .slice(-80)
        .flatMap((s) => {
          try {
            const event = JSON.parse(s);
            return typeof event?.type === "string" &&
              typeof event?.message === "string"
              ? [event]
              : [];
          } catch {
            return [];
          } // A partial log write cannot block Stop/recovery.
        });
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    let agent = null,
      permissions = [],
      direction = null,
      permissionProblem = null;
    if (!this.closed && !this.busy.has(id)) {
      try {
        const current = await this.node.executionContext(id);
        permissions = currentPermissions(current, record);
        agent = current.context.agent;
        direction = current.context.agent.direction ?? null;
      } catch (error) {
        permissionProblem = error.message;
      }
    }
    return {
      observedAt: Date.now(),
      record,
      agent,
      permissions,
      direction,
      permissionProblem,
      policy: runtimePolicy(contribution.runtime, contribution.networkAccess),
      networkAccess: contribution.networkAccess ?? "restricted",
      networkRevision: contribution.networkRevision ?? null,
      capabilityPack: contribution.capabilityPack ?? "general",
      capabilityRevision: contribution.capabilityRevision ?? null,
      capacity: this.provider.maximum ?? 1,
      busy: this.busy.has(id),
      events,
      operations: this.operationJournal
        .list(id)
        .map(({ result, ...operation }) => ({
          ...operation,
          resultAvailable: result != null,
        })),
      checkpoints: this.checkpoints.list(id).map(({ at, manifest }) => ({
        id: manifest.digest,
        at,
        files: manifest.files.length,
        bytes: manifest.bytes,
        exclusions: manifest.exclusions,
      })),
      authentication: this.authentications.get(id)?.view ?? null,
      agreement: this.agreements?.local(id) ?? null,
    };
  }
  resourceHint(id) {
    // A local scheduling hint, never an offer or execution grant. Provider
    // subscription balances cannot be measured reliably and stay unknown.
    const occupied = new Set(
      [...this.jobs.keys()]
        .filter((key) =>
          ["reserving", "launching", "running", "stopping"].includes(
            this.store.read(key)?.status,
          ),
        )
        .concat([
          ...this.busy,
          ...[...this.authentications]
            .filter(([, a]) => a.handle || a.view.status === "starting")
            .map(([id]) => id),
        ]),
    );
    const lease = this.jobs.get(id)?.lease;
    return {
      free_slots: Math.max(0, (this.provider.maximum ?? 1) - occupied.size),
      permission_until_ms: lease
        ? Date.now() + Math.max(0, Math.floor(lease.remaining()))
        : null,
    };
  }
  async overview(mission) {
    const items = this.node.contributors.store
      .read()
      .contributions.filter((c) => c.mission.missionId === mission);
    const result = {};
    // Bound VM inspection concurrency; one failing environment cannot hide
    // another agent's status.
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, items.length) }, async () => {
        while (cursor < items.length) {
          const item = items[cursor++];
          try {
            result[item.id] = await this.state(item.id);
          } catch (error) {
            result[item.id] = {
              observedAt: Date.now(),
              error: error.message,
              record: null,
              permissions: [],
              events: [],
            };
          }
        }
      }),
    );
    return result;
  }
  async diagnostics(id) {
    this.contribution(id);
    return executionDiagnostics(
      await this.state(id),
      retainedDiagnosticEvents(this.store.directory, id),
    );
  }
  async exclusive(id, action) {
    if (this.closed) throw new Error("Execution service is closing.");
    if (this.busy.has(id) || this.jobs.has(id))
      throw new Error("An execution operation is already active.");
    this.busy.add(id);
    const pending = Promise.resolve().then(action);
    this.operations.set(id, pending);
    try {
      return await pending;
    } finally {
      this.busy.delete(id);
      this.operations.delete(id);
    }
  }
  async prepare(id) {
    return this.exclusive(id, async () => {
      const controller = new AbortController();
      this.preparations.set(id, controller);
      try {
        if (this.authentications.get(id)?.handle)
          throw new Error("Finish or cancel sign-in first.");
        const { contribution } = await this.node.executionContext(id);
        controller.signal.throwIfAborted();
        const old = this.store.read(id);
        const digest = policyDigest(
          contribution.runtime,
          contribution.networkAccess,
        );
        if (
          providerPolicy(
            this.provider,
            contribution.runtime,
            contribution.networkAccess,
          ) !== digest
        )
          throw new Error(
            "This provider does not enforce the selected internet policy.",
          );
        if (
          old &&
          old.policy !== digest &&
          !(
            contribution.networkRevision &&
            ["restricted", "internet"].some(
              (mode) => old.policy === policyDigest(contribution.runtime, mode),
            )
          )
        )
          throw new Error("Runtime policy changed; create a new contribution.");
        if (old && inflight.has(old.status))
          throw new Error("Recover and stop the previous execution first.");
        this.store.write(
          old
            ? {
                ...old,
                policy: digest,
                status: "preparing",
                reason: "Preparing isolated environment.",
              }
            : newRecord(
                id,
                Date.now(),
                contribution.runtime,
                contribution.networkAccess,
              ),
        );
        try {
          const result = await this.provider.prepare({
            contribution,
            signal: controller.signal,
            onProgress: (reason) =>
              this.store.update(id, { reason: String(reason).slice(0, 2048) }),
          });
          controller.signal.throwIfAborted();
          this.store.update(id, {
            ...(old && result.created
              ? {
                  session: null,
                  wake: undefined,
                  recoveredSource: undefined,
                  reconstructedAt: Date.now(),
                }
              : {}),
            status: result.authenticated ? "ready" : "login_required",
            reason: result.authenticated
              ? "Isolated environment prepared."
              : "Sign in to the selected runtime inside this guest.",
          });
          if (old && result.created)
            this.log(
              id,
              "environment_recreated",
              "A new isolated environment replaced a missing one. The old runtime transcript and guest sign-in are unavailable. Restore saved source or import a published project, then review a new permission before continuing.",
            );
          this.log(
            id,
            "prepared",
            "Lima VM prepared with separate runtime and worker accounts.",
          );
        } catch (error) {
          let stopped = false;
          try {
            stopped = (await this.provider.terminate({ contribution })).stopped;
          } catch {
            /* Preserve uncertainty until recovery can confirm termination. */
          }
          this.store.update(id, {
            status: stopped ? "failed" : "recovery_required",
            reason: !stopped
              ? "Setup was interrupted and the environment’s stop is not confirmed. Recover it before retrying."
              : controller.signal.aborted
                ? "Setup cancelled. Saved files are retained; prepare again to continue safely."
                : error.message.slice(0, 2048),
          });
          throw error;
        }
      } finally {
        this.preparations.delete(id);
      }
    });
  }
  async setNetwork(id, networkAccess, expectedRevision) {
    NetworkAccess.parse(networkAccess);
    if (expectedRevision !== null) Id.parse(expectedRevision);
    const changed = await this.exclusive(id, async () => {
      const contribution = this.contribution(id);
      if (
        contribution.status !== "prepared" ||
        !contribution.nodeBinding ||
        contribution.sharedAgent?.withdrawn
      )
        throw new Error("Choose an active local contribution.");
      if ((contribution.networkRevision ?? null) !== expectedRevision)
        throw new Error(
          "Internet access changed. Review the current setting again.",
        );
      if (
        providerPolicy(this.provider, contribution.runtime, networkAccess) !==
        policyDigest(contribution.runtime, networkAccess)
      )
        throw new Error(
          "This provider does not enforce the selected internet policy.",
        );
      if (
        this.authentications.get(id)?.handle ||
        this.authentications.get(id)?.view.status === "starting"
      )
        throw new Error(
          "Finish or cancel sign-in before changing internet access.",
        );
      const record = this.store.read(id);
      if (
        record &&
        (inflight.has(record.status) || record.status === "preparing")
      )
        throw new Error(
          "Stop and recover this agent before changing internet access.",
        );
      if ((contribution.networkAccess ?? "restricted") === networkAccess)
        return false;
      // Even a ready VM must be shut down before changing policy. A failed or
      // uncertain shutdown leaves consent and the existing policy untouched.
      if (!(await this.provider.terminate({ contribution })).stopped)
        throw new Error(
          "The environment's stop is unconfirmed. Recover it before changing internet access.",
        );
      const networkRevision = randomUUID();
      this.node.contributors.store.update((local) => {
        const current = local.contributions.find((c) => c.id === id);
        if (
          !current ||
          current.status !== "prepared" ||
          current.sharedAgent?.withdrawn ||
          (current.networkRevision ?? null) !== expectedRevision
        )
          throw new Error(
            "Contribution changed. Review its current access settings.",
          );
        current.networkAccess = networkAccess;
        current.networkRevision = networkRevision;
        local.activity.unshift({
          id: randomUUID(),
          at: new Date().toISOString(),
          type: "network_changed",
          contributionId: id,
          label:
            networkAccess === "internet"
              ? "Public HTTPS access allowed"
              : "Workspace internet access blocked",
        });
        local.activity = local.activity.slice(0, 1000);
      });
      if (record)
        this.store.update(id, {
          status: "failed",
          policy: policyDigest(contribution.runtime, networkAccess),
          reason:
            "Internet access changed. Prepare the environment and review permission before running.",
        });
      this.log(
        id,
        "network_changed",
        networkAccess === "internet"
          ? "Contributor allowed public HTTPS. Previous execution consent is invalid."
          : "Contributor blocked workspace internet access. Previous execution consent is invalid.",
      );
      return true;
    });
    // Applying configuration never starts a model or grants execution. If it
    // fails, the saved choice remains visible and preparation can be retried.
    if (changed) await this.prepare(id);
  }
  async setCapabilityPack(id, capabilityPack, expectedRevision) {
    CapabilityPack.parse(capabilityPack);
    if (expectedRevision !== null) Id.parse(expectedRevision);
    const changed = await this.exclusive(id, async () => {
      const contribution = this.contribution(id);
      if (
        contribution.status !== "prepared" ||
        !contribution.nodeBinding ||
        contribution.sharedAgent?.withdrawn
      )
        throw new Error("Choose an active local contribution.");
      if ((contribution.capabilityRevision ?? null) !== expectedRevision)
        throw new Error(
          "Authoring tools changed. Review the current setting again.",
        );
      if (
        this.authentications.get(id)?.handle ||
        this.authentications.get(id)?.view.status === "starting"
      )
        throw new Error(
          "Finish or cancel sign-in before changing authoring tools.",
        );
      const record = this.store.read(id);
      if (
        record &&
        (inflight.has(record.status) || record.status === "preparing")
      )
        throw new Error(
          "Stop and recover this agent before changing authoring tools.",
        );
      if ((contribution.capabilityPack ?? "general") === capabilityPack)
        return false;
      // Even a ready VM must be shut down before changing the toolkit. A failed or
      // uncertain shutdown leaves consent and the existing policy untouched.
      if (!(await this.provider.terminate({ contribution })).stopped)
        throw new Error(
          "The environment's stop is unconfirmed. Recover it before changing authoring tools.",
        );
      const capabilityRevision = randomUUID();
      this.node.contributors.store.update((local) => {
        const current = local.contributions.find((c) => c.id === id);
        if (
          !current ||
          current.status !== "prepared" ||
          current.sharedAgent?.withdrawn ||
          (current.capabilityRevision ?? null) !== expectedRevision
        )
          throw new Error("Contribution changed. Review its current toolkit.");
        current.capabilityPack = capabilityPack;
        current.capabilityRevision = capabilityRevision;
        local.activity.unshift({
          id: randomUUID(),
          at: new Date().toISOString(),
          type: "capabilities_changed",
          contributionId: id,
          label: `Authoring toolkit: ${authoringPack(capabilityPack).label}`,
        });
        local.activity = local.activity.slice(0, 1000);
      });
      if (record)
        this.store.update(id, {
          status: "failed",
          reason:
            "Authoring tools changed. Prepare the environment and review permission before running.",
        });
      this.log(
        id,
        "capabilities_changed",
        `Contributor selected ${authoringPack(capabilityPack).label}. Previous execution consent is invalid.`,
      );
      return true;
    });
    // Applying configuration never starts a model or grants execution. If it
    // fails, the saved choice remains visible and preparation can be retried.
    if (changed) await this.prepare(id);
  }
  async cancelSetup(id) {
    this.contribution(id);
    this.preparations.get(id)?.abort();
    await this.operations.get(id)?.catch(() => {});
    // Killing a provisioning client is not proof the VM stopped.
    await this.stop(id, "Setup cancelled by this device’s human.");
    if (this.store.read(id)?.status === "stopped")
      this.store.update(id, {
        status: "failed",
        reason:
          "Setup cancelled. Prepare again to verify every component. Files are retained.",
      });
  }
  async signIn(id) {
    this.contribution(id);
    if (this.closed) throw new Error("Execution service is closing.");
    if (this.authentications.get(id)?.handle) return;
    if (
      [...this.authentications].some(
        ([other, a]) =>
          other !== id && (a.handle || a.view.status === "starting"),
      )
    )
      throw new Error(
        "Finish or cancel the other agent’s provider sign-in first. Your setup is saved.",
      );
    if (this.jobs.has(id) || this.busy.has(id))
      throw new Error("Wait for setup or stop the agent before signing in.");
    const record = this.store.read(id);
    if (
      !record ||
      !["ready", "login_required", "stopped"].includes(record.status)
    )
      throw new Error("Prepare and recover the environment first.");
    const auth = {
      view: {
        status: "starting",
        text: "Starting provider sign-in…",
        urls: [],
        startedAt: Date.now(),
      },
      handle: null,
      cancelled: false,
      starting: null,
      finished: null,
    };
    this.authentications.set(id, auth);
    this.busy.add(id);
    auth.starting = Promise.resolve().then(async () => {
      try {
        const { contribution } = await this.node.executionContext(id);
        if (auth.cancelled) return;
        const handle = await this.provider.authenticate({
          contribution,
          onOutput: (chunk) => {
            if (auth.cancelled) return;
            const previous =
              auth.view.status === "starting" ? "" : auth.view.text;
            auth.view.text = cleanLoginOutput(previous + chunk).slice(-32768);
            Object.assign(
              auth.view,
              loginPresentation(
                contribution.runtime,
                auth.view.text,
                auth.view.startedAt,
                auth.view,
              ),
            );
            auth.view.status = "waiting";
          },
        });
        auth.handle = handle;
        auth.finished = handle.done
          .then(async () => {
            if (auth.cancelled) return;
            const current = await this.provider.inspect({ contribution });
            if (auth.cancelled) return;
            if (!current.authenticated)
              throw new Error("Sign-in did not complete. Try again.");
            auth.view = {
              status: "complete",
              text: "Provider sign-in completed in this isolated environment.",
              urls: [],
            };
          })
          .catch((error) => {
            if (!auth.cancelled)
              auth.view = {
                ...auth.view,
                status: "failed",
                text: "Provider sign-in did not complete. Retry or use the diagnostic command.",
                urls: [],
                error: error.message,
              };
          })
          .finally(async () => {
            // Sign-in occupies VM capacity, but must never leave a hidden guest
            // running after cancellation, failure, or successful authentication.
            try {
              const stopped = await this.provider.terminate({ contribution });
              if (!stopped.stopped)
                throw new Error("Environment stop is unconfirmed.");
              if (auth.view.status === "complete")
                this.store.update(id, {
                  status: record.status === "stopped" ? "stopped" : "ready",
                  reason:
                    "Guest sign-in completed. Review permission before execution.",
                });
            } catch {
              this.store.update(id, {
                status: "recovery_required",
                reason:
                  "Sign-in ended, but the environment’s stop is not confirmed. Recover it before continuing.",
              });
            }
            auth.handle = null;
            this.busy.delete(id);
          });
      } catch (error) {
        auth.view = { status: "failed", text: error.message, urls: [] };
        try {
          if (
            !(
              await this.provider.terminate({
                contribution: this.contribution(id),
              })
            ).stopped
          )
            throw new Error("Unconfirmed stop");
        } catch {
          this.store.update(id, {
            status: "recovery_required",
            reason:
              "Sign-in setup failed and the environment’s stop is not confirmed. Recover it before continuing.",
          });
        }
        this.busy.delete(id);
        throw error;
      } finally {
        if (!auth.handle) this.busy.delete(id);
      }
    });
    await auth.starting;
  }
  async loginInput(id, text) {
    const auth = this.authentications.get(id);
    if (!auth?.handle) throw new Error("Start sign-in first.");
    auth.handle.input(text);
  }
  async cancelLogin(id) {
    this.contribution(id);
    const auth = this.authentications.get(id);
    if (!auth) return;
    auth.cancelled = true;
    auth.view = {
      status: "cancelled",
      text: "Sign-in cancelled. No agent work was started.",
      urls: [],
    };
    // Cancellation can arrive while a guest is still booting, before a login
    // handle exists. Wait for that exact operation, then stop its login unit.
    await auth.starting?.catch(() => {});
    if (auth.handle) await auth.handle.cancel();
    await auth.finished;
    this.busy.delete(id);
  }
  async openLogin(id, url, open) {
    const contribution = this.contribution(id);
    if (
      !this.authentications.get(id)?.view.urls.includes(url) ||
      !loginURL(contribution.runtime, url)
    )
      throw new Error("This link is not a current provider sign-in link.");
    await open(url);
  }
  async login(id) {
    return this.exclusive(id, async () => {
      if (!this.store.read(id))
        throw new Error("Prepare the environment first.");
      const { contribution } = await this.node.executionContext(id);
      return this.provider.login({ contribution });
    });
  }
  async start(id, grantId) {
    return this.exclusive(id, async () => {
      const old = this.store.read(id);
      if (!old || !["ready", "stopped"].includes(old.status))
        throw new Error(
          "Prepare, sign in and recover any previous execution first.",
        );
      const raw = await this.node.executionContext(id, grantId);
      const current = this.agreements?.constrain(id, raw) ?? raw;
      if (
        old.policy !==
          policyDigest(
            current.contribution.runtime,
            current.contribution.networkAccess,
          ) ||
        providerPolicy(
          this.provider,
          current.contribution.runtime,
          current.contribution.networkAccess,
        ) !== old.policy
      )
        throw new Error(
          "Runtime policy changed; prepare a new contribution and consent again.",
        );
      if (old.grant === grantId)
        throw new Error(
          "Request a fresh permission generation before resuming stopped work.",
        );
      if (
        old.execution &&
        current.grant.execution === old.execution &&
        current.grant.generation <= old.generation
      )
        throw new Error("Resume requires a newer execution generation.");
      const lease = permissionLease(current.grant);
      const sameExecution = old.execution === current.grant.execution;
      this.store.update(id, {
        status: "reserving",
        grant: grantId,
        execution: current.grant.execution,
        generation: current.grant.generation,
        session: sameExecution ? old.session : null,
        nonce: hash(),
        reservation: null,
        receipt: null,
        dispatched: false,
        expiresAt: lease.deadline,
        interruption: null,
        reason:
          current.grant.purpose === "planning"
            ? "Coordinator planning only; waiting for human Start."
            : "Starting isolated execution.",
      });
      const job = {
        controller: new AbortController(),
        lease,
        contribution: current.contribution,
        finished: null,
        stopping: null,
      };
      this.jobs.set(id, job);
      job.finished = this.run(id, job).catch(async (error) => {
        this.log(id, "failure", error.message);
        await this.finish(id, job, error);
      });
      return this.state(id);
    });
  }
  async check(id, job) {
    if (
      job.controller.signal.aborted ||
      this.closed ||
      job.lease.remaining() <= 0
    )
      throw new Error("Local execution stopped or permission expired.");
    const record = this.store.read(id);
    const result = await this.node.executionContext(id, record.grant);
    if (
      job.controller.signal.aborted ||
      this.closed ||
      job.lease.remaining() <= 0
    )
      throw new Error("Local execution stopped or permission expired.");
    return this.agreements?.constrain(id, result) ?? result;
  }
  async wakeState(channel, waiting = null, after = null, priorityAfter = null) {
    return channel.request({
      type: "snapshot",
      after,
      priority_after: priorityAfter,
      watch: [
        ...new Set([
          ...(waiting?.artifacts ?? []),
          ...(waiting?.reviews ?? []),
        ]),
      ],
    });
  }
  async hasNewWork(id) {
    const record = this.store.read(id);
    if (!record?.wake || !record.session) return true;
    const channel = this.node.openAgentChannel(id);
    try {
      return (
        createWakeTracker(record.wake).peek(
          await this.wakeState(
            channel,
            record.wake.waiting,
            record.wake.cursor,
            record.wake.priorityCursor,
          ),
        ) !== record.wake.fingerprint
      );
    } finally {
      channel.close();
    }
  }
  async run(id, job) {
    const ledger = this.node.openResourceLedger(id);
    const channel = this.node.openAgentChannel(id);
    const wakeFingerprint = createWakeTracker(this.store.read(id)?.wake);
    let monitoring = false;
    const monitor = setInterval(async () => {
      if (monitoring || job.stopping) return;
      monitoring = true;
      try {
        await this.check(id, job);
      } catch (error) {
        void this.finish(id, job, error);
      } finally {
        monitoring = false;
      }
    }, this.pollMs);
    monitor.unref?.();
    try {
      while (!job.controller.signal.aborted) {
        const { grant } = await this.check(id, job);
        if (grant.charged + grant.reserved >= grant.turns) break;
        let record = this.store.read(id);
        if (record.status !== "reserving")
          record = this.store.update(id, {
            status: "reserving",
            nonce: hash(),
            reservation: null,
            receipt: null,
            dispatched: false,
          });
        let reservation;
        try {
          reservation = await ledger.reserve({
            grant: record.grant,
            nonce: record.nonce,
          });
        } catch (error) {
          if (error.code !== "capacity_busy") throw error;
          this.store.update(id, {
            reason:
              "Queued for a mission execution slot. No runtime turn has started.",
          });
          await delay(this.pollMs, undefined, {
            signal: job.controller.signal,
          });
          continue;
        }
        this.store.update(id, {
          reservation: reservation.event,
          status: "launching",
        });
        await this.check(id, job);
        let waiting = this.store.read(id)?.wake?.waiting ?? null;
        let context = await this.wakeState(
          channel,
          waiting,
          this.store.read(id)?.wake?.cursor,
          this.store.read(id)?.wake?.priorityCursor,
        );
        let delivered = context;
        let baseline = wakeFingerprint.baseline(context);
        const delivery = new ContextDelivery(
          this.store.read(id)?.wake,
          (visible, paths, source, notice) => {
            wakeFingerprint.deliver({
              context: delivered.context,
              owner: delivered.owner,
              humans: delivered.humans,
              ...visible,
            });
            // A partial JSON read delivers its complete message records, but does
            // not consume unrelated semantic changes in the saved snapshot.
            if (paths.includes(""))
              delivered = { ...delivered, ...(notice ?? source) };
            baseline = wakeFingerprint.baseline(delivered);
          },
          {
            onMetric: (metric) =>
              this.log(id, "coordination_timing", JSON.stringify(metric)),
          },
        );
        delivery.observe(context);
        if (record.reconstructedAt && !record.session)
          context = {
            ...context,
            context: {
              ...context.context,
              recovery: {
                mode: "new_runtime_session",
                previousTranscriptAvailable: false,
                sourceCheckpointAvailable: this.checkpoints.list(id).length > 0,
              },
            },
          };
        if (record.recoveredSource)
          context = {
            ...context,
            context: {
              ...context.context,
              recoveredSource: record.recoveredSource,
            },
          };
        const briefing = buildTurnBriefing({
          context,
          purpose: grant.purpose,
          networkAccess: job.contribution.networkAccess,
          capabilityPack: job.contribution.capabilityPack,
          seconds: job.lease.remaining() / 1000,
        });
        delivery.expose(briefing.context);
        // The briefing includes bounded state-change notices. Message delivery
        // remains exact and independent of those notices and their counts.
        delivered = context;
        baseline = wakeFingerprint.baseline(delivered);
        const facade = new AgentFacade({
          request: (operation) => channel.request(operation),
          snapshot: () =>
            this.wakeState(
              channel,
              waiting,
              delivery.cursor,
              delivery.priorityCursor,
            ),
          delivery,
        });
        if (job.controller.signal.aborted)
          throw new Error("Execution stopped before launch.");
        let lastCheckpoint = -Infinity;
        const onTool = async (tool, args) => {
          const checked = await this.check(id, job);
          if (tool === "check_permission") {
            const consequential =
              [
                "workspace_exec",
                "workspace_patch",
                "workspace_write",
                "publish_artifact",
                "import_artifact",
                "import_artifact_project",
                "integrate_project",
                "direct_agent",
                "review_artifact",
              ].includes(args?.tool) ||
              (args?.tool === "board" &&
                [
                  "work",
                  "plan",
                  "plan_artifact",
                  "criterion",
                  "direct",
                  "clarify",
                  "artifact_action",
                ].includes(args?.operation));
            const pending = checked.context.agent.pending_clarifications ?? 0;
            if (consequential && pending)
              return {
                error:
                  "Read read_briefing section clarifications, then acknowledge_update for each relevant update before continuing. Your current direction and permission remain valid; no restart is needed.",
                code: "clarification_required",
                retryable: true,
                pending,
              };
            return { allowed: true, pending_clarifications: pending };
          }
          if (tool === "record_delivery") {
            const result = delivery.confirm(args);
            this.log(
              id,
              "context_delivery",
              JSON.stringify({
                paths: args.paths.length,
                seen: delivery.seen.size,
                cursor: delivery.cursor,
                priorityCursor: delivery.priorityCursor,
                grant: record.grant,
                reservation: reservation.event,
              }),
            );
            return result;
          }
          if (tool === "operation_start") {
            const request = OperationStart.parse(args);
            if (
              ["publish", "import"].includes(request.kind) &&
              job.lease.remaining() < 15000
            )
              return {
                error:
                  "Less than 15 seconds of local permission remain. Save a source checkpoint and ask the contributor to extend or resume before starting a project transfer.",
                code: "permission_window_short",
                retryable: true,
              };
            return this.operationJournal.begin(id, request);
          }
          if (tool === "checkpoint_begin")
            return this.checkpoints.begin(id, args.manifest);
          if (tool === "checkpoint_chunk")
            return this.checkpoints.chunk(id, args);
          if (tool === "checkpoint_finish")
            return this.checkpoints.finish(id, args.id);
          if (tool === "operation_progress")
            return this.operationJournal.update(
              id,
              OperationProgress.parse(args),
            );
          if (tool === "operation_finish")
            return this.operationJournal.finish(id, args.id, args.result);
          if (tool === "operation_failed")
            return this.operationJournal.fail(
              id,
              args.id,
              args.error,
              args.state,
            );
          if (tool === "operation_status") {
            if (
              !args ||
              Object.keys(args).some(
                (key) => !["id", "cancel"].includes(key),
              ) ||
              (args.cancel !== undefined && typeof args.cancel !== "boolean") ||
              (args.cancel && !args.id)
            )
              throw new Error("Use an operation id and optional cancel flag.");
            if (!args.id)
              return {
                operations: this.operationJournal
                  .list(id)
                  .map(({ result, ...operation }) => ({
                    ...operation,
                    resultAvailable: result != null,
                  })),
              };
            return args.cancel
              ? this.operationJournal.cancel(id, args.id)
              : this.operationJournal.get(id, args.id);
          }
          if (tool === "checkpoint") {
            if (performance.now() - lastCheckpoint < 2000) return {};
            lastCheckpoint = performance.now();
            const current = await this.wakeState(
              channel,
              waiting,
              delivery.cursor,
              delivery.priorityCursor,
            );
            if (wakeFingerprint.peek(current) === baseline) return {};
            // A notice is not delivery of the messages it points at. Keep
            // them pending until read_briefing emits their actual content.
            return {
              coordination_update: {
                pending: true,
                instruction:
                  "The mission has changed while you worked. Read read_briefing overview and pending updates before your next consequential action. Reassess current direction, questions and workforce; do not keep executing an obsolete plan.",
                pending_messages: new Set(
                  [
                    ...(current.priority?.items ?? []),
                    ...(current.updates?.items ?? []),
                  ]
                    .filter((m) => !delivery.received(m))
                    .map((m) => m.id),
                ).size,
                completeness:
                  "Local observations only; remote completeness is unknown.",
              },
            };
          }
          if (Object.hasOwn(AgentTools, tool)) {
            const started = performance.now();
            try {
              const result = await facade.call(tool, args);
              if (tool === "reply") delivery.responded(args.message);
              this.log(
                id,
                "tool_outcome",
                JSON.stringify({
                  operation: tool,
                  section: args?.section,
                  outcome: "ok",
                  milliseconds: Math.round(performance.now() - started),
                  grant: record.grant,
                  reservation: reservation.event,
                }),
              );
              return result;
            } catch (error) {
              this.log(
                id,
                "tool_outcome",
                JSON.stringify({
                  operation: tool,
                  outcome: "rejected",
                  code: error.code ?? "operation_rejected",
                  milliseconds: Math.round(performance.now() - started),
                }),
              );
              throw error;
            }
          }
          if (tool === "capabilities") {
            if (!args || Object.keys(args).length)
              throw new Error("Capabilities takes no arguments.");
            return {
              protocol: 13,
              network: job.contribution.networkAccess ?? "restricted",
              authoring: authoringPack(job.contribution.capabilityPack),
              artifactBrowser: {
                available: !!this.browseArtifact,
                image: !!this.browseArtifact,
                environment: "sandboxed offline host Chromium renderer",
                session: "fresh per call",
                conditions: ["viewport", "reducedMotion", "disableWebgl"],
              },
              localResources: {
                ...this.resourceHint(id),
                providerAvailability: "unknown",
                meaning:
                  "Local hint, not reserved capacity or authority. Remote reports expire.",
              },
              workspaceCommandSeconds: 120,
              permissionSeconds: Math.max(
                0,
                Math.floor(job.lease.remaining() / 1000),
              ),
            };
          }
          if (tool === "artifact_browser") {
            if (!this.browseArtifact)
              throw new Error(
                "Artifact browser is unavailable in this host. Report browser/visual checks as not_run.",
              );
            const input = ArtifactBrowserRequest.parse(args);
            const detail = await channel.request({
              type: "artifact_detail",
              revision: input.revision,
            });
            const result = await this.browseArtifact(
              { ...input, mission: job.contribution.mission.missionId },
              detail,
              job.controller.signal,
            );
            await this.check(id, job);
            const receipt = browserReceipt({
              revision: input.revision,
              files: detail.document.files,
              request: input,
              result,
              grant: record.grant,
              reservation: reservation.event,
            });
            this.log(id, "browser_receipt", JSON.stringify(receipt));
            this.log(
              id,
              "browser_check",
              JSON.stringify({
                revision: input.revision,
                control: grant.control,
                grant: record.grant,
                reservation: reservation.event,
                width: input.width,
                height: input.height,
                reducedMotion: input.reducedMotion,
                webglDisabled: input.disableWebgl,
                steps: input.steps.length,
                errors: result.errors?.length ?? 0,
              }),
            );
            return { ...result, execution_receipt: receipt };
          }
          if (tool === "wait_for_work") {
            const checked = WorkWait.parse(args);
            const fresh = await this.wakeState(
              channel,
              checked,
              delivery.cursor,
              delivery.priorityCursor,
            );
            waiting =
              checked.artifacts.length || checked.reviews.length
                ? checked
                : null;
            wakeFingerprint.wait(waiting);
            baseline = wakeFingerprint.baseline(delivered);
            this.log(
              id,
              "dependency_wait",
              JSON.stringify({
                artifacts: checked.artifacts.length,
                reviews: checked.reviews.length,
                grant: record.grant,
                reservation: reservation.event,
              }),
            );
            return delivery.issue(
              {
                waiting: true,
                reason: checked.reason,
                dependencies: (fresh.watched ?? []).map((detail) => ({
                  revision: detail.revision,
                  heads: detail.artifact.heads,
                  reviews: detail.reviews,
                  stale: detail.stale,
                })),
                instruction:
                  "Check these dependency observations, save your checkpoint and end this turn. The host will resume on relevant changes.",
              },
              { watched: fresh.watched },
            );
          }
          if (
            tool !== "board" ||
            !args ||
            Object.keys(args).some((k) => k !== "operation")
          )
            throw new Error("Unknown scoped tool.");
          this.log(id, "tool", args.operation?.type || "invalid operation");
          const started = performance.now();
          let value;
          try {
            const operation =
              args.operation.type === "snapshot"
                ? {
                    ...args.operation,
                    after: args.operation.after ?? delivery.cursor,
                    priority_after:
                      args.operation.priority_after ?? delivery.priorityCursor,
                    watch: [
                      ...new Set([
                        ...(args.operation.watch ?? []),
                        ...(waiting?.artifacts ?? []),
                        ...(waiting?.reviews ?? []),
                      ]),
                    ],
                  }
                : args.operation;
            value = await channel.request(operation);
            this.log(
              id,
              "tool_outcome",
              JSON.stringify({
                operation: args.operation.type,
                outcome: "ok",
                control: grant.control,
                direction: grant.direction,
                milliseconds: Math.round(performance.now() - started),
                grant: record.grant,
                reservation: reservation.event,
              }),
            );
          } catch (error) {
            this.log(
              id,
              "tool_outcome",
              JSON.stringify({
                operation: args.operation.type,
                outcome: "rejected",
                code: error.code ?? "operation_rejected",
                control: grant.control,
                direction: grant.direction,
                milliseconds: Math.round(performance.now() - started),
                grant: record.grant,
                reservation: reservation.event,
              }),
            );
            throw error;
          }
          if (args.operation.type === "snapshot") return delivery.issue(value);
          if (args.operation.type === "updates")
            return delivery.issue(value, { updates: value });
          if (args.operation.type === "priority_updates")
            return delivery.issue(value, { priority: value });
          if (args.operation.type === "messages") {
            const q = args.operation.query;
            const key =
              q.view === "inbox"
                ? "inbox"
                : q.audience === "main"
                  ? "main"
                  : q.audience?.startsWith("workstream:")
                    ? "workstream"
                    : null;
            if (key) return delivery.issue(value, { [key]: value });
          }
          if (args.operation.type === "context")
            return {
              ...value,
              execution:
                grant.purpose === "planning" ? "planning_only" : "isolated",
            };
          return value;
        };
        let responseText = "";
        const flushText = () => {
          if (responseText) {
            this.log(id, "agent", responseText);
            responseText = "";
          }
        };
        const turnBegan = performance.now();
        const guide = await readFile(
          new URL("./guest/agent.md", import.meta.url),
          "utf8",
        ).catch(() => null);
        // Packaged providers carry their own immutable guest resource path.
        const effectiveGuide = this.provider.resources
          ? await readFile(join(this.provider.resources, "agent.md"), "utf8")
          : guide;
        if (effectiveGuide)
          this.log(
            id,
            "effective_configuration",
            JSON.stringify(
              effectiveConfiguration({
                runtime: job.contribution.runtime,
                role: job.contribution.role,
                networkAccess: job.contribution.networkAccess,
                capabilityPack: job.contribution.capabilityPack,
                prompt: briefing.prompt,
                guide: effectiveGuide,
              }),
            ),
          );
        const request = {
          signal: job.controller.signal,
          contribution: job.contribution,
          seconds: Math.max(1, Math.floor(job.lease.remaining() / 1000)),
          remaining: () => job.lease.remaining(),
          session: record.session,
          prompt: briefing.prompt,
          onTool,
          onSession: (session) => {
            if (job.controller.signal.aborted)
              throw new Error(
                "Execution stopped during runtime initialization.",
              );
            this.store.update(id, {
              session,
              status: "running",
              reason: "The agent is working inside the isolated VM.",
            });
            this.log(
              id,
              "runtime_ready",
              JSON.stringify({
                milliseconds: Math.round(performance.now() - turnBegan),
                grant: record.grant,
                reservation: reservation.event,
                resumed: !!record.session,
              }),
            );
          },
          onEvent: (event) => {
            if (event.update?.sessionUpdate === "tool_call") {
              flushText();
              this.log(
                id,
                "runtime_tool",
                event.update.rawInput?.tool_name ||
                  event.update.title ||
                  "Scoped tool call",
              );
            }
            if (event.update?.sessionUpdate === "agent_message_chunk") {
              responseText += event.update.content?.text || "";
              if (responseText.length >= 1024 || responseText.endsWith("\n"))
                flushText();
            }
          },
        };
        if (job.controller.signal.aborted)
          throw new Error("Execution stopped before launch.");
        // Persist immediately before dispatch, after asynchronous preparation.
        // Stop during configuration loading must not record a launch that
        // never reached the provider. Crash uncertainty after here is charged.
        this.store.update(id, { dispatched: true });
        job.launching = record.session
          ? this.provider.resume(request)
          : this.provider.launch(request);
        const handle = await job.launching;
        const result = await handle.done.finally(flushText);
        if (job.stopping) return;
        const termination = await this.provider.terminate({
          contribution: job.contribution,
        });
        if (!termination?.stopped)
          throw new Error("VM termination has not been confirmed.");
        if (job.stopping) return;
        const receipt = await ledger.receipt({
          reservation: reservation.event,
          used: 1,
          stopped: true,
          summary: "Isolated runtime turn finished; VM termination confirmed.",
        });
        this.store.update(id, {
          receipt: receipt.event,
          wake: {
            fingerprint: baseline,
            ...wakeFingerprint.snapshot(),
            cursor: delivery.cursor,
            priorityCursor: delivery.priorityCursor,
          },
          status: "waiting",
          reason:
            waiting?.reason ??
            "Turn complete. Waiting for new mission messages or direction.",
        });
        this.log(
          id,
          "turn_completed",
          JSON.stringify({
            ...this.provider.usage(result),
            elapsedMs: Math.round(performance.now() - turnBegan),
            grant: record.grant,
            reservation: reservation.event,
          }),
        );
        if (grant.purpose === "planning") break;
        while (!job.controller.signal.aborted) {
          await delay(this.pollMs, undefined, {
            signal: job.controller.signal,
          });
          const { grant: current } = await this.check(id, job);
          if (current.charged + current.reserved >= current.turns)
            return await this.finish(
              id,
              job,
              "Permission turn allowance completed.",
            );
          if (
            wakeFingerprint.peek(
              await this.wakeState(
                channel,
                waiting,
                delivery.cursor,
                delivery.priorityCursor,
              ),
            ) !== baseline
          )
            break;
        }
      }
      await this.finish(
        id,
        job,
        "Permission completed. Request a new permission to continue.",
      );
    } finally {
      clearInterval(monitor);
      channel.close();
      ledger.close();
    }
  }
  async finish(id, job, reason) {
    if (job.stopping) return job.stopping;
    if (reason?.code === "direction_changed") {
      this.store.update(id, {
        interruption: {
          code: reason.code,
          previous: reason.previous,
          current: reason.current,
        },
      });
    }
    const message = reason instanceof Error ? reason.message : reason;
    job.controller.abort();
    job.stopping = (async () => {
      // A delayed VM boot may finish after Stop was clicked. Fence the launch
      // promise before terminating, so no process can appear after the receipt.
      await job.launching?.catch(() => {});
      await this.settle(id, message);
    })().finally(() => this.jobs.delete(id));
    return job.stopping;
  }
  async settle(id, reason) {
    const contribution = this.contribution(id);
    let record = this.store.read(id);
    if (!record) return;
    this.operationJournal.interrupted(id);
    // Repeated Stop/desktop close must not erase the reason for a settled
    // interruption. A new generation clears it only after current authorization.
    if (record.status === "stopped") reason = record.reason;
    this.store.update(id, {
      status: "stopping",
      reason: reason.slice(0, 2048),
    });
    try {
      await this.provider.interrupt({ contribution }).catch(() => {});
      const result = await this.provider.terminate({ contribution });
      if (!result.stopped)
        throw new Error("Termination has not been confirmed.");
      const ledger = this.node.openResourceLedger(id);
      try {
        if (record.grant) {
          // A crash may have lost the reservation response. Recover by the
          // durable nonce before deciding whether accounting is settled.
          const state = await ledger.state();
          const reservation = state.reservations.find(
            (r) => r.grant === record.grant && r.nonce === record.nonce,
          );
          if (reservation && !reservation.receipt) {
            const receipt = await ledger.receipt({
              reservation: reservation.id,
              used: record.dispatched ? 1 : 0,
              stopped: true,
              summary: "VM termination confirmed. " + reason.slice(0, 1800),
            });
            record = this.store.update(id, {
              reservation: reservation.id,
              receipt: receipt.event,
            });
          }
          await ledger.seal(record.grant);
        }
      } finally {
        ledger.close();
      }
      const setupOnly = !record.grant && !record.session;
      this.store.update(id, {
        status: setupOnly
          ? ["ready", "login_required", "failed"].includes(record.status)
            ? record.status
            : "failed"
          : "stopped",
        reason: setupOnly
          ? ["ready", "login_required", "failed"].includes(record.status)
            ? record.reason
            : "Environment stopped. Prepare it again to verify setup; saved files are retained."
          : reason.slice(0, 2048),
      });
      this.log(
        id,
        "stopped",
        "VM termination and accounting confirmed. " + reason,
      );
    } catch (error) {
      this.store.update(id, {
        status: "recovery_required",
        reason: `Recovery required: ${error.message}`.slice(0, 2048),
      });
      this.log(id, "recovery_required", error.message);
    }
  }
  async stop(id, reason = "Stopped by this device's human.") {
    this.contribution(id);
    if (this.busy.has(id) && !this.jobs.has(id))
      throw new Error("Wait for environment preparation to finish.");
    const job = this.jobs.get(id);
    if (job) {
      await this.finish(id, job, reason);
      await job.finished;
    } else {
      if (this.busy.has(id))
        throw new Error("Recovery is already in progress.");
      this.busy.add(id);
      try {
        await this.settle(id, reason);
      } finally {
        this.busy.delete(id);
      }
    }
  }
  async transfer(id, direction) {
    return this.exclusive(id, async () => {
      const contribution =
        direction === "export"
          ? this.contribution(id)
          : (await this.node.executionContext(id)).contribution;
      const info = statSync(contribution.workspace, { bigint: true });
      if (
        !info.isDirectory() ||
        realpathSync(contribution.workspace) !== contribution.workspace ||
        info.ino.toString() !== contribution.workspaceIdentity.inode ||
        info.dev.toString() !== contribution.workspaceIdentity.device
      )
        throw new Error("The prepared export folder was moved or replaced.");
      if (!this.store.read(id) || inflight.has(this.store.read(id).status))
        throw new Error("Stop and settle execution before transferring files.");
      if (direction === "export") {
        const result = await this.provider.exportFiles({ contribution });
        return this.exportWorkspace(contribution, result.files);
      }
      const files = await this.importWorkspace(contribution);
      if (!files) return { cancelled: true };
      return this.provider.importFiles({ contribution, files });
    });
  }
  async restoreCheckpoint(id, checkpoint) {
    return this.exclusive(id, async () => {
      const contribution = this.contribution(id);
      const record = this.store.read(id);
      if (
        !record ||
        inflight.has(record.status) ||
        record.status === "recovery_required"
      )
        throw new Error(
          "Prepare an environment and confirm it is stopped before restoring source.",
        );
      const files = this.checkpoints.restoreFiles(id, checkpoint);
      const destination = `recovered-${Date.now()}`;
      const result = await this.provider.importFiles({
        contribution,
        files,
        destination,
      });
      if (result.error) throw new Error(result.error);
      this.store.update(id, {
        recoveredSource: { directory: destination, checkpoint, at: Date.now() },
      });
      this.log(
        id,
        "source_restored",
        `Restored ${files.length} source files into ${destination}. Runtime transcript and credentials are not part of this checkpoint.`,
      );
      return { ...result, destination };
    });
  }
  async close() {
    this.closed = true;
    for (const controller of this.preparations.values()) controller.abort();
    await Promise.allSettled(
      [...this.authentications.keys()].map((id) => this.cancelLogin(id)),
    );
    await Promise.allSettled([...this.operations.values()]);
    await Promise.allSettled(
      this.node.contributors.store
        .read()
        .contributions.filter((c) => this.store.read(c.id))
        .map((c) => this.stop(c.id, "Desktop is closing.")),
    );
  }

  async recover() {
    for (const contribution of this.node.contributors.store.read()
      .contributions) {
      const record = this.store.read(contribution.id);
      if (
        record &&
        inflight.has(record.status) &&
        !this.jobs.has(contribution.id)
      )
        await this.stop(
          contribution.id,
          "Recovered after an interrupted desktop session.",
        );
    }
  }
}
