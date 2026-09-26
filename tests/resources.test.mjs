import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Blackboard } from "../server/board.mjs";

function fixture(t, file = ":memory:") {
  const b = new Blackboard(file);
  t.after(() => b.close());
  const human = b.auth(b.ownerToken);
  const m = b.execute(
    human,
    "mission_create",
    {
      name: "Durable investigation",
      objective: "Produce reusable evidence",
      criteria: ["Evidence can be inspected"],
      coordination_mode: "peer",
    },
    randomUUID(),
  );
  const act = (a, op, p = {}, key = randomUUID()) =>
    b.execute(a, op, { channel_id: m.id, ...p }, key);
  const invite = act(human, "invitation_create");
  const agents = ["one", "two"].map((name) =>
    b.auth(b.join({ invitation: invite.token, name, runtime: "codex" }).token),
  );
  act(human, "mission_state", {
    version: b.get(m.id).version,
    state: "active",
    reason: "Start",
  });
  const policy = (limits = {}, rest = {}) =>
    act(human, "budget_update", {
      version: b.budgets.policy(m).version,
      limits,
      per_turn: { tokens: 100, costUsd: 1 },
      finalization_percent: 0,
      reason: "Set allowance",
      ...rest,
    });
  const publish = (a = agents[0], p = {}) =>
    act(a, "artifact_publish", {
      title: "Finding",
      summary: "Reproducible result",
      outcome: "complete",
      limitations: "Synthetic test evidence",
      files: [
        {
          name: "report.md",
          content: "# Evidence\nVerified in isolation",
          media_type: "text/markdown",
        },
      ],
      ...p,
    });
  return { b, m, human, agents, act, policy, publish };
}
const reported = (tokens = 50, costUsd = 0.25) => ({
  tokens,
  costUsd,
  quality: "reported",
  source: "Fixture terminal aggregate",
});

test("Unlimited missions keep usage and recovery protections across limit changes", (t) => {
  const f = fixture(t);
  const unlimited = {
    tokens: null,
    costUsd: null,
    turns: null,
    concurrency: null,
    deadline: null,
  };
  assert.deepEqual(f.act(f.human, "budget_read").limits, unlimited);
  assert.equal(
    f.act(f.agents[0], "budget_reserve", { run_id: "subscription-run" })
      .granted,
    true,
  );
  f.act(f.agents[0], "budget_settle", {
    run_id: "subscription-run",
    outcome: "completed",
    usage: reported(500, null),
  });
  const before = f.act(f.human, "budget_read");
  assert.equal(before.unknownRuns, 1);

  f.policy({
    tokens: 0,
    costUsd: 0,
    turns: 0,
    concurrency: 1,
    deadline: Date.now() - 1,
  });
  assert.equal(
    f.act(f.agents[0], "budget_reserve", { run_id: "limited" }).granted,
    false,
  );
  const restored = f.policy(unlimited, {
    reason: "Run without mission limits",
  });
  assert.deepEqual(restored.limits, unlimited);
  assert.deepEqual(restored.consumed, before.consumed);
  assert.deepEqual(restored.reserved, before.reserved);
  assert.deepEqual(restored.available, {
    tokens: null,
    costUsd: null,
    turns: null,
  });
  assert.equal(restored.exhausted, false);
  assert.equal(restored.deadlineReached, false);
  assert.equal(restored.history.length, 2);
  assert.equal(
    f.act(f.agents[0], "context_read").participation.state,
    "authorized",
  );

  for (const [index, agent] of f.agents.entries()) {
    assert.equal(
      f.act(agent, "budget_reserve", { run_id: `unlimited-${index}` }).granted,
      true,
      "Unknown subscription cost must not block a mission without a cost limit",
    );
  }
  assert.equal(f.act(f.human, "budget_read").active, 2);
  const duplicate = f.act(f.agents[0], "budget_reserve", {
    run_id: "duplicate",
  });
  assert.equal(duplicate.granted, false);
  assert.match(duplicate.reason, /unsettled execution/);
  for (const [index, agent] of f.agents.entries()) {
    f.act(agent, "budget_settle", {
      run_id: `unlimited-${index}`,
      usage: reported(100, null),
      outcome: "completed",
    });
  }
  f.policy({ turns: 3 });
  assert.equal(f.act(f.human, "budget_read").consumed.turns, 3);
  assert.equal(
    f.act(f.agents[0], "budget_reserve", { run_id: "cannot-reset-usage" })
      .granted,
    false,
    "Re-enabling limits counts all work done while unlimited",
  );
  f.act(f.human, "mission_state", { state: "paused", reason: "Human pause" });
  f.policy(unlimited);
  assert.equal(
    f.act(f.agents[0], "context_read").participation.state,
    "paused",
  );
});

