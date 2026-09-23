import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Blackboard } from "../server/board.mjs";

function fixture(t, file = ":memory:") {
  const board = new Blackboard(file);
  t.after(() => board.close());
  const human = board.auth(board.ownerToken);
  const mission = board.execute(
    human,
    "mission_create",
    {
      name: "Evidence review",
      objective: "Validate and report an experiment",
      criteria: [
        "The baseline passes independent checks",
        "The changed input is rerun",
      ],
    },
    randomUUID(),
  );
  const act = (actor, op, input = {}, key = randomUUID()) =>
    board.execute(actor, op, { channel_id: mission.id, ...input }, key);
  const current = () => board.get(mission.id);
  const register = (name, role) => {
    const invitation = act(human, "invitation_create", { role });
    const joined = board.join({
      invitation: invitation.token,
      name,
      runtime: "codex",
    });
    return board.auth(joined.token);
  };
  const lead = register("coordinator", "coordinator");
  const worker = register("worker", "agent");
  const start = (coordinator = lead) => {
    act(coordinator, "plan_update", {
      version: current().version,
      plan: "Check evidence in Main",
    });
    act(coordinator, "coordinator_ready", {
      revision: current().startupRevision,
    });
    act(human, "mission_state", {
      version: current().version,
      state: "active",
      reason: "Start experiment",
    });
  };
  start();
  const evidence = act(worker, "message_post", {
    kind: "finding",
    body: "Baseline run: all independent checks pass. Changed-input run not executed.",
  });
  const report = (actor = lead, input = {}, key) =>
    act(
      actor,
      "criterion_update",
      {
        version: current().version,
        criterion_id: current().criteria[0].id,
        met: true,
        summary: "Baseline independently checked; results linked below.",
        refs: [evidence.id],
        ...input,
      },
      key,
    );
  return { board, human, lead, worker, act, current, report, start, evidence };
}

test("Coordinator reports criteria with attribution and evidence without tasks or changing mission authority", (t) => {
  const f = fixture(t);
  const before = f.act(f.worker, "context_read");
  const reported = f.report();
  const criterion = reported.criteria[0];
  assert.equal(criterion.met, true);
  assert.equal(criterion.assessment.updatedBy, f.lead.id);
  assert.deepEqual(criterion.assessment.refs, [f.evidence.id]);
  assert.equal(reported.criteria[1].met, false);
  assert.equal(reported.version, before.mission.version + 1);
  assert.deepEqual(
    {
      ...reported,
      criteria: before.mission.criteria,
      version: before.mission.version,
    },
    before.mission,
    "A report changes only criteria and optimistic concurrency version",
  );
  const updates = f.act(f.worker, "updates_read", { after: before.cursor });
  const report = updates.events.find(
    (e) => e.data.id === criterion.assessment.messageId,
  ).data;
  assert.equal(report.authorId, f.lead.id);
  assert.equal(report.createdAt, criterion.assessment.updatedAt);
  assert.equal(report.criterionId, criterion.id);
  assert.equal(report.criterionMet, true);
  assert.equal(report.streamId, reported.defaultStreamId);
  assert.deepEqual(report.refs, [f.evidence.id]);
  assert.match(report.body, /reported complete/);
  assert.equal(f.act(f.worker, "context_read").mission.criteria[0].met, true);
  const incomplete = f.report(f.lead, {
    criterion_id: reported.criteria[1].id,
    met: false,
    refs: [],
    summary: "Changed-input run has not been executed.",
  });
  assert.equal(incomplete.criteria[1].met, false);
  assert.match(incomplete.criteria[1].assessment.summary, /not been executed/);
  f.report(f.human, {
    criterion_id: reported.criteria[1].id,
    summary: "Human checked the rerun.",
  });
  assert.equal(
    f.current().state,
    "active",
    "All ticks never close a mission automatically",
  );
  assert.equal(f.act(f.human, "context_read").tasks.length, 0);
  assert.throws(
    () =>
      f.act(f.lead, "mission_state", {
        state: "closed",
        reason: "All ticks set",
      }),
    /human must/,
  );
});

