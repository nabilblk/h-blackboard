import { ContributionAgreements } from "../../desktop/contribution-agreements.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { NodeService } from "../../desktop/node-service.mjs";
import { ContributorService } from "../../desktop/service.mjs";
import { DesktopStore } from "../../desktop/store.mjs";
import { ExecutionManager } from "../../desktop/execution/manager.mjs";
import { ExecutionStore } from "../../desktop/execution/store.mjs";
import { OnboardingService } from "../../desktop/onboarding.mjs";
import {
  POLICY_DIGEST,
  POLICY_DIGESTS,
} from "../../desktop/execution/contract.mjs";
import { secureStorage } from "../helpers/secure-storage.mjs";

async function until(fn) {
  const deadline = Date.now() + 10000;
  while (!(await fn())) {
    if (Date.now() > deadline)
      throw new Error("Onboarding did not reach expected state");
    await delay(15);
  }
}
async function fixture(t, coordination = "coordinated") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hb-onboarding-")));
  const contributors = new ContributorService({
    store: new DesktopStore(join(root, "contributor")),
    exportDirectory: join(root, "exports"),
    chooseDirectory: async () => root,
    revealDirectory: async () => {},
  });
  const node = new NodeService({
    directory: join(root, "node"),
    binary: resolve("var/node/target/debug/harakiri-node"),
    secureStorage: secureStorage(),
  });
  node.contributors = contributors;
  let resolveRun;
  const provider = {
    version: 2,
    policy: POLICY_DIGEST,
    policies: POLICY_DIGESTS,
    maximum: 2,
    prepared: [],
    launches: 0,
    fail: false,
    async prepare({ contribution }) {
      this.prepared.push(contribution.id);
      if (this.fail) throw new Error("Download interrupted");
      return { authenticated: false };
    },
    async inspect() {
      return { running: false, stopped: true, authenticated: false };
    },
    async launch({ onSession }) {
      this.launches++;
      onSession("test-session");
      return {
        done: new Promise((r) => {
          resolveRun = r;
        }),
      };
    },
    resume(request) {
      return this.launch(request);
    },
    login() {},
    interrupt() {
      return Promise.resolve();
    },
    async terminate() {
      resolveRun?.({});
      return { stopped: true };
    },
    checkpoint() {},
    usage() {
      return { turns: 1 };
    },
    exportFiles() {},
    importFiles() {},
  };
  const executions = new ExecutionManager({
    store: new ExecutionStore(join(root, "execution")),
    provider,
    node,
    pollMs: 30,
  });
  node.executions = executions;
  const service = () =>
    new OnboardingService({
      directory: join(root, "setup"),
      node,
      executions,
      provider,
    });
  const onboarding = service();
  t.after(async () => {
    await onboarding.close();
    await executions.close();
    await node.close();
    rmSync(root, { recursive: true, force: true });
  });
  await node.handle("enroll", {});
  const { mission } = await node.handle("createMission", {
    definition: {
      name: "Onboarding fixture",
      objective: "Verify the guided lifecycle",
      scope: "Temporary isolated test",
      criteria: ["No launch from joining"],
      policy: {
        coordination,
        participation: "private",
        budget: { mode: "unlimited" },
      },
    },
  });
  const request = {
    id: randomUUID(),
    mission,
    terms: mission,
    role: coordination === "coordinated" ? "coordinator" : "agent",
    runtime: "grok",
    label: "Fixture",
    count: 1,
    limits: { mode: "unlimited", concurrency: 1 },
    workspaceChoiceId: null,
  };
  return {
    root,
    node,
    contributors,
    executions,
    provider,
    onboarding,
    service,
    mission,
    request,
  };
}