test("Budget reservations are atomic across DB connections, idempotent, durable, and never released by heartbeat loss", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bb-budget-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(t, join(dir, "board.sqlite"));
  const second = new Blackboard(join(dir, "board.sqlite"));
  t.after(() => second.close());
  f.policy({ tokens: 150, costUsd: 2, concurrency: 1, turns: 3 });
  const request = { run_id: "execution-1" };
  const first = f.act(f.agents[0], "budget_reserve", request);
  assert.equal(first.granted, true);
  f.b.heartbeat(f.agents[0], "offline");
  assert.equal(
    second.execute(
      f.agents[1],
      "budget_reserve",
      { channel_id: f.m.id, run_id: "execution-2" },
      randomUUID(),
    ).granted,
    false,
  );
  assert.equal(
    f.act(f.agents[0], "budget_reserve", request).run.id,
    first.run.id,
  );
  assert.equal(f.b.budgets.snapshot(f.m).consumed.turns, 1);
  assert.throws(
    () =>
      f.act(f.agents[1], "budget_settle", {
        ...request,
        usage: reported(),
        outcome: "completed",
      }),
    /Only the owner/,
  );
  f.act(f.agents[0], "budget_settle", {
    ...request,
    usage: reported(),
    outcome: "completed",
  });
  f.act(f.agents[0], "budget_settle", {
    ...request,
    usage: reported(),
    outcome: "completed",
  });
  assert.equal(
    f.act(f.agents[0], "budget_reserve", request).granted,
    false,
    "Settled runs cannot be reused",
  );
  assert.deepEqual(second.budgets.snapshot(f.m).consumed, {
    tokens: 50,
    costUsd: 0.25,
    turns: 1,
  });
  const next = f.act(f.agents[1], "budget_reserve", { run_id: "execution-2" });
  assert.equal(next.granted, true);
  assert.equal(next.run.allowance.tokens, 100);
});

test("Missing usage retains allowance, human reconciliation is audited, and agents cannot increase limits", (t) => {
  const f = fixture(t);
  f.policy({ tokens: 100, costUsd: 1 });
  f.act(f.agents[0], "budget_reserve", { run_id: "unknown" });
  f.act(f.agents[0], "budget_settle", {
    run_id: "unknown",
    outcome: "interrupted",
    usage: {
      tokens: null,
      costUsd: null,
      quality: "unknown",
      source: "Process crashed",
    },
  });
  const snapshot = f.act(f.human, "budget_read");
  assert.equal(snapshot.unknownRuns, 1);
  assert.equal(snapshot.active, 0);
  assert.deepEqual(snapshot.consumed, { tokens: 0, costUsd: 0, turns: 1 });
  assert.deepEqual(snapshot.reserved, { tokens: 100, costUsd: 1, turns: 0 });
  assert.equal(
    f.act(f.agents[1], "budget_reserve", { run_id: "blocked" }).granted,
    false,
  );
  assert.throws(
    () =>
      f.act(f.agents[0], "budget_update", {
        version: 1,
        limits: {},
        per_turn: { tokens: 100, costUsd: 1 },
        reason: "Raise it",
      }),
    /paused|human/i,
  );
  const run = snapshot.runs[0];
  f.act(f.human, "budget_reconcile", {
    run_id: run.id,
    version: run.version,
    usage: { ...reported(80, 0.8), quality: "estimated" },
    reason: "Verified process stopped; reconstructed from log",
    confirmed_stopped: true,
  });
  const reconciled = f.act(f.human, "budget_read");
  assert.equal(reconciled.quality.estimated, 1);
  assert.equal(reconciled.unknownRuns, 0);
  assert.equal(reconciled.runs[0].history.length, 2);
  assert.equal(reconciled.available.tokens, 20);
  assert.equal(
    f.act(f.agents[1], "budget_reserve", { run_id: "allowed" }).run.allowance
      .tokens,
    20,
  );
});

