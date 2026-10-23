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
  INTERNET_POLICY_DIGESTS,
} from "../../desktop/execution/contract.mjs";
import { secureStorage } from "../helpers/secure-storage.mjs";

async function until(fn, { timeoutMs = 10000, describe } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline)
      throw new Error(
        `Onboarding did not reach expected state${describe ? `: ${describe()}` : ""}`,
      );
    await delay(15);
  }
}
async function fixture(
  t,
  coordination = "coordinated",
  budget = { mode: "unlimited" },
) {
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
    internetPolicies: INTERNET_POLICY_DIGESTS,
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
        budget,
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

test("bulk setup preserves explicit internet choices and cannot change a saved setup's consent", async (t) => {
  const f = await fixture(t, "peer");
  const request = {
    ...f.request,
    count: 2,
    networkAccess: "internet",
    capabilityPack: "web-3d",
  };
  await f.onboarding.setup(request);
  await until(() => f.onboarding.state(f.mission)[0].status === "complete");
  for (const c of f.contributors.store.read().contributions) {
    assert.equal(c.networkAccess, "internet");
    assert.equal(c.capabilityPack, "web-3d");
    assert.equal(
      f.executions.store.read(c.id).policy,
      INTERNET_POLICY_DIGESTS.grok,
    );
  }
  await assert.rejects(
    f.onboarding.setup({ ...request, networkAccess: "restricted" }),
    /reviewed terms/,
  );
  assert.equal(f.provider.launches, 0);
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

test("a remote permission cannot exceed the contributor's reviewed session or offline limit", async (t) => {
  const f = await continuationFixture(t);
  await f.agreements.startReviewed({
    id: randomUUID(),
    mission: f.mission,
    revision: f.mission,
    readiness: null,
    approvals: [{ ...f.input, leaseMinutes: 5, offlineMinutes: 3 }],
  });
  await until(() => f.provider.launches === 1);
  const grantId = f.executions.store.read(f.c.id).grant;
  const context = await f.node.executionContext(f.c.id, grantId);
  const offered = {
    ...context,
    grant: {
      ...context.grant,
      expires_ms: context.grant.issued_ms + 45 * 60000,
      offline_ms: 30 * 60000,
    },
  };
  const constrained = f.agreements.constrain(f.c.id, offered).grant;
  assert.equal(constrained.expires_ms, offered.grant.issued_ms + 5 * 60000);
  assert.equal(constrained.offline_ms, 3 * 60000);
  await f.agreements.cancel(f.input.id);
});

test("replacement consent takes precedence when recovery links a permission to both saved approvals", async (t) => {
  const f = await continuationFixture(t);
  f.input.id = "00000000-0000-4000-8000-000000000001";
  await f.agreements.startReviewed({
    id: randomUUID(),
    mission: f.mission,
    revision: f.mission,
    readiness: null,
    approvals: [f.input],
  });
  await until(() => f.provider.launches === 1);
  const grantId = f.executions.store.read(f.c.id).grant;
  const context = await f.node.executionContext(f.c.id, grantId);
  await f.executions.stop(f.c.id, "Desktop is closing.");
  const old = f.agreements.store.read(f.input.id);
  f.agreements.save(old, { status: "interrupted" });
  const next = await f.agreements.approve({
    ...f.input,
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    leaseMinutes: 2,
    offlineMinutes: 1,
  });
  // Recovery can discover the same durable permission after a lost response or
  // an in-flight old issue. Preserve both journals; apply the latest consent.
  f.agreements.save(next, { grants: [grantId] });
  const constrained = f.agreements.constrain(f.c.id, context).grant;
  assert.equal(constrained.offline_ms, 60000);
  assert.ok(constrained.expires_ms <= context.grant.issued_ms + 120000);
  f.agreements.save(next, { status: "interrupted" });
  f.agreements.save(old, { status: "active" });
  assert.throws(
    () => f.agreements.constrain(f.c.id, context),
    /approval ended or changed/,
  );
  f.agreements.save(next, { status: "stopped" });
  assert.throws(
    () => f.agreements.constrain(f.c.id, context),
    /approval ended or changed/,
  );
});

test("a fully assigned turn pool can queue another approved agent without a false budget failure", async (t) => {
  const f = await fixture(t, "peer", {
    mode: "limited",
    turns: 2,
    concurrency: 4,
    deadline_ms: null,
    tokens: null,
    model_cost_microusd: null,
  });
  await f.onboarding.setup({ ...f.request, count: 2 });
  await until(() => f.onboarding.state(f.mission)[0].status === "complete");
  const agents = f.contributors.store.read().contributions;
  agents.forEach((c) => f.executions.store.update(c.id, { status: "ready" }));
  f.provider.launch = async ({ onSession }) => {
    f.provider.launches++;
    onSession("pooled-session");
    return { done: delay(25).then(() => ({})) };
  };
  const agreements = new ContributionAgreements({
    directory: join(f.root, "pool"),
    node: f.node,
    executions: f.executions,
  });
  f.executions.agreements = agreements;
  t.after(() => agreements.close());
  await agreements.startReviewed({
    id: randomUUID(),
    mission: f.mission,
    revision: f.mission,
    readiness: null,
    approvals: agents.map((c) => ({
      id: randomUUID(),
      mission: f.mission,
      terms: f.mission,
      coordinator: null,
      plan: null,
      registration: c.sharedAgent.registration,
      contributionId: c.id,
      ownerPermission: true,
      minutes: 60,
      turns: 2,
      followDirections: true,
    })),
  });
  await until(async () => {
    await agreements.tick();
    return f.provider.launches === 2;
  });
  await until(async () =>
    (
      await f.node.handle("governance", { mission: f.mission })
    ).reservations.every((r) => r.receipt),
  );
  const ledger = await f.node.handle("governance", { mission: f.mission });
  assert.equal(ledger.allocations.length, 1);
  assert.equal(ledger.allocations[0].charged, 2);
  assert.ok(
    agreements.list(f.mission).every((a) => a.status !== "interrupted"),
  );
});

test("changing internet access invalidates standing and stale approvals; fresh consent binds the new policy", async (t) => {
  const f = await continuationFixture(t);
  await f.agreements.approve(f.input);
  await f.executions.setNetwork(f.c.id, "internet", null);
  await f.agreements.tick();
  assert.equal(f.agreements.list(f.mission)[0].status, "review");
  assert.equal(f.provider.launches, 0);
  await assert.rejects(
    f.agreements.approve({ ...f.input, id: randomUUID() }),
    /Internet access changed/,
  );
  const c = f.contributors.store.read().contributions[0];
  f.executions.store.update(c.id, { status: "ready" });
  const approval = {
    ...f.input,
    id: randomUUID(),
    networkRevision: c.networkRevision,
  };
  await f.agreements.startReviewed({
    id: randomUUID(),
    mission: f.mission,
    revision: f.mission,
    readiness: null,
    approvals: [approval],
  });
  await until(() => f.provider.launches === 1);
  const ledger = await f.node.handle("governance", { mission: f.mission });
  const { executionBinding } =
    await import("../../desktop/execution/permissions.mjs");
  assert.equal(ledger.grants[0].consent_binding, executionBinding(c));
  await assert.rejects(
    f.node.handle("consentGrant", {
      mission: f.mission,
      contributionId: c.id,
      grant: ledger.grants[0].id,
    }),
    /Internet access changed/,
  );
  await f.agreements.cancel(approval.id);
  assert.equal(f.provider.launches, 1);
});

test("changing authoring tools invalidates standing and stale approvals; fresh consent binds the selected toolkit", async (t) => {
  const f = await continuationFixture(t);
  await f.agreements.approve(f.input);
  await f.executions.setCapabilityPack(f.c.id, "web-3d", null);
  await f.agreements.tick();
  assert.equal(f.agreements.list(f.mission)[0].status, "review");
  assert.equal(f.provider.launches, 0);
  await assert.rejects(
    f.agreements.approve({ ...f.input, id: randomUUID() }),
    /Authoring tools changed/,
  );
  const c = f.contributors.store.read().contributions[0];
  f.executions.store.update(c.id, { status: "ready" });
  const approval = {
    ...f.input,
    id: randomUUID(),
    capabilityRevision: c.capabilityRevision,
  };
  await f.agreements.startReviewed({
    id: randomUUID(),
    mission: f.mission,
    revision: f.mission,
    readiness: null,
    approvals: [approval],
  });
  await until(() => f.provider.launches === 1);
  const ledger = await f.node.handle("governance", { mission: f.mission });
  const { executionBinding } =
    await import("../../desktop/execution/permissions.mjs");
  assert.equal(ledger.grants[0].consent_binding, executionBinding(c));
  await assert.rejects(
    f.node.handle("consentGrant", {
      mission: f.mission,
      contributionId: c.id,
      grant: ledger.grants[0].id,
    }),
    /Authoring tools changed/,
  );
  await f.agreements.cancel(approval.id);
  assert.equal(f.provider.launches, 1);
});

test("a consented permission that never launched cannot strand resources after an internet change", async (t) => {
  const f = await continuationFixture(t);
  const start = f.executions.start.bind(f.executions);
  f.executions.start = async () => {
    throw new Error("Simulated interruption before launch");
  };
  await f.agreements.startReviewed({
    id: randomUUID(),
    mission: f.mission,
    revision: f.mission,
    readiness: null,
    approvals: [f.input],
  });
  const old = (await f.node.handle("governance", { mission: f.mission }))
    .grants[0];
  assert.ok(old.consent);
  assert.equal(old.reserved, 0);
  assert.equal(old.sealed, false);
  f.executions.start = start;
  await f.executions.setNetwork(f.c.id, "internet", null);
  const c = f.contributors.store.read().contributions[0];
  f.executions.store.update(c.id, { status: "ready" });
  const approval = {
    ...f.input,
    id: randomUUID(),
    networkRevision: c.networkRevision,
  };
  await f.agreements.approve(approval);
  await f.agreements.tick();
  await until(() => f.provider.launches === 1, {
    describe: () =>
      JSON.stringify(f.agreements.list(f.mission).map((a) => a.message)),
  });
  const ledger = await f.node.handle("governance", { mission: f.mission });
  assert.equal(ledger.grants.find((g) => g.id === old.id).sealed, true);
  assert.equal(ledger.grants.length, 2);
  await f.agreements.cancel(approval.id);
});

test("approval waits for human Start and survives a host-service restart without extending expiry", async (t) => {
  const f = await continuationFixture(t);
  const approved = await f.agreements.approve(f.input);
  await f.agreements.tick();
  assert.equal(f.provider.launches, 0);
  assert.equal(
    f.agreements.local(f.input.contributionId).waitingFor,
    "mission_start",
  );
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
    closeConfirmed: true,
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
  const waitForTurn = (turn, status) =>
    until(
      () => {
        assert.ok(
          f.provider.launches <= turn,
          `Unexpected model turn: expected ${turn}, observed ${f.provider.launches}`,
        );
        return (
          f.provider.launches === turn &&
          f.executions.store.read(f.c.id)?.status === status
        );
      },
      {
        // Native processes and durable writes are slower on shared CI runners.
        // This checks accounting and idle behavior, not a ten-second SLA.
        timeoutMs: 30000,
        describe: () =>
          JSON.stringify({
            expectedTurn: turn,
            expectedStatus: status,
            launches: f.provider.launches,
            status: f.executions.store.read(f.c.id)?.status,
            reason: f.executions.store.read(f.c.id)?.reason,
          }),
      },
    );
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
    await waitForTurn(turn, turn < 5 ? "waiting" : "stopped");
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
  await waitForTurn(6, "stopped");
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

for (const budget of [
  { mode: "unlimited" },
  {
    mode: "limited",
    turns: 6,
    concurrency: 2,
    deadline_ms: null,
    tokens: null,
    model_cost_microusd: null,
  },
])
  test(`six approvals queue fairly, settle and reclaim slots with ${budget.mode} budget`, async (t) => {
    const f = await fixture(t, "peer", budget);
    await f.onboarding.setup({ ...f.request, count: 6 });
    await until(() => f.onboarding.state(f.mission)[0].status === "complete");
    const agents = f.contributors.store.read().contributions;
    assert.equal(agents.length, 6);
    for (const c of agents)
      f.executions.store.update(c.id, { status: "ready" });
    const running = new Set();
    let maximum = 0;
    f.provider.launch = async ({ contribution, onSession }) => {
      running.add(contribution.id);
      maximum = Math.max(maximum, running.size);
      f.provider.launches++;
      onSession("capacity-fixture-session");
      return { done: delay(25).then(() => ({})) };
    };
    f.provider.terminate = async ({ contribution }) => {
      running.delete(contribution.id);
      return { stopped: true };
    };
    const agreements = new ContributionAgreements({
      directory: join(f.root, "six-approvals"),
      node: f.node,
      executions: f.executions,
    });
    f.executions.agreements = agreements;
    t.after(() => agreements.close());
    const approvals = agents.map((c) => ({
      id: randomUUID(),
      mission: f.mission,
      terms: f.mission,
      coordinator: null,
      plan: null,
      registration: c.sharedAgent.registration,
      contributionId: c.id,
      ownerPermission: true,
      minutes: 60,
      leaseMinutes: 45,
      offlineMinutes: 45,
      turns: 1,
      followDirections: true,
    }));
    await agreements.startReviewed({
      id: randomUUID(),
      mission: f.mission,
      revision: f.mission,
      readiness: null,
      approvals,
    });
    await until(
      async () => {
        await agreements.tick();
        return (
          f.provider.launches === 6 &&
          agents.every(
            (c) => f.executions.store.read(c.id).status === "stopped",
          )
        );
      },
      {
        timeoutMs: 30000,
        describe: () =>
          JSON.stringify(
            agreements.list(f.mission).map((a) => ({
              status: a.status,
              waiting: a.waitingFor,
              message: a.message,
            })),
          ),
      },
    );
    assert.ok(maximum <= 2);
    const ledger = await f.node.handle("governance", { mission: f.mission });
    assert.equal(new Set(ledger.grants.map((g) => g.allocation)).size, 6);
    assert.equal(ledger.reservations.length, 6);
    assert.ok(ledger.reservations.every((r) => r.receipt && r.stopped));
    assert.ok(
      ledger.grants.every((g) => g.expires_ms - g.issued_ms > 44 * 60000),
    );
    assert.ok(
      agreements.list(f.mission).every((a) => a.status !== "interrupted"),
    );
  });
