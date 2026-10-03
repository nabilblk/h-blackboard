import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";

const binary = resolve(
  process.env.HARAKIRI_NODE_TEST_BINARY ||
    "var/node/target/debug/harakiri-node-proof",
);
const definition = {
  name: "Isolated IPC fixture",
  objective: "Preserve the local mission across restarts",
  scope: "Temporary test state only",
  criteria: ["A persisted signed message"],
};

function frame(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(bytes.length);
  return Buffer.concat([prefix, bytes]);
}

async function service(t, profile, ownerSeed = "01".repeat(32)) {
  const child = spawn(binary, ["--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let buffer = Buffer.alloc(0);
  let errors = "";
  const frames = [];
  const waiters = [];
  let exited = false;
  child.stderr.on("data", (bytes) => {
    errors += bytes;
  });
  child.stdin.on("error", () => {});
  child.stdout.on("data", (bytes) => {
    buffer = Buffer.concat([buffer, bytes]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE()) {
      const length = buffer.readUInt32BE();
      assert.ok(length <= 6 * 1024 * 1024);
      const value = JSON.parse(buffer.subarray(4, 4 + length));
      buffer = buffer.subarray(4 + length);
      if (waiters.length) waiters.shift()(value);
      else frames.push(value);
    }
  });
  const exit = once(child, "exit").then(([code, signal]) => {
    exited = true;
    for (const resolve of waiters.splice(0)) resolve(null);
    return { code, signal, errors };
  });
  child.stdin.write(
    frame({
      version: 1,
      profile,
      owner_seed: ownerSeed,
      transport_seed: "02".repeat(32),
    }),
  );
  return {
    child,
    exit,
    next: () =>
      frames.length
        ? Promise.resolve(frames.shift())
        : exited
          ? Promise.resolve(null)
          : new Promise((resolve) => waiters.push(resolve)),
    send: (value) => child.stdin.write(frame(value)),
  };
}

async function profile(t) {
  const directory = await mkdtemp(join(tmpdir(), "hb-node-ipc-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test(
  "packaged IPC preserves signed local work and identity with networking disabled",
  { timeout: 15000 },
  async (t) => {
    const directory = await profile(t);
    const node = await service(t, directory);
    const hello = await node.next();
    assert.equal(hello.network, "disabled");
    assert.equal(hello.execution, "unavailable");
    node.send({ id: 1, command: { type: "create_mission", definition } });
    const created = await node.next();
    assert.equal(created.ok, true);
    node.send({
      id: 2,
      command: {
        type: "post_message",
        mission: created.value.mission,
        text: "One durable direction",
      },
    });
    assert.equal((await node.next()).ok, true);
    node.send({ id: 3, command: { type: "shutdown" } });
    assert.equal((await node.next()).ok, true);
    assert.equal((await node.exit).code, 0);

    const restarted = await service(t, directory);
    assert.deepEqual((await restarted.next()).identity, hello.identity);
    const bytes = frame({ id: 4, command: { type: "state" } });
    for (const byte of bytes) restarted.child.stdin.write(Buffer.from([byte]));
    const state = await restarted.next();
    assert.equal(state.value[0].id, created.value.mission);
    assert.equal(state.value[0].event_count, 2);
    assert.equal(state.value[0].state, "preparing");
    restarted.child.stdin.end();
    assert.equal((await restarted.exit).code, 0);
    const identity = await readFile(join(directory, "identity.json"), "utf8");
    assert.ok(!identity.includes("01".repeat(32)));
  },
);

test(
  "one writer per profile; changing its key does not silently replace its identity",
  { timeout: 15000 },
  async (t) => {
    const directory = await profile(t);
    const first = await service(t, directory);
    assert.equal((await first.next()).ready, true);
    const second = await service(t, directory);
    assert.equal((await second.exit).code, 1);
    first.child.stdin.end();
    assert.equal((await first.exit).code, 0);
    const before = await readFile(join(directory, "identity.json"));
    const wrongKey = await service(t, directory, "03".repeat(32));
    assert.equal((await wrongKey.exit).code, 1);
    assert.deepEqual(await readFile(join(directory, "identity.json")), before);
  },
);

test(
  "IPC rejects arbitrary signing, launch, paths and unknown fields without echoing input",
  { timeout: 15000 },
  async (t) => {
    for (const command of [
      { type: "sign", bytes: "private-fixture-marker" },
      { type: "launch", executable: "private-fixture-marker" },
      { type: "state", path: "private-fixture-marker" },
    ]) {
      const node = await service(t, await profile(t));
      assert.equal((await node.next()).ready, true);
      node.send({ id: 1, command });
      const result = await node.exit;
      assert.equal(result.code, 1);
      assert.ok(!result.errors.includes("private-fixture-marker"));
    }
  },
);

test(
  "oversized or truncated frames fail closed before allocating their payload",
  { timeout: 15000 },
  async (t) => {
    for (const malformed of [
      Buffer.from([255, 255, 255, 255]),
      Buffer.from([0, 1]),
      Buffer.from([0, 0, 0, 3, 123]),
    ]) {
      const node = await service(t, await profile(t));
      assert.equal((await node.next()).ready, true);
      node.child.stdin.end(malformed);
      assert.equal((await node.exit).code, 1);
    }
  },
);
