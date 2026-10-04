// Run with Electron for real OS-protected node identities. Requires explicit
// --run, three already authenticated disposable guests, and paid subscription
// use. A single operator/Mac rehearsal cannot satisfy the distributed G6 gate.
import { app, safeStorage, protocol } from "electron";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ExecutionStore } from "../../desktop/execution/store.mjs";
import { ExecutionManager } from "../../desktop/execution/manager.mjs";
import { LimaProvider } from "../../desktop/execution/lima.mjs";
import { exportWorkspace } from "../../desktop/execution/files.mjs";
import { createArtifactViewer } from "../../desktop/artifact-viewer.mjs";
import {
  runtimePolicy,
  policyDigest,
} from "../../desktop/execution/contract.mjs";
import {
  applyDisruption,
  checkPlan,
  deliveryPaths,
} from "../../experiments/community-day/check.mjs";
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

assert.ok(
  process.argv.includes("--run"),
  "Use --run to opt into real Grok subscription calls.",
);
const root = resolve(`var/experiments/g6/live-${randomUUID()}`);
const resumeIndex = process.argv.indexOf("--continue-from");
const previousRoot =
  resumeIndex === -1 ? null : resolve(process.argv[resumeIndex + 1] || ".");
if (previousRoot) {
  assert.equal(dirname(previousRoot), resolve("var/experiments/g6"));
  assert.match(previousRoot.split("/").at(-1), /^live-[a-f0-9-]{36}$/);
  assert.ok(
    existsSync(join(previousRoot, "result.json")),
    "Previous driver must have finished cleanup.",
  );
}
// Continuations keep identities, journals and native sessions, but write a new
// evidence bundle. Never splice a changed implementation into an earlier run.
const previousManifest = previousRoot
  ? JSON.parse(readFileSync(join(previousRoot, "manifest.json")))
  : null;
const profileRoot = previousManifest?.profile_root ?? previousRoot ?? root;
const reasonIndex = process.argv.indexOf("--continuation-reason");
const continuationReason =
  reasonIndex === -1
    ? "Resume after updating the idle guest broker with exact artifact import."
    : process.argv[reasonIndex + 1];
