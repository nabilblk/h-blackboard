import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionFixture } from "./helpers/local-execution.mjs";
import { AgentOperation } from "../desktop/node-service.mjs";
import { ExecutionRequests } from "../desktop/execution/contract.mjs";
import {
  currentPermissions,
  executionBinding,
  localAllowance,
} from "../desktop/execution/permissions.mjs";

const bounded = { mode: "bounded", turns: 20, concurrency: 1, minutes: 180 };

function fixture(t) {
  const f = executionFixture(t);
  f.sealed = [];
  f.provider.interrupt = async () => {};
  f.manager.node.openResourceLedger = () => ({
    state: async () => ({ reservations: [] }),
    seal: async (grant) => f.sealed.push(grant),
    close() {},
  });
  return f;
}

test("a stopped allowance edit retains the agent, session and files and needs fresh consent", async (t) => {
  const f = fixture(t);
  const before = f.contribution();
  const session = f.store.read(f.id).session;
  const path = join(before.workspace, "saved-work.txt");
  writeFileSync(path, "Existing work remains byte-for-byte.\n");
  f.provider.terminate = async () => {
    f.calls.terminate++;
    assert.equal(f.manager.busy.has(f.id), true);
    await assert.rejects(
      f.manager.exclusive(f.id, async () => {}),
      /already active/,
    );
    return { stopped: true };
  };

  await f.manager.setLimits(f.id, bounded, null);
  const edited = f.contribution();
  assert.deepEqual(edited.limits, bounded);
  assert.match(edited.limitsRevision, /^[a-f0-9-]{36}$/);
  const { limits: _limits, limitsRevision: _revision, ...retained } = edited;
  const { limits: _oldLimits, ...original } = before;
  assert.deepEqual(retained, original);
  assert.equal(f.store.read(f.id).session, session);
  assert.equal(
    readFileSync(path, "utf8"),
    "Existing work remains byte-for-byte.\n",
  );
  assert.deepEqual(f.sealed, [f.store.read(f.id).grant]);
  assert.equal(f.calls.terminate, 1);
  assert.equal(f.calls.prepare, 0);
  assert.equal(f.calls.launch, 0);
  assert.notEqual(executionBinding(edited), executionBinding(before));

  await f.manager.setLimits(f.id, { ...bounded }, edited.limitsRevision);
  assert.equal(
    f.contribution().limitsRevision,
    edited.limitsRevision,
    "Repeating the current cap must not create another consent revision",
  );
});

test("stale and invalid allowance reviews reject before shutdown or accounting changes", async (t) => {
  const f = fixture(t);
  f.local.update((s) => {
    s.contributions[0].limitsRevision = randomUUID();
  });
  const before = f.local.read();
  const execution = f.store.read(f.id);
  await assert.rejects(
    f.manager.setLimits(f.id, bounded, null),
    /allowance changed/,
  );
  assert.deepEqual(f.local.read(), before);
  assert.deepEqual(f.store.read(f.id), execution);
  assert.equal(f.calls.terminate, 0);
  assert.deepEqual(f.sealed, []);

  f.local.update((s) => {
    s.contributions[0].mission.role = "coordinator";
  });
  const coordinator = f.local.read();
  await assert.rejects(
    f.manager.setLimits(
      f.id,
      { ...bounded, concurrency: 2 },
      f.contribution().limitsRevision,
    ),
    /one execution slot/,
  );
  assert.deepEqual(f.local.read(), coordinator);
  assert.equal(f.calls.terminate, 0);
  assert.deepEqual(f.sealed, []);
});

test("uncertain termination and accounting never change the local cap", async (t) => {
  for (const failure of ["termination", "accounting"]) {
    await t.test(failure, async (t) => {
      const f = fixture(t);
      const before = f.local.read();
      if (failure === "termination") f.calls.stopped = false;
      else
        f.manager.node.openResourceLedger = () => ({
          state: async () => ({ reservations: [] }),
          seal: async () => {
            throw new Error("Accounting is unresolved");
          },
          close() {},
        });
      await assert.rejects(
        f.manager.setLimits(f.id, bounded, null),
        /unconfirmed/,
      );
      assert.deepEqual(f.local.read(), before);
      assert.equal(f.store.read(f.id).status, "recovery_required");
      assert.equal(f.store.read(f.id).session, "saved-session");
      assert.equal(f.manager.busy.has(f.id), false);
      assert.equal(f.calls.launch, 0);
    });
  }
});