test("guided Coordinator setup persists identity, shares and appoints once, without starting work", async (t) => {
  const f = await fixture(t);
  const [one, duplicate] = await Promise.all([
    f.onboarding.setup(f.request),
    f.onboarding.setup(f.request),
  ]);
  assert.deepEqual(one.contributions, duplicate.contributions);
  await until(() => f.onboarding.state(f.mission)[0].status === "complete");
  const local = f.contributors.store.read().contributions;
  assert.equal(local.length, 1);
  assert.ok(local[0].sharedAgent);
  const mission = (await f.node.state()).missions[0];
  assert.equal(
    mission.lifecycle.coordinator.identity.author,
    local[0].sharedAgent.author,
  );
  assert.equal(mission.lifecycle.phase, "preparing");
  assert.equal(mission.lifecycle.readiness, null);
  assert.equal(f.provider.launches, 0);
  await f.service().setup(f.request);
  assert.equal(f.contributors.store.read().contributions.length, 1);
  assert.equal(f.provider.prepared.length, 1);
});

test("interrupted bulk setup retries saved identities and rejects changed mission terms", async (t) => {
  const f = await fixture(t, "peer");
  f.request.count = 3;
  f.provider.fail = true;
  await f.onboarding.setup(f.request);
  await until(() => f.onboarding.state(f.mission)[0].status === "failed");
  const first = f.contributors.store.read().contributions[0].id;
  f.provider.fail = false;
  const recovered = f.service();
  await recovered.setup(f.request);
  await until(() => recovered.state(f.mission)[0].status === "complete");
  const local = f.contributors.store.read().contributions;
  assert.equal(local.length, 3);
  assert.ok(local.some((c) => c.id === first));
  assert.equal(new Set(local.map((c) => c.sharedAgent.registration)).size, 3);
  assert.equal(f.provider.launches, 0);
  await assert.rejects(
    recovered.setup({ ...f.request, id: randomUUID(), terms: "a".repeat(64) }),
    /instructions changed/,
  );
});

test("a reviewed custom export folder survives setup restart without a renderer path", async (t) => {
  const f = await fixture(t, "peer");
  f.request.count = 2;
  const choice = await f.contributors.handle("chooseWorkspace", {});
  f.request.workspaceChoiceId = choice.id;
  f.provider.fail = true;
  await f.onboarding.setup(f.request);
  await until(() => f.onboarding.state(f.mission)[0].status === "failed");
  f.contributors.choices.clear();
  f.provider.fail = false;
  const resumed = f.service();
  await resumed.setup(f.request);
  await until(() => resumed.state(f.mission)[0].status === "complete");
  const local = f.contributors.store.read().contributions;
  assert.equal(local.length, 2);
  assert.ok(
    local.every((c) => c.workspace.startsWith(join(f.root, "harakiri-"))),
  );
  assert.equal(f.provider.launches, 0);
});

for (const lost of ["allocate", "grant", "consentGrant"])
  test(`owner planning approval recovers a lost ${lost} response without duplicate authority`, async (t) => {
    const f = await fixture(t);
    await f.onboarding.setup(f.request);
    await until(() =>
      f.onboarding.state(f.mission).some((j) => j.status === "complete"),
    );
    const c = f.contributors.store.read().contributions[0];
    f.executions.store.update(c.id, { status: "ready" });
    const m = (await f.node.state()).missions[0];
    const request = {
      id: randomUUID(),
      contributionId: c.id,
      control: m.lifecycle.revision,
      direction: m.lifecycle.revision,
      turns: 2,
      minutes: 5,
    };
    const handle = f.node.handle.bind(f.node);
    let drop = true;
    f.node.handle = async (method, args, native) => {
      const result = await handle(method, args, native);
      if (drop && (args.action?.type === lost || method === lost)) {
        drop = false;
        throw new Error("Response lost after save");
      }
      return result;
    };
    await assert.rejects(f.onboarding.permission(request), /Response lost/);
    f.node.handle = handle;
    await f.service().permission(request);
    await until(() => f.provider.launches === 1);
    const ledger = await handle("governance", { mission: f.mission });
    assert.equal(ledger.allocations.length, 1);
    assert.equal(ledger.grants.length, 1);
    assert.ok(ledger.grants[0].consent);
    await f.onboarding.permission(request);
    assert.equal(f.provider.launches, 1);
    assert.equal(
      (await f.node.state()).missions[0].lifecycle.phase,
      "preparing",
    );
    await f.executions.stop(c.id);
  });

