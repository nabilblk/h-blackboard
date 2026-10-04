import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NodeService } from "../../desktop/node-service.mjs";
import { secureStorage } from "../helpers/secure-storage.mjs";

const binary = resolve(
  process.env.HARAKIRI_NODE_TEST_BINARY ||
    "var/node/target/debug/harakiri-node",
);
const definition = {
  name: "Local test mission",
  objective: "Test offline preparation and recovery",
  scope: "Temporary profile only",
  criteria: ["Preserve the exact signed conversation"],
  policy: {
    coordination: "coordinated",
    participation: "private",
    budget: { mode: "unlimited" },
  },
};
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "hb-desktop-node-test-"));
  const directory = join(root, "node");
  const storage = secureStorage();
  const services = [];
  const open = () => {
    const service = new NodeService({
      directory,
      binary,
      secureStorage: storage,
    });
    services.push(service);
    return service;
  };
  t.after(async () => {
    for (const service of services) await service.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { directory, open, service: open() };
}

test("native service creates offline Preparing missions and preserves signed history through restart", async (t) => {
  const { directory, service, open } = fixture(t);
  assert.equal((await service.state()).status, "not_enrolled");
  assert.equal(existsSync(directory), false);
  await assert.rejects(
    service.handle("createMission", { definition }),
    /Create your local node/,
  );
  const enrolled = await service.handle("enroll", {});
  const { mission } = await service.handle("createMission", { definition });
  const { event } = await service.handle("postMessage", {
    mission,
    text: "Owner instruction\nAvailable offline.",
  });
  const state = await service.state();
  assert.equal(state.network, "disabled");
  assert.equal(state.execution, "unavailable");
  assert.deepEqual(state.missions[0].definition, definition);
  assert.equal(state.missions[0].state, "preparing");
  assert.equal(state.missions[0].coordinator_node, enrolled.identity.endpoint);
  const page = await service.handle("messages", { mission });
  assert.equal(page.before, null);
  assert.equal(page.items[0].id, event);
  assert.equal(page.items[0].author, enrolled.identity.owner);
  assert.equal(page.items[0].text, "Owner instruction\nAvailable offline.");
  await service.close();
  const restarted = open();
  assert.deepEqual(await restarted.state(), state);
  assert.deepEqual(await restarted.handle("messages", { mission }), page);
});

test("strict native commands reject authority, paths, unknown policy and execution requests", async (t) => {
  const { service } = fixture(t);
  await service.handle("enroll", {});
  for (const request of [
    { definition, profile: "/tmp/untrusted" },
    { definition: { ...definition, execute: true } },
    {
      definition: {
        ...definition,
        policy: { ...definition.policy, participation: "open" },
      },
    },
    {
      definition: {
        ...definition,
        policy: {
          ...definition.policy,
          budget: { mode: "unlimited", turns: 999 },
        },
      },
    },
    { definition: { ...definition, policy: undefined } },
  ])
    await assert.rejects(service.handle("createMission", request));
  await assert.rejects(
    service.handle("launch", { command: "sh" }),
    /Unknown node operation/,
  );
  await assert.rejects(
    service.handle("sign", { payload: "data" }),
    /Unknown node operation/,
  );
  assert.equal((await service.state()).missions.length, 0);
  const finite = {
    ...definition,
    policy: {
      coordination: "peer",
      participation: "approval",
      budget: {
        mode: "limited",
        turns: 10,
        concurrency: 2,
        deadline_ms: null,
        tokens: null,
        model_cost_microusd: null,
      },
    },
  };
  await service.handle("createMission", { definition: finite });
  const state = await service.state();
  assert.deepEqual(state.missions[0].definition, finite);
  assert.equal(state.missions[0].coordinator_node, null);
  const invalid = structuredClone(finite);
  invalid.policy.budget.turns = null;
  invalid.policy.budget.concurrency = null;
  await assert.rejects(
    service.handle("createMission", { definition: invalid }),
    /rejected/,
  );
  assert.equal((await service.state()).missions.length, 1);
});

test("damaged or concurrently opened profiles fail without replacing history or keys", async (t) => {
  const { directory, service, open } = fixture(t);
  await service.handle("enroll", {});
  await service.handle("createMission", { definition });
  const protectedKeys = readFileSync(join(directory, "keys.v1.enc"));
  const duplicate = open();
  await assert.rejects(duplicate.state(), /refused its profile/);
  assert.equal((await service.state()).missions.length, 1);
  await service.close();
  const identityFile = join(directory, "records/identity.json");
  writeFileSync(identityFile, "damaged identity");
  const damaged = open();
  await assert.rejects(damaged.state(), /refused its profile/);
  assert.equal(readFileSync(identityFile, "utf8"), "damaged identity");
  assert.deepEqual(readFileSync(join(directory, "keys.v1.enc")), protectedKeys);
});
