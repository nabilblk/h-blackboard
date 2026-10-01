import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  readdirSync,
  renameSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DesktopStore } from "../desktop/store.mjs";
import { ContributorService } from "../desktop/service.mjs";
import { executionReadiness, REVIEW_TTL_MS } from "../desktop/model.mjs";
import {
  APP_URL,
  CONTENT_SECURITY_POLICY,
  isTrustedFrame,
  staticAsset,
} from "../desktop/security.mjs";

function fixture(t) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "harakiri-desktop-test-")),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const parent = join(directory, "work");
  mkdirSync(parent);
  const store = new DesktopStore(join(directory, "state"));
  let clock = Date.now();
  let chosen = parent;
  let role = "agent";
  const revealed = [];
  const service = new ContributorService({
    store,
    now: () => clock,
    chooseDirectory: async () => chosen,
    revealDirectory: async (path) => {
      revealed.push(path);
    },
    inspect: async () => ({
      origin: "https://board.example",
      missionId: "mi_fixture",
      name: "Isolated test mission",
      role,
      inspectedAt: new Date(clock).toISOString(),
    }),
  });
  return {
    directory,
    parent,
    store,
    service,
    revealed,
    advance: (ms) => {
      clock += ms;
    },
    choose: (path) => {
      chosen = path;
    },
    role: (value) => {
      role = value;
    },
    async preparation(overrides = {}) {
      const review = await service.handle("inspect", {
        invitation: "never-persist-this-token",
      });
      const choice = await service.handle("chooseWorkspace", {});
      return {
        reviewId: review.reviewId,
        workspaceChoiceId: choice.id,
        runtime: "grok",
        limits: { mode: "bounded", concurrency: 2, turns: 20, minutes: 60 },
        ...overrides,
      };
    },
  };
}

test("a prepared contribution persists ownership, exact local terms and an empty dedicated workspace", async (t) => {
  const f = fixture(t);
  const input = await f.preparation();
  const state = await f.service.handle("prepare", input);
  const item = state.contributions[0];
  assert.equal(item.status, "prepared");
  assert.equal(item.runtime, "grok");
  assert.deepEqual(item.limits, input.limits);
  assert.equal(item.contributorId, state.contributor.id);
  assert.equal(item.deviceId, state.device.id);
  assert.equal(item.workspace, join(f.parent, `harakiri-${item.id}`));
  assert.deepEqual(readdirSync(item.workspace), []);
  assert.equal(statSync(item.workspace).mode & 0o777, 0o700);
  assert.equal(statSync(f.store.file).mode & 0o777, 0o600);
  assert.equal(item.execution.allowed, false);
  assert.equal("workspaceIdentity" in item, false);
  assert.equal(state.activity[0].type, "contribution_prepared");
  const restarted = new DesktopStore(f.store.directory);
  assert.equal(restarted.read().contributions[0].id, item.id);
  assert.equal(restarted.read().contributor.id, state.contributor.id);
  assert.equal(restarted.read().device.id, state.device.id);
  assert.equal(
    readFileSync(f.store.file, "utf8").includes("never-persist-this-token"),
    false,
  );
  assert.equal(readFileSync(f.store.file, "utf8").includes("reviewId"), false);
  assert.deepEqual(readdirSync(f.store.directory), ["contributions.json"]);
});

test("remote-shaped requests cannot set paths, ownership, commands, providers or hidden permissions", async (t) => {
  const f = fixture(t);
  const input = await f.preparation();
  for (const extra of [
    { workspace: "/Users/other" },
    { contributorId: randomUUID() },
    { deviceId: randomUUID() },
    { command: "sh arbitrary.sh" },
    { provider: "local-process" },
    { permissions: "full-access" },
    { status: "running" },
    { mission: { origin: "https://attacker.example" } },
  ])
    await assert.rejects(
      f.service.handle("prepare", { ...input, ...extra }),
      /Invalid desktop request/,
    );
  await assert.rejects(
    f.service.handle("prepare", {
      ...input,
      limits: { ...input.limits, permissions: "full-access" },
    }),
    /Invalid desktop request/,
  );
  for (const method of [
    "execute",
    "spawn",
    "resume",
    "run",
    "fetch",
    "writeFile",
    "setPolicy",
    "constructor",
    "__proto__",
  ])
    await assert.rejects(f.service.handle(method, {}));
  assert.equal(f.store.read().contributions.length, 0);
  assert.deepEqual(readdirSync(f.parent), []);
});

