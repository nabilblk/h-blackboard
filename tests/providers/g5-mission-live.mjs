// Opt-in real provider journey. A temporary native node hosts one genuinely
// executing Coordinator. The G0 guest's login is reused inside that guest only.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { NodeService } from "../../desktop/node-service.mjs";
import { ContributorService } from "../../desktop/service.mjs";
import { DesktopStore } from "../../desktop/store.mjs";
import { ExecutionStore } from "../../desktop/execution/store.mjs";
import { ExecutionManager } from "../../desktop/execution/manager.mjs";
import { LimaProvider } from "../../desktop/execution/lima.mjs";
import { exportWorkspace } from "../../desktop/execution/files.mjs";
import { secureStorage } from "../helpers/secure-storage.mjs";

const runtime = process.argv[2] || "grok";
if (!["grok", "claude", "codex"].includes(runtime))
  throw new Error("Unsupported runtime");
const root = resolve(`var/node/g5/mission-${runtime}-${randomUUID()}`);
mkdirSync(join(root, "workspace"), { recursive: true, mode: 0o700 });
let provider;
if (runtime === "grok") {
  const proof = JSON.parse(
    readFileSync("var/node/feasibility/vm-profile.json", "utf8"),
  );
  assert.match(proof.lima_home, /^(\/private)?\/tmp\/hb-lima-[a-zA-Z0-9_-]+$/);
  assert.equal(proof.instance, "proof");
  provider = new LimaProvider({ directory: proof.lima_home });
  provider.instance = () => "proof";
} else {
  const proof = JSON.parse(
    readFileSync(`var/node/g5-runtimes/${runtime}-conformance.json`, "utf8"),
  );
  assert.equal(proof.contribution.runtime, runtime);
  assert.match(proof.directory, /^\/tmp\/hb-g5-[a-zA-Z0-9_-]+$/);
  provider = new LimaProvider({ directory: proof.directory });
  const instance = provider.instance(proof.contribution.id);
  // Test-only reuse of this runtime's guest-native login, inside the SAME VM.
  provider.instance = () => instance;
}
const n = new NodeService({
  directory: join(root, "node"),
  binary: resolve("var/node/target/debug/harakiri-node"),
  secureStorage: secureStorage(),
});
const contributors = new ContributorService({
  store: new DesktopStore(join(root, "contributions")),
  chooseDirectory: async () => realpathSync(join(root, "workspace")),
  revealDirectory: async () => {},
});
n.contributors = contributors;
const store = new ExecutionStore(join(root, "execution"));
const manager = new ExecutionManager({
  store,
  provider,
  node: n,
  exportWorkspace,
  pollMs: 1000,
});
n.executions = manager;
const checks = [];
let mission, contribution, allocation, owner;
async function untilStopped() {
  const deadline = Date.now() + 22 * 60 * 1000;
  let previous;
  while (Date.now() < deadline) {
    const current = store.read(contribution.id);
    if (current.status !== previous)
      console.log(current.status, current.reason);
    previous = current.status;
    if (["stopped", "failed", "recovery_required"].includes(current.status)) {
      assert.equal(current.status, "stopped", current.reason);
      return;
    }
    await delay(2000);
  }
  throw new Error("Mission proof exceeded its test deadline");
}
async function permit(purpose) {
  const context = await n
    .openAgentChannel(contribution.id)
    .request({ type: "context" });
  const ledger = await n.handle("governance", { mission });
  const previous = ledger.grants.at(-1);
  const { event: grant } = await n.handle("govern", {
    mission,
    control: context.lifecycle.revision,
    action: {
      type: "grant",
      purpose,
      previous: previous?.seal ?? null,
      allocation,
      registration: context.agent.id,
      direction:
        purpose === "planning"
          ? context.lifecycle.revision
          : context.agent.direction.id,
      execution: previous?.execution ?? randomBytes(32).toString("hex"),
      generation: previous ? previous.generation + 1 : 1,
      turns: 1,
      expires_ms: Date.now() + (purpose === "planning" ? 600000 : 1200000),
      offline_ms: purpose === "planning" ? 590000 : 1190000,
    },
  });
  await n.handle("consentGrant", {
    mission,
    grant,
    contributionId: contribution.id,
  });
  await manager.start(contribution.id, grant);
  await untilStopped();
}
try {
  await n.handle("enroll", {});
  owner = (await n.state()).identity.owner;
  ({ mission } = await n.handle("createMission", {
    definition: {
      name: "One-hour stargazing club · G5 live proof",
      objective:
        "Create an attractive self-contained HTML guide for a one-hour community stargazing club for 12 children. Include an accessible 60-minute schedule, a materials checklist and a small interactive three-question space quiz. Save index.html and publish it as a complete application artifact with index.html as its entrypoint. Test its source and document the limits of testing without a browser in the guest. Workstreams and tasks are optional.",
      scope:
        "Isolated execution validation. No network research, purchases, messages outside this mission or extra agents. During preparation, publish a concise text plan and readiness, then wait for the human. After Start, create and publish the artifact in one useful turn. Never mark independent verification as complete yourself.",
      criteria: [
        "A complete self-contained HTML guide is published with an entrypoint and testing limitations.",
      ],
      policy: {
        coordination: "coordinated",
        participation: "private",
        budget: { mode: "unlimited" },
      },
    },
  }));
  const review = await n.handle("reviewContribution", {
    mission,
    role: "coordinator",
  });
  const choice = await contributors.handle("chooseWorkspace", {});
  const result = await n.handle("prepareContribution", {
    reviewId: review.reviewId,
    workspaceChoiceId: choice.id,
    runtime,
    limits: { mode: "unlimited", concurrency: 1 },
  });
  contribution = result.contributions[0];
  await n.handle("shareAgent", {
    mission,
    contributionId: contribution.id,
    label: "Stargazing Coordinator (isolated proof)",
  });
  await n.handle("appointCoordinator", {
    mission,
    revision: mission,
    contributionId: contribution.id,
  });
  let view = (await n.state()).missions[0];
  ({ event: allocation } = await n.handle("govern", {
    mission,
    control: view.lifecycle.revision,
    action: { type: "allocate", node: owner, turns: null, slots: 1 },
  }));
  await manager.prepare(contribution.id);
  assert.equal(
    store.read(contribution.id).status,
    "ready",
    "Complete guest-native login first",
  );
  await permit("planning");
  view = (await n.state()).missions[0];
  assert.equal(view.lifecycle.phase, "preparing");
  assert.ok(
    view.lifecycle.readiness,
    "The real Coordinator must acknowledge its exact plan",
  );
  checks.push("real Coordinator plan/readiness while workers remain gated");
  const planningSession = store.read(contribution.id).session;
  await n.handle("startMission", {
    mission,
    revision: view.lifecycle.revision,
    readiness: view.lifecycle.readiness.id,
  });
  await permit("work");
  assert.equal(store.read(contribution.id).session, planningSession);
  checks.push(
    "human Start and native context resume across a new permission generation",
  );
  const artifacts = await n.handle("artifacts", { mission, query: {} });
  const application = artifacts.items.find(
    (a) =>
      a.kind === "application" &&
      a.stage === "complete" &&
      a.entrypoint === "index.html",
  );
  assert.ok(application, "The executing agent must publish its HTML artifact");
  assert.equal(application.accepted, false);
  const html = await n.readArtifactFile({
    mission,
    revision: application.revision,
    path: "index.html",
  });
  assert.match(html.toString(), /<!doctype html|<html/i);
  assert.match(html.toString(), /quiz/i);
  writeFileSync(join(root, "index.html"), html, { mode: 0o600 });
  checks.push(
    "agent-authored HTML artifact retrieved as exact verified bytes; human acceptance remains separate",
  );
  const ledger = await n.handle("governance", { mission });
  assert.ok(
    ledger.reservations.every((r) => r.stopped && r.used === 1 && r.receipt),
  );
  assert.equal(ledger.allocations[0].reserved, 0);
  checks.push(
    "real turns charged once, VM termination confirmed and permissions sealed",
  );
  writeFileSync(
    join(root, "result.json"),
    JSON.stringify(
      { at: new Date().toISOString(), mission, checks, application, ledger },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log("PASS", root, checks);
} finally {
  await n.close();
  writeFileSync(
    `var/node/g5/last-mission-${runtime}.json`,
    JSON.stringify({ root, mission, checks }, null, 2),
    { mode: 0o600 },
  );
}
