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
const document = (title = "Festival guide") => ({
  title,
  summary: "Offline fixture guide",
  kind: "application",
  stage: "complete",
  limitations: "Fixture; no real visitors.",
  entrypoint: "index.html",
  inputs: [],
  files: [],
});
test(
  "artifact transfers preserve exact bytes, scoped agent identity, private boundaries and offline restart",
  { timeout: 45000 },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hb-artifacts-")));
    const workspace = join(root, "work");
    mkdirSync(workspace);
    const storage = secureStorage();
    let n;
    const contributors = new ContributorService({
      store: new DesktopStore(join(root, "contributor")),
      chooseDirectory: async () => workspace,
      revealDirectory: async () => {},
    });
    const start = () => {
      n = new NodeService({
        directory: join(root, "node"),
        binary: resolve("var/node/target/debug/harakiri-node"),
        secureStorage: storage,
      });
      n.contributors = contributors;
      return n;
    };
    start();
    t.after(async () => {
      await n?.close();
      rmSync(root, { recursive: true, force: true });
    });
    await n.handle("enroll", {});
    const { mission } = await n.handle("createMission", {
      definition: {
        name: "Artifacts fixture",
        objective: "Compare useful outputs",
        scope: "Isolated test only",
        criteria: [],
        policy: {
          coordination: "peer",
          participation: "private",
          budget: { mode: "unlimited" },
        },
      },
    });
    const current = async () =>
      (await n.state()).missions.find((m) => m.id === mission);
    const human = (transfer) =>
      n.handle("artifactTransfer", { mission, transfer });
    const upload = async (call, control, conversation, bytes) => {
      const { upload } = await call({
        type: "begin",
        control,
        conversation,
        path: "index.html",
        media_type: "text/html",
        size: bytes.length,
      });
      for (let offset = 0; offset < bytes.length; offset += 48 * 1024)
        await call({
          type: "chunk",
          upload,
          offset,
          hex: bytes.subarray(offset, offset + 48 * 1024).toString("hex"),
        });
      return upload;
    };
    const bytes = Buffer.from(
      "<!doctype html><h1>Festival guide</h1>" + ".".repeat(150000),
    );
    const handle = await upload(human, mission, "main", bytes);
    await assert.rejects(
      human({ type: "chunk", upload: handle, offset: 0, hex: "01" }),
    );
    const { event: first } = await human({
      type: "publish",
      control: mission,
      conversation: "main",
      artifact: null,
      parents: [],
      document: document(),
      uploads: [handle],
      retain: [],
    });
    assert.deepEqual(
      await n.readArtifactFile({
        mission,
        revision: first,
        path: "index.html",
      }),
      bytes,
    );
    assert.equal(
      (await n.handle("artifactDetail", { mission, revision: first })).artifact
        .accepted,
      false,
    );
    await assert.rejects(
      n.readArtifactFile({ mission, revision: first, path: "../node.sqlite" }),
    );
    const prepare = async (label) => {
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
      const c = result.contributions[0];
      await n.handle("shareAgent", { mission, contributionId: c.id, label });
      return { contribution: c, channel: n.openAgentChannel(c.id) };
    };
    const a = await prepare("Guide author");
    const b = await prepare("Guide reviewer");
    const acall = (transfer) =>
      a.channel.request({ type: "artifact_transfer", transfer });
    const bcall = (transfer) =>
      b.channel.request({ type: "artifact_transfer", transfer });
    await assert.rejects(upload(acall, mission, "main", Buffer.from("early")));
    await n.handle("startMission", {
      mission,
      revision: mission,
      readiness: null,
    });
    const control = (await current()).lifecycle.revision;
    const agentBytes = Buffer.from("<h1>Verified fixture application</h1>");
    const receipt = await upload(acall, control, "main", agentBytes);
    await assert.rejects(
      bcall({
        type: "chunk",
        upload: receipt,
        offset: agentBytes.length,
        hex: "",
      }),
    );
    const { event: agentRevision } = await acall({
      type: "publish",
      control,
      conversation: "main",
      artifact: null,
      parents: [],
      document: document("Agent-authored guide"),
      uploads: [receipt],
      retain: [],
    });
    const detail = await b.channel.request({
      type: "artifact_detail",
      revision: agentRevision,
    });
    assert.equal(
      detail.author,
      (await a.channel.request({ type: "context" })).agent.identity.author,
    );
    await b.channel.request({
      type: "artifact_action",
      control,
      conversation: "main",
      action: {
        type: "review",
        revision: agentRevision,
        verdict: "verified",
        summary: "Read exact saved bytes",
        conditions: "Native service fixture; no process or model",
        evidence: [first],
      },
    });
    await assert.rejects(
      b.channel.request({
        type: "artifact_action",
        control,
        conversation: "main",
        action: {
          type: "accept",
          revision: agentRevision,
          accepted: true,
          reason: "Agent is not human authority",
        },
      }),
    );
    const { event: next } = await acall({
      type: "publish",
      control,
      conversation: "main",
      artifact: agentRevision,
      parents: [agentRevision],
      document: document("Updated guide"),
      uploads: [],
      retain: [{ revision: agentRevision, path: "index.html" }],
    });
    assert.deepEqual(
      await n.readArtifactFile({ mission, revision: next, path: "index.html" }),
      agentBytes,
    );
    assert.equal(
      (await n.handle("artifactDetail", { mission, revision: next })).reviews
        .length,
      0,
    );
    const registration = (await a.channel.request({ type: "context" })).agent
      .id;
    const { audience } = await n.handle("openAgentConversation", {
      mission,
      registration,
    });
    const secretHandle = await upload(
      acall,
      control,
      audience,
      Buffer.from("private output"),
    );
    const { event: secret } = await acall({
      type: "publish",
      control,
      conversation: audience,
      artifact: null,
      parents: [],
      document: document("Private note"),
      uploads: [secretHandle],
      retain: [],
    });
    await assert.rejects(
      b.channel.request({ type: "artifact_detail", revision: secret }),
    );
    await assert.rejects(
      bcall({ type: "read", revision: secret, path: "index.html", offset: 0 }),
    );
    assert.equal(
      (await b.channel.request({ type: "artifacts", query: {} })).items.some(
        (x) => x.revision === secret,
      ),
      false,
    );
    const paused = await n.handle("pauseMission", {
      mission,
      revision: control,
      reason: "Fixture pause",
    });
    await assert.rejects(
      upload(acall, paused.event, "main", Buffer.from("paused")),
    );
    assert.equal((await n.state()).execution, "unavailable");
    for (const x of [
      { type: "read", revision: first, path: "/etc/passwd", offset: 0 },
      {
        type: "read",
        revision: first,
        path: "index.html",
        offset: 0,
        author: "00".repeat(32),
      },
    ])
      assert.equal(
        AgentOperation.safeParse({ type: "artifact_transfer", transfer: x })
          .success,
        false,
      );
    assert.equal(NodeRequests.agentRequest, undefined);
    await n.close();
    start();
    await n.state();
    assert.deepEqual(
      await n.readArtifactFile({
        mission,
        revision: first,
        path: "index.html",
      }),
      bytes,
    );
    assert.deepEqual(
      await n.readArtifactFile({
        mission,
        revision: secret,
        path: "index.html",
      }),
      Buffer.from("private output"),
    );
  },
);
