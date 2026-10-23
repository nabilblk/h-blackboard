import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  newRecord,
  permissionLease,
  validateProvider,
  ExecutionRequests,
} from "../desktop/execution/contract.mjs";
import { ExecutionStore } from "../desktop/execution/store.mjs";
import { LimaProvider } from "../desktop/execution/lima.mjs";
import {
  executionDiagnostics,
  retainedDiagnosticEvents,
} from "../desktop/execution/diagnostics.mjs";
import {
  exportWorkspace,
  readImportFiles,
} from "../desktop/execution/files.mjs";

test("shareable execution diagnostics only export bounded structured facts", () => {
  const diagnostic = executionDiagnostics({
    observedAt: 1000,
    capacity: 2,
    record: {
      status: "stopped",
      session: "PRIVATE SESSION",
      reason: "PRIVATE ERROR",
      transitions: Array.from({ length: 100 }, () => ({
        at: 900,
        from: "running",
        to: "stopped",
        reason: "PRIVATE PROMPT",
      })),
    },
    authentication: {
      status: "failed",
      failure: "expired",
      code: "PRIVATE CODE",
      text: "PRIVATE OUTPUT",
    },
    events: [{ type: "PRIVATE EVENT" }],
  });
  assert.equal(diagnostic.transitions.length, 80);
  assert.equal(diagnostic.savedSession, true);
  assert.equal(diagnostic.authenticationFailure, "expired");
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE/);
  assert.equal(
    executionDiagnostics({ record: { status: "UNTRUSTED" } }).status,
    "unknown",
  );
  assert.throws(() =>
    ExecutionRequests.executionDiagnostics.parse({
      contributionId: randomUUID(),
      path: "/Users",
    }),
  );
});

test("diagnostic correlations retain useful failure and usage facts without provider prose or identities", () => {
  const grant = "a".repeat(64),
    reservation = "b".repeat(64);
  const result = executionDiagnostics({
    observedAt: 2000,
    events: [
      {
        at: 1000,
        type: "tool_outcome",
        message: JSON.stringify({
          operation: "snapshot",
          outcome: "rejected",
          code: "history_incomplete",
          milliseconds: 17,
          grant,
          reservation,
          prompt: "SECRET",
          path: "/Users/PRIVATE",
        }),
      },
      {
        at: 1100,
        type: "tool_outcome",
        message: JSON.stringify({
          operation: "snapshot",
          outcome: "ok",
          milliseconds: 4,
          grant,
          reservation,
        }),
      },
      {
        at: 1200,
        type: "turn_completed",
        message: JSON.stringify({
          turns: 1,
          tokens: 110,
          inputTokens: 100,
          outputTokens: 10,
          cachedInputTokens: 80,
          providerText: "SECRET",
        }),
      },
      {
        at: 1300,
        type: "turn_completed",
        message: JSON.stringify({ turns: 1 }),
      },
      {
        at: 1400,
        type: "runtime_ready",
        message: JSON.stringify({
          milliseconds: 200,
          resumed: true,
          grant,
          reservation,
          path: "/PRIVATE",
        }),
      },
      {
        at: 1500,
        type: "dependency_wait",
        message: JSON.stringify({
          artifacts: 2,
          reviews: 1,
          grant,
          reservation,
          reason: "SECRET task text",
        }),
      },
      {
        at: 1600,
        type: "browser_check",
        message: JSON.stringify({
          control: grant,
          revision: reservation,
          grant,
          width: 390,
          height: 700,
          reducedMotion: true,
          webglDisabled: true,
          screenshot: "SECRET",
        }),
      },
    ],
  });
  assert.equal(result.outcomes[0].code, "history_incomplete");
  assert.equal(result.outcomes[0].grant, result.outcomes[1].grant);
  assert.notEqual(result.outcomes[0].grant, result.outcomes[0].reservation);
  assert.equal(result.outcomes[2].tokens, 110);
  assert.equal(result.outcomes[2].cachedInputTokens, 80);
  assert.equal(result.outcomes[3].tokens, null);
  assert.equal(result.outcomes[4].resumed, true);
  assert.equal(result.outcomes[4].milliseconds, 200);
  assert.equal(result.outcomes[5].artifacts, 2);
  assert.equal(result.outcomes[5].reviews, 1);
  assert.equal(result.outcomes[5].grant, result.outcomes[0].grant);
  assert.equal(result.outcomes[6].control, result.outcomes[0].grant);
  assert.equal(result.outcomes[6].revision, result.outcomes[0].reservation);
  assert.equal(result.outcomes[6].reducedMotion, true);
  assert.equal(result.outcomes[6].webglDisabled, true);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE|a{64}|b{64}/);
});

test("execution intent survives restart, rejects identity substitution and symlinks", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hb-execution-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const id = randomUUID();
  const store = new ExecutionStore(directory);
  store.write(newRecord(id));
  store.update(id, { status: "launching", nonce: "1".repeat(64) });
  assert.equal(new ExecutionStore(directory).read(id).status, "launching");
  const other = randomUUID();
  writeFileSync(store.path(other), JSON.stringify(store.read(id)));
  assert.throws(() => store.read(other), /identity/);
  rmSync(store.path(other));
  symlinkSync(store.path(id), store.path(other));
  assert.throws(() => store.read(other));
  assert.throws(() => store.read("../../outside"));
});

