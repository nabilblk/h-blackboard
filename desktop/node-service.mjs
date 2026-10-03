import { createHash } from "node:crypto";
import {
  GovernanceRequests,
  GovernanceAgentOperations,
} from "./governance-contract.mjs";
import { mkdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { NodeBridge } from "./node-bridge.mjs";
import {
  ArtifactRequests,
  ArtifactAgentOperations,
} from "./artifact-contract.mjs";
import { NodeIdentity } from "./node-identity.mjs";
import { Limits, Runtime, Id } from "./model.mjs";

const id = z.string().regex(/^[a-f0-9]{64}$/);
const text = (max, min = 1) =>
  z
    .string()
    .trim()
    .min(min)
    .refine(
      (s) => Buffer.byteLength(s) <= max && !s.includes("\0"),
      "Text is too long or contains invalid characters",
    );
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const budget = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("unlimited") }).strict(),
  z
    .object({
      mode: z.literal("limited"),
      turns: integer.max(0xffffffff).nullable(),
      concurrency: integer.max(1024).nullable(),
      deadline_ms: integer.nullable(),
      tokens: integer.nullable(),
      model_cost_microusd: integer.nullable(),
    })
    .strict(),
]);
const audience = z
  .string()
  .regex(/^(main|(?:private|workstream):[a-f0-9]{64})$/)
  .default("main");
const ticket = z
  .string()
  .max(16384)
  .regex(/^harakiri:\/\/(join|discover)\/[a-f0-9]+$/);
const discovery = z
  .object({
    enabled: z.boolean(),
    lan: z.boolean(),
    bootstrap: z
      .array(
        z
          .string()
          .max(4096)
          .regex(/^harakiri:\/\/peer\/[a-f0-9]+$/),
      )
      .max(8),
    blocked: z.array(id).max(64),
  })
  .strict();
const network = z
  .object({
    mode: z.enum(["offline", "direct", "public_relays", "custom"]),
    relays: z.array(z.string().max(512)).max(4),
    allow_lan: z.boolean(),
  })
  .strict();
const missionDefinition = z
  .object({
    name: text(120),
    objective: text(4096),
    scope: text(8192, 0),
    criteria: z.array(text(1024)).max(32),
    policy: z
      .object({
        coordination: z.enum(["coordinated", "peer"]),
        participation: z.enum(["private", "approval"]),
        budget,
      })
      .strict(),
  })
  .strict();
const messageQuery = z
  .object({
    view: z.enum(["conversation", "inbox", "sent"]),
    audience: audience.nullable().optional(),
    thread: id.nullable().optional(),
    before: id.nullable().optional(),
    anchor: id.nullable().optional(),
    search: text(512, 0).nullable().optional(),
  })
  .strict();
const taskDefinition = z
  .object({
    title: text(240),
    description: text(4096),
    criteria: z.array(text(1024)).max(16),
    workstream: id.nullable(),
  })
  .strict();
const parentIds = z
  .array(id)
  .max(256)
  .refine((a) => new Set(a).size === a.length);
const ids = z
  .array(id)
  .max(32)
  .refine((a) => new Set(a).size === a.length, "Duplicate references");
const attemptStatus = z.enum([
  "planned",
  "in_progress",
  "blocked",
  "paused",
  "submitted",
  "complete",
  "cancelled",
]);
const workAction = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("create_workstream"),
      name: text(80),
      goal: text(4096),
    })
    .strict(),
  z
    .object({
      type: z.literal("revise_workstream"),
      workstream: id,
      bases: parentIds,
      name: text(80),
      goal: text(4096),
    })
    .strict(),
  z
    .object({
      type: z.literal("assign_workstream"),
      registration: id,
      workstream: id.nullable(),
      goal_revision: id.nullable(),
      direction: text(2048),
    })
    .strict(),
  z
    .object({
      type: z.literal("create_task"),
      definition: taskDefinition,
      assignees: ids,
    })
    .strict(),
  z
    .object({
      type: z.literal("revise_task"),
      task: id,
      bases: parentIds,
      definition: taskDefinition,
    })
    .strict(),
  z
    .object({
      type: z.literal("assign_task"),
      task: id,
      registration: id,
      approach: text(2048),
    })
    .strict(),
  z
    .object({
      type: z.literal("report_attempt"),
      task: id,
      task_revision: id,
      allocation: id,
      registration: id,
      bases: parentIds,
      status: attemptStatus,
      summary: text(4096),
      evidence: z.array(id).max(16),
    })
    .strict(),
]);
const taskQuery = z
  .object({
    after: id.nullable().optional(),
    task: id.nullable().optional(),
    workstream: z
      .union([id, z.literal("main")])
      .nullable()
      .optional(),
    status: z
      .union([attemptStatus, z.literal("conflict")])
      .nullable()
      .optional(),
    search: text(512, 0).nullable().optional(),
    owner: text(120, 0).nullable().optional(),
  })
  .strict();
