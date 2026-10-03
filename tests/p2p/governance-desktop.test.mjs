import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  NodeService,
  NodeRequests,
  AgentOperation,
} from "../../desktop/node-service.mjs";
import { ContributorService } from "../../desktop/service.mjs";
import { DesktopStore } from "../../desktop/store.mjs";
import { secureStorage } from "../helpers/secure-storage.mjs";
test(
  "desktop resource capabilities bind real local consent, preserve reservations, and never expose execution to renderer or model",
  { timeout: 45000 },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hb-governance-")));
    const workspace = join(root, "work");
    mkdirSync(workspace);
    const storage = secureStorage();
    const contributors = new ContributorService({
      store: new DesktopStore(join(root, "contributor")),
      chooseDirectory: async () => workspace,
      revealDirectory: async () => {},
    });
    let n;
    const start = () => {
      n = new NodeService({
        directory: join(root, "node"),
        binary: resolve("var/node/target/debug/harakiri-node"),
        secureStorage: storage,
      });
      n.contributors = contributors;
    };
    start();
    t.after(async () => {
      await n?.close();
      rmSync(root, { recursive: true, force: true });
    });
    await n.handle("enroll", {});
    const owner = (await n.state()).identity.owner;
    const { mission } = await n.handle("createMission", {
      definition: {
        name: "Subscription allowance",
        objective: "Test consent and resource accounting",
        scope: "Isolated test only",
        criteria: [],
        policy: {
          coordination: "peer",
          participation: "private",
          budget: { mode: "unlimited" },
        },
      },
    });
    const review = await n.handle("reviewContribution", {
      mission,
      role: "agent",
    });
    // Recovery must cover every reservation permitted by the Rust protocol,
    // even when all 512 need explicit owner reconciliation.
    const sealRequest = {
      mission,
      control: mission,
      action: {
        type: "seal_grant",
        grant: "f".repeat(64),
        settlements: Array.from({ length: 512 }, (_, i) =>
          i.toString(16).padStart(64, "0"),
        ),
      },
    };
    assert.equal(NodeRequests.govern.safeParse(sealRequest).success, true);
    sealRequest.action.settlements.push("e".repeat(64));
    assert.equal(NodeRequests.govern.safeParse(sealRequest).success, false);
    const choice = await contributors.handle("chooseWorkspace", {});
    const prepared = await n.handle("prepareContribution", {
      reviewId: review.reviewId,
      workspaceChoiceId: choice.id,
      runtime: "grok",
      limits: { mode: "bounded", turns: 1, concurrency: 1, minutes: 60 },
    });
    const contribution = prepared.contributions[0];
    await n.handle("shareAgent", {
      mission,
      contributionId: contribution.id,
      label: "Budget fixture",
    });
    await n.handle("startMission", {
      mission,
      revision: mission,
      readiness: null,
    });
    const context = await n
      .openAgentChannel(contribution.id)
      .request({ type: "context" });
    const control = context.lifecycle.revision;
    const { event: allocation } = await n.handle("govern", {
      mission,
      control,
      action: { type: "allocate", node: owner, turns: null, slots: 1 },
    });
    const { event: grant } = await n.handle("govern", {
      mission,
      control,
      action: {
        type: "grant",
        previous: null,
        allocation,
        registration: context.agent.id,
        direction: context.agent.direction.id,
        execution: "aa".repeat(32),
        generation: 1,
        turns: 10,
        expires_ms: Date.now() + 3600000,
        offline_ms: 600000,
      },
    });
    const cap = n.openResourceLedger(contribution.id);
    assert.equal(cap.executionAvailable, false);
    await assert.rejects(cap.reserve({ grant, nonce: "bb".repeat(32) }));
    await n.handle("consentGrant", {
      mission,
      grant,
      contributionId: contribution.id,
    });
    const receipt = await cap.reserve({ grant, nonce: "bb".repeat(32) });
    assert.equal(receipt.execution_available, false);
    assert.deepEqual(
      await cap.reserve({ grant, nonce: "bb".repeat(32) }),
      receipt,
    );
    assert.throws(() =>
      NodeRequests.govern.parse({
        mission,
        control,
        action: {
          type: "receipt",
          reservation: receipt.event,
          used: 0,
          stopped: true,
          summary: "Renderer fakes a stop",
        },
      }),
    );
    assert.throws(() =>
      AgentOperation.parse({
        type: "govern",
        control,
        action: {
          type: "resolve",
          reservation: receipt.event,
          reason: "Model frees its budget",
        },
      }),
    );
    await assert.rejects(
      n.handle("openResourceLedger", { contributionId: contribution.id }),
    );
    await n.close();
    start();
    let ledger = await n.handle("governance", { mission });
    assert.equal(ledger.allocations[0].reserved, 1);
    await assert.rejects(
      n
        .openResourceLedger(contribution.id)
        .reserve({ grant, nonce: "cc".repeat(32) }),
    );
    await n.handle("govern", {
      mission,
      control,
      action: {
        type: "resolve",
        reservation: receipt.event,
        reason: "Fixture deliberately accepts unknown usage; charge full turn",
      },
    });
    // Budget consumed even though the mission is unlimited and the node restarted.
    await assert.rejects(
      n
        .openResourceLedger(contribution.id)
        .reserve({ grant, nonce: "cc".repeat(32) }),
    );
    ledger = await n.handle("governance", { mission });
    assert.equal(ledger.allocations[0].charged, 1);
    assert.equal(ledger.execution_available, false);
    await n.handle("missionAction", {
      mission,
      revision: control,
      action: { type: "archive", reason: "Preserve evidence" },
    });
    await assert.rejects(
      n.handle("postMessage", {
        mission,
        audience: "main",
        text: "Should be read only",
        to: null,
        thread: null,
      }),
    );
    const archived = (await n.state()).missions[0];
    assert.equal(archived.lifecycle.phase, "archived");
    await n.handle("missionAction", {
      mission,
      revision: archived.lifecycle.revision,
      action: { type: "restore" },
    });
    assert.equal((await n.state()).missions[0].lifecycle.phase, "paused");
    const { audience } = await n.handle("openAgentConversation", {
      mission,
      registration: context.agent.id,
    });
    const privateMessage = await n.openAgentChannel(contribution.id).request({
      type: "post",
      audience,
      text: "Private evidence before withdrawal",
      to: null,
      thread: null,
    });
    await n.handle("withdrawAgent", {
      mission,
      contributionId: contribution.id,
    });
    const reviewPrivate = await n.handle("privateRecovery", {
      mission,
      audience,
    });
    assert.equal(reviewPrivate.length, 1);
    assert.equal(reviewPrivate[0].member, context.agent.identity.author);
    const query = { view: "conversation", audience };
    assert.equal(
      (await n.handle("queryMessages", { mission, query })).items.find(
        (m) => m.id === privateMessage.event,
      ).provisional,
      true,
    );
    await n.handle("reconcilePrivate", {
      mission,
      audience,
      ...reviewPrivate[0],
      accepted: privateMessage.event,
    });
    assert.deepEqual(
      await n.handle("privateRecovery", { mission, audience }),
      [],
    );
    assert.equal(
      (await n.handle("queryMessages", { mission, query })).items.find(
        (m) => m.id === privateMessage.event,
      ).provisional,
      false,
    );
    await assert.rejects(
      n.handle("reconcilePrivate", {
        mission,
        audience,
        ...reviewPrivate[0],
        accepted: null,
      }),
    );
    assert.ok(!JSON.stringify(ledger).includes(workspace));
  },
);
