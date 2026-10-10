import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DesktopStore } from "../desktop/store.mjs";
import { ExecutionStore } from "../desktop/execution/store.mjs";
import { ExecutionManager } from "../desktop/execution/manager.mjs";
import {
  executionBinding,
  currentPermissions,
} from "../desktop/execution/permissions.mjs";
import {
  POLICY_DIGEST,
  POLICY_DIGESTS,
  INTERNET_POLICY_DIGESTS,
  newRecord,
  policyDigest,
  runtimePolicy,
} from "../desktop/execution/contract.mjs";
import { Requests } from "../desktop/model.mjs";
import { AgentOperation } from "../desktop/node-service.mjs";

const h = (c) => c.repeat(64);
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "hb-network-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const local = new DesktopStore(join(directory, "local"));
  const id = randomUUID();
  local.update((s) =>
    s.contributions.push({
      id,
      contributorId: s.contributor.id,
      deviceId: s.device.id,
      mission: {
        origin: "harakiri://node/owner",
        missionId: h("a"),
        name: "Isolated network test",
        role: "agent",
        inspectedAt: new Date().toISOString(),
      },
      nodeBinding: { owner: h("b"), revision: h("c") },
      runtime: "grok",
      sharedAgent: {
        registration: h("d"),
        author: h("e"),
        label: "Fixture",
        withdrawn: false,
      },
      limits: { mode: "unlimited", concurrency: 1 },
      workspace: directory,
      workspaceIdentity: { device: "1", inode: "2" },
      status: "prepared",
      createdAt: new Date().toISOString(),
      revokedAt: null,
    }),
  );
  const contribution = () => local.read().contributions[0];
  const store = new ExecutionStore(join(directory, "execution"));
  store.write({
    ...newRecord(id),
    status: "stopped",
    session: "saved-session",
    grant: h("f"),
  });
  const calls = {
    prepare: 0,
    terminate: 0,
    launch: 0,
    stopped: true,
    fail: false,
  };
  const provider = {
    version: 2,
    policy: POLICY_DIGEST,
    policies: POLICY_DIGESTS,
    internetPolicies: INTERNET_POLICY_DIGESTS,
    async prepare() {
      calls.prepare++;
      if (calls.fail) throw new Error("Provisioning interrupted");
      return { authenticated: true };
    },
    async terminate() {
      calls.terminate++;
      return { stopped: calls.stopped };
    },
    async inspect() {
      return { stopped: true, running: false };
    },
    launch() {
      calls.launch++;
    },
    resume() {
      calls.launch++;
    },
    login() {},
    interrupt() {},
    checkpoint() {},
    usage() {},
    exportFiles() {},
    importFiles() {},
  };
  const node = {
    contributors: { store: local },
    executionContext: async () => ({ contribution: contribution() }),
  };
  const manager = new ExecutionManager({ store, provider, node });
  return { id, local, contribution, store, provider, manager, calls };
}

test("old contributions default to restricted and each runtime's internet choice has separate consent", (t) => {
  const f = fixture(t);
  assert.equal(f.contribution().networkAccess, "restricted");
  const policies = new Set();
  for (const runtime of ["grok", "claude", "codex"]) {
    assert.equal(runtimePolicy(runtime).workerNetwork, "none");
    assert.equal(
      runtimePolicy(runtime, "internet").runtimeNetwork,
      "provider-only",
    );
    for (const mode of ["restricted", "internet"])
      policies.add(policyDigest(runtime, mode));
    const legacy = { ...f.contribution(), runtime, networkAccess: undefined };
    assert.equal(
      executionBinding(legacy),
      executionBinding({ ...legacy, networkAccess: "restricted" }),
    );
    assert.notEqual(
      executionBinding(legacy),
      executionBinding({ ...legacy, networkAccess: "internet" }),
    );
  }
  assert.equal(policies.size, 6);
  assert.equal(
    Requests.prepare.parse({
      reviewId: f.id,
      workspaceChoiceId: randomUUID(),
      runtime: "grok",
      limits: { mode: "unlimited", concurrency: 1 },
    }).networkAccess,
    "restricted",
  );
  assert.throws(() => runtimePolicy("grok", "unrestricted"));
  assert.equal(
    AgentOperation.safeParse({
      type: "executionNetwork",
      networkAccess: "internet",
    }).success,
    false,
  );
});

