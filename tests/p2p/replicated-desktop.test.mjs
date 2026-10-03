import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NodeService } from "../../desktop/node-service.mjs";
import { secureStorage } from "../helpers/secure-storage.mjs";

const definition = {
  name: "Replicated science day",
  objective: "Prepare a shared afternoon",
  scope: "Isolated test records",
  criteria: ["A durable shared direction"],
  policy: {
    coordination: "coordinated",
    participation: "private",
    budget: { mode: "unlimited" },
  },
};
const config = { mode: "direct", relays: [], allow_lan: true };
async function until(check, description) {
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.fail(description);
}
test(
  "desktop services synchronize approved peers, private scopes and revocation through restart with no agents",
  { timeout: 120000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "hb-peer-desktop-"));
    const storage = secureStorage();
    const all = [];
    const copied = new Map();
    const make = (name) => {
      const service = new NodeService({
        directory: join(root, name),
        binary: resolve("var/node/target/debug/harakiri-node"),
        secureStorage: storage,
        writeClipboard: (text) => copied.set(name, text),
      });
      all.push(service);
      return service;
    };
    t.after(async () => {
      for (const service of all) await service.close();
      rmSync(root, { recursive: true, force: true });
    });
    const a = make("a");
    let b = make("b");
    const c = make("c");
    for (const n of [a, b, c]) {
      await n.handle("enroll", {});
      await n.handle("configureNetwork", { config });
    }
    const { mission } = await a.handle("createMission", { definition });
    const { ticket } = await a.handle("issueInvitation", { mission });
    await a.handle("copyInvitation", { mission });
    assert.equal(copied.get("a"), ticket);
    await assert.rejects(
      a.handle("copyInvitation", {
        mission,
        text: "untrusted clipboard content",
      }),
    );
    await assert.rejects(b.handle("copyInvitation", { mission }));
    const bKey = (await b.state()).identity.owner;
    const cKey = (await c.state()).identity.owner;
    for (const n of [b, c]) {
      const review = await n.handle("inspectInvitation", { ticket });
      assert.deepEqual(review.definition, definition);
      assert.equal((await n.state()).missions.length, 0);
      await n.handle("requestJoin", {
        ticket,
        reviewed_mission: mission,
        reviewed_revision: mission,
      });
      const author = (await n.state()).identity.owner;
      await until(
        async () =>
          (await a.handle("peers", { mission })).requests.some(
            (r) => r.author === author,
          ),
        "Owner did not receive the signed request",
      );
      assert.equal((await n.state()).missions.length, 0);
      await a.handle("decideJoin", { mission, author, admit: true });
      await until(
        async () =>
          (await n.state()).joins.some((j) => j.status === "admitted"),
        "Join did not complete",
      );
    }
    await until(
      async () => (await b.handle("peers", { mission })).members.length === 3,
      "Roster did not converge",
    );
    const { audience } = await b.handle("createAudience", {
      mission,
      readers: [cKey],
    });
    await b.handle("postMessage", {
      mission,
      audience,
      text: "Private evidence between B and C",
    });
    await until(
      async () =>
        (await c.handle("audiences", { mission })).some(
          (a) => a.id === audience,
        ) &&
        (await c.handle("messages", { mission, audience })).items.length === 1,
      "Private history did not synchronize",
    );
    assert.deepEqual(await a.handle("audiences", { mission }), []);
    assert.equal((await a.handle("messages", { mission })).items.length, 0);
    await a.close();
    await b.handle("postMessage", {
      mission,
      text: "Creator offline: authorized work continues",
    });
    await until(
      async () =>
        (await c.handle("messages", { mission })).items.some((m) =>
          m.text.startsWith("Creator offline"),
        ),
      "Creator-free replication failed",
    );
    const identity = (await b.state()).identity;
    await b.close();
    b = make("b");
    assert.deepEqual((await b.state()).identity, identity);
    assert.equal((await b.state()).network, "enabled");
    await c.handle("postMessage", { mission, text: "Catch up after restart" });
    await until(
      async () =>
        (await b.handle("messages", { mission })).items.some(
          (m) => m.text === "Catch up after restart",
        ),
      "Durable reconnect failed",
    );
    const restartedOwner = make("a");
    await restartedOwner.state();
    await until(
      async () =>
        (await restartedOwner.handle("messages", { mission })).items.length ===
        2,
      "Owner did not catch up",
    );
    await restartedOwner.handle("revokeMember", { mission, author: bKey });
    await until(
      async () =>
        (await b.handle("peers", { mission })).members.some(
          (m) => m.author === bKey && m.revoked,
        ),
      "Revoked node did not learn its revocation",
    );
    await assert.rejects(
      b.handle("postMessage", { mission, text: "Must be rejected" }),
    );
    assert.equal(
      (await b.handle("messages", { mission, audience })).items.length,
      1,
    );
    assert.equal((await b.handle("audiences", { mission }))[0].id, audience);
    for (const n of [restartedOwner, b, c]) {
      assert.equal((await n.state()).execution, "unavailable");
      assert.equal((await n.state()).missions[0].state, "preparing");
    }
  },
);
