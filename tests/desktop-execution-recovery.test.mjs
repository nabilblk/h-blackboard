import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ExecutionStore } from "../desktop/execution/store.mjs";
import { ExecutionManager } from "../desktop/execution/manager.mjs";
import { newRecord, POLICY_DIGEST } from "../desktop/execution/contract.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const waitFor = async (fn) => {
  const until = Date.now() + 3000;
  while (!fn()) {
    if (Date.now() > until)
      throw new Error("Timed out waiting for execution transition");
    await delay(5);
  }
};
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "hb-recovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const id = randomUUID();
  const contribution = {
    id,
    runtime: "grok",
    sharedAgent: { registration: "a".repeat(64) },
    mission: { missionId: "b".repeat(64) },
  };
  const grant = {
    id: "c".repeat(64),
    execution: "d".repeat(64),
    generation: 1,
    purpose: "planning",
    issued_ms: Date.now(),
    expires_ms: Date.now() + 10000,
    offline_ms: 10000,
    consent: "consent",
    turns: 3,
    charged: 0,
    reserved: 0,
  };
  const reservations = [];
  const flags = {
    running: false,
    launches: 0,
    stops: 0,
    allowed: true,
    unknownStop: false,
    lostReservation: false,
    lateBoot: null,
  };
  let done;
  const ledger = {
    close() {},
    async state() {
      return { grants: [grant], reservations };
    },
    async reserve({ grant: g, nonce }) {
      const record = {
        id: (reservations.length + 1).toString(16).padStart(64, "0"),
        grant: g,
        nonce,
        receipt: null,
        used: null,
        stopped: false,
      };
      reservations.push(record);
      grant.reserved++;
      if (flags.lostReservation) throw new Error("Reservation response lost");
      return { event: record.id };
    },
    async receipt(value) {
      assert.equal(
        flags.running,
        false,
        "never free allowance while the VM is still running",
      );
      const r = reservations.find((r) => r.id === value.reservation);
      Object.assign(r, value, { receipt: "f".repeat(64) });
      grant.reserved--;
      grant.charged += value.used;
      return { event: r.receipt };
    },
    async seal() {
      assert.ok(reservations.every((r) => r.receipt && r.stopped));
      grant.sealed = true;
    },
  };
  const node = {
    contributors: {
      store: { read: () => ({ contributions: [contribution] }) },
    },
    async executionContext(_id, g) {
      if (!flags.allowed) throw new Error("Mission paused");
      return { contribution, grant: g ? grant : undefined };
    },
    openResourceLedger: () => ledger,
    openAgentChannel: () => ({ close() {}, request: async () => ({}) }),
  };
  const provider = {
    version: 2,
    policy: POLICY_DIGEST,
    prepare: async () => ({ authenticated: true }),
    login() {},
    inspect() {},
    async launch({ onSession }) {
      if (flags.lateBoot) await flags.lateBoot.promise;
      flags.running = true;
      flags.launches++;
      await onSession("saved-session");
      done = deferred();
      return { done: done.promise };
    },
    resume(request) {
      return this.launch(request);
    },
    interrupt: async () => {},
    async terminate() {
      flags.stops++;
      if (flags.unknownStop) throw new Error("Cannot verify VM termination");
      flags.running = false;
      done?.reject(new Error("Stopped"));
      return { stopped: true };
    },
    checkpoint() {},
    usage() {
      return { turns: 1 };
    },
    exportFiles() {},
    importFiles() {},
  };
  const store = new ExecutionStore(directory);
  store.write({ ...newRecord(id), status: "ready" });
  const manager = new ExecutionManager({ store, provider, node, pollMs: 10 });
  return { id, manager, store, flags, grant, reservations, provider, node };
}

test("a lost reservation response is recovered by durable nonce without a free turn", async (t) => {
  const f = fixture(t);
  f.flags.lostReservation = true;
  await f.manager.start(f.id, f.grant.id);
  await waitFor(() => f.store.read(f.id).status === "stopped");
  assert.equal(f.flags.launches, 0);
  assert.equal(f.reservations.length, 1);
  assert.equal(f.reservations[0].used, 0);
  assert.equal(f.grant.sealed, true);
});