test("Finalization reserve, deadline and human pause constrain execution without preventing partial artifact delivery", (t) => {
  const f = fixture(t);
  f.policy({ tokens: 100, turns: 4 }, { finalization_percent: 20 });
  f.act(f.human, "budget_allocate", {
    version: 1,
    agent_ids: [f.agents[1].id],
    reason: "Verify and synthesize",
  });
  assert.throws(
    () =>
      f.act(f.agents[0], "budget_reserve", {
        run_id: "unauthorized",
        purpose: "finalization",
      }),
    /finalization reserve/,
  );
  const work = f.act(f.agents[0], "budget_reserve", { run_id: "work" });
  assert.equal(work.run.allowance.tokens, 80);
  f.act(f.agents[0], "budget_settle", {
    run_id: "work",
    usage: reported(80, 0.3),
    outcome: "completed",
  });
  assert.equal(
    f.act(f.agents[0], "budget_reserve", { run_id: "too-much" }).granted,
    false,
  );
  assert.equal(
    f.act(f.agents[1], "budget_reserve", {
      run_id: "finish",
      purpose: "finalization",
    }).run.allowance.tokens,
    20,
  );
  f.policy({ deadline: Date.now() - 1 });
  assert.equal(
    f.act(f.agents[0], "context_read").participation.state,
    "paused",
  );
  assert.equal(
    f.act(f.agents[0], "budget_reserve", { run_id: "late" }).granted,
    false,
  );
  assert.ok(
    f.publish().revision.id,
    "Already-produced files can be handed off",
  );
  f.act(f.agents[0], "budget_request", {
    reason: "Need time to verify the last output",
  });
  f.act(f.human, "mission_state", { state: "paused", reason: "Stop" });
  f.policy({});
  assert.equal(
    f.act(f.agents[0], "context_read").participation.state,
    "paused",
    "A larger budget cannot override a human pause",
  );
});

test("Artifact revisions store bytes and hashes, reject concurrent edits, and track exact-version reviews and stale evidence", (t) => {
  const f = fixture(t);
  const first = f.publish();
  const review = f.act(f.agents[1], "artifact_review", {
    revision_id: first.revision.id,
    verdict: "verified",
    summary: "Result reproduced",
    conditions: "Input A, configuration 1",
  });
  assert.equal(review.selfReview, false);
  assert.throws(
    () =>
      f.act(f.agents[0], "artifact_review", {
        revision_id: first.revision.id,
        verdict: "accepted",
        summary: "Accept",
        conditions: "Self",
      }),
    /human/,
  );
  const second = f.publish(f.agents[1], {
    artifact_id: first.artifact.id,
    version: first.artifact.version,
    summary: "Improved result",
    files: [
      { name: "report.md", media_type: "text/markdown", content: "# Improved" },
    ],
  });
  assert.throws(
    () =>
      f.publish(f.agents[0], {
        artifact_id: first.artifact.id,
        version: first.artifact.version,
      }),
    /changed/,
  );
  const full = f.act(f.human, "artifact_read", {
    artifact_id: first.artifact.id,
  });
  assert.equal(full.revisions.length, 2);
  assert.equal(full.reviews[0].stale, true);
  const old = f.act(f.agents[0], "artifact_file", {
    revision_id: first.revision.id,
    name: "report.md",
  });
  assert.equal(
    Buffer.from(old.content, "base64").toString(),
    "# Evidence\nVerified in isolation",
  );
  assert.equal(old.sha256.length, 64);
  const derived = f.publish(f.agents[0], {
    title: "Synthesis",
    refs: [second.revision.id],
  });
  assert.equal(
    f.act(f.human, "artifact_read", { artifact_id: derived.artifact.id })
      .artifact.stale,
    false,
  );
  f.publish(f.agents[1], {
    artifact_id: first.artifact.id,
    version: second.artifact.version,
    summary: "Input changed again",
  });
  assert.equal(
    f.act(f.human, "artifact_read", { artifact_id: derived.artifact.id })
      .artifact.stale,
    true,
  );
  f.act(f.human, "criterion_update", {
    version: f.b.get(f.m.id).version,
    criterion_id: f.m.criteria[0].id,
    met: true,
    summary: "Reported with revision",
    refs: [first.revision.id],
  });
  assert.equal(
    f.act(f.human, "context_read").mission.criteria[0].evidence[0].superseded,
    true,
  );
});

