import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NodeService } from "../../desktop/node-service.mjs";
import { ContributorService } from "../../desktop/service.mjs";
import { DesktopStore } from "../../desktop/store.mjs";
import { secureStorage } from "../helpers/secure-storage.mjs";

const config = { mode: "direct", relays: [], allow_lan: true };
const discovery = { enabled: true, lan: false, bootstrap: [], blocked: [] };
const definition = {
  name: "Community science day",
  objective: "Plan an afternoon of hands-on learning",
  scope: "Reviewed terms; excluded from the public listing",
  criteria: ["A usable event plan"],
  policy: {
    coordination: "coordinated",
    participation: "approval",
    budget: { mode: "unlimited" },
  },
};
async function until(check, message) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.fail(message);
}

test(
  "community discovery, live approval, reviewed local offers and withdrawal across three node processes",
  { timeout: 150000 },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hb-discovery-")));
    const all = [];
    const storage = secureStorage();
    function make(name) {
      const n = new NodeService({
        directory: join(root, name),
        binary: resolve("var/node/target/debug/harakiri-node"),
        secureStorage: storage,
      });
      all.push(n);
      return n;
    }
    t.after(async () => {
      for (const n of all) await n.close();
      rmSync(root, { recursive: true, force: true });
    });
    const a = make("a"),
      b = make("b");
    let c = make("c");
    const parent = join(root, "work");
    mkdirSync(parent);
    const contributors = new ContributorService({
      store: new DesktopStore(join(root, "preparations")),
      chooseDirectory: async () => parent,
      revealDirectory: async () => {},
    });
    c.contributors = contributors;
    for (const n of [a, b, c]) {
      await n.handle("enroll", {});
      await n.handle("configureNetwork", { config });
    }
    await a.handle("configureDiscovery", { config: discovery });
    const aTicket = (await a.handle("discoveryState", {})).peer_ticket;
    await b.handle("configureDiscovery", {
      config: { ...discovery, bootstrap: [aTicket] },
    });
    const bTicket = (await b.handle("discoveryState", {})).peer_ticket;
    await c.handle("configureDiscovery", {
      config: { ...discovery, bootstrap: [bTicket] },
    });
    const { mission } = await a.handle("createMission", { definition });
    const { mission: privateMission } = await a.handle("createMission", {
      definition: {
        ...definition,
        name: "Private planning",
        policy: { ...definition.policy, participation: "private" },
      },
    });
    await assert.rejects(
      a.handle("publishListing", {
        mission: privateMission,
        summary: "Not public",
        capabilities: [],
        active: true,
      }),
    );
    await a.handle("publishListing", {
      mission,
      summary: "Help plan a science day for local families.",
      capabilities: ["Research", "Planning"],
      active: true,
    });
    await until(
      async () =>
        (await c.handle("discoveryState", {})).listings.some(
          (l) => l.advertisement.mission === mission,
        ),
      "A public brief did not travel through the community peer",
    );
    const catalog = await c.handle("discoveryState", {});
    assert.equal(catalog.listings.length, 1);
    assert.equal((await c.state()).missions.length, 0);
    assert.ok(!JSON.stringify(catalog).includes(definition.scope));
    const reference = catalog.listings[0].reference;
    await assert.rejects(
      c.handle("reviewContribution", { mission, role: "agent" }),
    );
    const review = await c.handle("inspectInvitation", { ticket: reference });
    assert.deepEqual(review.definition, definition);
    await c.handle("requestJoin", {
      ticket: reference,
      reviewed_mission: mission,
      reviewed_revision: review.reviewed_revision,
    });
    const author = (await c.state()).identity.owner;
    await until(
      async () =>
        (await a.handle("peers", { mission })).requests.some(
          (r) => r.author === author,
        ),
      "Owner did not receive the discovered mission request",
    );
    assert.equal((await c.state()).missions.length, 0);
    await a.handle("decideJoin", { mission, author, admit: true });
    await until(
      async () => (await c.state()).joins.some((j) => j.status === "admitted"),
      "Explicit admission did not synchronize",
    );
    assert.equal((await b.state()).missions.length, 0);
    const coordinatorReview = await c.handle("reviewContribution", {
      mission,
      role: "coordinator",
    });
    assert.equal(coordinatorReview.mission.role, "coordinator");
    assert.equal(
      (await c.state()).missions[0].lifecycle.coordinator,
      null,
      "Offering a Coordinator must not appoint one",
    );
    const terms = await c.handle("reviewContribution", {
      mission,
      role: "agent",
    });
    assert.equal(terms.nodeBinding.revision, mission);
    const choice = await contributors.handle("chooseWorkspace", {});
    const preparation = {
      reviewId: terms.reviewId,
      workspaceChoiceId: choice.id,
      runtime: "grok",
      limits: { mode: "unlimited", concurrency: 2 },
    };
    await assert.rejects(
      contributors.handle("prepare", preparation),
      /signed mission review/,
    );
    await assert.rejects(
      c.handle("prepareContribution", {
        ...preparation,
        workspace: "/untrusted/path",
      }),
    );
    const local = await c.handle("prepareContribution", preparation);
    assert.equal(
      local.contributions[0].nodeBinding.owner,
      (await a.state()).identity.owner,
    );
    const workspace = local.contributions[0].workspace;
    assert.ok(workspace.startsWith(parent + "/"));
    assert.ok(existsSync(workspace));
    assert.equal(local.contributions[0].execution.allowed, false);
    await c.handle("postMessage", {
      mission,
      text: "A real saved contribution note.",
    });
    await until(
      async () => (await a.handle("messages", { mission })).items.length === 1,
      "Main did not converge",
    );
    const stale = await c.handle("reviewContribution", {
      mission,
      role: "agent",
    });
    const staleChoice = await contributors.handle("chooseWorkspace", {});
    await c.handle("withdrawMission", { mission });
    await assert.rejects(
      c.handle("prepareContribution", {
        ...preparation,
        reviewId: stale.reviewId,
        workspaceChoiceId: staleChoice.id,
      }),
    );
    assert.equal(contributors.snapshot().contributions[0].status, "revoked");
    assert.ok(existsSync(workspace));
    await assert.rejects(
      c.handle("postMessage", { mission, text: "No further participation" }),
    );
    await until(
      async () =>
        (await a.handle("peers", { mission })).members.some(
          (m) => m.author === author && m.withdrawn,
        ),
      "Owner did not learn the signed withdrawal",
    );
    await c.close();
    c = make("c");
    c.contributors = contributors;
    assert.equal((await c.state()).withdrawals[0].mission, mission);
    assert.equal((await c.handle("messages", { mission })).items.length, 1);
    await assert.rejects(
      c.handle("requestJoin", {
        ticket: reference,
        reviewed_mission: mission,
        reviewed_revision: review.reviewed_revision,
      }),
    );
    await a.handle("publishListing", {
      mission,
      summary: "Help plan a science day for local families.",
      capabilities: ["Research"],
      active: false,
    });
    await until(
      async () =>
        (await b.handle("discoveryState", {})).listings.some(
          (l) => l.status === "unlisted",
        ),
      "Signed unlisting did not propagate",
    );
    await assert.rejects(b.handle("inspectInvitation", { ticket: reference }));
    for (const n of [a, b, c])
      assert.equal((await n.state()).execution, "unavailable");
  },
);
