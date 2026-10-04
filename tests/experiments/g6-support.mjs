import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { NodeService } from "../../desktop/node-service.mjs";
import { ContributorService } from "../../desktop/service.mjs";
import { DesktopStore } from "../../desktop/store.mjs";

export const network = { mode: "direct", relays: [], allow_lan: true };
export const discovery = {
  enabled: true,
  lan: false,
  bootstrap: [],
  blocked: [],
};
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export function evidenceAt(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const timeline = join(root, "timeline.jsonl");
  writeFileSync(timeline, "", { mode: 0o600, flag: "wx" });
  let previous = null;
  let sequence = 0;
  const record = (type, detail) => {
    const body = {
      sequence: ++sequence,
      at: new Date().toISOString(),
      previous,
      type,
      detail,
    };
    const hash = sha256(JSON.stringify(body));
    appendFileSync(timeline, JSON.stringify({ ...body, hash }) + "\n", {
      mode: 0o600,
    });
    previous = hash;
    return body;
  };
  return {
    root,
    record,
    save(name, value) {
      assert.match(name, /^[a-zA-Z0-9_-]+\.json$/);
      writeFileSync(join(root, name), JSON.stringify(value, null, 2) + "\n", {
        mode: 0o600,
      });
    },
    async check(name, operation) {
      const begin = performance.now();
      record("check_started", { name });
      try {
        const result = await operation();
        record("check_passed", {
          name,
          elapsed_ms: Math.round(performance.now() - begin),
          result: result ?? null,
        });
        console.log(`PASS ${name}`);
        return result;
      } catch (error) {
        record("check_failed", {
          name,
          elapsed_ms: Math.round(performance.now() - begin),
          error: error.message,
        });
        throw error;
      }
    },
  };
}

export async function until(check, description, timeout = 45000) {
  const begin = performance.now();
  while (performance.now() - begin < timeout) {
    const value = await check();
    if (value)
      return {
        value,
        observed_after_ms: Math.round(performance.now() - begin),
      };
    await delay(150);
  }
  throw new Error(`Timed out: ${description}`);
}

export function peer(root, label, secureStorage) {
  const directory = join(root, label);
  const workspace = join(directory, "workspace");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const contributors = new ContributorService({
    store: new DesktopStore(join(directory, "contributor")),
    chooseDirectory: async () => workspace,
    revealDirectory: async () => {},
  });
  const start = () => {
    const n = new NodeService({
      directory: join(directory, "node"),
      binary: resolve("var/node/target/debug/harakiri-node"),
      secureStorage,
    });
    n.contributors = contributors;
    return n;
  };
  const p = { label, directory, n: start(), contributors };
  p.restart = async () => {
    await p.n.close();
    p.n = start();
    await p.n.state();
    if (p.agent)
      p.agent.channel = p.n.openAgentChannel(p.agent.contribution.id);
  };
  return p;
}

export async function joinDiscovered(owner, member, mission) {
  const { value: listing } = await until(
    async () =>
      (await member.n.handle("discoveryState", {})).listings.find(
        (l) => l.advertisement.mission === mission,
      ),
    "advertised mission discovery",
  );
  const review = await member.n.handle("inspectInvitation", {
    ticket: listing.reference,
  });
  assert.equal(
    (await member.n.state()).missions.length,
    0,
    "Inspection must not join.",
  );
  await member.n.handle("requestJoin", {
    ticket: listing.reference,
    reviewed_mission: mission,
    reviewed_revision: review.reviewed_revision,
  });
  const author = (await member.n.state()).identity.owner;
  await until(
    async () =>
      (await owner.n.handle("peers", { mission })).requests.some(
        (r) => r.author === author,
      ),
    "owner receives admission request",
  );
  assert.equal(
    (await member.n.state()).missions.length,
    0,
    "Request must await admission.",
  );
  await owner.n.handle("decideJoin", { mission, author, admit: true });
  await until(
    async () =>
      (await member.n.state()).joins.some((j) => j.status === "admitted"),
    "explicit admission",
  );
}

export async function prepareAgent(
  p,
  mission,
  role = "agent",
  limits = { mode: "unlimited", concurrency: 1 },
) {
  const review = await p.n.handle("reviewContribution", { mission, role });
  const choice = await p.contributors.handle("chooseWorkspace", {});
  const prepared = await p.n.handle("prepareContribution", {
    reviewId: review.reviewId,
    workspaceChoiceId: choice.id,
    runtime: "grok",
    limits,
  });
  const contribution = prepared.contributions[0];
  await p.n.handle("shareAgent", {
    mission,
    contributionId: contribution.id,
    label: `${p.label} ${role}`,
  });
  return { contribution, channel: p.n.openAgentChannel(contribution.id) };
}

export async function current(n, mission) {
  const value = (await n.state()).missions.find((m) => m.id === mission);
  assert.ok(value, "Mission missing from authorized history");
  return value;
}

export async function publish(
  n,
  mission,
  {
    title,
    path,
    bytes,
    artifact = null,
    parents = [],
    inputs = [],
    kind = "data",
    entrypoint = null,
    channel = null,
  },
) {
  const control = (await current(n, mission)).lifecycle.revision;
  const call = (transfer) =>
    channel
      ? channel.request({ type: "artifact_transfer", transfer })
      : n.handle("artifactTransfer", { mission, transfer });
  const { upload } = await call({
    type: "begin",
    control,
    conversation: "main",
    path,
    media_type: path.endsWith(".html") ? "text/html" : "application/json",
    size: bytes.length,
  });
  for (let offset = 0; offset < bytes.length; offset += 48 * 1024)
    await call({
      type: "chunk",
      upload,
      offset,
      hex: bytes.subarray(offset, offset + 48 * 1024).toString("hex"),
    });
  return (
    await call({
      type: "publish",
      control,
      conversation: "main",
      artifact,
      parents,
      document: {
        title,
        summary: title,
        kind,
        stage: "complete",
        limitations: "Controlled experiment; no real event or bookings.",
        entrypoint,
        inputs,
        files: [],
      },
      uploads: [upload],
      retain: [],
    })
  ).event;
}

export async function snapshot(p, mission, evidence, stage) {
  // Private local evidence only. Do not copy authentication directories, VM
  // images, the OS key store, invitations, or native runtime sessions to reports.
  const missionView = await current(p.n, mission);
  const messages = [];
  let before = null;
  do {
    const page = await p.n.handle("messages", {
      mission,
      audience: "main",
      before,
    });
    messages.push(...page.items);
    before = page.before ?? null;
  } while (before);
  const artifacts = [];
  let after = null;
  do {
    const page = await p.n.handle("artifacts", { mission, query: { after } });
    artifacts.push(...page.items);
    after = page.after ?? null;
  } while (after);
  evidence.save(`${stage}-${p.label}.json`, {
    mission: missionView,
    messages,
    artifacts,
    governance: await p.n.handle("governance", { mission }),
    peers: await p.n.handle("peers", { mission }),
    network: await p.n.handle("networkState", {}),
    workstreams: await p.n.handle("workstreams", { mission }),
  });
}
