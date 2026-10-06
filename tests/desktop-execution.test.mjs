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
import { executionDiagnostics } from "../desktop/execution/diagnostics.mjs";
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
  provider.vm = async () => ({ running: false });
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