test("allowance review excludes setup, login, active work and terminal contributions", async (t) => {
  const f = fixture(t);
  const before = f.local.read();
  for (const status of [
    "preparing",
    "reserving",
    "launching",
    "running",
    "waiting",
    "stopping",
    "recovery_required",
  ]) {
    f.store.update(f.id, { status });
    await assert.rejects(
      f.manager.setLimits(f.id, bounded, null),
      /Stop and recover/,
    );
    assert.deepEqual(f.local.read(), before);
  }
  f.store.update(f.id, { status: "stopped" });
  for (const auth of [
    { view: { status: "starting" } },
    { handle: {}, view: { status: "waiting" } },
  ]) {
    f.manager.authentications.set(f.id, auth);
    await assert.rejects(f.manager.setLimits(f.id, bounded, null), /sign-in/);
    assert.deepEqual(f.local.read(), before);
  }
  f.manager.authentications.clear();
  f.manager.preparations.set(f.id, {});
  await assert.rejects(f.manager.setLimits(f.id, bounded, null), /setup/);
  f.manager.preparations.clear();
  f.manager.jobs.set(f.id, {});
  await assert.rejects(
    f.manager.setLimits(f.id, bounded, null),
    /already active/,
  );
  f.manager.jobs.clear();
  for (const terminal of ["withdrawn", "revoked"]) {
    f.local.update((s) => {
      s.contributions[0].status =
        terminal === "revoked" ? "revoked" : "prepared";
      s.contributions[0].revokedAt =
        terminal === "revoked" ? new Date().toISOString() : null;
      s.contributions[0].sharedAgent.withdrawn = terminal === "withdrawn";
    });
    const terminalState = f.local.read();
    await assert.rejects(
      f.manager.setLimits(f.id, bounded, null),
      /active local contribution/,
    );
    assert.deepEqual(f.local.read(), terminalState);
  }
  assert.equal(f.calls.terminate, 0);
  assert.equal(f.calls.launch, 0);
  assert.deepEqual(f.sealed, []);
});

test("the post-stop check catches an intervening revocation without changing limits", async (t) => {
  const f = fixture(t);
  const limits = f.contribution().limits;
  f.provider.terminate = async () => {
    f.local.update((s) => {
      s.contributions[0].status = "revoked";
      s.contributions[0].revokedAt = new Date().toISOString();
    });
    return { stopped: true };
  };
  await assert.rejects(
    f.manager.setLimits(f.id, bounded, null),
    /allowance changed|active local contribution/,
  );
  assert.deepEqual(f.contribution().limits, limits);
  assert.equal(f.contribution().limitsRevision, undefined);
  assert.equal(f.contribution().status, "revoked");
  assert.equal(f.calls.launch, 0);
});

