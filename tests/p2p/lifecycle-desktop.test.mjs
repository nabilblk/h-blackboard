import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NodeService, NodeRequests } from "../../desktop/node-service.mjs";
import { ContributorService } from "../../desktop/service.mjs";
import { DesktopStore } from "../../desktop/store.mjs";
import { secureStorage } from "../helpers/secure-storage.mjs";

const definition = {
  name: "Festival plan",
  objective: "Make a useful schedule",
  scope: "Research only",
  criteria: [],
  policy: {
    coordination: "coordinated",
    participation: "private",
    budget: { mode: "unlimited" },
  },
};

test(
  "native lifecycle preserves consent, separates Coordinator authority and never launches an agent",
  { timeout: 30000 },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hb-lifecycle-")));
    const parent = join(root, "work");
    mkdirSync(parent);
    const storage = secureStorage();
    const contributors = new ContributorService({
      store: new DesktopStore(join(root, "preparations")),
      chooseDirectory: async () => parent,
      revealDirectory: async () => {},
    });
    const make = () => {
      const n = new NodeService({
        directory: join(root, "node"),
        binary: resolve("var/node/target/debug/harakiri-node"),
        secureStorage: storage,
      });
      n.contributors = contributors;
      return n;
    };
    let n = make();
    t.after(async () => {
      await n.close();
      rmSync(root, { recursive: true, force: true });
    });
    await n.handle("enroll", {});
    const { mission } = await n.handle("createMission", { definition });
    const current = async () =>
      (await n.state()).missions.find((m) => m.id === mission);
    const command = async (method, extra = {}) =>
      n.handle(method, {
        mission,
        revision: (await current()).lifecycle.revision,
        ...extra,
      });
    const prepare = async (role) => {
      const review = await n.handle("reviewContribution", { mission, role });
      const choice = await contributors.handle("chooseWorkspace", {});
      const state = await n.handle("prepareContribution", {
        reviewId: review.reviewId,
        workspaceChoiceId: choice.id,
        runtime: "grok",
        limits: { mode: "unlimited", concurrency: 1 },
      });
      return state.contributions[0];
    };
    assert.equal((await current()).state, "preparing");
    await assert.rejects(command("startMission", { readiness: null }));
    const agent = await prepare("agent");
    await assert.rejects(
      command("appointCoordinator", { contributionId: agent.id }),
    );
    const c = await prepare("coordinator");
    await command("appointCoordinator", { contributionId: c.id });
    const appointed = await current();
    assert.notEqual(
      appointed.lifecycle.coordinator.identity.author,
      appointed.owner,
    );
    assert.equal(appointed.lifecycle.terms_revision, c.nodeBinding.revision);
    assert.equal(appointed.lifecycle.readiness, null);
    await command("setPlan", {
      text: "A human plan cannot impersonate agent readiness.",
    });
    await assert.rejects(command("startMission", { readiness: null }));
    await assert.rejects(n.handle("coordinatorReady", { mission }));
    assert.ok(!Object.hasOwn(NodeRequests, "coordinatorReady"));
    const channel = n.openAgentChannel(c.id);
    const planned = await current();
    const ready = await channel.request({
      type: "ready",
      control: planned.lifecycle.revision,
      plan: planned.lifecycle.plan.id,
    });
    await command("startMission", { readiness: ready.event });
    await command("pauseMission", {
      reason: "Review the plan before resuming",
    });
    const paused = await current();
    assert.equal(paused.lifecycle.readiness.id, ready.event);
    assert.deepEqual(paused.lifecycle.start_blockers, []);
    await command("startMission", { readiness: ready.event });
    await command("pauseMission", {
      reason: "Pause retains the accepted plan",
    });
    // The human explicitly re-adopts the saved plan. This is a new signed
    // control revision, not fabricated readiness, a mission Start or new terms.
    await command("setPlan", { text: paused.lifecycle.plan.text });
    const preparing = await current();
    assert.equal(preparing.lifecycle.phase, "preparing");
    assert.equal(preparing.lifecycle.plan.text, paused.lifecycle.plan.text);
    assert.equal(
      preparing.lifecycle.terms_revision,
      paused.lifecycle.terms_revision,
    );
    assert.deepEqual(
      preparing.lifecycle.coordinator,
      paused.lifecycle.coordinator,
    );
    assert.equal(preparing.lifecycle.readiness, null);
    await assert.rejects(command("startMission", { readiness: ready.event }));
    await assert.rejects(
      n.handle("setPlan", {
        mission,
        revision: paused.lifecycle.revision,
        text: "A stale pause review cannot overwrite the current plan.",
      }),
    );
    assert.equal((await n.state()).execution, "unavailable");
    const reviewed = await n.handle("reviewContribution", {
      mission,
      role: "coordinator",
    });
    const choice = await contributors.handle("chooseWorkspace", {});
    const before = await current();
    const changed = {
      ...definition,
      scope: "Use a different venue; no purchases",
    };
    await command("updateInstructions", { definition: changed });
    await assert.rejects(
      n.handle("setPlan", {
        mission,
        revision: before.lifecycle.revision,
        text: "A stale editor",
      }),
    );
    await assert.rejects(
      n.handle("prepareContribution", {
        reviewId: reviewed.reviewId,
        workspaceChoiceId: choice.id,
        runtime: "grok",
        limits: { mode: "unlimited", concurrency: 1 },
      }),
      /changed/,
    );
    await assert.rejects(
      command("appointCoordinator", { contributionId: c.id }),
      /current mission instructions/,
    );
    const newTerms = await current();
    assert.equal(newTerms.lifecycle.plan, null);
    assert.equal(newTerms.lifecycle.readiness, null);
    assert.equal(
      contributors.snapshot().contributions.find((x) => x.id === c.id)
        .nodeBinding.revision,
      c.nodeBinding.revision,
    );
    assert.ok(
      contributors
        .snapshot()
        .contributions.find((x) => x.id === c.id)
        .execution.blockers.some((b) => b.code === "mission_terms_changed"),
    );
    const c2 = await prepare("coordinator");
    await contributors.handle("revoke", { contributionId: c2.id });
    await assert.rejects(
      command("appointCoordinator", { contributionId: c2.id }),
    );
    await command("setCoordination", { mode: "peer" });
    await assert.rejects(
      n.handle("reviewContribution", { mission, role: "coordinator" }),
      /coordinated mission/,
    );
    await command("startMission", { readiness: null });
    assert.equal((await current()).state, "active");
    assert.equal((await n.state()).execution, "unavailable");
    await command("pauseMission", { reason: "Review before continuing" });
    assert.equal((await current()).state, "paused");
    await n.close();
    n = make();
    assert.equal(
      (await current()).lifecycle.pause_reason,
      "Review before continuing",
    );
    await command("startMission", { readiness: null });
    assert.equal((await current()).state, "active");
    const history = await n.handle("messages", { mission });
    assert.ok(
      history.items.some(
        (m) => m.kind === "control" && m.text.includes("Mission paused"),
      ),
    );
    assert.ok(history.items.some((m) => m.text.includes("human plan")));
    await assert.rejects(
      command("setPlan", { text: "Invalid bypass", readiness: true }),
    );
    assert.ok(
      contributors
        .snapshot()
        .contributions.every((c) => c.execution.allowed === false),
    );
  },
);