async function continuationFixture(t) {
  const f = await fixture(t, "peer");
  await f.onboarding.setup(f.request);
  await until(() => f.onboarding.state(f.mission)[0].status === "complete");
  const c = f.contributors.store.read().contributions[0];
  f.executions.store.update(c.id, { status: "ready" });
  const agreements = new ContributionAgreements({
    directory: join(f.root, "agreements"),
    node: f.node,
    executions: f.executions,
  });
  f.executions.agreements = agreements;
  const input = {
    id: randomUUID(),
    mission: f.mission,
    terms: f.mission,
    coordinator: null,
    plan: null,
    registration: c.sharedAgent.registration,
    contributionId: c.id,
    ownerPermission: true,
    minutes: 60,
    turns: 10,
    followDirections: true,
  };
  return { ...f, c, agreements, input };
}

test("reviewed Start launches once, preserves independent local caps, and Stop disables renewal", async (t) => {
  const f = await continuationFixture(t);
  const request = {
    id: randomUUID(),
    mission: f.mission,
    revision: f.mission,
    readiness: null,
    approvals: [f.input],
  };
  await f.agreements.startReviewed(request);
  await until(() => f.provider.launches === 1);
  await f.agreements.startReviewed(request);
  await f.agreements.tick();
  assert.equal(f.provider.launches, 1);
  const ledger = await f.node.handle("governance", { mission: f.mission });
  assert.equal(ledger.grants.length, 1);
  assert.ok(ledger.grants[0].consent);
  await f.agreements.cancel(f.input.id);
  await f.agreements.tick();
  assert.equal(f.provider.launches, 1);
  assert.equal(f.agreements.list(f.mission)[0].status, "stopped");
});

test("approval waits for human Start and survives a host-service restart without extending expiry", async (t) => {
  const f = await continuationFixture(t);
  const approved = await f.agreements.approve(f.input);
  await f.agreements.tick();
  assert.equal(f.provider.launches, 0);
  const reopened = new ContributionAgreements({
    directory: join(f.root, "agreements"),
    node: f.node,
    executions: f.executions,
  });
  assert.equal((await reopened.approve(f.input)).expiresAt, approved.expiresAt);
  await f.node.handle("startMission", {
    mission: f.mission,
    revision: f.mission,
    readiness: null,
  });
  await reopened.tick();
  await until(() => f.provider.launches === 1);
  await reopened.cancel(f.input.id);
});

test("new mission terms invalidate standing approval without launching or extending limits", async (t) => {
  const f = await continuationFixture(t);
  await f.agreements.approve(f.input);
  const m = (await f.node.state()).missions[0];
  await f.node.handle("updateInstructions", {
    mission: f.mission,
    revision: m.lifecycle.revision,
    definition: { ...m.definition, scope: "Changed scope" },
  });
  await f.agreements.tick();
  assert.equal(f.provider.launches, 0);
  assert.equal(f.agreements.list(f.mission)[0].status, "review");
  await assert.rejects(f.agreements.continue(f.input.id), /changed/);
});

test("owner authorization alone never supplies another contribution's local consent", async (t) => {
  const f = await continuationFixture(t);
  await f.node.handle("startMission", {
    mission: f.mission,
    revision: f.mission,
    readiness: null,
  });
  await f.agreements.approve({ ...f.input, contributionId: null });
  await f.agreements.tick();
  assert.equal(f.provider.launches, 0);
  const ledger = await f.node.handle("governance", { mission: f.mission });
  assert.equal(ledger.grants.length, 1);
  assert.equal(ledger.grants[0].consent, null);
});

