import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NodeService } from "../../desktop/node-service.mjs";
import { ContributorService } from "../../desktop/service.mjs";
import { DesktopStore } from "../../desktop/store.mjs";
import { secureStorage } from "../helpers/secure-storage.mjs";
async function until(check) {
  const end = Date.now() + 20000;
  while (!(await check())) {
    if (Date.now() > end) assert.fail("Peer observation did not converge");
    await new Promise((r) => setTimeout(r, 100));
  }
}
test(
  "signed contributor waits cross the real peer transport without adding mission messages",
  { timeout: 45000 },
  async (t) => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "hb-observation-peers-")),
    );
    const nodes = [];
    t.after(async () => {
      for (const n of nodes) await n.close();
      rmSync(root, { recursive: true, force: true });
    });
    for (const name of ["owner", "contributor"]) {
      const n = new NodeService({
        directory: join(root, name),
        binary: resolve("var/node/target/debug/harakiri-node"),
        secureStorage: secureStorage(),
      });
      nodes.push(n);
      await n.handle("enroll", {});
      await n.handle("configureNetwork", {
        config: { mode: "direct", relays: [], allow_lan: true },
      });
    }
    const [a, b] = nodes;
    const { mission } = await a.handle("createMission", {
      definition: {
        name: "Remote readiness fixture",
        objective: "Observe contributor readiness",
        scope: "No runtime execution",
        criteria: [],
        policy: {
          coordination: "peer",
          participation: "private",
          budget: { mode: "unlimited" },
        },
      },
    });
    const { ticket } = await a.handle("issueInvitation", { mission });
    await b.handle("inspectInvitation", { ticket });
    await b.handle("requestJoin", {
      ticket,
      reviewed_mission: mission,
      reviewed_revision: mission,
    });
    const author = (await b.state()).identity.owner;
    await until(async () =>
      (await a.handle("peers", { mission })).requests.some(
        (r) => r.author === author,
      ),
    );
    await a.handle("decideJoin", { mission, author, admit: true });
    await until(async () =>
      (await b.state()).joins.some((j) => j.status === "admitted"),
    );
    b.contributors = new ContributorService({
      store: new DesktopStore(join(root, "preparations")),
      exportDirectory: join(root, "exports"),
      chooseDirectory: async () => root,
      revealDirectory: async () => {},
    });
    const review = await b.handle("reviewContribution", {
      mission,
      role: "agent",
    });
    const choice = await b.contributors.handle("chooseWorkspace", {});
    const prepared = await b.handle("prepareContribution", {
      reviewId: review.reviewId,
      workspaceChoiceId: choice.id,
      runtime: "grok",
      limits: { mode: "unlimited", concurrency: 1 },
    });
    const c = prepared.contributions[0];
    await b.handle("shareAgent", {
      mission,
      contributionId: c.id,
      label: "Fixture worker",
    });
    await until(
      async () => (await a.handle("agents", { mission })).items.length === 1,
    );
    b.executions = {
      close: async () => {},
      store: { read: () => ({ status: "ready" }) },
      state: async () => ({ permissions: [], agreement: null }),
    };
    const before = (await a.handle("messages", { mission })).items.length;
    await b.publishExecutionObservations();
    await until(
      async () => (await a.handle("observations", { mission })).length === 1,
    );
    const [view] = await a.handle("observations", { mission });
    assert.equal(view.report.state, "awaiting_approval");
    assert.equal(view.contributor, author);
    assert.ok(view.remaining_ms > 0 && view.remaining_ms <= 30000);
    assert.equal(
      (await a.handle("messages", { mission })).items.length,
      before,
    );
    assert.equal(JSON.stringify(view).includes(root), false);
    await assert.rejects(
      b.handle("publishObservation", { report: view.report }),
      /not allowed|Unknown|Unsupported|invalid/i,
    );
    await a.handle("revokeMember", { mission, author });
    assert.equal((await a.handle("observations", { mission })).length, 0);
  },
);