test("workspaces and reviews require live local capabilities and cannot be replayed", async (t) => {
  const f = fixture(t);
  const input = await f.preparation();
  await assert.rejects(
    f.service.handle("prepare", { ...input, workspaceChoiceId: randomUUID() }),
    /expired/,
  );
  await assert.rejects(
    f.service.handle("prepare", { ...input, reviewId: randomUUID() }),
    /expired/,
  );
  await f.service.handle("prepare", input);
  await assert.rejects(f.service.handle("prepare", input), /expired/);
  const next = await f.preparation();
  f.advance(REVIEW_TTL_MS + 1);
  await assert.rejects(f.service.handle("prepare", next), /expired/);
});

test("local consent can be revoked idempotently, survives restart and preserves all workspace files", async (t) => {
  const f = fixture(t);
  const {
    contributions: [item],
  } = await f.service.handle("prepare", await f.preparation());
  writeFileSync(
    join(item.workspace, "result.txt"),
    "Keep the contributor's work.",
  );
  let next = await f.service.handle("revoke", { contributionId: item.id });
  assert.equal(next.contributions[0].status, "revoked");
  assert.ok(next.contributions[0].revokedAt);
  assert.equal(next.contributions[0].execution.allowed, false);
  assert.ok(
    next.contributions[0].execution.blockers.some(
      (entry) => entry.code === "consent_revoked",
    ),
  );
  next = await f.service.handle("revoke", { contributionId: item.id });
  assert.equal(
    next.activity.filter((entry) => entry.type === "consent_revoked").length,
    1,
  );
  assert.equal(
    new DesktopStore(f.store.directory).read().contributions[0].status,
    "revoked",
  );
  assert.equal(
    readFileSync(join(item.workspace, "result.txt"), "utf8"),
    "Keep the contributor's work.",
  );
  await f.service.handle("reveal", { contributionId: item.id });
  assert.deepEqual(f.revealed, [item.workspace]);
  await assert.rejects(
    f.service.handle("revoke", { contributionId: randomUUID() }),
    /not found/,
  );
  await assert.rejects(
    f.service.handle("resume", { contributionId: item.id }),
    /Unsupported/,
  );
});

test("allowance validation rejects ambiguous, fractional, excessive and negative budgets", async (t) => {
  const f = fixture(t);
  const input = await f.preparation();
  for (const limits of [
    { mode: "bounded", concurrency: 0, turns: 20, minutes: 60 },
    { mode: "bounded", concurrency: 33, turns: 20, minutes: 60 },
    { mode: "bounded", concurrency: 1.5, turns: 20, minutes: 60 },
    { mode: "bounded", concurrency: 1, turns: -1, minutes: 60 },
    { mode: "bounded", concurrency: 1, turns: 10001, minutes: 60 },
    { mode: "bounded", concurrency: 1, turns: 20, minutes: 0 },
    { mode: "bounded", concurrency: 1, turns: 20, minutes: 10081 },
    { mode: "unlimited", concurrency: 1, turns: 10 },
    { mode: "unlimited", concurrency: "1" },
    { mode: "unlimited" },
  ])
    await assert.rejects(
      f.service.handle("prepare", { ...input, limits }),
      /Invalid desktop request/,
    );
  const result = await f.service.handle("prepare", {
    ...input,
    limits: { mode: "unlimited", concurrency: 3 },
  });
  assert.deepEqual(result.contributions[0].limits, {
    mode: "unlimited",
    concurrency: 3,
  });
  assert.equal(result.contributions[0].execution.allowed, false);
});

test("a coordinator invitation cannot turn into several coordinators", async (t) => {
  const f = fixture(t);
  f.role("coordinator");
  const input = await f.preparation();
  await assert.rejects(f.service.handle("prepare", input), /one coordinator/);
  const result = await f.service.handle("prepare", {
    ...input,
    limits: { ...input.limits, concurrency: 1 },
  });
  assert.equal(result.contributions[0].mission.role, "coordinator");
});

test("cancelled pickers create no grants or files and private app data cannot be chosen", async (t) => {
  const f = fixture(t);
  f.choose(null);
  assert.equal(await f.service.handle("chooseWorkspace", {}), null);
  f.choose(f.store.directory);
  await assert.rejects(f.service.handle("chooseWorkspace", {}), /private data/);
  assert.deepEqual(readdirSync(f.parent), []);
});