assert.ok(
  typeof continuationReason === "string" &&
    continuationReason.length > 0 &&
    continuationReason.length <= 2048,
);
if (previousManifest) {
  assert.equal(previousManifest.kind, "single-mac-live-rehearsal");
  assert.equal(dirname(profileRoot), resolve("var/experiments/g6"));
  assert.match(profileRoot.split("/").at(-1), /^live-[a-f0-9-]{36}$/);
  assert.equal(
    JSON.parse(readFileSync(join(previousRoot, "result.json"))).phases.length,
    0,
    "Continuation currently supports an unfinished baseline only.",
  );
}
mkdirSync(join(root, "app"), { recursive: true, mode: 0o700 });
app.setName("Harakiri Desktop");
app.setPath("userData", join(root, "app"));
app.on("window-all-closed", () => {});
protocol.registerSchemesAsPrivileged([
  {
    scheme: "harakiri-artifact",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
// Do not await readiness at module top level: Electron finishes loading this
// entry module before emitting ready. Schedule the driver after initialization.
app
  .whenReady()
  .then(async () => {
    const evidence = evidenceAt(root);
    const peers = ["A", "B", "C"].map((label) =>
      peer(profileRoot, label, safeStorage),
    );
    const [a, b, c] = peers;
    const viewer = createArtifactViewer(a.n, () => null);
    const layoutChecks = new Map();
    const config = JSON.parse(
      readFileSync("var/experiments/g6/vms.json", "utf8"),
    );
    assert.equal(config.version, 1);
    assert.match(config.directory, /^\/tmp\/hb-g6-[a-zA-Z0-9_-]+$/);
    assert.deepEqual(
      config.participants.map((p) => p.label),
      ["A", "B", "C"],
    );
    const inputs = JSON.parse(
      readFileSync("experiments/community-day/baseline.json"),
    );
    const change = JSON.parse(
      readFileSync("experiments/community-day/disruption.json"),
    );
    const brief = readFileSync("experiments/community-day/brief.md", "utf8");
    let mission;
    let ending = false;
    let ownsLock = false;
    let cleanupFailed = false;
    const lock = resolve("var/experiments/g6/live.lock");
    const result = {
      kind: "single-mac-live-rehearsal",
      computers: 1,
      independent_operators: 1,
      runtime: "grok",
      budget: "unlimited",
      g6_exit: "pending",
      phases: [],
      continuation_of: previousRoot,
    };
    const view = (p = a) => current(p.n, mission);
    const ledger = (p = a) => p.n.handle("governance", { mission });
    const govern = async (p, action) =>
      p.n.handle("govern", {
        mission,
        control: (await view(p)).lifecycle.revision,
        action,
      });
    const sourceFiles = [
      "experiments/community-day/brief.md",
      "experiments/community-day/baseline.json",
      "experiments/community-day/disruption.json",
      "experiments/community-day/check.mjs",
      "tests/experiments/g6-live.mjs",
      "tests/experiments/g6-support.mjs",
      "desktop/execution/guest/agent.md",
      "desktop/execution/guest/bridge.py",
      "desktop/execution/guest/artifact_io.py",
      "desktop/execution/tools.mjs",
      "desktop/artifact-viewer.mjs",
      "desktop/artifact-layout.mjs",
    ];
    evidence.save("manifest.json", {
      ...result,
      profile_root: profileRoot,
      at: new Date().toISOString(),
      node: process.version,
      electron: process.versions.electron,
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      working_tree_diff_sha256: sha256(execFileSync("git", ["diff"])),
      files: Object.fromEntries(
        sourceFiles.map((p) => [p, sha256(readFileSync(p))]),
      ),
      policy: runtimePolicy("grok"),
      policy_digest: policyDigest("grok"),
      limitations: [
        "One Mac, one operator and subscription account; not an independent-contributor trial.",
        "Direct local Iroh links do not exercise NAT, alternate relays or sleep/wake.",
        "Live baseline and input-change phases; other fault proofs are separately labeled protocol/VM tests.",
        "No matched single-agent baseline or measured model billing; no efficiency claim.",
      ],
    });
    console.log(`Private live evidence: ${root}`);

    async function stopAll(reason) {
      const stopped = await Promise.allSettled(
        peers
          .filter((p) => p.manager && p.agent)
          .map((p) => p.manager.stop(p.agent.contribution.id, reason)),
      );
      for (const [i, s] of stopped.entries())
        if (s.status === "rejected")
          evidence.record("stop_failed", { index: i, error: s.reason.message });
    }
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => {
        ending = true;
        evidence.record("operator_interrupt", { signal });
        void stopAll("Experiment interrupted by operator.");
      });

    async function permit(p, purpose, recovery = 0) {
      const context = await p.agent.channel.request({ type: "context" });
      const previous = (await ledger()).grants
        .filter((g) => g.registration === context.agent.id)
        .at(-1);
      if (previous)
        assert.ok(
          previous.sealed,
          "Previous permission must be sealed before resume.",
        );
      const duration = purpose === "planning" ? 14 * 60000 : 30 * 60000;
      const grant = (
        await govern(a, {
          type: "grant",
          purpose,
          previous: previous?.seal ?? null,
          allocation: p.allocation,
          registration: context.agent.id,
          direction:
            purpose === "planning"
              ? context.lifecycle.revision
              : context.agent.direction.id,
          execution: previous?.execution ?? randomBytes(32).toString("hex"),
          generation: previous ? previous.generation + 1 : 1,
          turns: 1,
          expires_ms: Date.now() + duration,
          offline_ms: duration - 10000,
        })
      ).event;
      await until(
        async () => (await ledger(p)).grants.some((g) => g.id === grant),
        "permission reaches contributor",
      );
      await p.n.handle("consentGrant", {
        mission,
        grant,
        contributionId: p.agent.contribution.id,
      });
      evidence.record("execution_permitted", { peer: p.label, grant, purpose });
      await p.manager.start(p.agent.contribution.id, grant);
      await until(
        async () => {
          if (ending) throw new Error("Operator interrupted experiment.");
          const record = p.store.read(p.agent.contribution.id);
          if (["failed", "recovery_required"].includes(record.status))
            throw new Error(`${p.label}: ${record.reason}`);
          return record.status === "stopped";
        },
        `${p.label} completes and confirms termination`,
        duration + 60000,
      );
      const journal = p.store.read(p.agent.contribution.id);
      evidence.record("execution_stopped", {
        peer: p.label,
        grant,
        generation: journal.generation,
        receipt: journal.receipt,
        reason: journal.reason,
        interruption: journal.interruption ?? null,
      });
      await until(
        async () => (await ledger()).grants.find((g) => g.id === grant)?.sealed,
        "sealed permission reaches owner",
      );
      if (journal.interruption?.code === "direction_changed") {
        assert.ok(
          recovery < 2,
          "Repeated direction changes exceeded the supervised recovery limit.",
        );
        assert.ok(
          journal.session,
          "Interrupted work did not preserve a native session.",
        );
        evidence.record("operator_recovery_approval", {
          peer: p.label,
          previous_grant: grant,
          interruption: journal.interruption,
          session: journal.session,
          attempt: recovery + 1,
          reason:
            "Supervisor explicitly approves a new bounded permission after confirmed termination. Production contributors must approve locally.",
        });
        return permit(p, purpose, recovery + 1);
      }
    }

    async function outputFor(input, inputArtifact) {
      const page = await a.n.handle("artifacts", { mission, query: {} });
      for (const artifact of page.items.filter(
        (x) => x.kind === "application" && x.stage === "complete" && !x.stale,
      )) {
        const detail = await a.n.handle("artifactDetail", {
          mission,
          revision: artifact.revision,
        });
        const paths = deliveryPaths(detail.document);
        if (!paths || !detail.document.inputs.includes(inputArtifact)) continue;
        let evaluation;
        try {
          const schedule = JSON.parse(
            await a.n.readArtifactFile({
              mission,
              revision: artifact.revision,
              path: paths.schedule,
            }),
          );
          const budget = JSON.parse(
            await a.n.readArtifactFile({
              mission,
              revision: artifact.revision,
              path: paths.budget,
            }),
          );
          evaluation = checkPlan(input, schedule, budget);
        } catch (error) {
          evaluation = {
            passed: false,
            errors: [{ code: "invalid_json", detail: error.message }],
          };
        }
        evidence.record("outcome_checked", {
          revision: artifact.revision,
          evaluation,
        });
        if (!layoutChecks.has(artifact.revision)) {
          const inspection = await viewer.inspect(
            {
              mission,
              revision: artifact.revision,
              path: detail.document.entrypoint,
            },
            detail,
          );
          layoutChecks.set(artifact.revision, inspection);
          evidence.save(`layout-${artifact.revision}.json`, inspection);
          const failed = inspection.checks.some(
            (x) =>
              x.documentWidth > x.viewport || x.errors.length || x.nodeAccess,
          );
          await a.n.handle("artifactAction", {
            mission,
            control: (await view()).lifecycle.revision,
            conversation: detail.artifact.conversation,
            action: {
              type: "review",
              revision: artifact.revision,
              verdict: failed ? "changes_requested" : "inconclusive",
              summary:
                "Operator's bounded layout measurement. Content, interactions and visual quality need separate review.",
              conditions: `${inspection.engine}. ${inspection.limitations}`,
              checks: inspection.checks.map((x) => ({
                method: "browser_check",
                result:
                  x.documentWidth > x.viewport ||
                  x.errors.length ||
                  x.nodeAccess
                    ? "failed"
                    : "passed",
                details: Buffer.from(
                  `${x.viewport}px viewport; ${x.documentWidth}px document. Errors: ${x.errors.join("; ")}. Overflow: ${x.overflow.map((e) => `${e.tag} ${e.id}: ${e.text}`).join("; ")}`,
                )
                  .subarray(0, 1000)
                  .toString("utf8"),
              })),
              evidence: [],
            },
          });
          evidence.record("operator_intervention", {
            reason:
              "Published exact-revision desktop/phone layout measurements; no acceptance or agent browser access.",
            revision: artifact.revision,
            failed,
          });
        }
        const layout = layoutChecks.get(artifact.revision);
        const layoutPassed = layout.checks.every(
          (x) =>
            x.documentWidth <= x.viewport && !x.errors.length && !x.nodeAccess,
        );
        let handoff = null;
        for (const item of page.items.filter(
          (x) => x.kind === "report" && x.stage === "complete" && !x.stale,
        )) {
          const report = await a.n.handle("artifactDetail", {
            mission,
            revision: item.revision,
          });
          if (
            report.document.inputs.includes(inputArtifact) &&
            report.document.inputs.includes(artifact.revision)
          ) {
            handoff = item.revision;
            break;
          }
        }
        if (
          evaluation.passed &&
          layoutPassed &&
          handoff &&
          detail.reviews.some(
            (r) =>
              r.verdict === "verified" &&
              !r.self_review &&
              !r.stale &&
              r.checks.some(
                (check) =>
                  check.method === "executed_tests" &&
                  check.result === "passed",
              ),
          )
        )
          return { artifact, detail, evaluation, handoff, layout };
      }
      return null;
    }

    async function workPhase(input, inputArtifact) {
      // Bounded observation rounds avoid an unattended endless experiment while
      // preserving an unlimited mission budget. Every new turn is a fresh grant.
      for (let round = 1; round <= 4; round++) {
        evidence.record("round_started", { input: input.revision, round });
        // Direction changes invalidate work permissions. Let the Coordinator
        // finish directing the round before approving parallel worker turns.
        await permit(a, "work");
        const runs = await Promise.allSettled(
          [b, c].map(async (p) => {
            try {
              await permit(p, "work");
            } catch (error) {
              await stopAll(
                "A participant failed; preserve the interrupted round.",
              );
              throw error;
            }
          }),
        );
        const failed = runs.find((r) => r.status === "rejected");
        if (failed) throw failed.reason;
        for (const p of peers)
          await snapshot(p, mission, evidence, `${input.revision}-${round}`);
        const output = await outputFor(input, inputArtifact);
        if (output) return output;
        await a.n.handle("postMessage", {
          mission,
          text: "Experiment checkpoint: continue the current plan. Final application must include schedule.json, budget.json, offline HTML and a Python checker, cite the current input artifact, and receive an independent exact-version review with executed_tests scope and honest environment/results. Read the operator's exact-revision layout findings and fix any overflow or browser errors. Publish a complete report handoff whose inputs include both current input and application revisions. Keep human-facing times and costs readable, technical IDs secondary. Use messages for updated review targets within the existing direction. Report blockers honestly.",
        });
        evidence.record("operator_intervention", {
          reason:
            "No independently reviewed, machine-valid complete deliverable after this round.",
          round,
        });
      }
      throw new Error(
        `No qualifying ${input.revision} deliverable in four observation rounds. Preserve the failure; do not fabricate success.`,
      );
    }

    async function saveArtifacts() {
      let after = null;
      do {
        const page = await a.n.handle("artifacts", {
          mission,
          query: { after },
        });
        for (const item of page.items) {
          const detail = await a.n.handle("artifactDetail", {
            mission,
            revision: item.revision,
          });
          for (const version of detail.history) {
            const revision = await a.n.handle("artifactDetail", {
              mission,
              revision: version.id,
            });
            evidence.save(`artifact-${version.id}.json`, revision);
            for (const f of revision.document.files) {
              // Protocol-validated paths; also reject traversal at this host boundary.
              assert.ok(
                f.path
                  .split("/")
                  .every(
                    (s) => s && s !== "." && s !== ".." && !s.includes("\\"),
                  ),
              );
              const path = join(root, "artifacts", version.id, f.path);
              mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
              const bytes = await a.n.readArtifactFile({
                mission,
                revision: version.id,
                path: f.path,
              });
              writeFileSync(path, bytes, { mode: 0o600 });
              evidence.record("artifact_file_saved", {
                revision: version.id,
                path: f.path,
                size: bytes.length,
                sha256: sha256(bytes),
              });
            }
          }
        }
        after = page.after;
      } while (after);
    }

    try {
      // The fixture VM set must never serve two experiment drivers at once. A
      // crashed driver leaves this lock for explicit inspection, not auto-reuse.
      mkdirSync(lock, { mode: 0o700 });
      ownsLock = true;
      writeFileSync(
        join(lock, "owner.json"),
        JSON.stringify({ pid: process.pid, root }),
        { mode: 0o600 },
      );
      // Authentication is checked before creating a mission or making a paid call.
      for (const p of peers) {
        const logs = join(root, p.label);
        mkdirSync(logs, { recursive: true, mode: 0o700 });
        const fixture = config.participants.find((v) => v.label === p.label);
        assert.equal(fixture.contribution.runtime, "grok");
        p.provider = new LimaProvider({ directory: config.directory });
        const instance = p.provider.instance(fixture.contribution.id);
        p.provider.instance = () => instance; // Reuse only this same guest's login.
        if ((await p.provider.vm(fixture.contribution.id)).running)
          assert.ok(
            (await p.provider.inspect({ contribution: fixture.contribution }))
              .stopped,
            `${p.label}: another execution is active; do not take its VM.`,
          );
        p.claimed = true;
        await p.provider.boot(fixture.contribution.id);
        const guestState = await p.provider.inspect({
          contribution: fixture.contribution,
        });
        assert.ok(
          guestState.stopped,
          `${p.label}: guest execution must be stopped before preparation.`,
        );
        assert.ok(
          guestState.authenticated,
          `${p.label}: sign in inside its test guest first.`,
        );
        if (!previousRoot) {
          // Keep the guest's own login but never seed a fresh trial with the
          // earlier agents' output. Preserve that workspace inside the guest.
          const archive = `/var/lib/harakiri/test-workspaces/${root.split("/").at(-1)}`;
          await p.provider.guest(fixture.contribution.id, [
            "python3",
            "-c",
            "import os,pwd,stat,sys\np='/workspace'; d=sys.argv[1]\nassert stat.S_ISDIR(os.lstat(p).st_mode)\nos.makedirs(os.path.dirname(d), mode=0o700, exist_ok=True)\nassert not os.path.exists(d)\nos.rename(p,d)\nos.mkdir(p,0o700)\nu=pwd.getpwnam('hb-worker'); os.chown(p,u.pw_uid,u.pw_gid)",
            archive,
          ]);
          evidence.record("previous_workspace_preserved", {
            peer: p.label,
            guest_archive: archive,
            new_workspace: "empty",
            native_session: "new",
          });
        }
        await p.provider.terminate({ contribution: fixture.contribution });
        const launch = p.provider.launch.bind(p.provider);
        let loggedBytes = 0;
        p.provider.launch = async (request) => {
          appendFileSync(
            join(logs, "prompts.jsonl"),
            JSON.stringify({
              at: new Date().toISOString(),
              prompt: request.prompt,
            }) + "\n",
            { mode: 0o600 },
          );
          return launch({
            ...request,
            onEvent(event) {
              const line =
                JSON.stringify({ at: new Date().toISOString(), event }) + "\n";
              loggedBytes += Buffer.byteLength(line);
              if (loggedBytes > 64 * 1024 * 1024)
                throw new Error(
                  "Raw evidence cap reached; stop instead of discarding runtime logs.",
                );
              appendFileSync(join(logs, "runtime-events.jsonl"), line, {
                mode: 0o600,
              });
              request.onEvent(event);
            },
          });
        };
        await p.n.handle("enroll", {});
        await p.n.handle("configureNetwork", { config: network });
      }
      await a.n.handle("configureDiscovery", { config: discovery });
      const ticket = (await a.n.handle("discoveryState", {})).peer_ticket;
      for (const p of [b, c])
        await p.n.handle("configureDiscovery", {
          config: { ...discovery, bootstrap: [ticket] },
        });
      if (previousRoot) {
        mission = JSON.parse(readFileSync(join(previousRoot, "final-A.json")))
          .mission.id;
        assert.equal(
          (await view()).lifecycle.phase,
          "active",
          "Continue an active unfinished rehearsal only.",
        );
      } else
        ({ mission } = await a.n.handle("createMission", {
          definition: {
            name: "Community Science Day · Grok live rehearsal",
            objective:
              "Plan the Community Science Day from the authoritative Event inputs artifact. Deliver schedule.json, budget.json, a tested Python checker, and an independently reviewed offline HTML guide.",
            scope: brief,
            criteria: [
              "All eight activities satisfy the current scheduling constraints",
              "Accurate event budget with reserve stays within $900",
              "Python checker rejects invalid schedules and documents testing",
              "Usable offline HTML guide contains exact JSON and checker files",
              "Independent review and current artifact lineage after the venue change",
            ],
            policy: {
              coordination: "coordinated",
              participation: "approval",
              budget: { mode: "unlimited" },
            },
          },
        }));
      if (!previousRoot)
        await a.n.handle("publishListing", {
          mission,
          summary: "Local community-day rehearsal",
          capabilities: ["Scheduling", "Validation", "HTML"],
          active: true,
        });
      if (!previousRoot)
        for (const p of [b, c]) await joinDiscovered(a, p, mission);
      const savedInputs = previousRoot
        ? JSON.parse(
            readFileSync(join(previousRoot, "final-A.json")),
          ).artifacts.filter((x) => x.title === "Event inputs")
        : [];
      if (previousRoot)
        assert.equal(
          savedInputs.length,
          1,
          "Continue only an unfinished baseline; do not silently replace revised input.",
        );
      const input = previousRoot
        ? savedInputs[0].revision
        : await publish(a.n, mission, {
            title: "Event inputs",
            path: "input.json",
            bytes: Buffer.from(JSON.stringify(inputs, null, 2)),
          });
      for (const p of peers) {
        if (previousRoot) {
          const contributions = p.contributors.store
            .read()
            .contributions.filter((c) => c.mission.missionId === mission);
          assert.equal(
            contributions.length,
            1,
            "Expected one original contribution per participant.",
          );
          p.agent = {
            contribution: contributions[0],
            channel: p.n.openAgentChannel(contributions[0].id),
          };
        } else
          p.agent = await prepareAgent(
            p,
            mission,
            p === a ? "coordinator" : "agent",
          );
        p.store = new ExecutionStore(join(p.directory, "execution"));
        p.manager = new ExecutionManager({
          store: p.store,
          provider: p.provider,
          node: p.n,
          exportWorkspace,
          pollMs: 1000,
        });
        p.n.executions = p.manager;
        if (previousRoot) {
          const identity = (await p.n.state()).identity.owner;
          const allocations = (await ledger()).allocations.filter(
            (x) => x.node === identity,
          );
          assert.equal(allocations.length, 1);
          p.allocation = allocations[0].id;
          const prior = p.store.read(p.agent.contribution.id);
          assert.equal(
            prior.status,
            "stopped",
            "Confirm prior termination before upgrading the guest.",
          );
          evidence.record("contribution_continued", {
            peer: p.label,
            contribution: p.agent.contribution.id,
            session: prior.session,
            generation: prior.generation,
            receipt: prior.receipt,
          });
        } else
          p.allocation = (
            await govern(a, {
              type: "allocate",
              node: (await p.n.state()).identity.owner,
              turns: null,
              slots: 1,
            })
          ).event;
        await p.manager.prepare(p.agent.contribution.id);
        assert.equal(p.store.read(p.agent.contribution.id).status, "ready");
      }
      await until(
        async () =>
          (await a.n.handle("agents", { mission })).items.length === 3,
        "three Grok contributions shared",
      );
      if (!previousRoot) {
        await a.n.handle("appointCoordinator", {
          mission,
          revision: (await view()).lifecycle.revision,
          contributionId: a.agent.contribution.id,
        });
        await permit(a, "planning");
        const prepared = await view();
        assert.ok(
          prepared.lifecycle.readiness,
          "Real Coordinator must record its own readiness.",
        );
        await a.n.handle("startMission", {
          mission,
          revision: prepared.lifecycle.revision,
          readiness: prepared.lifecycle.readiness.id,
        });
        for (const p of [b, c])
          await until(
            async () => (await view(p)).lifecycle.phase === "active",
            "human Start replication",
          );
      } else {
        await a.n.handle("postMessage", {
          mission,
          text: `Operator continuation after a confirmed stop: ${continuationReason} The scoped import_artifact tool transfers exact files into the workspace. Preserve existing artifact identities and continue the current plan. All previous outputs and this intervention remain in the experiment evidence.`,
        });
        evidence.record("operator_intervention", {
          reason: continuationReason,
          previous: previousRoot,
        });
      }
      const baseline =
        (await outputFor(inputs, input)) ?? (await workPhase(inputs, input));
      result.phases.push({
        input: "baseline",
        revision: baseline.artifact.revision,
        objective_checks: "passed",
        independent_agent_review: true,
        layout_checks: "passed",
        handoff: baseline.handoff,
      });
      const revisedInput = await publish(a.n, mission, {
        title: "Event inputs · venue changed",
        path: "input.json",
        bytes: Buffer.from(
          JSON.stringify(applyDisruption(inputs, change), null, 2),
        ),
        artifact: input,
        parents: [input],
      });
      await a.n.handle("postMessage", {
        mission,
        text: `${change.announcement}\nAuthoritative input revision: ${revisedInput}`,
      });
      evidence.record("operator_disruption", {
        previous: input,
        revision: revisedInput,
        announcement: change.announcement,
      });
      const final = await workPhase(
        applyDisruption(inputs, change),
        revisedInput,
      );
      result.phases.push({
        input: "venue-change",
        revision: final.artifact.revision,
        objective_checks: "passed",
        independent_agent_review: true,
        layout_checks: "passed",
        handoff: final.handoff,
      });
      result.outcome = "awaiting_human_visual_review";
      result.final_revision = final.artifact.revision;
      result.next =
        "Inspect the exact HTML and run the delivered checker inside an isolated guest. No automatic human acceptance or G6 completion.";
    } catch (error) {
      result.outcome = "stopped_with_failure";
      result.error = error.message;
      console.error(error);
      process.exitCode = 1;
    } finally {
      viewer.close();
      await stopAll("Local rehearsal finished; retain all evidence.");
      if (mission) {
        await saveArtifacts().catch((error) =>
          evidence.record("artifact_export_failed", { error: error.message }),
        );
        for (const p of peers)
          await snapshot(p, mission, evidence, "final").catch((error) =>
            evidence.record("snapshot_failed", {
              peer: p.label,
              error: error.message,
            }),
          );
      }
      for (const p of peers) {
        await p.manager?.close();
        await p.n.close();
        if (p.provider && p.claimed) {
          const fixture = config.participants.find((v) => v.label === p.label);
          await p.provider
            .terminate({ contribution: fixture.contribution })
            .catch((error) => {
              cleanupFailed = true;
              evidence.record("vm_stop_failed", {
                peer: p.label,
                error: error.message,
              });
            });
        }
      }
      if (ownsLock && !cleanupFailed) rmSync(lock, { recursive: true });
      if (cleanupFailed) {
        result.outcome = "stop_unconfirmed";
        result.next =
          "Inspect the saved journals and confirm VM termination before releasing the live-run lock.";
        process.exitCode = 1;
      }
      evidence.save("result.json", result);
      console.log(
        `Result: ${result.outcome}; G6 exit remains pending. Evidence: ${root}`,
      );
      app.exit(process.exitCode || 0);
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