test("finite contribution expires even when the mission budget is unlimited", async (t) => {
  const f = await continuationFixture(t);
  const a = await f.agreements.approve(f.input);
  f.agreements.clock = () => a.expiresAt + 1;
  await f.agreements.tick();
  assert.equal(f.provider.launches, 0);
  assert.equal(f.agreements.list(f.mission)[0].status, "expired");
});

for (const lost of ["startMission", "allocate", "grant", "consentGrant"])
  test(`reviewed Start recovers a lost ${lost} response and keeps one signed permission`, async (t) => {
    const f = await continuationFixture(t);
    const input = {
      id: randomUUID(),
      mission: f.mission,
      revision: f.mission,
      readiness: null,
      approvals: [f.input],
    };
    const handle = f.node.handle.bind(f.node);
    let drop = true;
    f.node.handle = async (method, args, native) => {
      const result = await handle(method, args, native);
      if (drop && (method === lost || args.action?.type === lost)) {
        drop = false;
        throw new Error("Saved reply lost");
      }
      return result;
    };
    await f.agreements
      .startReviewed(input)
      .catch((e) => assert.match(e.message, /lost/));
    f.node.handle = handle;
    const saved = f.agreements.list(f.mission)[0];
    if (saved.status === "interrupted") await f.agreements.continue(saved.id);
    const recovered = new ContributionAgreements({
      directory: join(f.root, "agreements"),
      node: f.node,
      executions: f.executions,
    });
    f.executions.agreements = recovered;
    await Promise.all([
      recovered.startReviewed(input),
      recovered.startReviewed(input),
    ]);
    await recovered.tick();
    await until(() => f.provider.launches === 1);
    const ledger = await handle("governance", { mission: f.mission });
    assert.equal(ledger.grants.length, 1);
    assert.equal(ledger.allocations.length, 1);
    assert.equal(recovered.startState(f.mission)[0].phase, "complete");
    await recovered.cancel(f.input.id);
  });

test("changed accepted plans and clock rollback require fresh contribution review", async (t) => {
  const f = await continuationFixture(t);
  await f.node.handle("setPlan", {
    mission: f.mission,
    revision: f.mission,
    text: "The approved plan",
  });
  const before = (await f.node.state()).missions[0];
  const input = { ...f.input, plan: before.lifecycle.plan.id };
  await f.agreements.approve(input);
  await f.node.handle("setPlan", {
    mission: f.mission,
    revision: before.lifecycle.revision,
    text: "A changed plan",
  });
  await f.agreements.tick();
  assert.equal(f.provider.launches, 0);
  await assert.rejects(f.agreements.continue(input.id), /changed/);
  const current = (await f.node.state()).missions[0];
  const fresh = await f.agreements.approve({
    ...input,
    id: randomUUID(),
    plan: current.lifecycle.plan.id,
  });
  f.agreements.clock = () => fresh.createdAt - 10000;
  await f.agreements.tick();
  assert.match(
    f.agreements.list(f.mission).find((a) => a.id === fresh.id).message,
    /clock moved backwards/,
  );
  assert.equal(f.provider.launches, 0);
});

test("unused owner permission stops without accepting accounting risk", async (t) => {
  const f = await continuationFixture(t);
  await f.node.handle("startMission", {
    mission: f.mission,
    revision: f.mission,
    readiness: null,
  });
  await f.agreements.approve({ ...f.input, contributionId: null });
  await f.agreements.tick();
  await f.agreements.cancel(f.input.id);
  const ledger = await f.node.handle("governance", { mission: f.mission });
  assert.equal(ledger.grants[0].revoked, true);
  assert.equal(ledger.grants[0].sealed, false);
  assert.equal(ledger.grants[0].risk_accepted, null);
  assert.equal(f.provider.launches, 0);
});

