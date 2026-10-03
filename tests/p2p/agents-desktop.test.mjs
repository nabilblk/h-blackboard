import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NodeService } from "../../desktop/node-service.mjs";
import { ContributorService } from "../../desktop/service.mjs";
import { DesktopStore } from "../../desktop/store.mjs";
import { secureStorage } from "../helpers/secure-storage.mjs";

test(
  "shared agents require local prepared consent, preserve private paths, retry and survive restart",
  { timeout: 30000 },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hb-roster-")));
    const folder = join(root, "work");
    mkdirSync(folder);
    const storage = secureStorage();
    const contributors = new ContributorService({
      store: new DesktopStore(join(root, "contributor")),
      chooseDirectory: async () => folder,
      revealDirectory: async () => {},
    });
    const create = () => {
      const service = new NodeService({
        directory: join(root, "node"),
        binary: resolve("var/node/target/debug/harakiri-node"),
        secureStorage: storage,
      });
      service.contributors = contributors;
      return service;
    };
    let n = create();
    t.after(async () => {
      await n.close();
      rmSync(root, { recursive: true, force: true });
    });
    await n.handle("enroll", {});
    const definition = {
      name: "Festival",
      objective: "An accessible festival",
      scope: "Research only",
      criteria: [],
      policy: {
        coordination: "peer",
        participation: "private",
        budget: { mode: "unlimited" },
      },
    };
    const { mission } = await n.handle("createMission", { definition });
    const current = async () =>
      (await n.state()).missions.find((m) => m.id === mission);
    const prepare = async () => {
      const review = await n.handle("reviewContribution", {
        mission,
        role: "agent",
      });
      const choice = await contributors.handle("chooseWorkspace", {});
      const result = await n.handle("prepareContribution", {
        reviewId: review.reviewId,
        workspaceChoiceId: choice.id,
        runtime: "grok",
        limits: { mode: "unlimited", concurrency: 1 },
      });
      return result.contributions[0];
    };
    const first = await prepare();
    const second = await prepare();
    assert.notEqual(
      first.id,
      second.id,
      "one node can contribute multiple agents of the same runtime",
    );
    assert.notEqual(first.workspace, second.workspace);
    assert.equal(
      (await n.handle("agents", { mission })).total,
      0,
      "preparation alone does not publish an agent",
    );
    await assert.rejects(
      n.handle("shareAgent", {
        mission,
        contributionId: first.id,
        label: "Researcher",
        workspace: folder,
      }),
    );
    const shared = await n.handle("shareAgent", {
      mission,
      contributionId: first.id,
      label: "Accessibility researcher",
    });
    assert.deepEqual(
      await n.handle("shareAgent", {
        mission,
        contributionId: first.id,
        label: "Accessibility researcher",
      }),
      shared,
    );
    const roster = await n.handle("agents", { mission });
    assert.equal(roster.total, 1);
    assert.equal(roster.items[0].status, "waiting_for_start");
    assert.equal(roster.items[0].identity.runtime, "grok");
    assert.ok(!JSON.stringify(roster).includes(root));
    const bound = contributors
      .snapshot()
      .contributions.find((c) => c.id === first.id);
    assert.equal(bound.sharedAgent.registration, shared.registration);
    await n.handle("startMission", {
      mission,
      revision: (await current()).lifecycle.revision,
      readiness: null,
    });
    assert.equal(
      (await n.handle("agents", { mission })).items[0].status,
      "direction_assigned",
    );
    await n.handle("directAgent", {
      mission,
      revision: (await current()).lifecycle.revision,
      registration: shared.registration,
      text: "Check access to every venue.",
    });
    assert.equal(
      (await n.handle("agents", { mission })).items[0].direction.text,
      "Check access to every venue.",
    );
    assert.equal((await n.state()).execution, "unavailable");
    await n.close();
    n = create();
    assert.equal(
      (await n.handle("agents", { mission })).items[0].direction.text,
      "Check access to every venue.",
    );
    // A lost local metadata write retries the same signed offer, not another agent.
    const mark = contributors.markAgentShared.bind(contributors);
    contributors.markAgentShared = () => {
      throw new Error("simulated interrupted metadata write");
    };
    await assert.rejects(
      n.handle("shareAgent", {
        mission,
        contributionId: second.id,
        label: "Schedule researcher",
      }),
    );
    contributors.markAgentShared = mark;
    await n.handle("shareAgent", {
      mission,
      contributionId: second.id,
      label: "Schedule researcher",
    });
    assert.equal((await n.handle("agents", { mission })).total, 2);
    // Failure to publish a withdrawal cannot restore local consent. A later
    // state reconciliation retries the durable pending intent.
    const request = n.bridge.request.bind(n.bridge);
    n.bridge.request = (input) =>
      input.type === "withdraw_agent"
        ? Promise.reject(new Error("temporary IPC outage"))
        : request(input);
    await assert.rejects(
      n.handle("withdrawAgent", { mission, contributionId: first.id }),
    );
    const revoked = contributors
      .snapshot()
      .contributions.find((c) => c.id === first.id);
    assert.equal(revoked.status, "revoked");
    assert.ok(
      revoked.execution.blockers.some(
        (b) => b.code === "agent_withdrawal_pending",
      ),
    );
    n.bridge.request = request;
    await n.state();
    assert.equal(
      (await n.handle("agents", { mission })).items.find(
        (a) => a.id === shared.registration,
      ).status,
      "withdrawn",
    );
    await n.handle("updateInstructions", {
      mission,
      revision: (await current()).lifecycle.revision,
      definition: { ...definition, scope: "The outdoor stage is closed" },
    });
    await assert.rejects(
      n.handle("shareAgent", {
        mission,
        contributionId: second.id,
        label: "Schedule researcher",
      }),
      /current mission instructions/,
    );
    assert.equal(
      (await n.handle("agents", { mission })).items.find(
        (a) => a.identity.label === "Schedule researcher",
      ).status,
      "review_required",
    );
    assert.ok(
      contributors
        .snapshot()
        .contributions.every((c) => c.execution.allowed === false),
    );
  },
);