test("Only the current coordinator and human can report; human can override and peer agents cannot", (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.report(f.worker),
    /Only the current coordinator or human/,
  );
  assert.throws(
    () =>
      f.act(f.lead, "mission_update", {
        version: f.current().version,
        name: "Changed",
        objective: "Move the goalposts",
        criteria: [],
      }),
    /human must/,
  );
  f.report();
  const override = f.report(f.human, {
    met: false,
    refs: [],
    summary: "The rerun evidence does not match the required environment.",
  });
  assert.equal(override.criteria[0].assessment.updatedBy, "human");
  assert.equal(override.criteria[0].met, false);
  f.act(f.human, "coordinator_set", {
    version: f.current().version,
    agent_id: f.worker.id,
    reason: "Handover",
  });
  f.start(f.worker);
  assert.throws(
    () => f.report(f.lead),
    /Only the current coordinator or human/,
  );
  assert.equal(
    f.report(f.worker).criteria[0].assessment.updatedBy,
    f.worker.id,
  );
  f.act(f.human, "coordination_set", {
    version: f.current().version,
    mode: "peer",
  });
  f.act(f.human, "mission_state", {
    version: f.current().version,
    state: "active",
    reason: "Peer experiment",
  });
  assert.throws(
    () => f.report(f.worker),
    /Only the current coordinator or human/,
  );
  assert.throws(
    () => f.report(f.lead),
    /Only the current coordinator or human/,
  );
  assert.equal(
    f.report(f.human, {
      refs: [],
      summary: "Human checked the evidence directly.",
    }).criteria[0].met,
    true,
  );
});

test("Completion evidence must be present, public, and within the mission; rejected reports leave no partial audit", (t) => {
  const f = fixture(t);
  const privateRecord = f.act(f.lead, "message_post", {
    body: "Private evidence",
    direct_agent_id: f.lead.id,
  });
  const other = f.board.execute(
    f.human,
    "mission_create",
    {
      name: "Other mission",
      objective: "Separate scope",
      criteria: ["Separate criterion"],
    },
    randomUUID(),
  );
  const before = f.act(f.human, "context_read");
  for (const [input, pattern] of [
    [{ refs: [] }, /supporting evidence/],
    [{ summary: "  " }, /at least 1/],
    [{ refs: [privateRecord.id] }, /private message/],
    [{ refs: [f.evidence.id, other.id] }, /not found in this mission/],
    [{ refs: ["me_missing"] }, /not found in this mission/],
    [{ criterion_id: other.criteria[0].id }, /Criterion not found/],
    [{ text: "Easier criterion" }, /Unrecognized key/],
    [{ updatedBy: "human" }, /Unrecognized key/],
  ])
    assert.throws(() => f.report(f.lead, input), pattern);
  assert.throws(
    () => f.report(f.human, { refs: [privateRecord.id] }),
    /private message/,
  );
  const after = f.act(f.human, "context_read");
  assert.deepEqual(after.mission, before.mission);
  assert.equal(after.cursor, before.cursor);
  const deduped = f.report(f.lead, { refs: [f.evidence.id, f.evidence.id] });
  assert.deepEqual(deduped.criteria[0].assessment.refs, [f.evidence.id]);
});

test("Stale reports cannot undo a newer human decision; retries publish exactly one report", (t) => {
  const f = fixture(t);
  const version = f.current().version;
  const key = randomUUID();
  const reported = f.report(f.lead, { version }, key);
  assert.deepEqual(f.report(f.lead, { version }, key), reported);
  const override = f.report(f.human, {
    met: false,
    refs: [],
    summary: "Evidence needs a new review.",
  });
  assert.throws(
    () => f.report(f.lead, { version: reported.version }),
    /record changed/,
  );
  assert.throws(
    () => f.report(f.lead, { version, summary: "Different body" }, key),
    /reused/,
  );
  assert.deepEqual(f.report(f.lead, { version }, key), reported);
  assert.deepEqual(
    f.current(),
    override,
    "An old successful retry cannot reapply its report",
  );
  assert.equal(
    f.board.list(f.current().id, "message").filter((m) => m.criterionId).length,
    2,
  );
});

