import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  NodeService,
  NodeRequests,
  AgentOperation,
} from "../../desktop/node-service.mjs";
import { ContributorService } from "../../desktop/service.mjs";
import { DesktopStore } from "../../desktop/store.mjs";
import { secureStorage } from "../helpers/secure-storage.mjs";

test(
  "scoped host channels bind a real preparation and never expose agent signing in the renderer",
  { timeout: 30000 },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hb-communication-")));
    const folder = join(root, "work");
    mkdirSync(folder);
    const storage = secureStorage();
    const contributors = new ContributorService({
      store: new DesktopStore(join(root, "contributor")),
      chooseDirectory: async () => folder,
      revealDirectory: async () => {},
    });
    const n = new NodeService({
      directory: join(root, "node"),
      binary: resolve("var/node/target/debug/harakiri-node"),
      secureStorage: storage,
    });
    n.contributors = contributors;
    t.after(async () => {
      await n.close();
      rmSync(root, { recursive: true, force: true });
    });
    await n.handle("enroll", {});
    const definition = {
      name: "Scoped communication",
      objective: "Prepare an accessible festival",
      scope: "Discussion only",
      criteria: [],
      policy: {
        coordination: "coordinated",
        participation: "private",
        budget: { mode: "unlimited" },
      },
    };
    const { mission } = await n.handle("createMission", { definition });
    const current = async () =>
      (await n.state()).missions.find((m) => m.id === mission);
    const prepare = async (role, label) => {
      const review = await n.handle("reviewContribution", { mission, role });
      const choice = await contributors.handle("chooseWorkspace", {});
      const result = await n.handle("prepareContribution", {
        reviewId: review.reviewId,
        workspaceChoiceId: choice.id,
        runtime: "grok",
        limits: { mode: "unlimited", concurrency: 1 },
      });
      const c = result.contributions[0];
      assert.throws(() => n.openAgentChannel(c.id), /shared preparation/);
      const shared = await n.handle("shareAgent", {
        mission,
        contributionId: c.id,
        label,
      });
      return { ...c, shared };
    };
    const co = await prepare("coordinator", "Festival coordinator");
    const agent = await prepare("agent", "Accessibility");
    const channel = n.openAgentChannel(co.id);
    const worker = n.openAgentChannel(agent.id);
    assert.equal(NodeRequests.agentRequest, undefined);
    assert.equal(NodeRequests.openAgentChannel, undefined);
    assert.doesNotMatch(
      readFileSync("desktop/preload.cjs", "utf8"),
      /agent_request|openAgentChannel|AgentOperation/,
    );
    for (const input of [
      { type: "context", mission },
      { type: "context", author: co.shared.author },
      { type: "start_mission", revision: mission },
      { type: "post", text: "x", audience: "main", workspace: folder },
      {
        type: "acknowledge",
        control: mission,
        direction: mission,
        role: "human",
      },
    ])
      assert.equal(AgentOperation.safeParse(input).success, false);
    await assert.rejects(n.handle("agentRequest", { mission }));
    await assert.rejects(
      channel.request({
        type: "plan",
        control: mission,
        text: "Not appointed",
      }),
    );
    await n.handle("appointCoordinator", {
      mission,
      revision: (await current()).lifecycle.revision,
      contributionId: co.id,
    });
    const control = (await current()).lifecycle.revision;
    const plan = await channel.request({
      type: "plan",
      control,
      text: "Discuss access in Main. No extra workstreams needed.",
    });
    await channel.request({ type: "ready", control, plan: plan.event });
    const state = await current();
    assert.equal(state.lifecycle.start_blockers.length, 0);
    await n.handle("startMission", {
      mission,
      revision: state.lifecycle.revision,
      readiness: state.lifecycle.readiness.id,
    });
    const context = await worker.request({ type: "context" });
    assert.equal(context.execution, "unavailable");
    assert.equal(context.agent.identity.author, agent.shared.author);
    assert.ok(!JSON.stringify(context).includes(root));
    const stream = await channel.request({
      type: "work",
      control: context.lifecycle.revision,
      action: {
        type: "create_workstream",
        name: "Accessibility",
        goal: "Compare step-free routes",
      },
    });
    await assert.rejects(
      worker.request({
        type: "work",
        control: context.lifecycle.revision,
        action: {
          type: "create_workstream",
          name: "Unapproved",
          goal: "Organize without the Coordinator",
        },
      }),
    );
    const assignment = await channel.request({
      type: "work",
      control: context.lifecycle.revision,
      action: {
        type: "assign_workstream",
        workstream: stream.event,
        goal_revision: stream.event,
        registration: agent.shared.registration,
        direction: "Measure the north entrance",
      },
    });
    assert.equal(
      (await worker.request({ type: "context" })).agent.direction.id,
      assignment.event,
    );
    const task = await worker.request({
      type: "work",
      control: context.lifecycle.revision,
      action: {
        type: "create_task",
        definition: {
          title: "Measure access",
          description: "Check the entrance slope",
          criteria: ["Include measurements"],
          workstream: null,
        },
        assignees: [],
      },
    });
    const tasks = await worker.request({ type: "tasks", query: {} });
    assert.equal(tasks.items[0].id, task.event);
    assert.equal(tasks.items[0].definition.workstream, stream.event);
    assert.equal(
      tasks.items[0].attempts[0].registration,
      agent.shared.registration,
    );
    await assert.rejects(
      worker.request({
        type: "work",
        control: context.lifecycle.revision,
        action: {
          type: "assign_task",
          task: task.event,
          registration: co.shared.registration,
          approach: "Allocate someone else",
        },
      }),
    );
    await worker.request({
      type: "post",
      audience: `workstream:${stream.event}`,
      text: "North route needs a ramp",
    });
    assert.equal(
      (
        await n.handle("messages", {
          mission,
          audience: `workstream:${stream.event}`,
        })
      ).items[0].text,
      "North route needs a ramp",
    );
    // Return to Main direction before the existing acknowledgment/privacy checks.
    await n.handle("directAgent", {
      mission,
      revision: context.lifecycle.revision,
      registration: agent.shared.registration,
      text: "Follow the main direction",
    });
    context.agent = (await worker.request({ type: "context" })).agent;
    const receipt = await worker.request({
      type: "acknowledge",
      control: context.lifecycle.revision,
      direction: context.agent.direction.id,
    });
    assert.equal(
      (await worker.request({ type: "context" })).agent.acknowledgment,
      receipt.event,
    );
    const { audience } = await n.handle("openAgentConversation", {
      mission,
      registration: agent.shared.registration,
    });
    const message = await n.handle("postMessage", {
      mission,
      audience,
      text: "Private mobility requirement",
    });
    await assert.rejects(
      channel.request({
        type: "messages",
        query: { view: "conversation", audience },
      }),
    );
    const privateMessages = await worker.request({
      type: "messages",
      query: { view: "conversation", audience },
    });
    assert.equal(privateMessages.items[0].id, message.event);
    // Match the generated Rust/TypeScript Option fields, including explicit
    // nulls from the thread UI instead of only omitted JavaScript properties.
    const threadQuery = {
      view: "conversation",
      audience,
      thread: message.event,
      before: null,
      anchor: null,
      search: null,
    };
    assert.equal(
      (await worker.request({ type: "messages", query: threadQuery })).items[0]
        .id,
      message.event,
    );
    assert.equal(
      (await n.handle("queryMessages", { mission, query: threadQuery }))
        .items[0].id,
      message.event,
    );

    const reply = await worker.request({
      type: "post",
      audience,
      text: "I will account for it privately.",
      thread: message.event,
    });
    const inbox = await n.handle("queryMessages", {
      mission,
      query: { view: "inbox" },
    });
    assert.equal(inbox.items[0].id, reply.event);
    assert.equal(inbox.items[0].author, agent.shared.author);
    const dm = (await n.handle("audiences", { mission }))[0];
    assert.equal(dm.unread, 1);
    await n.handle("markMessagesRead", { mission, ids: [reply.event] });
    assert.equal((await n.handle("audiences", { mission }))[0].unread, 0);
    worker.close();
    await assert.rejects(worker.request({ type: "context" }), /closed/);
    const again = n.openAgentChannel(agent.id);
    // Local revoke is effective even if the signed withdrawal cannot yet be sent.
    const request = n.bridge.request.bind(n.bridge);
    n.bridge.request = (input) =>
      input.type === "withdraw_agent"
        ? Promise.reject(new Error("offline"))
        : request(input);
    await assert.rejects(
      n.handle("withdrawAgent", { mission, contributionId: agent.id }),
    );
    await assert.rejects(again.request({ type: "context" }));
    n.bridge.request = request;
    await n.state();
    await n.handle("pauseMission", {
      mission,
      revision: (await current()).lifecycle.revision,
      reason: "Review",
    });
    const paused = (await current()).lifecycle.revision;
    const resumedPlan = await channel.request({
      type: "plan",
      control: paused,
      text: "Wait for human review, then continue.",
    });
    await channel.request({
      type: "ready",
      control: paused,
      plan: resumedPlan.event,
    });
    const ready = await current();
    assert.equal(ready.lifecycle.start_blockers.length, 0);
    await n.handle("withdrawAgent", { mission, contributionId: co.id });
    const withdrawn = await current();
    assert.equal(withdrawn.lifecycle.readiness, null);
    assert.ok(
      withdrawn.lifecycle.start_blockers.includes("coordinator_unavailable"),
    );
    await assert.rejects(
      n.handle("startMission", {
        mission,
        revision: withdrawn.lifecycle.revision,
        readiness: ready.lifecycle.readiness.id,
      }),
    );
    const changed = { ...definition, scope: "A newly approved scope" };
    await n.handle("updateInstructions", {
      mission,
      revision: (await current()).lifecycle.revision,
      definition: changed,
    });
    await assert.rejects(channel.request({ type: "context" }));
    assert.equal((await n.state()).execution, "unavailable");
  },
);
