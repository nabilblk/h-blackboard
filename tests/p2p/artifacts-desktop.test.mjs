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
import { reviewFromForm } from "../../shared/artifact-review.mjs";
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

test("human review form records mixed checks and copied board evidence through the native command", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hb-review-form-")));
  const node = new NodeService({
    directory: root,
    binary: resolve("var/node/target/debug/harakiri-node"),
    secureStorage: secureStorage(),
  });
  t.after(async () => {
    await node.close();
    rmSync(root, { recursive: true, force: true });
  });
  await node.handle("enroll", {});
  const { mission } = await node.handle("createMission", {
    definition: {
      name: "Human review regression",
      objective: "Preserve exact evidence and honest unperformed checks",
      scope: "Isolated native test; no guest or real workspace",
      criteria: [],
      policy: {
        coordination: "peer",
        participation: "private",
        budget: { mode: "unlimited" },
      },
    },
  });
  const transfer = (transfer) =>
    node.handle("artifactTransfer", { mission, transfer });
  const bytes = Buffer.from("<h1>Isolated review fixture</h1>");
  const { upload } = await transfer({
    type: "begin",
    control: mission,
    conversation: "main",
    path: "index.html",
    media_type: "text/html",
    size: bytes.length,
  });
  await transfer({
    type: "chunk",
    upload,
    offset: 0,
    hex: bytes.toString("hex"),
  });
  const { event: revision } = await transfer({
    type: "publish",
    control: mission,
    conversation: "main",
    artifact: null,
    parents: [],
    document: document("Human review fixture"),
    uploads: [upload],
    retain: [],
  });
  const { event: message } = await node.handle("postMessage", {
    mission,
    audience: "main",
    text: "Fixture observation: the drawing leaves a visible gap.",
  });
  const form = new FormData();
  for (const [key, value] of Object.entries({
    verdict: "changes_requested",
    summary: "The closed-loop caption contradicts the visible diagram.",
    conditions: "Selected-path inspection only. Screenshot: circuit-gap.png.",
    check_source_inspection: "not_run",
    check_executed_tests: "not_run",
    check_browser_check: "passed",
    details_browser_check:
      "Fixture preview on this Mac; selected controls responded.",
    check_visual_inspection: "failed",
    details_visual_inspection:
      "Fixture preview; a visible gap contradicts its caption.",
    evidence:
      "Owner artifact-preview observations and screenshot circuit-gap.png.",
  }))
    form.set(key, value);
  const request = (action) =>
    node.handle("artifactAction", {
      mission,
      control: mission,
      conversation: "main",
      action,
    });
  const before = String(form.get("evidence"));
  assert.throws(() => reviewFromForm(revision, form), /Move descriptions/);
  assert.equal(
    form.get("evidence"),
    before,
    "Invalid prose is never silently dropped",
  );
  form.set("evidence", "");
  const action = reviewFromForm(revision, form);
  // Reproduce the previous renderer's opaque Zod rejection before native write.
  await assert.rejects(request({ ...action, evidence: before.split(/\s+/) }), {
    name: "ZodError",
  });
  assert.equal(
    (await node.handle("artifactDetail", { mission, revision })).reviews.length,
    0,
  );
  // Empty optional links work; Not checked never becomes a performed check.
  await request(action);
  const unlinked = await node.handle("artifactDetail", { mission, revision });
  assert.equal(unlinked.reviews.length, 1);
  assert.deepEqual(unlinked.reviews[0].evidence, []);
  assert.deepEqual(unlinked.reviews[0].checks, action.checks);
  form.set("evidence", `[Message](harakiri://message/${message})\n${revision}`);
  const linked = reviewFromForm(revision, form);
  await request(linked);
  const detail = await node.handle("artifactDetail", { mission, revision });
  assert.equal(
    detail.reviews.length,
    1,
    "The latest review by this author replaces their earlier projection",
  );
  const review = detail.reviews.find((review) => review.evidence.length === 2);
  assert.equal(review.verdict, "changes_requested");
  assert.deepEqual(review.evidence, [message, revision]);
  assert.deepEqual(review.checks, linked.checks);
  assert.deepEqual(
    review.checks
      .slice(0, 2)
      .map(({ result, details }) => ({ result, details })),
    Array.from({ length: 2 }, () => ({
      result: "not_run",
      details: "Not checked in this review.",
    })),
  );
  assert.equal(review.conditions, form.get("conditions"));
  assert.equal(detail.artifact.accepted, false);
  // A syntactically valid ID is not permission to link a different record type.
  await assert.rejects(request({ ...linked, evidence: [mission] }));
  assert.equal(
    (await node.handle("artifactDetail", { mission, revision })).reviews.length,
    1,
  );
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
    const resumable = {
      type: "begin",
      control: mission,
      conversation: "main",
      path: "resume.txt",
      media_type: "text/plain",
      size: 6,
      resume_key: "a".repeat(64),
    };
    const partial = await human(resumable);
    await human({
      type: "chunk",
      upload: partial.upload,
      offset: 0,
      hex: Buffer.from("abc").toString("hex"),
    });
    await n.close();
    start();
    await n.state();
    const resumed = await human(resumable);
    assert.equal(resumed.upload, partial.upload);
    assert.equal(resumed.offset, 3);
    // Exact replay is safe; a different chunk can never replace received bytes.
    await human({
      type: "chunk",
      upload: resumed.upload,
      offset: 0,
      hex: Buffer.from("abc").toString("hex"),
    });
    await assert.rejects(
      human({
        type: "chunk",
        upload: resumed.upload,
        offset: 0,
        hex: "000000",
      }),
    );
    await human({ type: "cancel", upload: resumed.upload });
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
    const repeat = await upload(human, mission, "main", bytes);
    const replay = await human({
      type: "publish",
      control: mission,
      conversation: "main",
      artifact: null,
      parents: [],
      document: document(),
      uploads: [repeat],
      retain: [],
    });
    assert.equal(
      replay.event,
      first,
      "A lost response must not duplicate an identical publication",
    );
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
    assert.equal(
      (
        await n.handle("artifactCache", {
          mission,
          revision: first,
          action: "save",
        })
      ).state,
      "saving",
    );
    await n.artifactCaches.get(`${mission}:${first}`).pending;
    assert.equal(
      (
        await n.handle("artifactCache", {
          mission,
          revision: first,
          action: "status",
        })
      ).state,
      "saved",
    );
    assert.equal(
      (await n.handle("artifactDetail", { mission, revision: first }))
        .available_files.length,
      1,
    );

    let inspected = 0;
    n.inspectArtifact = async (request, detail) => {
      inspected++;
      assert.equal(request.revision, first);
      assert.equal(detail.revision, first);
      return { revision: first };
    };
    const inspect = { mission, revision: first, path: "index.html" };
    assert.deepEqual(await n.handle("artifactInspect", inspect), {
      revision: first,
    });
    await assert.rejects(
      n.handle("artifactInspect", { ...inspect, path: "missing.html" }),
    );
    await assert.rejects(
      n.handle("artifactInspect", { ...inspect, revision: "f".repeat(64) }),
    );
    assert.equal(
      AgentOperation.safeParse({
        type: "artifact_inspect",
        revision: first,
        path: "index.html",
      }).success,
      false,
    );
    assert.equal(
      inspected,
      1,
      "Invalid reads must never invoke a host renderer",
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
        checks: [
          {
            method: "executed_tests",
            result: "passed",
            details:
              "Compared imported bytes with the exact published fixture bytes; no browser or quality assessment.",
          },
        ],
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