// This contract deliberately has no identity, mission, path or execution field.
export const AgentOperation = z.discriminatedUnion("type", [
  ...ArtifactAgentOperations,
  ...GovernanceAgentOperations,
  z.object({ type: z.literal("context") }).strict(),
  z.object({ type: z.literal("workstreams") }).strict(),
  z.object({ type: z.literal("tasks"), query: taskQuery }).strict(),
  z
    .object({ type: z.literal("work"), control: id, action: workAction })
    .strict(),
  z.object({ type: z.literal("messages"), query: messageQuery }).strict(),
  z
    .object({
      type: z.literal("post"),
      audience,
      text: text(16384),
      to: id.nullable().default(null),
      thread: id.nullable().default(null),
    })
    .strict(),
  z
    .object({ type: z.literal("acknowledge"), control: id, direction: id })
    .strict(),
  z
    .object({ type: z.literal("plan"), control: id, text: text(16384) })
    .strict(),
  z.object({ type: z.literal("ready"), control: id, plan: id }).strict(),
  z
    .object({
      type: z.literal("direct"),
      control: id,
      registration: id,
      text: text(2048),
    })
    .strict(),
]);
const control = { mission: id, revision: id };
export const NodeRequests = {
  ...ArtifactRequests,
  ...GovernanceRequests,
  workEvidence: z.object({ mission: id, event: id }).strict(),
  workstreams: z.object({ mission: id }).strict(),
  tasks: z.object({ mission: id, query: taskQuery }).strict(),
  work: z.object({ mission: id, revision: id, action: workAction }).strict(),
  state: z.object({}).strict(),
  enroll: z.object({}).strict(),
  createMission: z.object({ definition: missionDefinition }).strict(),
  updateInstructions: z
    .object({ ...control, definition: missionDefinition })
    .strict(),
  setCoordination: z
    .object({ ...control, mode: z.enum(["coordinated", "peer"]) })
    .strict(),
  setPlan: z.object({ ...control, text: text(16384) }).strict(),
  startMission: z.object({ ...control, readiness: id.nullable() }).strict(),
  pauseMission: z.object({ ...control, reason: text(1024) }).strict(),
  appointCoordinator: z.object({ ...control, contributionId: Id }).strict(),
  agents: z
    .object({ mission: id, after: id.nullable().default(null) })
    .strict(),
  shareAgent: z
    .object({ mission: id, contributionId: Id, label: text(120) })
    .strict(),
  withdrawAgent: z.object({ mission: id, contributionId: Id }).strict(),
  directAgent: z
    .object({ ...control, registration: id, text: text(2048) })
    .strict(),
  networkState: z.object({}).strict(),
  configureNetwork: z.object({ config: network }).strict(),
  discoveryState: z.object({}).strict(),
  configureDiscovery: z.object({ config: discovery }).strict(),
  publishListing: z
    .object({
      mission: id,
      summary: text(2000),
      capabilities: z.array(text(80)).max(8),
      active: z.boolean(),
    })
    .strict(),
  copyPeerTicket: z.object({}).strict(),
  withdrawMission: z.object({ mission: id }).strict(),
  reviewContribution: z
    .object({ mission: id, role: z.enum(["agent", "coordinator"]) })
    .strict(),
  prepareContribution: z
    .object({
      reviewId: Id,
      workspaceChoiceId: Id,
      runtime: Runtime,
      limits: Limits,
    })
    .strict(),
  issueInvitation: z.object({ mission: id }).strict(),
  copyInvitation: z.object({ mission: id }).strict(),
  inspectInvitation: z.object({ ticket }).strict(),
  requestJoin: z
    .object({ ticket, reviewed_mission: id, reviewed_revision: id })
    .strict(),
  localJoins: z.object({}).strict(),
  peers: z.object({ mission: id }).strict(),
  decideJoin: z
    .object({ mission: id, author: id, admit: z.boolean() })
    .strict(),
  revokeInvitations: z.object({ mission: id }).strict(),
  revokeMember: z.object({ mission: id, author: id }).strict(),
  createAudience: z
    .object({ mission: id, readers: z.array(id).min(1).max(15) })
    .strict(),
  audiences: z.object({ mission: id }).strict(),
  openAgentConversation: z.object({ mission: id, registration: id }).strict(),
  queryMessages: z.object({ mission: id, query: messageQuery }).strict(),
  markMessagesRead: z
    .object({ mission: id, ids: z.array(id).max(200) })
    .strict(),
  postMessage: z
    .object({
      mission: id,
      audience,
      text: text(16384),
      to: id.nullable().default(null),
      thread: id.nullable().default(null),
    })
    .strict(),
  messages: z
    .object({ mission: id, audience, before: id.nullable().default(null) })
    .strict(),
};