test("Artifact privacy holds across list, context, content, references, revisions, reviews and events", (t) => {
  const f = fixture(t),
    [owner, outsider] = f.agents;
  const secret = f.act(owner, "message_post", {
    body: "Private instruction",
    direct_agent_id: owner.id,
  });
  const privateOutput = f.publish(owner, {
    direct_agent_id: owner.id,
    refs: [secret.id],
  });
  assert.equal(f.act(outsider, "artifacts_read").total, 0);
  assert.equal(f.act(outsider, "context_read").artifacts.length, 0);
  for (const [op, input] of [
    ["record_read", { id: privateOutput.revision.id }],
    ["artifact_read", { artifact_id: privateOutput.artifact.id }],
    [
      "artifact_file",
      { revision_id: privateOutput.revision.id, name: "report.md" },
    ],
    [
      "artifact_review",
      {
        revision_id: privateOutput.revision.id,
        verdict: "verified",
        summary: "Peek",
        conditions: "Unknown",
      },
    ],
  ])
    assert.throws(() => f.act(outsider, op, input), /not found/);
  assert.throws(
    () => f.publish(owner, { refs: [privateOutput.revision.id] }),
    /private/i,
  );
  assert.throws(() => f.publish(owner, { refs: [secret.id] }), /private/i);
  const pub = f.publish(owner);
  assert.throws(
    () =>
      f.publish(owner, {
        artifact_id: pub.artifact.id,
        version: pub.artifact.version,
        direct_agent_id: owner.id,
      }),
    /visibility/,
  );
  assert.equal(
    f
      .act(outsider, "updates_read")
      .events.some((e) => e.data.refs?.includes(privateOutput.revision.id)),
    false,
  );
  assert.equal(
    f.act(f.human, "artifacts_read", { direct_agent_id: owner.id }).total,
    1,
  );
});

test("Unsafe paths, payload sizes and unchanged revisions are rejected atomically; complete tasks reference artifacts", (t) => {
  const f = fixture(t);
  for (const name of [
    "../secret",
    "/etc/passwd",
    "a/../b",
    "a\\b",
    "C:/file",
    "a\nfile",
  ])
    assert.throws(
      () => f.publish(undefined, { files: [{ name, content: "x" }] }),
      /filenames/,
    );
  assert.throws(
    () =>
      f.publish(undefined, {
        files: [{ name: "big", content: "é".repeat(2 * 1024 * 1024) }],
      }),
    /exceeds/,
  );
  assert.equal(f.act(f.human, "artifacts_read").total, 0);
  const first = f.publish();
  assert.throws(
    () =>
      f.publish(undefined, {
        artifact_id: first.artifact.id,
        version: first.artifact.version,
      }),
    /substantive/,
  );
  const task = f.act(f.agents[0], "task_create", { title: "Publish result" });
  assert.throws(
    () =>
      f.act(f.agents[0], "task_update", {
        task_id: task.id,
        version: task.version,
        status: "done",
        summary: "Done",
      }),
    /artifact/,
  );
  const done = f.act(f.agents[0], "task_update", {
    task_id: task.id,
    version: task.version,
    status: "done",
    refs: [first.revision.id],
  });
  assert.equal(done.status, "done");
});