test("Definition edits preserve unchanged evidence, reset reworded criteria, and cannot smuggle progress changes", (t) => {
  const f = fixture(t);
  const reported = f.report();
  const edit = (input = {}) =>
    f.act(f.human, "mission_update", {
      version: f.current().version,
      name: f.current().name,
      objective: f.current().objective,
      scope: "Updated scope",
      criteria: f.current().criteria.map(({ id, text }) => ({ id, text })),
      ...input,
    });
  assert.deepEqual(edit().criteria, reported.criteria);
  const oldVersion = f.current().version;
  f.report(f.human, {
    met: false,
    refs: [],
    summary: "Recheck this requirement.",
  });
  assert.throws(() => edit({ version: oldVersion }), /record changed/);
  const criteria = f.current().criteria;
  assert.throws(
    () => edit({ criteria: [{ ...criteria[0], met: true }] }),
    /Use criterion_update/,
  );
  assert.throws(
    () => edit({ criteria: [{ text: "New criterion", met: true }] }),
    /Use criterion_update/,
  );
  assert.throws(
    () => edit({ criteria: [criteria[0], criteria[0]] }),
    /Duplicate criterion ID/,
  );
  assert.throws(
    () => edit({ criteria: [{ id: "cr_foreign", text: "Other" }] }),
    /Criterion not found/,
  );
  const changed = edit({
    criteria: [
      { ...criteria[0], text: "The new baseline passes independent checks" },
      criteria[1],
      { text: "Document the results" },
    ],
  });
  assert.equal(changed.criteria[0].met, false);
  assert.equal(changed.criteria[0].assessment, undefined);
  assert.deepEqual(changed.criteria[1], criteria[1]);
  assert.equal(changed.criteria[2].met, false);
  assert.notEqual(changed.criteria[2].id, criteria[0].id);
  assert.ok(
    f.board.get(reported.criteria[0].assessment.messageId),
    "Earlier reports survive definition edits",
  );
  assert.ok(
    f
      .act(f.human, "messages_read")
      .messages.some((m) => /Progress reset/.test(m.body)),
  );
  const removedId = changed.criteria[0].id;
  edit({ criteria: [changed.criteria[1]] });
  assert.throws(
    () => f.report(f.lead, { criterion_id: removedId }),
    /Criterion not found/,
  );
});

test("Preparation, pauses, closure, and archive retain their authority over status reporting", (t) => {
  const f = fixture(t);
  f.act(f.human, "agent_control", {
    agent_id: f.lead.id,
    control: "pause",
    reason: "Pause review",
  });
  assert.throws(() => f.report(), /Work is paused/);
  f.act(f.human, "agent_control", {
    agent_id: f.lead.id,
    control: "resume",
    reason: "Resume review",
  });
  for (const state of ["preparing", "paused", "closed"]) {
    f.act(f.human, "mission_state", {
      version: f.current().version,
      state,
      reason: "Lifecycle test",
    });
    assert.throws(() => f.report(), /not authorized|Work is paused/);
    assert.equal(
      f.report(f.human, {
        met: false,
        refs: [],
        summary: "Human status review.",
      }).state,
      state,
    );
  }
  f.act(f.human, "mission_archive", {
    version: f.current().version,
    archived: true,
  });
  for (const actor of [f.lead, f.human])
    assert.throws(() => f.report(actor), /archived and read-only/);
});

test("Evidence and legacy unchecked criteria survive a database reopen", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "harakiri-criteria-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "board.sqlite");
  const f = fixture(t, file);
  const reported = f.report();
  const reopened = new Blackboard(file);
  try {
    assert.deepEqual(reopened.get(reported.id).criteria, reported.criteria);
    assert.equal(reopened.get(reported.id).criteria[1].assessment, undefined);
    assert.equal(
      reopened.get(reported.criteria[0].assessment.messageId).authorId,
      f.lead.id,
    );
  } finally {
    reopened.close();
  }
});
