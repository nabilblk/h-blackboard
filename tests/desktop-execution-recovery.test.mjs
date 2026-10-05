import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ExecutionStore } from "../desktop/execution/store.mjs";
import { ExecutionManager } from "../desktop/execution/manager.mjs";
import {
  newRecord,
  POLICY_DIGEST,
  POLICY_DIGESTS,
} from "../desktop/execution/contract.mjs";

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
function fixture(t, runtime = "grok") {
  const directory = mkdtempSync(join(tmpdir(), "hb-recovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const id = randomUUID();
  const contribution = {
    id,
    runtime,
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
  provider.policies = POLICY_DIGESTS;
  store.write({ ...newRecord(id, Date.now(), runtime), status: "ready" });
  const manager = new ExecutionManager({ store, provider, node, pollMs: 10 });
  return { id, manager, store, flags, grant, reservations, provider, node };
}

test("sign-in cancellation during guest boot waits for and stops that login, without recording its secrets", async (t) => {
  const f = fixture(t);
  const boot = deferred(),
    login = deferred();
  let started = false,
    cancelled = 0;
  f.provider.authenticate = async ({ onOutput }) => {
    started = true;
    await boot.promise;
    onOutput("Visit https://accounts.x.ai/device?private-code=not-for-history");
    return {
      done: login.promise,
      input() {},
      cancel: async () => {
        cancelled++;
        login.reject(new Error("Cancelled"));
      },
    };
  };
  const start = f.manager.signIn(f.id);
  await waitFor(() => started);
  const stop = f.manager.cancelLogin(f.id);
  boot.resolve();
  await Promise.all([start, stop]);
  assert.equal(cancelled, 1);
  assert.equal(f.manager.busy.has(f.id), false);
  assert.equal(f.manager.authentications.get(f.id).view.status, "cancelled");
  assert.deepEqual(f.manager.authentications.get(f.id).view.urls, []);
  assert.ok(f.flags.stops > 0);
  assert.doesNotMatch(
    JSON.stringify(f.store.read(f.id)),
    /private-code|not-for-history/,
  );
  assert.equal(f.flags.launches, 0);
});

test("successful guest sign-in frees capacity and does not grant or start work", async (t) => {
  const f = fixture(t);
  const login = deferred();
  f.provider.authenticate = async ({ onOutput }) => {
    onOutput("Open https://accounts.x.ai/device?private-code=guest-only\n");
    onOutput("Waiting for authorization…");
    return {
      done: login.promise,
      input() {},
      cancel: async () => {},
    };
  };
  f.provider.inspect = async () => ({ authenticated: true, stopped: true });
  await f.manager.signIn(f.id);
  const waiting = f.manager.authentications.get(f.id).view;
  assert.equal(waiting.status, "waiting");
  assert.doesNotMatch(waiting.text, /Starting provider/);
  assert.match(waiting.text, /guest-only\nWaiting for authorization/);
  assert.deepEqual(waiting.urls, [
    "https://accounts.x.ai/device?private-code=guest-only",
  ]);
  login.resolve();
  await waitFor(() => !f.manager.busy.has(f.id));
  assert.equal(f.store.read(f.id).status, "ready");
  assert.equal(f.manager.authentications.get(f.id).view.status, "complete");
  assert.equal(f.flags.launches, 0);
  assert.equal(f.flags.stops, 1);
  assert.equal(f.reservations.length, 0);
  assert.doesNotMatch(JSON.stringify(f.store.read(f.id)), /guest-only/);
});

test("failed sign-in with unconfirmed VM termination stays recovery-required", async (t) => {
  const f = fixture(t);
  const login = deferred();
  f.flags.unknownStop = true;
  f.provider.authenticate = async () => ({
    done: login.promise,
    input() {},
    cancel: async () => {},
  });
  await f.manager.signIn(f.id);
  login.reject(new Error("Provider rejected login"));
  await waitFor(() => !f.manager.busy.has(f.id));
  assert.equal(f.store.read(f.id).status, "recovery_required");
  assert.equal(f.manager.authentications.get(f.id).view.status, "failed");
});

for (const runtime of ["claude", "codex"])
  test(`${runtime} uses its own policy; changed consent cannot reserve or launch`, async (t) => {
    const f = fixture(t, runtime);
    const correct = f.store.read(f.id).policy;
    assert.equal(correct, POLICY_DIGESTS[runtime]);
    f.store.update(f.id, { policy: POLICY_DIGEST });
    await assert.rejects(f.manager.start(f.id, f.grant.id), /policy changed/);
    assert.equal(f.reservations.length, 0);
    assert.equal(f.flags.launches, 0);
    f.store.update(f.id, { policy: correct });
    await f.manager.start(f.id, f.grant.id);
    await waitFor(() => f.flags.running);
    await f.manager.stop(f.id);
    assert.equal(f.store.read(f.id).policy, correct);
    assert.equal(f.grant.charged, 1);
  });

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

test("a real-shaped receipt feed stays idle until a human criterion report changes", async (t) => {
  const f = fixture(t);
  f.grant.purpose = "work";
  const messages = [];
  const criteria = [];
  let unread = 0;
  f.node.openAgentChannel = () => ({
    close() {},
    request: async (op) => {
      if (op.type === "context")
        return {
          agent: { identity: { author: "own" } },
          conversations: [{ id: "main", unread, writable: true }],
        };
      if (op.type === "messages") return { items: messages };
      if (op.type === "governance") return { criteria };
      if (op.type === "workstreams") return [{ id: "stream", unread }];
      return {};
    },
  });
  const ledger = f.node.openResourceLedger();
  const receipt = ledger.receipt.bind(ledger);
  ledger.receipt = async (...args) => {
    const result = await receipt(...args);
    messages.push({
      id: `receipt-${++unread}`,
      author: "host-human",
      kind: "governance",
    });
    return result;
  };
  f.provider.launch = async ({ onSession }) => {
    f.flags.running = true;
    f.flags.launches++;
    await onSession("saved-session");
    return { done: Promise.resolve({}) };
  };
  await f.manager.start(f.id, f.grant.id);
  await waitFor(() => f.store.read(f.id).status === "waiting");
  await delay(80);
  assert.equal(
    f.flags.launches,
    1,
    "accounting must not buy another model turn",
  );
  criteria.push({
    index: 0,
    author: "human",
    report: "correction",
    met: false,
  });
  await waitFor(
    () => f.flags.launches === 2 && f.store.read(f.id).status === "waiting",
  );
  await delay(80);
  assert.equal(f.flags.launches, 2);
  await f.manager.stop(f.id);
  assert.equal(f.grant.charged, 2);
  assert.equal(f.flags.running, false);
});

test("quit stops an idle prepared VM and preserves environment readiness separately", async (t) => {
  const f = fixture(t);
  f.flags.running = true;
  await f.manager.close();
  assert.equal(f.flags.running, false);
  assert.equal(f.flags.launches, 0);
  assert.equal(f.store.read(f.id).status, "ready");
});

test("closing before guest sign-in preserves the outstanding login step", async (t) => {
  const f = fixture(t);
  f.store.update(f.id, {
    status: "login_required",
    reason: "Sign in to Grok inside this environment.",
  });
  await f.manager.close();
  assert.equal(f.store.read(f.id).status, "login_required");
  assert.match(f.store.read(f.id).reason, /Sign in/);
  assert.equal(f.flags.launches, 0);
});

test("cancelling setup during its authority check never begins provisioning", async (t) => {
  const f = fixture(t),
    context = deferred();
  const original = f.node.executionContext;
  let prepared = false;
  f.node.executionContext = async (...args) => {
    await context.promise;
    return original(...args);
  };
  f.provider.prepare = async () => {
    prepared = true;
    return { authenticated: false };
  };
  const start = f.manager.prepare(f.id);
  const failure = assert.rejects(start, /abort/i);
  await waitFor(() => f.manager.preparations.has(f.id));
  const cancel = f.manager.cancelSetup(f.id);
  context.resolve();
  await Promise.all([failure, cancel]);
  assert.equal(prepared, false);
  assert.equal(f.manager.busy.has(f.id), false);
  assert.equal(f.flags.running, false);
});

test("direction interruption survives shutdown and resumes only with a fresh consented generation", async (t) => {
  const { DirectionChanged } =
    await import("../desktop/execution/permissions.mjs");
  const f = fixture(t);
  f.grant.purpose = "work";
  const original = f.node.executionContext;
  let changed = false;
  f.node.executionContext = async (id, grant) => {
    if (changed && grant === "c".repeat(64))
      throw new DirectionChanged("1".repeat(64), "2".repeat(64));
    return original(id, grant);
  };
  await f.manager.start(f.id, f.grant.id);
  await waitFor(() => f.flags.running);
  changed = true;
  await waitFor(() => f.store.read(f.id).status === "stopped");
  assert.equal(f.store.read(f.id).interruption.code, "direction_changed");
  assert.equal(f.store.read(f.id).session, "saved-session");
  assert.equal(f.reservations[0].stopped, true);
  assert.equal(f.flags.launches, 1);
  await f.manager.close();
  assert.match(f.store.read(f.id).reason, /Direction changed/);
  const resumed = new ExecutionManager({
    store: f.store,
    provider: f.provider,
    node: f.node,
    pollMs: 10,
  });
  Object.assign(f.grant, {
    id: "3".repeat(64),
    generation: 2,
    sealed: false,
    charged: 0,
    reserved: 0,
    consent: null,
  });
  await assert.rejects(resumed.start(f.id, f.grant.id), /consent|expired/);
  assert.equal(f.flags.launches, 1);
  f.grant.consent = "fresh-local-approval";
  const resume = f.provider.resume.bind(f.provider);
  f.provider.resume = (request) => {
    assert.equal(request.session, "saved-session");
    return resume(request);
  };
  await resumed.start(f.id, f.grant.id);
  await waitFor(() => f.flags.launches === 2);
  assert.equal(f.store.read(f.id).interruption, null);
  await resumed.stop(f.id);
  assert.equal(f.reservations.length, 2);
  assert.ok(f.reservations.every((r) => r.stopped && r.used === 1));
});