test("local network change preserves work, never launches and old approvals cannot revive after toggling back", async (t) => {
  const f = fixture(t);
  const old = executionBinding(f.contribution());
  await f.manager.setNetwork(f.id, "internet", null);
  const internet = f.contribution();
  assert.equal(internet.networkAccess, "internet");
  assert.ok(internet.networkRevision);
  assert.equal(f.store.read(f.id).session, "saved-session");
  assert.equal(f.store.read(f.id).policy, INTERNET_POLICY_DIGESTS.grok);
  assert.equal(f.calls.launch, 0);
  await assert.rejects(
    f.manager.setNetwork(f.id, "restricted", null),
    /changed/,
  );
  await f.manager.setNetwork(f.id, "restricted", internet.networkRevision);
  assert.equal(f.contribution().networkAccess, "restricted");
  assert.notEqual(executionBinding(f.contribution()), old);
  assert.notEqual(f.contribution().networkRevision, internet.networkRevision);
  const now = Date.now();
  const view = {
    contribution: f.contribution(),
    context: {
      lifecycle: { revision: h("a"), phase: "active" },
      agent: { status: "direction_assigned", direction: { id: h("b") } },
    },
    governance: {
      grants: [
        {
          id: h("c"),
          purpose: "work",
          registration: h("d"),
          control: h("a"),
          direction: h("b"),
          consent: h("e"),
          consent_binding: old,
          issued_ms: now,
          expires_ms: now + 10000,
          offline_ms: 10000,
          turns: 3,
          charged: 0,
          reserved: 0,
        },
      ],
    },
  };
  assert.deepEqual(currentPermissions(view, null, now), []);
  assert.equal(f.calls.launch, 0);
  const count = f.calls.prepare;
  await f.manager.setNetwork(
    f.id,
    "restricted",
    f.contribution().networkRevision,
  );
  assert.equal(f.calls.prepare, count);
});

test("live, uncertain, busy, withdrawn or unsupported environments cannot widen access", async (t) => {
  const f = fixture(t);
  for (const status of [
    "running",
    "waiting",
    "launching",
    "reserving",
    "stopping",
    "recovery_required",
    "preparing",
  ]) {
    f.store.update(f.id, { status });
    await assert.rejects(
      f.manager.setNetwork(f.id, "internet", null),
      /Stop and recover/,
    );
  }
  f.store.update(f.id, { status: "stopped" });
  f.manager.busy.add(f.id);
  await assert.rejects(f.manager.setNetwork(f.id, "internet", null), /active/);
  f.manager.busy.clear();
  f.calls.stopped = false;
  await assert.rejects(
    f.manager.setNetwork(f.id, "internet", null),
    /unconfirmed/,
  );
  f.calls.stopped = true;
  f.manager.authentications.set(f.id, {
    handle: {},
    view: { status: "waiting" },
  });
  await assert.rejects(f.manager.setNetwork(f.id, "internet", null), /sign-in/);
  f.manager.authentications.clear();
  f.provider.internetPolicies = undefined;
  await assert.rejects(
    f.manager.setNetwork(f.id, "internet", null),
    /does not enforce/,
  );
  f.provider.internetPolicies = INTERNET_POLICY_DIGESTS;
  f.local.update((s) => {
    s.contributions[0].sharedAgent.withdrawn = true;
  });
  await assert.rejects(
    f.manager.setNetwork(f.id, "internet", null),
    /active local/,
  );
  assert.equal(f.contribution().networkAccess, "restricted");
  assert.equal(f.calls.prepare, 0);
});

test("failed provisioning leaves reviewed choice visible and cannot launch until retry succeeds", async (t) => {
  const f = fixture(t);
  f.calls.fail = true;
  await assert.rejects(
    f.manager.setNetwork(f.id, "internet", null),
    /Provisioning interrupted/,
  );
  assert.equal(f.contribution().networkAccess, "internet");
  assert.equal(f.store.read(f.id).status, "failed");
  assert.equal(f.store.read(f.id).session, "saved-session");
  await assert.rejects(f.manager.start(f.id, h("a")), /Prepare/);
  f.calls.fail = false;
  await f.manager.prepare(f.id);
  assert.equal(f.store.read(f.id).status, "ready");
  assert.equal(f.calls.launch, 0);
});

test("a crash between contribution and execution journal updates requires policy preparation", async (t) => {
  const f = fixture(t);
  f.local.update((s) => {
    s.contributions[0].networkAccess = "internet";
    s.contributions[0].networkRevision = randomUUID();
  });
  const view = await f.manager.state(f.id);
  assert.equal(view.networkAccess, "internet");
  assert.equal(view.record.status, "failed");
  await f.manager.prepare(f.id);
  assert.equal(f.store.read(f.id).policy, INTERNET_POLICY_DIGESTS.grok);
  assert.equal(f.calls.launch, 0);
});