test("opt-in diagnostics cover retained rotations and tolerate interrupted final writes without exporting prose", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hb-safe-diagnostics-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const id = randomUUID();
  const events = Array.from({ length: 100 }, (_, at) =>
    JSON.stringify({
      at,
      type: "tool_outcome",
      message: JSON.stringify({
        operation: "snapshot",
        outcome: "ok",
        milliseconds: 1,
        secret: "PRIVATE",
      }),
    }),
  );
  writeFileSync(
    join(directory, `${id}.events.jsonl.previous`),
    events.join("\n") + "\n",
  );
  writeFileSync(
    join(directory, `${id}.events.jsonl`),
    JSON.stringify({ type: "agent", message: "PRIVATE prompt" }) +
      '\n{"interrupted":',
  );
  const retained = retainedDiagnosticEvents(directory, id);
  const diagnostic = executionDiagnostics({}, retained);
  assert.equal(diagnostic.outcomes.length, 100);
  assert.equal(diagnostic.coverage.files, 2);
  assert.equal(diagnostic.coverage.malformed, 1);
  assert.equal(diagnostic.coverage.completeHistory, false);
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE/);
  assert.throws(() => retainedDiagnosticEvents(directory, "../secret"));
  rmSync(join(directory, `${id}.events.jsonl`));
  symlinkSync(
    join(directory, `${id}.events.jsonl.previous`),
    join(directory, `${id}.events.jsonl`),
  );
  assert.throws(() => retainedDiagnosticEvents(directory, id), /bounded local/);
});

test("permission expiry cannot be extended by a clock rollback or later turn", () => {
  let wall = 1000,
    mono = 0;
  const grant = {
    issued_ms: 1000,
    expires_ms: 10000,
    offline_ms: 2000,
    consent: "yes",
    sealed: false,
  };
  const lease = permissionLease(grant, { wall: () => wall, mono: () => mono });
  wall = 900;
  mono = 1500;
  assert.equal(lease.remaining(), 500);
  wall = 2000;
  mono = 2100;
  assert.equal(lease.remaining(), 0);
  wall = 3000;
  assert.throws(() => permissionLease(grant, { wall: () => wall }), /expired/);
  assert.throws(
    () => permissionLease({ ...grant, issued_ms: undefined }),
    /expired/,
  );
});

test("renderer cannot supply executable, host path or provider; legacy local runner is rejected", () => {
  const contributionId = randomUUID();
  assert.throws(() =>
    ExecutionRequests.executionStart.parse({
      contributionId,
      grant: "a".repeat(64),
      command: "sh",
    }),
  );
  assert.throws(() =>
    ExecutionRequests.executionImport.parse({ contributionId, path: "/Users" }),
  );
  assert.throws(
    () => validateProvider({ isolation: "vm", resume() {} }),
    /enforcing/,
  );
});

test("VM identity stays short, collision-free for UUIDs and scoped to the desktop profile", () => {
  const one = new LimaProvider({
    directory: "/tmp/hb-vm",
    namespace: "profile one",
  });
  const two = new LimaProvider({
    directory: "/tmp/hb-vm",
    namespace: "profile two",
  });
  const id = randomUUID();
  assert.match(one.instance(id), /^h[a-z0-9]{25}$/);
  assert.notEqual(one.instance(id), two.instance(id));
  assert.notEqual(one.instance(id), one.instance(randomUUID()));
  assert.throws(() => one.instance("../../outside"));
});

test("stopped guest guidance is refreshed once and cached only after every tool file is written", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hb-tool-refresh-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const provider = new LimaProvider({ directory });
  const contribution = { id: randomUUID(), networkAccess: "restricted" };
  const files = new Map();
  const installed = [];
  let writes = 0;
  provider.guest = async (_id, [command, path, ...rest], options = {}) => {
    if (command === "install") installed.push([path, ...rest]);
    if (command === "cat") return files.get(path) ?? "";
    if (command === "tee") {
      files.set(path, String(options.input));
      writes++;
    }
    return "";
  };
  await provider.syncTools(contribution);
  assert.equal(writes, 17);
  assert.match(files.get("/opt/harakiri/agent.md"), /wait_for_work/);
  assert.match(files.get("/opt/harakiri/tools.json"), /artifact_browser/);
  assert.match(files.get("/opt/harakiri/tools.json"), /checkpoint_workspace/);
  assert.ok(files.has("/opt/harakiri/operations.py"));
  assert.ok(files.has("/opt/harakiri/project.py"));
  assert.ok(files.has("/opt/harakiri/checkpoint.py"));
  assert.ok(
    installed.some(
      (args) => args.at(-1) === "/usr/local/lib/harakiri-project.py",
    ),
    "the isolated worker must receive the refreshed project helper, not just the runtime account",
  );
  assert.match(files.get("/opt/harakiri/mcp_results.py"), /class ResultCache/);
  await provider.syncTools(contribution);
  assert.equal(writes, 17);
  assert.equal(
    JSON.parse(files.get("/opt/harakiri/capabilities.json")).pack,
    "general",
  );
  files.set("/opt/harakiri/tools.digest", "interrupted-old-install");
  await provider.syncTools(contribution);
  assert.equal(writes, 34);
  await provider.syncTools({ ...contribution, capabilityPack: "web-3d" });
  assert.equal(
    JSON.parse(files.get("/opt/harakiri/capabilities.json")).pack,
    "web-3d",
  );
  const webDigest = files.get("/opt/harakiri/tools.digest");
  await provider.syncTools(contribution);
  assert.notEqual(files.get("/opt/harakiri/tools.digest"), webDigest);
  assert.equal(
    JSON.parse(files.get("/opt/harakiri/capabilities.json")).pack,
    "general",
  );
  assert.ok(
    [...files.keys()].every((path) => path.startsWith("/opt/harakiri/")),
  );
});

