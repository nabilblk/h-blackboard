import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeService } from "../../desktop/node-service.mjs";
import { secureStorage } from "../helpers/secure-storage.mjs";

const network = { mode: "direct", relays: [], allow_lan: true };
const discovery = { enabled: true, lan: false, bootstrap: [], blocked: [] };
async function until(check, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.fail(message);
}

test(
  "a fresh community address reconnects existing members after cached routes expire",
  { timeout: 90000 },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hb-reconnect-")));
    const storage = secureStorage(),
      nodes = [];
    const make = (label) => {
      const n = new NodeService({
        directory: join(root, label),
        binary: resolve("var/node/target/debug/harakiri-node"),
        secureStorage: storage,
      });
      nodes.push(n);
      return n;
    };
    t.after(async () => {
      for (const n of nodes) await n.close();
      rmSync(root, { recursive: true, force: true });
    });
    let a = make("a"),
      b = make("b");
    for (const n of [a, b]) {
      await n.handle("enroll", {});
      await n.handle("configureNetwork", { config: network });
      await n.handle("configureDiscovery", { config: discovery });
    }
    const { mission } = await a.handle("createMission", {
      definition: {
        name: "Reconnect fixture",
        objective: "Retain shared work after a break",
        scope: "Isolated test",
        criteria: [],
        policy: {
          coordination: "peer",
          participation: "private",
          budget: { mode: "unlimited" },
        },
      },
    });
    const { ticket } = await a.handle("issueInvitation", { mission });
    const review = await b.handle("inspectInvitation", { ticket });
    await b.handle("requestJoin", {
      ticket,
      reviewed_mission: mission,
      reviewed_revision: review.reviewed_revision,
    });
    const author = (await b.state()).identity.owner;
    await until(
      async () =>
        (await a.handle("peers", { mission })).requests.some(
          (r) => r.author === author,
        ),
      "Join request missing",
    );
    await a.handle("decideJoin", { mission, author, admit: true });
    await until(
      async () => (await b.state()).joins.some((j) => j.status === "admitted"),
      "Admission missing",
    );
    await a.close();
    await b.close();

    // Only these temporary fixture databases are changed. Simulate the expiry
    // index after both peers were offline, without changing the machine clock.
    for (const label of ["a", "b"]) {
      const db = new DatabaseSync(join(root, label, "records", "node.sqlite"));
      db.exec("UPDATE contacts SET expires_ms=0");
      db.close();
    }
    a = make("a");
    b = make("b");
    await a.state();
    await b.state();
    const fresh = (await a.handle("discoveryState", {})).peer_ticket;
    await b.handle("configureDiscovery", {
      config: { ...discovery, bootstrap: [fresh] },
    });
    const message = await a.handle("postMessage", {
      mission,
      audience: "main",
      text: "New work after restarting both peers",
      to: null,
      thread: null,
    });
    await until(
      async () =>
        (await b.handle("messages", { mission, audience: "main" })).items.some(
          (m) => m.text === "New work after restarting both peers",
        ),
      "Fresh peer address did not restore mission replication",
    );
    assert.ok(message);
    assert.equal((await b.handle("peers", { mission })).members.length, 2);
    assert.equal((await b.state()).joins[0].status, "admitted");

    const outsider = make("outsider");
    await outsider.handle("enroll", {});
    await outsider.handle("configureNetwork", { config: network });
    await outsider.handle("configureDiscovery", {
      config: { ...discovery, bootstrap: [fresh] },
    });
    await new Promise((resolve) => setTimeout(resolve, 2200));
    assert.equal(
      (await outsider.state()).missions.length,
      0,
      "A community address must never admit a new member",
    );
  },
);