export class NodeService {
  constructor({ directory, binary, secureStorage, writeClipboard }) {
    this.directory = directory;
    this.writeClipboard = writeClipboard;
    this.issuedInvitations = new Map();
    this.binary = binary;
    this.keys = new NodeIdentity(directory, secureStorage);
    this.bridge = null;
    this.starting = null;
    this.contributors = null;
    this.contributionReviews = new Map();
  }

  async start(keys) {
    if (this.closed) throw new Error("The local node is closing.");
    if (this.bridge) return this.bridge;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const profile = join(this.directory, "records");
      mkdirSync(profile, { recursive: true, mode: 0o700 });
      const stat = lstatSync(profile);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
        throw new Error("The local node records directory is not private.");
      const bridge = new NodeBridge(this.binary, { ...keys, profile });
      try {
        this.identity = await bridge.ready;
      } catch (error) {
        await bridge.close();
        throw error;
      }
      this.bridge = bridge;
      return bridge;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async state() {
    if (!this.keys.enrolled())
      return {
        status: "not_enrolled",
        identity: null,
        missions: [],
        network: "disabled",
        connection: null,
        joins: [],
        withdrawals: [],
        execution: "unavailable",
      };
    const bridge = await this.start(await this.keys.load());
    const missions = [];
    let before = null;
    do {
      const page = await bridge.request({ type: "missions", before });
      missions.push(...page.items);
      before = page.before;
    } while (before);
    const [connection, joins, withdrawals] = await Promise.all([
      bridge.request({ type: "network_state" }),
      bridge.request({ type: "local_joins" }),
      bridge.request({ type: "withdrawals" }),
    ]);
    for (const item of withdrawals)
      this.contributors?.withdrawNode(item.mission);
    this.contributors?.observeNodeTerms(missions);
    // Local revocation is durable first. Publishing its withdrawal may fail
    // during shutdown or profile recovery; the visible pending intent retries.
    for (const c of this.contributors?.snapshot().contributions ?? []) {
      if (c.status !== "revoked" || !c.sharedAgent || c.sharedAgent.withdrawn)
        continue;
      try {
        if (!withdrawals.some((w) => w.mission === c.mission.missionId))
          await bridge.request({
            type: "withdraw_agent",
            mission: c.mission.missionId,
            registration: c.sharedAgent.registration,
          });
        this.contributors.markAgentShared(c.id, {
          ...c.sharedAgent,
          withdrawn: true,
        });
      } catch {
        // snapshot() exposes agent_withdrawal_pending; no consent is restored.
      }
    }
    return {
      status: "ready",
      identity: this.identity,
      missions,
      network: connection.running ? "enabled" : "disabled",
      connection,
      joins,
      withdrawals,
      execution: "unavailable",
    };
  }

  async handle(method, input) {
    const schema = NodeRequests[method];
    if (!schema) throw new Error("Unknown node operation.");
    const request = schema.parse(input);
    if (method === "state") return this.state();
    if (method === "enroll") {
      await this.start(await this.keys.enroll());
      return this.state();
    }
    if (!this.keys.enrolled())
      throw new Error("Create your local node before creating a mission.");
    const bridge = await this.start(await this.keys.load());
    if (method === "copyPeerTicket") {
      const value = await bridge.request({ type: "discovery_state" });
      if (!value.peer_ticket || !this.writeClipboard)
        throw new Error(
          "Enable discovery before copying a community peer address.",
        );
      this.writeClipboard(value.peer_ticket);
      return null;
    }
    if (method === "reviewContribution") {
      if (!this.contributors)
        throw new Error("Contribution preparation is unavailable.");
      const checked = await bridge.request({
        type: "review_contribution",
        mission: request.mission,
      });
      if (
        request.role === "coordinator" &&
        (checked.owner !== this.identity.owner ||
          checked.definition.policy?.coordination !== "coordinated")
      )
        throw new Error(
          "Only the creator of a coordinated mission can prepare its initial coordinator.",
        );
      const review = this.contributors.reviewNode(checked, request.role);
      if (this.contributionReviews.size >= 10)
        this.contributionReviews.delete(
          this.contributionReviews.keys().next().value,
        );
      this.contributionReviews.set(review.reviewId, checked);
      return review;
    }
    if (method === "prepareContribution") {
      const review = this.contributionReviews.get(request.reviewId);
      if (!review || !this.contributors)
        throw new Error(
          "Review this mission again before preparing a contribution.",
        );
      const checked = await bridge.request({
        type: "review_contribution",
        mission: review.mission,
      });
      if (checked.reviewed_revision !== review.reviewed_revision)
        throw new Error("The mission changed. Review the new terms.");
      await this.contributors.handle("prepare", request, {
        nodeRevision: checked.reviewed_revision,
      });
      this.contributionReviews.delete(request.reviewId);
      return this.contributors.snapshot();
    }
    if (method === "appointCoordinator") {
      if (!this.contributors)
        throw new Error("Contribution preparation is unavailable.");
      const checked = await bridge.request({
        type: "review_contribution",
        mission: request.mission,
      });
      if (
        checked.owner !== this.identity.owner ||
        checked.definition.policy?.coordination !== "coordinated"
      )
        throw new Error(
          "Only the mission creator can appoint its prepared Coordinator.",
        );
      const c = this.contributors.preparedCoordinator(
        request.contributionId,
        checked,
      );
      const label =
        c.sharedAgent?.label ??
        `${{ claude: "Claude Code", codex: "Codex", grok: "Grok Build" }[c.runtime]} · ${c.id.slice(0, 8)}`;
      if (!c.sharedAgent)
        await this.handle("shareAgent", {
          mission: request.mission,
          contributionId: c.id,
          label,
        });
      return bridge.request({
        type: "appoint_coordinator",
        mission: request.mission,
        revision: request.revision,
        contribution: c.id,
        label,
        runtime: c.runtime,
      });
    }
    if (method === "shareAgent") {
      if (!this.contributors)
        throw new Error("Contribution preparation is unavailable.");
      const checked = await bridge.request({
        type: "review_contribution",
        mission: request.mission,
      });
      const c = this.contributors.preparedContribution(
        request.contributionId,
        checked,
      );
      const result = await bridge.request({
        type: "share_agent",
        mission: request.mission,
        terms: checked.reviewed_revision,
        contribution: c.id,
        label: request.label,
        runtime: c.runtime,
        role: c.mission.role,
        contributor_name: this.contributors.snapshot().contributor.name,
      });
      this.contributors.markAgentShared(c.id, {
        ...result,
        label: request.label,
        withdrawn: false,
      });
      return result;
    }
    if (method === "withdrawAgent") {
      const c = this.contributors
        ?.snapshot()
        .contributions.find(
          (c) =>
            c.id === request.contributionId &&
            c.mission.missionId === request.mission,
        );
      if (!c?.sharedAgent)
        throw new Error("A shared contribution on this device is required.");
      await this.contributors.handle("revoke", { contributionId: c.id });
      await bridge.request({
        type: "withdraw_agent",
        mission: request.mission,
        registration: c.sharedAgent.registration,
      });
      this.contributors.markAgentShared(c.id, {
        ...c.sharedAgent,
        withdrawn: true,
      });
      return null;
    }
    if (method === "withdrawMission") {
      await bridge.request({ type: "withdraw_mission", ...request });
      this.contributors?.withdrawNode(request.mission);
      return null;
    }
    if (method === "issueInvitation") {
      const issued = await bridge.request({
        type: "issue_invitation",
        ...request,
      });
      if (this.issuedInvitations.size >= 256)
        this.issuedInvitations.delete(
          this.issuedInvitations.keys().next().value,
        );
      this.issuedInvitations.set(request.mission, {
        ticket: issued.ticket,
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });
      return issued;
    }
    if (method === "copyInvitation") {
      const issued = this.issuedInvitations.get(request.mission);
      if (!issued || issued.expires <= Date.now() || !this.writeClipboard)
        throw new Error("Create a fresh invitation before copying it.");
      this.writeClipboard(issued.ticket);
      return null;
    }
    if (method === "revokeInvitations") {
      const result = await bridge.request({
        type: "revoke_invitations",
        ...request,
      });
      this.issuedInvitations.delete(request.mission);
      return result;
    }
    if (method === "copyArtifactReference") {
      await bridge.request({ type: "artifact_detail", ...request });
      if (!this.writeClipboard) throw new Error("Clipboard unavailable.");
      this.writeClipboard(request.revision);
      return null;
    }
    if (method === "artifactOpen" || method === "artifactSave") {
      const detail = await bridge.request({
        type: "artifact_detail",
        mission: request.mission,
        revision: request.revision,
      });
      if (!detail.document.files.some((f) => f.path === request.path))
        throw new Error("File not in this revision.");
      const callback =
        method === "artifactOpen" ? this.openArtifact : this.saveArtifact;
      if (!callback) throw new Error("The artifact viewer is unavailable.");
      return callback(request, detail);
    }
    if (method === "consentGrant") {
      const checked = await bridge.request({
        type: "review_contribution",
        mission: request.mission,
      });
      const contribution = this.contributors?.preparedContribution(
        request.contributionId,
        checked,
      );
      if (!contribution?.sharedAgent || contribution.sharedAgent.withdrawn)
        throw new Error("Review and share this local contribution first.");
      const ledger = await bridge.request({
        type: "governance",
        mission: request.mission,
      });
      const grant = ledger.grants.find((g) => g.id === request.grant);
      if (
        !grant ||
        grant.registration !== contribution.sharedAgent.registration ||
        grant.expires_ms <= Date.now()
      )
        throw new Error(
          "This permission does not match your current contribution.",
        );
      const binding = createHash("sha256")
        .update(
          JSON.stringify({
            id: contribution.id,
            workspace: contribution.workspaceIdentity,
            runtime: contribution.runtime,
            limits: contribution.limits,
            terms: contribution.nodeBinding,
          }),
        )
        .digest("hex");
      return bridge.request({
        type: "govern",
        mission: request.mission,
        control: grant.control,
        action: { type: "consent", grant: grant.id, binding },
      });
    }
    const commands = {
      governance: "governance",
      govern: "govern",
      missionAction: "mission_action",
      privateRecovery: "private_recovery",
      reconcilePrivate: "reconcile_private",
      artifacts: "artifacts",
      artifactDetail: "artifact_detail",
      artifactAction: "artifact_action",
      artifactTransfer: "artifact_transfer",
      createMission: "create_mission",
      updateInstructions: "update_instructions",
      setCoordination: "set_coordination",
      setPlan: "set_plan",
      startMission: "start_mission",
      pauseMission: "pause_mission",
      agents: "agents",
      workEvidence: "work_evidence",
      workstreams: "workstreams",
      tasks: "tasks",
      work: "work",
      directAgent: "direct_agent",
      postMessage: "post_message",
      openAgentConversation: "open_agent_conversation",
      queryMessages: "query_messages",
      markMessagesRead: "mark_messages_read",
      messages: "messages",
      networkState: "network_state",
      configureNetwork: "configure_network",
      discoveryState: "discovery_state",
      configureDiscovery: "configure_discovery",
      publishListing: "publish_listing",
      inspectInvitation: "inspect_invitation",
      requestJoin: "request_join",
      localJoins: "local_joins",
      peers: "peers",
      decideJoin: "decide_join",
      revokeMember: "revoke_member",
      createAudience: "create_audience",
      audiences: "audiences",
    };
    const type = commands[method];
    if (!type) throw new Error("Unknown node operation.");
    return bridge.request({ type, ...request });
  }

  /** Internal capability for a future authenticated guest adapter. It must
   * never be returned through the renderer IPC or exposed as an open server. */
  openAgentChannel(contributionId) {
    Id.parse(contributionId);
    const contribution = this.contributors
      ?.snapshot()
      .contributions.find((c) => c.id === contributionId);
    if (!contribution?.sharedAgent || contribution.sharedAgent.withdrawn)
      throw new Error("A shared preparation on this device is required.");
    const mission = contribution.mission.missionId;
    const registration = contribution.sharedAgent.registration;
    let closed = false;
    return Object.freeze({
      close: () => {
        closed = true;
      },
      request: async (input) => {
        const operation = AgentOperation.parse(input);
        if (closed || this.closed) throw new Error("Agent channel closed.");
        const bridge = await this.start(await this.keys.load());
        const checked = await bridge.request({
          type: "review_contribution",
          mission,
        });
        const current = this.contributors.preparedContribution(
          contributionId,
          checked,
        );
        if (
          closed ||
          this.closed ||
          current.sharedAgent?.registration !== registration ||
          current.sharedAgent.withdrawn
        )
          throw new Error("Agent channel unavailable.");
        return bridge.request({
          type: "agent_request",
          mission,
          contribution: contributionId,
          registration,
          operation,
        });
      },
    });
  }

  /** Host accounting capability for a future enforcing provider. This creates
   * no process or executable credential and is absent from the preload. */
  openResourceLedger(contributionId) {
    Id.parse(contributionId);
    let closed = false;
    return Object.freeze({
      executionAvailable: false,
      close: () => {
        closed = true;
      },
      reserve: async ({ grant, nonce }) => {
        id.parse(grant);
        id.parse(nonce);
        if (closed || this.closed) throw new Error("Resource ledger closed.");
        const bridge = await this.start(await this.keys.load());
        const local = this.contributors
          ?.snapshot()
          .contributions.find((c) => c.id === contributionId);
        if (!local?.sharedAgent || local.sharedAgent.withdrawn)
          throw new Error("Shared local preparation required.");
        const mission = local.mission.missionId;
        const checked = await bridge.request({
          type: "review_contribution",
          mission,
        });
        const current = this.contributors.preparedContribution(
          contributionId,
          checked,
        );
        const ledger = await bridge.request({ type: "governance", mission });
        const permission = ledger.grants.find((g) => g.id === grant);
        if (
          !permission ||
          permission.registration !== current.sharedAgent.registration ||
          !permission.consent
        )
          throw new Error("Local permission and consent required.");
        if (closed || this.closed) throw new Error("Resource ledger closed.");
        return bridge.request({
          type: "reserve_local",
          mission,
          control: permission.control,
          registration: current.sharedAgent.registration,
          grant,
          consent: permission.consent,
          nonce,
          limits: current.limits,
        });
      },
    });
  }

  async readArtifactFile(request) {
    ArtifactRequests.artifactOpen.parse(request);
    const chunks = [];
    let offset = 0;
    let size = null;
    do {
      const result = await this.handle("artifactTransfer", {
        mission: request.mission,
        transfer: {
          type: "read",
          revision: request.revision,
          path: request.path,
          offset,
        },
      });
      const bytes = Buffer.from(result.hex, "hex");
      if (size !== null && result.size !== size)
        throw new Error("Artifact size changed.");
      size = result.size;
      if (
        result.offset !== offset + bytes.length ||
        result.size > 16 * 1024 * 1024 ||
        (!result.complete && result.offset <= offset)
      )
        throw new Error("Invalid artifact transfer.");
      chunks.push(bytes);
      offset = result.offset;
      if (result.complete) {
        if (offset !== size) throw new Error("Incomplete artifact transfer.");
        break;
      }
    } while (offset < size);
    return Buffer.concat(chunks);
  }

  async close() {
    this.closed = true;
    if (this.starting) await this.starting.catch(() => {});
    await this.bridge?.close();
  }
}