test("missing environments cannot boot or export through Lima's default template", async () => {
  const provider = new LimaProvider({ directory: "/tmp/hb-missing-vm" });
  const contribution = { id: randomUUID(), runtime: "grok" };
  let commands = 0;
  provider.vm = async () => ({ exists: false, running: false });
  provider.run = async () => {
    commands++;
    throw new Error("Unexpected Lima command");
  };
  await assert.rejects(provider.boot(contribution.id), /Prepare this isolated/);
  await assert.rejects(
    provider.exportFiles({ contribution }),
    /Prepare this isolated/,
  );
  await assert.rejects(
    provider.login({ contribution }),
    /Prepare this isolated/,
  );
  assert.equal(commands, 0);
});

test("concurrent boots cannot oversubscribe local VM capacity", async () => {
  const provider = new LimaProvider({ directory: "/tmp/hb-capacity-test" });
  provider.maximum = 1;
  let running = false,
    launches = 0;
  provider.vm = async () => ({ exists: true, running: false });
  provider.run = async ([command]) => {
    if (command === "list")
      return JSON.stringify({ status: running ? "Running" : "Stopped" });
    if (command === "start") {
      await new Promise((r) => setTimeout(r, 15));
      running = true;
      launches++;
    }
  };
  const results = await Promise.allSettled([
    provider.boot(randomUUID()),
    provider.boot(randomUUID()),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(launches, 1);
});

test("queued environment setup explains capacity and can be cancelled without booting", async () => {
  const provider = new LimaProvider({
    directory: "/tmp/hb-capacity-cancel-test",
  });
  provider.maximum = 1;
  const controller = new AbortController();
  let reason = "",
    launches = 0;
  provider.vm = async () => ({ exists: true, running: false });
  provider.run = async ([command]) => {
    if (command === "list") return JSON.stringify({ status: "Running" });
    if (command === "start") launches++;
  };
  await assert.rejects(
    provider.boot(randomUUID(), {
      signal: controller.signal,
      waitForSlot: true,
      onProgress: (message) => {
        reason = message;
        controller.abort();
      },
    }),
    /abort/i,
  );
  assert.match(reason, /Waiting for a free environment slot/);
  assert.equal(launches, 0);
});

test("workspace export rejects hostile paths and imports never follow links", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hb-transfer-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = {
    path: "report/result.txt",
    base64: Buffer.from("exact bytes").toString("base64"),
  };
  for (const path of [
    "../secret",
    "/etc/passwd",
    "a/../../secret",
    "a\\secret",
    "a:b",
  ])
    await assert.rejects(
      exportWorkspace({ workspace: directory }, [{ ...file, path }]),
    );
  await assert.rejects(
    exportWorkspace({ workspace: directory }, [file, file]),
    /Duplicate/,
  );
  await assert.rejects(
    exportWorkspace({ workspace: directory }, [
      file,
      { ...file, path: "report" },
    ]),
    /Conflicting/,
  );
  const result = await exportWorkspace({ workspace: directory }, [file]);
  assert.equal(result.exported, 1);
  const imported = await readImportFiles([join(result.directory, file.path)]);
  assert.equal(imported[0].base64, file.base64);
  symlinkSync(join(result.directory, file.path), join(directory, "link"));
  await assert.rejects(
    readImportFiles([join(directory, "link")]),
    /regular files/,
  );
});

test("cancelled starts leave a serialized capacity queue promptly without releasing its predecessor", async () => {
  const provider = new LimaProvider({ directory: "/tmp/hb-capacity-order" });
  let release;
  provider.bootQueue = new Promise((r) => {
    release = r;
  });
  const controller = new AbortController();
  let boots = 0;
  provider.vm = async () => ({ exists: true, running: false });
  provider.run = async ([command]) => {
    if (command === "start") boots++;
    return "";
  };
  const cancelled = provider.boot(randomUUID(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, /abort/i);
  const later = provider.boot(randomUUID());
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(boots, 0);
  release();
  await later;
  assert.equal(boots, 1);
});
