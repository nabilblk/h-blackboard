// Three real native services and real Iroh transport; scripted agent records.
// No model calls or VM execution. Kept separate from the live-agent experiment.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { secureStorage } from "../helpers/secure-storage.mjs";
import { AgentOperation, NodeRequests } from "../../desktop/node-service.mjs";
import { applyDisruption } from "../../experiments/community-day/check.mjs";
import {
  evidenceAt,
  peer,
  until,
  network,
  discovery,
  joinDiscovered,
  prepareAgent,
  current,
  publish,
  snapshot,
  sha256,
} from "./g6-support.mjs";

const root = resolve(`var/experiments/g6/rehearsal-${randomUUID()}`);
const evidence = evidenceAt(root);
const storage = secureStorage();
const peers = ["A", "B", "C"].map((label) => peer(root, label, storage));
const [a, b, c] = peers;
const bytes = readFileSync("experiments/community-day/baseline.json");
const baseline = JSON.parse(bytes);
const change = JSON.parse(
  readFileSync("experiments/community-day/disruption.json"),
);
let mission;
const view = (p = a) => current(p.n, mission);
const ledger = (p = a) => p.n.handle("governance", { mission });
const govern = async (p, action) =>
  p.n.handle("govern", {
    mission,
    control: (await view(p)).lifecycle.revision,
    action,
  });