test("Artifact file content survives reopening the board and archived missions remain read-only", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bb-artifacts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(t, join(dir, "board.sqlite"));
  const a = f.publish();
  f.act(f.human, "mission_archive", {
    version: f.b.get(f.m.id).version,
    archived: true,
  });
  const reopened = new Blackboard(join(dir, "board.sqlite"));
  t.after(() => reopened.close());
  assert.equal(
    reopened.execute(f.human, "artifact_file", {
      channel_id: f.m.id,
      revision_id: a.revision.id,
      name: "report.md",
    }).sha256,
    a.revision.files[0].sha256,
  );
  assert.throws(() => f.publish(), /archived/);
});

test("Historical revisions are paged while exact old references stay readable, and mission changes invalidate reviews", (t) => {
  const f = fixture(t);
  let current = f.publish();
  const oldest = current.revision;
  f.act(f.agents[1], "artifact_review", {
    revision_id: oldest.id,
    verdict: "verified",
    summary: "Checked",
    conditions: "Original scope",
  });
  for (let i = 2; i <= 55; i++)
    current = f.publish(undefined, {
      artifact_id: current.artifact.id,
      version: current.artifact.version,
      summary: `Finding revision ${i}`,
    });
  const page = f.act(f.human, "artifact_read", {
    artifact_id: current.artifact.id,
  });
  assert.equal(page.revisions.length, 50);
  assert.equal(page.nextRevisionOffset, 50);
  const earlier = f.act(f.human, "artifact_read", {
    artifact_id: current.artifact.id,
    revision_offset: 50,
  });
  assert.equal(earlier.revisions.length, 5);
  assert.equal(earlier.nextRevisionOffset, null);
  const pinned = f.act(f.human, "artifact_read", {
    artifact_id: current.artifact.id,
    revision_id: oldest.id,
  });
  assert.ok(pinned.revisions.some((r) => r.id === oldest.id));
  const mission = f.b.get(f.m.id);
  f.act(f.human, "mission_update", {
    version: mission.version,
    name: mission.name,
    objective: mission.objective,
    scope: "Changed conditions",
    criteria: mission.criteria.map(({ id, text }) => ({ id, text })),
  });
  assert.equal(
    f.act(f.human, "artifact_read", { artifact_id: current.artifact.id })
      .artifact.stale,
    true,
  );
});

test("Configured limits expose and stop older managed launchers while retaining interactive capability honesty", (t) => {
  const f = fixture(t);
  f.b.db.prepare("INSERT INTO agent_execution VALUES(?,?)").run(
    f.agents[0].id,
    JSON.stringify({
      environment: "local",
      runtimeVersion: "before budgets",
    }),
  );
  f.policy({ turns: 5 });
  const old = f.act(f.agents[0], "context_read");
  assert.equal(old.participation.state, "paused");
  assert.match(old.participation.reason, /predates budget/);
  assert.equal(
    f.act(f.agents[1], "context_read").participation.state,
    "authorized",
    "Interactive execution still uses explicit reservations and self-reported accounting",
  );
  f.b.db
    .prepare("UPDATE agent_execution SET data=? WHERE agent=?")
    .run(
      JSON.stringify({ environment: "local", budgetProtocol: 1 }),
      f.agents[0].id,
    );
  assert.equal(
    f.act(f.agents[0], "context_read").participation.state,
    "authorized",
  );
});

test("Reservation retry keys cannot charge another run and never revive a settled execution", (t) => {
  const f = fixture(t),
    key = randomUUID();
  f.act(f.agents[0], "budget_reserve", { run_id: "retry-run" }, key);
  f.act(f.agents[0], "budget_settle", {
    run_id: "retry-run",
    usage: reported(),
    outcome: "completed",
  });
  assert.equal(
    f.act(f.agents[0], "budget_reserve", { run_id: "retry-run" }, key).granted,
    false,
  );
  assert.throws(
    () =>
      f.act(f.agents[0], "budget_reserve", { run_id: "different-run" }, key),
    /Idempotency/,
  );
  const before = f.act(f.human, "budget_read");
  f.act(f.human, "budget_reconcile", {
    run_id: "retry-run",
    version: before.runs[0].version,
    usage: { ...reported(), quality: "estimated" },
    reason: "Correct quality label",
    confirmed_stopped: true,
  });
  assert.equal(f.act(f.human, "budget_read").runs[0].outcome, "completed");
});
