import test from "node:test";
import assert from "node:assert/strict";
import { executionFixture } from "./helpers/local-execution.mjs";
import { NodeRequests, AgentOperation } from "../desktop/node-service.mjs";

test("updated terms require confirmed termination and settlement under the execution exclusion", async (t) => {
  const f = executionFixture(t);
  let sealed = false,
    calls = 0;
  f.provider.interrupt = async () => {};
  f.manager.node.openResourceLedger = () => ({
    state: async () => ({ reservations: [] }),
    seal: async () => {
      sealed = true;
    },
    close() {},
  });
  const before = f.contribution();
  await f.manager.withStoppedContribution(f.id, async () => {
    assert.equal(sealed, true);
    assert.equal(f.calls.terminate, 1);
    assert.equal(f.manager.busy.has(f.id), true);
    await assert.rejects(
      f.manager.exclusive(f.id, async () => {}),
      /already active/,
    );
    calls++;
  });
  assert.equal(calls, 1);
  assert.deepEqual(f.contribution(), before);
  assert.equal(f.store.read(f.id).session, "saved-session");
  assert.equal(f.calls.launch, 0);
  f.calls.stopped = false;
  await assert.rejects(
    f.manager.withStoppedContribution(f.id, async () => calls++),
    /unconfirmed/,
  );
  assert.equal(f.store.read(f.id).status, "recovery_required");
  assert.equal(calls, 1);
  assert.equal(f.manager.busy.has(f.id), false);
});

test("review cannot race login, setup, running work or withdrawn consent", async (t) => {
  const f = executionFixture(t);
  const forbidden = async () => assert.fail("review must not run");
  for (const status of [
    "preparing",
    "running",
    "stopping",
    "recovery_required",
    "waiting",
  ]) {
    f.store.update(f.id, { status });
    await assert.rejects(
      f.manager.withStoppedContribution(f.id, forbidden),
      /Stop and recover/,
    );
  }
  f.store.update(f.id, { status: "stopped" });
  f.manager.authentications.set(f.id, { view: { status: "starting" } });
  await assert.rejects(
    f.manager.withStoppedContribution(f.id, forbidden),
    /sign-in/,
  );
  f.manager.authentications.clear();
  f.manager.jobs.set(f.id, {});
  await assert.rejects(
    f.manager.withStoppedContribution(f.id, forbidden),
    /already active/,
  );
  f.manager.jobs.clear();
  f.local.update((s) => {
    s.contributions[0].sharedAgent.withdrawn = true;
  });
  await assert.rejects(
    f.manager.withStoppedContribution(f.id, forbidden),
    /active local contribution/,
  );
  assert.equal(f.calls.terminate, 0);
  assert.equal(f.calls.launch, 0);
  assert.equal(
    AgentOperation.safeParse({
      type: "renewContribution",
      contributionId: f.id,
    }).success,
    false,
  );
  assert.equal(
    NodeRequests.renewContribution.safeParse({
      reviewId: f.id,
      contributionId: f.id,
      terms: "a".repeat(64),
    }).success,
    false,
  );
});