test("Stop fences delayed VM startup before releasing the reservation", async (t) => {
  const f = fixture(t);
  f.flags.lateBoot = deferred();
  await f.manager.start(f.id, f.grant.id);
  await waitFor(() => f.store.read(f.id).dispatched);
  const stopping = f.manager.stop(f.id);
  await delay(10);
  assert.equal(f.flags.stops, 0);
  assert.equal(f.reservations[0].receipt, null);
  f.flags.lateBoot.resolve();
  await stopping;
  assert.equal(f.flags.running, false);
  assert.equal(f.store.read(f.id).status, "stopped");
  assert.equal(f.reservations[0].used, 1);
  await assert.rejects(f.manager.start(f.id, f.grant.id), /fresh permission/);
});

test("pause interrupts execution; failed termination retains allowance until confirmed recovery", async (t) => {
  const f = fixture(t);
  await f.manager.start(f.id, f.grant.id);
  await waitFor(() => f.flags.running);
  f.flags.unknownStop = true;
  f.flags.allowed = false;
  await waitFor(() => f.store.read(f.id).status === "recovery_required");
  assert.equal(f.grant.reserved, 1);
  assert.equal(f.reservations[0].receipt, null);
  f.flags.unknownStop = false;
  await f.manager.stop(f.id);
  assert.equal(f.store.read(f.id).status, "stopped");
  assert.equal(f.grant.charged, 1);
  assert.equal(f.grant.reserved, 0);
});

test("restart after dispatch charges uncertainty, proves termination and never relaunches automatically", async (t) => {
  const f = fixture(t);
  const nonce = "1".repeat(64);
  f.reservations.push({
    id: "e".repeat(64),
    grant: f.grant.id,
    nonce,
    receipt: null,
  });
  f.flags.running = true;
  f.grant.reserved = 1;
  f.store.update(f.id, {
    status: "launching",
    grant: f.grant.id,
    nonce,
    dispatched: true,
  });
  await f.manager.recover();
  assert.equal(f.flags.launches, 0);
  assert.equal(f.flags.running, false);
  assert.equal(f.reservations[0].used, 1);
  assert.equal(f.store.read(f.id).status, "stopped");
});

test("a lost receipt response cannot charge a completed turn twice", async (t) => {
  const f = fixture(t);
  const ledger = f.node.openResourceLedger();
  const receipt = ledger.receipt.bind(ledger);
  ledger.receipt = async (...args) => {
    await receipt(...args);
    throw new Error("Receipt acknowledgment lost");
  };
  f.provider.launch = async ({ onSession }) => {
    f.flags.running = true;
    await onSession("one-session");
    return { done: Promise.resolve({}) };
  };
  await f.manager.start(f.id, f.grant.id);
  await waitFor(() => f.store.read(f.id).status === "stopped");
  assert.equal(f.grant.charged, 1);
  assert.equal(f.grant.reserved, 0);
  assert.equal(f.grant.sealed, true);
});

test("peer messages arriving during a turn wake saved work; own messages do not spin the model", async (t) => {
  const f = fixture(t);
  f.grant.purpose = "work";
  f.grant.turns = 3;
  const messages = [];
  const completions = [];
  f.node.openAgentChannel = () => ({
    close() {},
    request: async (op) => {
      if (op.type === "context")
        return { agent: { identity: { author: "own" } } };
      if (op.type === "messages") return { items: messages };
      return {};
    },
  });
  f.provider.launch = async ({ onSession, session }) => {
    f.flags.running = true;
    f.flags.launches++;
    if (f.flags.launches > 1) assert.equal(session, "saved-session");
    await onSession("saved-session");
    const completed = deferred();
    completions.push(completed);
    return { done: completed.promise };
  };
  await f.manager.start(f.id, f.grant.id);
  await waitFor(() => completions.length === 1);
  messages.push({ author: "own", text: "Published progress" });
  completions[0].resolve({});
  await waitFor(() => f.store.read(f.id).status === "waiting");
  await delay(60);
  assert.equal(f.flags.launches, 1);
  messages.push({ author: "peer", text: "Please inspect a new finding" });
  await waitFor(() => completions.length === 2);
  messages.push({
    author: "peer",
    text: "Another instruction arrived while working",
  });
  completions[1].resolve({});
  await waitFor(() => completions.length === 3);
  completions[2].resolve({});
  await waitFor(() => f.store.read(f.id).status === "stopped");
  assert.equal(f.grant.charged, 3);
});

test("quit stops an idle prepared VM as well as active jobs", async (t) => {
  const f = fixture(t);
  f.flags.running = true;
  await f.manager.close();
  assert.equal(f.flags.running, false);
  assert.equal(f.flags.launches, 0);
  assert.equal(f.store.read(f.id).status, "stopped");
});