const report = {
  kind: "single-computer-protocol-rehearsal",
  independent_operators: 1,
  computers: 1,
  native_nodes: 3,
  real_model_calls: 0,
  g6_exit: "pending",
  limitations: [
    "Scripted agent messages and host accounting fixtures; no real model reasoning or VM stop proof.",
    "Test keyring in memory; this run does not test macOS Keychain recovery.",
    "Direct local networking; NAT, alternate relays and independent human consent remain untested.",
  ],
};
evidence.save("manifest.json", {
  ...report,
  at: new Date().toISOString(),
  node: process.version,
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  working_tree_diff_sha256: sha256(execFileSync("git", ["diff"])),
  input_sha256: sha256(bytes),
  budget: { mode: "unlimited" },
});
console.log(`Evidence: ${root}`);
try {
  await evidence.check(
    "advertise, discover, review and explicitly admit three profiles",
    async () => {
      for (const p of peers) {
        await p.n.handle("enroll", {});
        await p.n.handle("configureNetwork", { config: network });
      }
      await a.n.handle("configureDiscovery", { config: discovery });
      const aTicket = (await a.n.handle("discoveryState", {})).peer_ticket;
      await b.n.handle("configureDiscovery", {
        config: { ...discovery, bootstrap: [aTicket] },
      });
      const bTicket = (await b.n.handle("discoveryState", {})).peer_ticket;
      await c.n.handle("configureDiscovery", {
        config: { ...discovery, bootstrap: [bTicket] },
      });
      ({ mission } = await a.n.handle("createMission", {
        definition: {
          name: "Community Science Day · protocol rehearsal",
          objective:
            "Prepare a usable schedule, resource budget, checker and offline guide.",
          scope:
            "Isolated scripted protocol fixture. No paid model calls or real bookings.",
          criteria: [
            "Current inputs, exact deliverable and independent review preserved",
          ],
          policy: {
            coordination: "coordinated",
            participation: "approval",
            budget: { mode: "unlimited" },
          },
        },
      }));
      await a.n.handle("publishListing", {
        mission,
        summary: "Controlled community event experiment",
        capabilities: ["Scheduling", "Review"],
        active: true,
      });
      await joinDiscovered(a, b, mission);
      await joinDiscovered(a, c, mission);
      for (const p of peers) {
        p.agent = await prepareAgent(
          p,
          mission,
          p === a ? "coordinator" : "agent",
        );
        p.owner = (await p.n.state()).identity.owner;
      }
      await until(
        async () =>
          (await a.n.handle("agents", { mission })).items.length === 3,
        "three shared preparations",
      );
      for (const p of peers)
        assert.equal((await p.n.state()).execution, "unavailable");
    },
  );

  await evidence.check(
    "joining cannot start work; exact readiness and human Start required",
    async () => {
      await assert.rejects(
        b.agent.channel.request({
          type: "work",
          control: mission,
          action: {
            type: "create_workstream",
            name: "Premature",
            goal: "Must be denied",
          },
        }),
      );
      await assert.rejects(
        a.n.handle("startMission", {
          mission,
          revision: mission,
          readiness: null,
        }),
      );
      await a.n.handle("appointCoordinator", {
        mission,
        revision: mission,
        contributionId: a.agent.contribution.id,
      });
      const control = (await view()).lifecycle.revision;
      const plan = await a.agent.channel.request({
        type: "plan",
        control,
        text: "B makes the schedule; C checks it; Coordinator integrates the guide. Scripted fixture.",
      });
      await a.agent.channel.request({
        type: "ready",
        control,
        plan: plan.event,
      });
      const ready = (await view()).lifecycle.readiness.id;
      await a.n.handle("startMission", {
        mission,
        revision: control,
        readiness: ready,
      });
      for (const p of [b, c])
        await until(
          async () => (await view(p)).lifecycle.phase === "active",
          "human Start replication",
        );
      for (const p of peers) {
        const context = await p.agent.channel.request({ type: "context" });
        await p.agent.channel.request({
          type: "acknowledge",
          control: context.lifecycle.revision,
          direction: context.agent.direction.id,
        });
      }
    },
  );

  let input, output, revised;
  await evidence.check(
    "exact input revision change invalidates dependent evidence",
    async () => {
      input = await publish(a.n, mission, {
        title: "Event inputs",
        path: "input.json",
        bytes,
      });
      await until(
        async () =>
          (await b.n.handle("artifacts", { mission, query: {} })).items.some(
            (x) => x.revision === input,
          ),
        "input replication",
      );
      output = await publish(b.n, mission, {
        title: "Scripted guide fixture",
        path: "index.html",
        bytes: Buffer.from(
          "<!doctype html><h1>Protocol fixture, not an agent deliverable</h1>",
        ),
        inputs: [input],
        kind: "application",
        entrypoint: "index.html",
        channel: b.agent.channel,
      });
      await until(
        async () =>
          (await c.n.handle("artifacts", { mission, query: {} })).items.some(
            (x) => x.revision === output,
          ),
        "output replication",
      );
      assert.equal(
        (await c.n.handle("artifactDetail", { mission, revision: output }))
          .stale,
        false,
      );
      revised = await publish(a.n, mission, {
        title: "Event inputs · venue changed",
        path: "input.json",
        bytes: Buffer.from(JSON.stringify(applyDisruption(baseline, change))),
        artifact: input,
        parents: [input],
      });
      const observed = await until(
        async () =>
          (await c.n.handle("artifactDetail", { mission, revision: output }))
            .stale,
        "stale input evidence",
      );
      evidence.record("input_change_observed", {
        input,
        revised,
        dependent: output,
        ...observed,
      });
    },
  );

  await evidence.check(
    "B and C exchange messages and exact files with creator disconnected",
    async () => {
      await snapshot(a, mission, evidence, "before-partition");
      await a.n.close();
      evidence.record("creator_disconnected", {});
      const message = await b.agent.channel.request({
        type: "post",
        audience: "main",
        text: "B has the venue change; C can review while A is offline.",
      });
      await until(
        async () =>
          (await c.n.handle("messages", { mission })).items.some(
            (m) => m.id === message.event,
          ),
        "peer-to-peer message without creator",
      );
      const file = await c.n.readArtifactFile({
        mission,
        revision: output,
        path: "index.html",
      });
      assert.match(file.toString(), /Protocol fixture/);
      await assert.rejects(
        b.n.handle("pauseMission", {
          mission,
          revision: (await view(b)).lifecycle.revision,
          reason: "B cannot impersonate owner",
        }),
      );
      await a.restart();
      await until(
        async () =>
          (await a.n.handle("messages", { mission })).items.some(
            (m) => m.id === message.event,
          ),
        "creator catches up",
      );
      evidence.record("creator_reconnected", {});
    },
  );

  let grant, reservation, resource;
  await evidence.check(
    "unknown reservation survives restart without duplicate admission or free allowance",
    async () => {
      const allocation = (
        await govern(a, {
          type: "allocate",
          node: b.owner,
          turns: null,
          slots: 1,
        })
      ).event;
      const context = await b.agent.channel.request({ type: "context" });
      grant = (
        await govern(a, {
          type: "grant",
          previous: null,
          allocation,
          registration: context.agent.id,
          direction: context.agent.direction.id,
          execution: randomBytes(32).toString("hex"),
          generation: 1,
          turns: 2,
          expires_ms: Date.now() + 600000,
          offline_ms: 300000,
        })
      ).event;
      await until(
        async () => (await ledger(b)).grants.some((g) => g.id === grant),
        "permission replication",
      );
      resource = b.n.openResourceLedger(b.agent.contribution.id);
      await assert.rejects(resource.reserve({ grant, nonce: "11".repeat(32) }));
      await b.n.handle("consentGrant", {
        mission,
        grant,
        contributionId: b.agent.contribution.id,
      });
      reservation = await resource.reserve({ grant, nonce: "11".repeat(32) });
      await b.n.close();
      await b.restart();
      b.agent.channel = b.n.openAgentChannel(b.agent.contribution.id);
      resource = b.n.openResourceLedger(b.agent.contribution.id);
      assert.deepEqual(
        await resource.reserve({ grant, nonce: "11".repeat(32) }),
        reservation,
      );
      await assert.rejects(resource.reserve({ grant, nonce: "22".repeat(32) }));
      assert.equal((await ledger(b)).allocations[0].reserved, 1);
      await assert.rejects(resource.seal(grant));
    },
  );

  await evidence.check(
    "finite contributor allocation exhausts inside an unlimited mission",
    async () => {
      const allocation = (
        await govern(a, { type: "allocate", node: c.owner, turns: 1, slots: 1 })
      ).event;
      const context = await c.agent.channel.request({ type: "context" });
      const permission = (
        await govern(a, {
          type: "grant",
          previous: null,
          allocation,
          registration: context.agent.id,
          direction: context.agent.direction.id,
          execution: randomBytes(32).toString("hex"),
          generation: 1,
          turns: 2,
          expires_ms: Date.now() + 600000,
          offline_ms: 300000,
        })
      ).event;
      await until(
        async () => (await ledger(c)).grants.some((g) => g.id === permission),
        "finite permission replication",
      );
      await c.n.handle("consentGrant", {
        mission,
        grant: permission,
        contributionId: c.agent.contribution.id,
      });
      const cap = c.n.openResourceLedger(c.agent.contribution.id);
      const r = await cap.reserve({
        grant: permission,
        nonce: "33".repeat(32),
      });
      await cap.receipt({
        reservation: r.event,
        used: 1,
        stopped: true,
        summary: "Scripted accounting fixture; no real execution.",
      });
      await assert.rejects(
        cap.reserve({ grant: permission, nonce: "44".repeat(32) }),
      );
      await cap.seal(permission);
      assert.equal((await view()).definition.policy.budget.mode, "unlimited");
    },
  );

  await evidence.check(
    "handover to B waits for settlement and survives owner restart",
    async () => {
      const next = await prepareAgent(b, mission, "coordinator");
      const context = await next.channel.request({ type: "context" });
      await until(
        async () =>
          (await a.n.handle("agents", { mission })).items.some(
            (x) => x.id === context.agent.id,
          ),
        "candidate identity replicated",
      );
      assert.equal(context.agent.status, "waiting_for_appointment");
      await assert.rejects(
        next.channel.request({
          type: "plan",
          control: context.lifecycle.revision,
          text: "Cannot self-appoint",
        }),
      );
      await assert.rejects(
        b.n.handle("appointCoordinator", {
          mission,
          revision: context.lifecycle.revision,
          contributionId: next.contribution.id,
        }),
      );
      const action = {
        type: "handover",
        registration: context.agent.id,
        coordinator: {
          author: context.agent.identity.author,
          label: context.agent.identity.label,
          runtime: "grok",
        },
        settlements: [],
      };
      await assert.rejects(
        a.n.handle("missionAction", {
          mission,
          revision: (await view()).lifecycle.revision,
          action,
        }),
      );
      await until(
        async () =>
          (await ledger()).reservations.some((r) => r.id === reservation.event),
        "unknown reservation propagated",
      );
      await govern(a, {
        type: "resolve",
        reservation: reservation.event,
        reason:
          "Scripted unknown-usage exercise; no VM ran. Charge one whole turn without inventing a stop receipt.",
      });
      await govern(a, {
        type: "retire_grant",
        grant,
        reason:
          "Controlled fixture: explicitly accept missing stop evidence; no real execution exists.",
      });
      await until(
        async () => (await ledger()).handover_blockers.length === 0,
        "all permissions sealed",
      );
      const unresolved = (await ledger()).reservations.find(
        (r) => r.id === reservation.event,
      );
      assert.equal(
        unresolved.stopped,
        false,
        "Resolution is not proof of process termination",
      );
      assert.equal(
        unresolved.used,
        null,
        "Unknown usage must not become measured usage",
      );
      action.settlements = (await ledger()).grants.map((g) => g.seal);
      const control = (await view()).lifecycle.revision;
      await a.n.handle("missionAction", { mission, revision: control, action });
      await a.n.close();
      await a.restart();
      await assert.rejects(
        a.n.handle("missionAction", { mission, revision: control, action }),
        "Stale handover cannot replay",
      );
      await until(
        async () =>
          (await view(b)).lifecycle.coordinator.identity.author ===
          context.agent.identity.author,
        "handover replicated",
      );
      assert.equal((await view(b)).lifecycle.phase, "preparing");
      await assert.rejects(
        a.agent.channel.request({
          type: "plan",
          control: (await view()).lifecycle.revision,
          text: "Former Coordinator cannot plan",
        }),
      );
      await assert.rejects(
        a.n.handle("startMission", {
          mission,
          revision: (await view()).lifecycle.revision,
          readiness: null,
        }),
      );
      const revision = (await view(b)).lifecycle.revision;
      const plan = await next.channel.request({
        type: "plan",
        control: revision,
        text: "B coordinates the revised event; recheck all artifacts.",
      });
      await next.channel.request({
        type: "ready",
        control: revision,
        plan: plan.event,
      });
      await until(
        async () => !!(await view()).lifecycle.readiness,
        "fresh readiness replicated",
      );
      await a.n.handle("startMission", {
        mission,
        revision,
        readiness: (await view()).lifecycle.readiness.id,
      });
    },
  );

  await evidence.check(
    "untrusted content cannot become owner authority; exact revision review and acceptance",
    async () => {
      for (const operation of [
        { type: "start_mission", revision: mission },
        {
          type: "govern",
          control: mission,
          action: { type: "allocate", node: c.owner, turns: null, slots: 32 },
        },
        { type: "context", workspace: "/Users" },
      ])
        assert.equal(AgentOperation.safeParse(operation).success, false);
      assert.equal(
        NodeRequests.missionAction.safeParse({
          mission,
          revision: mission,
          action: {
            type: "handover",
            registration: mission,
            coordinator: { author: mission, label: "x", runtime: "grok" },
            settlements: Array(257).fill(mission),
          },
        }).success,
        false,
      );
      await until(
        async () => (await view(c)).lifecycle.phase === "active",
        "new Start replicated",
      );
      const latest = await publish(c.n, mission, {
        title: "Revised guide fixture",
        path: "index.html",
        bytes: Buffer.from(
          "<!doctype html><h1>Venue change · protocol fixture</h1>",
        ),
        artifact: output,
        parents: [output],
        inputs: [revised],
        kind: "application",
        entrypoint: "index.html",
        channel: c.agent.channel,
      });
      await until(
        async () =>
          (await a.n.handle("artifacts", { mission, query: {} })).items.some(
            (x) => x.revision === latest,
          ),
        "revised output arrives",
      );
      const control = (await view()).lifecycle.revision;
      await a.n.handle("artifactAction", {
        mission,
        control,
        conversation: "main",
        action: {
          type: "review",
          revision: latest,
          verdict: "verified",
          summary: "Verified only the protocol fixture bytes and lineage.",
          conditions: "No event quality or agent efficiency claim.",
          evidence: [],
        },
      });
      await a.n.handle("artifactAction", {
        mission,
        control,
        conversation: "main",
        action: {
          type: "accept",
          revision: latest,
          accepted: true,
          reason: "Accept this scripted protocol fixture only.",
        },
      });
      const detail = await a.n.handle("artifactDetail", {
        mission,
        revision: latest,
      });
      assert.equal(detail.stale, false);
      assert.equal(detail.acceptance.accepted, true);
      assert.equal(detail.history.length, 2);
      assert.equal(
        (await a.n.handle("artifactDetail", { mission, revision: output }))
          .acceptance,
        null,
      );
    },
  );
  report.rehearsal = "passed";
} catch (error) {
  report.rehearsal = "failed";
  report.error = error.message;
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const p of peers) {
    if (mission)
      await snapshot(p, mission, evidence, "final").catch((error) =>
        evidence.record("snapshot_failed", {
          peer: p.label,
          error: error.message,
        }),
      );
    await p.n.close();
  }
  evidence.save("result.json", report);
  console.log(
    `${report.rehearsal}. G6 remains pending independent computers, real operators and live fault checks.`,
  );
}