test("real signed deliverable acceptance and closure remain distinct and survive retry", async (t) => {
  const { CompletionService } = await import("../../desktop/completion.mjs");
  const f = await continuationFixture(t);
  await f.node.handle("startMission", {
    mission: f.mission,
    revision: f.mission,
    readiness: null,
  });
  const m = (await f.node.state()).missions[0];
  const control = m.lifecycle.revision;
  const bytes = Buffer.from(
    "<!doctype html><title>Fixture handoff</title><h1>Reviewable result</h1>",
  );
  const transfer = (transfer) =>
    f.node.handle("artifactTransfer", { mission: f.mission, transfer });
  const { upload } = await transfer({
    type: "begin",
    control,
    conversation: "main",
    path: "index.html",
    media_type: "text/html",
    size: bytes.length,
  });
  await transfer({
    type: "chunk",
    upload,
    offset: 0,
    hex: bytes.toString("hex"),
  });
  const { event: revision } = await transfer({
    type: "publish",
    control,
    conversation: "main",
    artifact: null,
    parents: [],
    document: {
      title: "Fixture handoff",
      summary: "Exact revision to review",
      kind: "application",
      stage: "complete",
      limitations: "Test data",
      entrypoint: "index.html",
      inputs: [],
      files: [],
    },
    uploads: [upload],
    retain: [],
  });
  const complete = new CompletionService({
    directory: join(f.root, "completion"),
    node: f.node,
  });
  const r = {
    id: randomUUID(),
    mission: f.mission,
    control,
    revisions: [revision],
    reason: "Human reviewed this exact fixture.",
  };
  await complete.complete(r);
  await complete.complete(r);
  const detail = await f.node.handle("artifactDetail", {
    mission: f.mission,
    revision,
  });
  assert.equal(detail.acceptance.accepted, true);
  assert.equal(detail.acceptance.author, m.owner);
  assert.equal((await f.node.state()).missions[0].lifecycle.phase, "closed");
  const governance = await f.node.handle("governance", { mission: f.mission });
  assert.ok(
    !governance.criteria.some((c) => c.met),
    "Acceptance never manufactures completed criteria",
  );
  assert.equal(f.provider.launches, 0);
});

test("finite permission renewal preserves an idle session and never spends beyond the reviewed turn cap", async (t) => {
  const f = await continuationFixture(t);
  f.provider.launch = async ({ onSession }) => {
    f.provider.launches++;
    onSession("fixture-saved-session");
    return { done: Promise.resolve({}) };
  };
  const input = { ...f.input, turns: 6 };
  await f.agreements.startReviewed({
    id: randomUUID(),
    mission: f.mission,
    revision: f.mission,
    readiness: null,
    approvals: [input],
  });
  for (let turn = 1; turn <= 5; turn++) {
    await until(
      () =>
        f.provider.launches === turn &&
        f.executions.store.read(f.c.id)?.status ===
          (turn < 5 ? "waiting" : "stopped"),
    );
    if (turn < 5)
      await f.node.handle("postMessage", {
        mission: f.mission,
        text: `Human update ${turn}`,
      });
  }
  await f.agreements.tick();
  assert.equal(
    f.provider.launches,
    5,
    "renewing authority alone does not wake an idle model",
  );
  assert.equal(
    (await f.node.handle("governance", { mission: f.mission })).grants.length,
    1,
  );
  await f.node.handle("postMessage", {
    mission: f.mission,
    text: "One more substantive update",
  });
  await f.agreements.tick();
  await until(
    () =>
      f.provider.launches === 6 &&
      f.executions.store.read(f.c.id)?.status === "stopped",
  );
  await f.node.handle("postMessage", {
    mission: f.mission,
    text: "This must not exceed the approved allowance",
  });
  await f.agreements.tick();
  const ledger = await f.node.handle("governance", { mission: f.mission });
  assert.deepEqual(
    ledger.grants.map((g) => g.turns),
    [5, 1],
  );
  assert.equal(
    ledger.grants.reduce((n, g) => n + g.charged, 0),
    6,
  );
  assert.ok(ledger.grants.every((g) => g.sealed));
  assert.equal(f.provider.launches, 6);
});
