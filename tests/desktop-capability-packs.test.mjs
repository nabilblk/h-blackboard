import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { executionFixture } from "./helpers/local-execution.mjs";
import { executionBinding } from "../desktop/execution/permissions.mjs";
import { Requests } from "../desktop/model.mjs";
import { AgentOperation } from "../desktop/node-service.mjs";
import { effectiveConfiguration } from "../desktop/execution/provenance.mjs";
import { readGuidance } from "../desktop/execution/guidance.mjs";
import { guestTools } from "../desktop/execution/tools.mjs";
import { authoringPack } from "../shared/authoring-packs.mjs";

test("old and new preparations are generic; web tools require an explicit choice", (t) => {
  const f = executionFixture(t);
  assert.equal(f.contribution().capabilityPack, "general");
  const input = {
    reviewId: f.id,
    workspaceChoiceId: randomUUID(),
    runtime: "grok",
    limits: { mode: "unlimited", concurrency: 1 },
  };
  assert.equal(Requests.prepare.parse(input).capabilityPack, "general");
  assert.equal(
    Requests.prepare.parse({ ...input, capabilityPack: "web-3d" })
      .capabilityPack,
    "web-3d",
  );
  assert.throws(() =>
    Requests.prepare.parse({ ...input, capabilityPack: "custom-download" }),
  );
  assert.equal(
    executionBinding(f.contribution()),
    executionBinding({ ...f.contribution(), capabilityPack: undefined }),
  );
  assert.notEqual(
    executionBinding(f.contribution()),
    executionBinding({ ...f.contribution(), capabilityPack: "web-3d" }),
  );
  assert.equal(
    AgentOperation.safeParse({
      type: "executionCapabilities",
      capabilityPack: "web-3d",
    }).success,
    false,
  );
});

test("changing toolkit preserves session/network, starts no model and never revives old consent", async (t) => {
  const f = executionFixture(t),
    before = executionBinding(f.contribution());
  const policy = f.store.read(f.id).policy;
  await f.manager.setCapabilityPack(f.id, "web-3d", null);
  const revision = f.contribution().capabilityRevision;
  assert.ok(revision);
  assert.equal(f.contribution().capabilityPack, "web-3d");
  assert.equal(f.contribution().networkAccess, "restricted");
  assert.equal(f.store.read(f.id).policy, policy);
  assert.equal(f.store.read(f.id).session, "saved-session");
  assert.equal(f.calls.launch, 0);
  await assert.rejects(
    f.manager.setCapabilityPack(f.id, "general", null),
    /changed/,
  );
  await f.manager.setCapabilityPack(f.id, "general", revision);
  assert.notEqual(f.contribution().capabilityRevision, revision);
  assert.notEqual(executionBinding(f.contribution()), before);
  const prepares = f.calls.prepare;
  await f.manager.setCapabilityPack(
    f.id,
    "general",
    f.contribution().capabilityRevision,
  );
  assert.equal(f.calls.prepare, prepares);
});

test("running, uncertain or authenticating environments cannot change toolkit", async (t) => {
  const f = executionFixture(t);
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
      f.manager.setCapabilityPack(f.id, "web-3d", null),
      /Stop and recover/,
    );
  }
  f.store.update(f.id, { status: "stopped" });
  f.calls.stopped = false;
  await assert.rejects(
    f.manager.setCapabilityPack(f.id, "web-3d", null),
    /unconfirmed/,
  );
  assert.equal(f.contribution().capabilityPack, "general");
  f.calls.stopped = true;
  f.manager.authentications.set(f.id, {
    handle: {},
    view: { status: "waiting" },
  });
  await assert.rejects(
    f.manager.setCapabilityPack(f.id, "web-3d", null),
    /sign-in/,
  );
  assert.equal(f.calls.prepare, 0);
});

test("an interrupted toolkit preparation retains files/session and cannot launch", async (t) => {
  const f = executionFixture(t);
  f.calls.fail = true;
  await assert.rejects(
    f.manager.setCapabilityPack(f.id, "web-3d", null),
    /Provisioning interrupted/,
  );
  assert.equal(f.contribution().capabilityPack, "web-3d");
  assert.equal(f.store.read(f.id).status, "failed");
  assert.equal(f.store.read(f.id).session, "saved-session");
  await assert.rejects(f.manager.start(f.id, "a".repeat(64)), /Prepare/);
  f.calls.fail = false;
  await f.manager.prepare(f.id);
  assert.equal(f.store.read(f.id).status, "ready");
  assert.equal(f.calls.launch, 0);
});

test("core guidance and tool descriptions do not prescribe a web stack; provenance records selection", () => {
  assert.doesNotMatch(readGuidance("artifacts").content, /Three\.js|esbuild/);
  assert.doesNotMatch(
    JSON.stringify(guestTools()),
    /prepared web-artifact|includes Node/,
  );
  for (const runtime of ["grok", "claude", "codex"]) {
    const core = effectiveConfiguration({
      runtime,
      prompt: "test",
      guide: "test",
    });
    assert.equal(core.buildkit, null);
    const web = effectiveConfiguration({
      runtime,
      prompt: "test",
      guide: "test",
      capabilityPack: "web-3d",
    });
    assert.equal(web.buildkit, "web-artifact-1");
    assert.equal(web.networkAccess, "restricted");
  }
  assert.throws(() => authoringPack("__proto__"));
});