test("a replaced parent or workspace cannot redirect a saved native folder grant", async (t) => {
  const f = fixture(t);
  const input = await f.preparation();
  const other = join(f.directory, "other");
  mkdirSync(other);
  renameSync(f.parent, `${f.parent}-original`);
  symlinkSync(other, f.parent);
  await assert.rejects(f.service.handle("prepare", input), /folder changed/);
  assert.deepEqual(readdirSync(other), []);
  f.choose(`${f.parent}-original`);
  const {
    contributions: [item],
  } = await f.service.handle("prepare", await f.preparation());
  renameSync(item.workspace, `${item.workspace}-original`);
  symlinkSync(other, item.workspace);
  await assert.rejects(
    f.service.handle("reveal", { contributionId: item.id }),
    /moved or replaced/,
  );
  assert.deepEqual(f.revealed, []);
});

test("replacing local terms requires a fresh review; existing preparations are never widened in place", async (t) => {
  const f = fixture(t);
  const {
    contributions: [item],
  } = await f.service.handle("prepare", await f.preparation());
  await assert.rejects(
    f.service.handle("prepare", await f.preparation()),
    /already prepared/,
  );
  await f.service.handle("revoke", { contributionId: item.id });
  const result = await f.service.handle(
    "prepare",
    await f.preparation({ limits: { mode: "unlimited", concurrency: 1 } }),
  );
  assert.notEqual(result.contributions[0].id, item.id);
  assert.notEqual(result.contributions[0].workspace, item.workspace);
  assert.equal(result.contributions[1].status, "revoked");
});

test("invalid or foreign persisted ownership fails closed without resetting the profile", async (t) => {
  const f = fixture(t);
  await f.service.handle("prepare", await f.preparation());
  const value = f.store.read();
  value.contributions[0].contributorId = randomUUID();
  const corrupt = JSON.stringify(value);
  writeFileSync(f.store.file, corrupt);
  assert.throws(() => new DesktopStore(f.store.directory), /left unchanged/);
  assert.equal(readFileSync(f.store.file, "utf8"), corrupt);
  writeFileSync(f.store.file, "{broken");
  assert.throws(() => new DesktopStore(f.store.directory), /left unchanged/);
  assert.equal(readFileSync(f.store.file, "utf8"), "{broken");
});

test("state and workspace paths are not reachable through the desktop static-file protocol", () => {
  const root = "/app/ui";
  assert.equal(staticAsset(root, APP_URL), "/app/ui/index.html");
  assert.equal(
    staticAsset(root, "harakiri://desktop/assets/main-123.js"),
    "/app/ui/assets/main-123.js",
  );
  for (const url of [
    "file:///etc/passwd",
    "https://desktop/index.html",
    "harakiri://other/index.html",
    "harakiri://user@desktop/index.html",
    "harakiri://desktop:123/index.html",
    "harakiri://desktop/../main.mjs",
    "harakiri://desktop/assets/%2f..%2fmain.mjs",
    "harakiri://desktop/assets/../../../var/secret.json",
    "harakiri://desktop/contributions.json",
    "harakiri://desktop/assets/evil.html",
    "harakiri://desktop/assets/%00.js",
  ])
    assert.throws(() => staticAsset(root, url), undefined, url);
  assert.match(CONTENT_SECURITY_POLICY, /connect-src 'none'/);
  assert.match(CONTENT_SECURITY_POLICY, /frame-src 'none'/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe-inline|unsafe-eval/);
});

test("native controls accept only the main frame of the bundled application window", () => {
  const frame = { url: APP_URL };
  const contents = { mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: contents };
  const event = { sender: contents, senderFrame: frame };
  assert.equal(isTrustedFrame(event, window), true);
  assert.equal(isTrustedFrame({ ...event, sender: {} }, window), false);
  assert.equal(
    isTrustedFrame({ ...event, senderFrame: { url: APP_URL } }, window),
    false,
  );
  for (const url of [
    "https://board.example",
    "file:///app/ui/index.html",
    "harakiri://attacker/index.html",
    "harakiri://desktop/assets/index.html",
    "about:blank",
  ]) {
    frame.url = url;
    assert.equal(isTrustedFrame(event, window), false);
  }
  frame.url = APP_URL;
  assert.equal(
    isTrustedFrame(event, { ...window, isDestroyed: () => true }),
    false,
  );
});

test("execution readiness never trusts a prepared record or a self-declared sandbox descriptor", () => {
  for (const status of ["prepared", "revoked", "running"]) {
    const result = executionReadiness({
      status,
      provider: { isolation: "vm", capabilities: { sandbox: true } },
    });
    assert.equal(result.allowed, false);
    assert.ok(
      result.blockers.some((entry) => entry.code === "isolated_execution"),
    );
    assert.ok(
      result.blockers.some((entry) => entry.code === "contributor_identity"),
    );
  }
});