test("returning to an old cap cannot revive its consent and absent revisions retain legacy binding", async (t) => {
  const f = fixture(t);
  const original = f.contribution();
  const oldBinding = executionBinding(original);
  assert.equal(
    executionBinding({ ...original, limitsRevision: undefined }),
    oldBinding,
  );
  const now = Date.now();
  const grant = {
    id: "1".repeat(64),
    registration: original.sharedAgent.registration,
    control: "2".repeat(64),
    direction: "3".repeat(64),
    purpose: "work",
    execution: "4".repeat(64),
    generation: 1,
    consent: "5".repeat(64),
    consent_binding: oldBinding,
    sealed: false,
    revoked: false,
    turns: 10,
    charged: 0,
    reserved: 0,
    issued_ms: now,
    expires_ms: now + 60000,
    offline_ms: 60000,
  };
  const context = {
    lifecycle: { revision: grant.control, phase: "active" },
    agent: { status: "direction_assigned", direction: { id: grant.direction } },
  };
  const permissions = (contribution, g = grant) =>
    currentPermissions(
      {
        contribution,
        context,
        governance: { grants: [g] },
      },
      null,
      now,
    );
  assert.equal(permissions(original).length, 1);
  await f.manager.setLimits(f.id, bounded, null);
  const firstRevision = f.contribution().limitsRevision;
  await f.manager.setLimits(f.id, original.limits, firstRevision);
  const restored = f.contribution();
  assert.deepEqual(restored.limits, original.limits);
  assert.notEqual(restored.limitsRevision, firstRevision);
  assert.notEqual(executionBinding(restored), oldBinding);
  assert.equal(permissions(restored).length, 0);
  assert.equal(
    permissions(restored, {
      ...grant,
      consent_binding: executionBinding(restored),
    }).length,
    1,
  );
  assert.equal(f.calls.launch, 0);
});

test("cumulative allowance includes old sealed and reserved usage and never restarts the clock", () => {
  const now = 1800000000000;
  const contribution = {
    sharedAgent: { registration: "a".repeat(64) },
    limits: { mode: "bounded", concurrency: 1, turns: 10, minutes: 120 },
  };
  const first = now - 90 * 60000;
  const governance = {
    grants: [
      {
        registration: contribution.sharedAgent.registration,
        consent: "old",
        issued_ms: first,
        sealed: true,
        charged: 4,
        reserved: 0,
      },
      {
        registration: contribution.sharedAgent.registration,
        consent: "later",
        issued_ms: now - 60000,
        revoked: true,
        charged: 0,
        reserved: 1,
      },
      {
        registration: contribution.sharedAgent.registration,
        consent: null,
        issued_ms: first - 60000,
        charged: 0,
        reserved: 0,
      },
      {
        registration: "b".repeat(64),
        consent: "foreign",
        issued_ms: 1,
        charged: 100,
        reserved: 100,
      },
    ],
  };
  assert.deepEqual(localAllowance(contribution, governance, now), {
    deadline: first + 120 * 60000,
    used: 5,
    remaining: 5,
    issue: null,
  });
  const larger = {
    ...contribution,
    limits: { ...contribution.limits, turns: 20, minutes: 180 },
    limitsRevision: randomUUID(),
  };
  assert.deepEqual(localAllowance(larger, governance, now), {
    deadline: first + 180 * 60000,
    used: 5,
    remaining: 15,
    issue: null,
  });
  const expired = localAllowance(
    { ...larger, limits: { ...larger.limits, minutes: 60 } },
    governance,
    now,
  );
  assert.match(expired.issue, /time cap has expired/);
  const exhausted = localAllowance(
    { ...larger, limits: { ...larger.limits, turns: 5 } },
    governance,
    now,
  );
  assert.match(exhausted.issue, /turn cap is used/);
  assert.deepEqual(
    localAllowance(
      { ...larger, limits: { mode: "unlimited", concurrency: 1 } },
      governance,
      now,
    ),
    {
      deadline: null,
      used: 5,
      remaining: null,
      issue: null,
    },
  );
  assert.equal(
    localAllowance(contribution, { grants: [] }, now).deadline,
    null,
  );
});

test("only the strict local execution API accepts allowance edits", () => {
  const request = {
    contributionId: randomUUID(),
    limits: bounded,
    expectedRevision: null,
  };
  assert.equal(
    ExecutionRequests.executionLimits.safeParse(request).success,
    true,
  );
  for (const extra of [
    { startedAt: Date.now() },
    { resetUsage: true },
    { revision: randomUUID() },
  ])
    assert.equal(
      ExecutionRequests.executionLimits.safeParse({ ...request, ...extra })
        .success,
      false,
    );
  assert.equal(
    AgentOperation.safeParse({ type: "executionLimits", ...request }).success,
    false,
  );
  assert.equal(
    ExecutionRequests.executionLimits.safeParse({
      ...request,
      limits: { ...bounded, turns: 0 },
    }).success,
    false,
  );
});
