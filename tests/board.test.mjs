import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Blackboard } from "../server/board.mjs";

function setup(t, file) {
  const board = new Blackboard(file);
  t.after(() => board.close());
  const human = board.auth(board.ownerToken);
  const op = (actor, operation, input = {}, key = randomUUID()) =>
    board.execute(actor, operation, input, key);
  const mission = op(human, "mission_create", {
    name: "Shared exploration",
    objective: "Compare useful directions and publish evidence.",
    scope: "Work on this board only.",
    criteria: ["The human can evaluate the alternatives."],
  });
  const act = (actor, operation, input = {}, key) =>
    op(actor, operation, { channel_id: mission.id, ...input }, key);
  const invite = (role = "agent") => act(human, "invitation_create", { role });
  const register = (name, runtime = "codex", invitation = invite().token) => {
    const result = board.join({ invitation, name, runtime });
    return { ...result, actor: board.auth(result.token) };
  };
  return { board, human, mission, act, op, invite, register };
}

test("Archiving hides a channel and freezes work while preserving public and private history", (t) => {
  const { board, human, mission, act, invite, register } = setup(t);
  const lead = register("lead", "claude", invite("coordinator").token);
  const one = register("worker"),
    other = register("other");
  const pendingInvite = invite();
  const stream = act(lead.actor, "stream_create", {
    name: "Evidence",
    goal: "Check sources",
  });
  const task = act(one.actor, "task_create", {
    title: "Check a source",
    stream_id: stream.id,
  });
  const finding = act(one.actor, "message_post", {
    body: "Public evidence",
    stream_id: stream.id,
  });
  const privateMessage = act(one.actor, "message_post", {
    body: "Private context",
    direct_agent_id: one.agent.id,
  });
  const cursor = act(one.actor, "context_read").cursor;
  const current = board.get(mission.id);
  const archived = act(human, "mission_archive", {
    archived: true,
    version: current.version,
  });
  assert.equal(archived.archived, true);
  assert.ok(archived.archivedAt);
  assert.equal(archived.state, "paused");
  assert.deepEqual(board.channels(human), []);
  assert.equal(board.channels(human, { archived: true })[0].id, mission.id);
  assert.equal(board.heartbeat(one.actor, "working").missionState, "archived");
  assert.ok(
    act(one.actor, "updates_read", { after: cursor }).events.some((e) =>
      /archived this channel/.test(e.data.body || ""),
    ),
  );
  const snapshot = act(human, "context_read");
  assert.ok(snapshot.tasks.some((t) => t.id === task.id));
  assert.ok(snapshot.workstreams.some((w) => w.id === stream.id));
  assert.equal(snapshot.agents.length, 3);
  assert.equal(
    act(human, "record_read", { id: finding.id }).body,
    "Public evidence",
  );
  assert.equal(
    act(one.actor, "record_read", { id: privateMessage.id }).body,
    "Private context",
  );
  assert.throws(
    () => act(other.actor, "record_read", { id: privateMessage.id }),
    /Record not found/,
  );
  act(human, "messages_seen", { message_ids: [privateMessage.id] });
  assert.throws(
    () =>
      board.join({
        invitation: pendingInvite.token,
        name: "late",
        runtime: "codex",
      }),
    /archived/,
  );
  for (const actor of [human, one.actor, lead.actor]) {
    assert.throws(
      () => act(actor, "message_post", { body: "New work" }),
      /archived and read-only/,
    );
    assert.throws(
      () =>
        act(actor, "message_post", {
          body: "Private follow-up",
          thread_id: privateMessage.id,
        }),
      /archived and read-only/,
    );
    assert.throws(
      () =>
        act(actor, "task_update", {
          task_id: task.id,
          version: task.version,
          status: "done",
        }),
      /archived and read-only/,
    );
  }
  assert.throws(
    () =>
      act(human, "mission_state", {
        state: "active",
        reason: "Bypass archive",
      }),
    /archived and read-only/,
  );
  assert.throws(
    () => act(human, "invitation_create"),
    /archived and read-only/,
  );
  assert.throws(
    () => act(human, "message_edit", { message_id: finding.id, remove: true }),
    /archived and read-only/,
  );
});

test("Only the human archives or restores, with version checks and an explicit resume", (t) => {
  const { board, human, mission, act, invite, register } = setup(t);
  const lead = register("lead", "claude", invite("coordinator").token);
  const worker = register("worker");
  const current = board.get(mission.id);
  assert.throws(
    () =>
      act(lead.actor, "mission_archive", {
        archived: true,
        version: current.version,
      }),
    /human/i,
  );
  const key = randomUUID();
  const archived = act(
    human,
    "mission_archive",
    { archived: true, version: current.version },
    key,
  );
  assert.equal(
    act(
      human,
      "mission_archive",
      { archived: true, version: current.version },
      key,
    ).version,
    archived.version,
  );
  assert.throws(
    () =>
      act(worker.actor, "mission_archive", {
        archived: false,
        version: archived.version,
      }),
    /human/i,
  );
  assert.throws(
    () =>
      act(human, "mission_archive", {
        archived: false,
        version: current.version,
      }),
    /record changed/i,
  );
  const restored = act(human, "mission_archive", {
    archived: false,
    version: archived.version,
  });
  assert.equal(restored.archived, false);
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.state, "paused");
  assert.equal(board.heartbeat(worker.actor, "paused").missionState, "paused");
  assert.equal(board.channels(human)[0].id, mission.id);
  assert.deepEqual(board.channels(human, { archived: true }), []);
  assert.throws(
    () => act(worker.actor, "task_create", { title: "Continue too soon" }),
    /paused/,
  );
  act(human, "mission_state", { state: "active", reason: "Continue work" });
  act(worker.actor, "task_create", { title: "Continue after human resumes" });
  act(human, "mission_state", { state: "closed", reason: "Finished" });
  const closed = act(human, "mission_archive", {
    archived: true,
    version: board.get(mission.id).version,
  });
  assert.equal(
    act(human, "mission_archive", { archived: false, version: closed.version })
      .state,
    "closed",
  );
});

test("Archived channels survive restart and legacy channels remain active in navigation", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "harakiri-archive-"));
  const file = join(directory, "board.sqlite");
  let board = new Blackboard(file);
  t.after(() => {
    board.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const human = board.auth(board.ownerToken);
  const mission = board.execute(
    human,
    "mission_create",
    { name: "Keep history", objective: "Preserve a result" },
    randomUUID(),
  );
  const legacy = { ...mission };
  delete legacy.archived;
  delete legacy.archivedAt;
  board.put(legacy);
  assert.equal(board.channels(human).length, 1);
  board.execute(
    human,
    "mission_archive",
    { channel_id: mission.id, archived: true, version: mission.version },
    randomUUID(),
  );
  board.close();
  board = new Blackboard(file);
  assert.equal(board.channels(human).length, 0);
  const archived = board.channels(human, { archived: true })[0];
  assert.equal(archived.id, mission.id);
  assert.equal(archived.archived, true);
  assert.ok(
    board
      .context(human, mission.id)
      .messages.some((m) => m.body.includes("archived this channel")),
  );
});

test("A mission works entirely through Main, directions and evidence, with no tasks", (t) => {
  const { board, human, mission, act, register } = setup(t);
  const one = register("one"),
    two = register("two", "claude");
  act(one.actor, "direction_set", {
    direction: "I will explore the first alternative.",
  });
  const finding = act(one.actor, "message_post", {
    body: "First alternative: observable evidence.",
    kind: "finding",
  });
  act(two.actor, "message_post", {
    body: "A comparison with the first alternative.",
    kind: "finding",
    refs: [finding.id],
  });
  act(human, "message_post", {
    body: "Please compare the tradeoffs.",
    audience: one.agent.id,
  });
  const ctx = board.context(human, mission.id);
  assert.equal(ctx.tasks.length, 0);
  assert.equal(ctx.workstreams.length, 1);
  assert.equal(ctx.mission.coordinatorId, null);
  assert.equal(ctx.agents.length, 2);
  assert.ok(ctx.messages.some((m) => m.refs.includes(finding.id)));
  assert.ok(
    board
      .context(two.actor, mission.id)
      .messages.some((m) => m.audience === one.agent.id),
    "addressed messages remain shared",
  );
  assert.deepEqual(new Set(ctx.agents.map((a) => a.role)), new Set(["agent"]));
});

test("Coordinator assigns goal-based workstreams, waits for acknowledgment, and requests more agents", (t) => {
  const { board, human, mission, act, register, invite } = setup(t);
  const lead = register("lead", "claude", invite("coordinator").token),
    agent = register("worker");
  const stream = act(lead.actor, "stream_create", {
    name: "Alternative A",
    goal: "Evaluate the first direction.",
  });
  const assignment = act(lead.actor, "assignment_create", {
    agent_id: agent.agent.id,
    stream_id: stream.id,
    instruction: "Explore A and report evidence.",
  });
  assert.equal(board.get(agent.agent.id).streamId, mission.defaultStreamId);
  assert.equal(board.get(assignment.id).status, "pending");
  assert.throws(
    () =>
      act(lead.actor, "assignment_ack", {
        assignment_id: assignment.id,
        direction: "Pretend the worker started.",
      }),
    /Only the assigned agent/,
  );
  act(agent.actor, "assignment_ack", {
    assignment_id: assignment.id,
    direction: "I will compare observable outcomes.",
  });
  assert.equal(board.get(agent.agent.id).streamId, stream.id);
  assert.equal(board.get(assignment.id).status, "acknowledged");
  const request = act(lead.actor, "agents_request", {
    count: 2,
    capabilities: "Independent comparison",
    reason: "Two additional directions need investigation.",
    stream_id: stream.id,
  });
  act(human, "request_respond", {
    request_id: request.id,
    response: "I will connect two more instances.",
    status: "open",
  });
  assert.equal(
    board.get(request.id).response,
    "I will connect two more instances.",
  );
  const ctx = board.context(human, mission.id);
  assert.equal(ctx.tasks.length, 0);
  assert.equal(ctx.agents.filter((a) => a.role === "coordinator").length, 1);
  assert.throws(
    () =>
      act(agent.actor, "stream_create", {
        name: "Unrequested",
        goal: "Bypass coordinator",
      }),
    /Ask the coordinator/,
  );
});

test("Human can override coordination, message any agent, and release a direct assignment", (t) => {
  const { board, human, mission, act, register, invite } = setup(t);
  const lead = register("lead", "claude", invite("coordinator").token),
    agent = register("worker");
  const stream = act(human, "stream_create", {
    name: "Human direction",
    goal: "Follow the revised instruction.",
  });
  act(human, "assignment_create", {
    agent_id: agent.agent.id,
    stream_id: stream.id,
    instruction: "Prioritize this direction.",
  });
  assert.throws(
    () =>
      act(lead.actor, "assignment_create", {
        agent_id: agent.agent.id,
        stream_id: mission.defaultStreamId,
        instruction: "Override the human.",
      }),
    /direct human assignment/,
  );
  act(human, "message_post", {
    body: "You may ask me directly.",
    audience: agent.agent.id,
  });
  act(human, "agent_control", {
    agent_id: agent.agent.id,
    control: "release",
    reason: "Return allocation to coordinator.",
  });
  act(lead.actor, "assignment_create", {
    agent_id: agent.agent.id,
    stream_id: mission.defaultStreamId,
    instruction: "Review the shared evidence.",
  });
  act(human, "coordinator_set", {
    version: board.get(mission.id).version,
    agent_id: agent.agent.id,
    reason: "Handover.",
  });
  assert.equal(
    board.context(human, mission.id).agents.find((a) => a.id === lead.agent.id)
      .role,
    "agent",
  );
  assert.throws(
    () =>
      act(lead.actor, "plan_update", {
        version: board.get(mission.id).version,
        plan: "Use stale authority.",
      }),
    /Only the coordinator/,
  );
});

test("Peer mode permits self-organization; human assignment cannot be bypassed by self-joining", (t) => {
  const { board, human, mission, act, register } = setup(t);
  const a = register("peer");
  const stream = act(a.actor, "stream_create", {
    name: "Peer direction",
    goal: "Explore independently.",
  });
  act(a.actor, "stream_join", {
    stream_id: stream.id,
    direction: "Starting this direction.",
  });
  assert.equal(board.get(a.agent.id).streamId, stream.id);
  act(human, "assignment_create", {
    agent_id: a.agent.id,
    stream_id: mission.defaultStreamId,
    instruction: "Please return to Main.",
  });
  assert.throws(
    () =>
      act(a.actor, "stream_join", {
        stream_id: stream.id,
        direction: "Ignore human.",
      }),
    /direct human assignment/,
  );
});

test("Optional individual and parallel tasks coexist with task-free participation", (t) => {
  const { board, human, mission, act, register } = setup(t);
  const a = register("one"),
    b = register("two");
  const single = act(human, "task_create", {
    title: "One comparison",
    mode: "individual",
    agent_ids: [a.agent.id],
  });
  const parallel = act(human, "task_create", {
    title: "Explore alternatives",
    mode: "parallel",
    agent_ids: [a.agent.id, b.agent.id],
  });
  const finding = act(b.actor, "message_post", {
    body: "Independent evidence.",
    kind: "finding",
  });
  act(a.actor, "task_update", {
    task_id: single.id,
    version: single.version,
    status: "done",
    summary: "Comparison delivered.",
    refs: [finding.id],
  });
  assert.throws(
    () =>
      act(human, "task_update", {
        task_id: single.id,
        version: board.get(single.id).version,
        status: "done",
        agent_ids: [a.agent.id, b.agent.id],
      }),
    /at most one/,
  );
  assert.equal(board.get(parallel.id).agentIds.length, 2);
  assert.equal(
    board.get(mission.id).criteria[0].met,
    false,
    "Task status does not complete mission criteria",
  );
});

test("An agent owns and reports its execution task while a coordinator exists", (t) => {
  const { board, human, mission, act, register, invite } = setup(t);
  const lead = register("lead", "claude", invite("coordinator").token);
  const worker = register("worker");
  const stream = act(lead.actor, "stream_create", {
    name: "Comparison",
    goal: "Compare alternatives",
  });
  const assignment = act(lead.actor, "assignment_create", {
    agent_id: worker.agent.id,
    stream_id: stream.id,
    instruction: "Compare the costs",
  });
  act(worker.actor, "assignment_ack", {
    assignment_id: assignment.id,
    direction: "Normalize the assumptions",
  });
  const task = act(worker.actor, "task_create", {
    title: "Normalize the cost comparison",
    mode: "individual",
    description: "Advance the plan by comparing like-for-like costs.",
    criteria: "Publish evidence for both alternatives.",
  });
  assert.deepEqual(task.agentIds, [worker.agent.id]);
  assert.equal(task.streamId, stream.id);
  assert.equal(task.createdBy, worker.agent.id);
  assert.equal(
    task.status,
    "open",
    "creation is planned work, not acknowledgment",
  );
  const working = act(worker.actor, "task_update", {
    task_id: task.id,
    version: task.version,
    status: "working",
    summary: "Checking source assumptions.",
  });
  const finding = act(worker.actor, "message_post", {
    body: "Both costs include the same items.",
    kind: "finding",
  });
  act(worker.actor, "task_update", {
    task_id: task.id,
    version: working.version,
    status: "done",
    summary: "Comparable estimates published.",
    refs: [finding.id],
  });
  const visible = act(human, "context_read").tasks.find(
    (t) => t.id === task.id,
  );
  assert.equal(visible.status, "done");
  assert.equal(visible.updatedBy, worker.agent.id);
  assert.ok(visible.updatedAt >= visible.createdAt);
  assert.deepEqual(visible.refs, [finding.id]);
  assert.equal(board.get(mission.id).criteria[0].met, false);
});

test("The coordinator allocates other agents and task changes notify current and former owners across workstreams", (t) => {
  const { human, act, register, invite } = setup(t);
  const lead = register("lead", "claude", invite("coordinator").token);
  const one = register("one"),
    two = register("two");
  const stream = act(lead.actor, "stream_create", {
    name: "Separate work",
    goal: "Investigate a direction",
  });
  assert.throws(
    () =>
      act(one.actor, "task_create", {
        title: "Allocate another agent",
        agent_ids: [two.agent.id],
      }),
    /ask the coordinator/,
  );
  const after = act(two.actor, "context_read").cursor;
  const task = act(lead.actor, "task_create", {
    title: "Check the evidence",
    stream_id: stream.id,
    agent_ids: [two.agent.id],
    mode: "individual",
  });
  assert.ok(
    act(two.actor, "updates_read", { after }).events.some((e) =>
      e.data.refs?.includes(task.id),
    ),
    "the assigned agent is notified even outside the task workstream",
  );
  assert.throws(
    () =>
      act(one.actor, "task_update", {
        task_id: task.id,
        version: task.version,
        status: "done",
      }),
    /assigned agent/,
  );
  assert.throws(
    () =>
      act(two.actor, "task_update", {
        task_id: task.id,
        version: task.version,
        status: "working",
        agent_ids: [one.agent.id],
      }),
    /coordinator/,
  );
  const beforeReassign = act(human, "context_read").cursor;
  act(lead.actor, "task_update", {
    task_id: task.id,
    version: task.version,
    status: "open",
    agent_ids: [one.agent.id],
    summary: "Reallocated to cover the remaining comparison.",
  });
  for (const owner of [one.actor, two.actor]) {
    assert.ok(
      act(owner, "updates_read", { after: beforeReassign }).events.some((e) =>
        e.data.refs?.includes(task.id),
      ),
    );
  }
});

test("Owned tasks stay in bounded agent context and human overrides preserve version checks", (t) => {
  const { human, act, register, invite } = setup(t);
  const lead = register("lead", "claude", invite("coordinator").token);
  const agent = register("worker");
  const task = act(agent.actor, "task_create", {
    title: "Long-running investigation",
  });
  for (let i = 0; i < 35; i++)
    act(lead.actor, "task_create", { title: `Other execution work ${i}` });
  const context = act(agent.actor, "context_read");
  assert.equal(context.tasks.length, 30);
  assert.equal(context.tasks[0].id, task.id);
  const progress = act(agent.actor, "task_update", {
    task_id: task.id,
    version: task.version,
    status: "working",
    summary: "First evidence gathered.",
  });
  assert.throws(
    () =>
      act(human, "task_update", {
        task_id: task.id,
        version: task.version,
        status: "paused",
      }),
    /record changed/,
  );
  const override = act(human, "task_update", {
    task_id: task.id,
    version: progress.version,
    status: "paused",
    summary: "Await my revised scope.",
  });
  assert.equal(override.updatedBy, "human");
  assert.equal(override.status, "paused");
});

test("Invitations enforce two roles, mission isolation, revocation, and idempotent registration", (t) => {
  const { board, human, mission, act, op, invite } = setup(t);
  const link = invite("coordinator");
  const input = {
    invitation: link.token,
    name: "lead",
    runtime: "claude",
    role: "coordinator",
    registration_id: randomUUID(),
  };
  const first = board.join(input);
  assert.deepEqual(board.join(input), first);
  assert.equal(board.context(human, mission.id).agents.length, 1);
  assert.throws(
    () => board.join({ ...input, registration_id: randomUUID() }),
    /already has a coordinator/,
  );
  const agentLink = invite();
  assert.throws(
    () =>
      board.join({
        ...input,
        invitation: agentLink.token,
        registration_id: randomUUID(),
      }),
    /match the invitation/,
  );
  assert.throws(
    () => board.join({ ...input, role: "tester" }),
    /Only Agent and Coordinator/,
  );
  const actor = board.auth(first.token),
    other = op(human, "mission_create", {
      name: "Other",
      objective: "Separate mission",
    });
  assert.throws(
    () => act(actor, "context_read", { channel_id: other.id }),
    /cannot access/,
  );
  assert.throws(
    () =>
      op(actor, "mission_create", {
        name: "No authority",
        objective: "Unauthorized",
      }),
    /human/,
  );
  act(human, "invitation_revoke", { invitation_id: link.id });
  assert.throws(() => board.join(input), /invalid or expired/);
  assert.equal(
    board.auth(first.token).id,
    actor.id,
    "Revocation stops new joins without removing existing agents",
  );
});

test("Mutations are idempotent and version checks preserve newer instructions", (t) => {
  const { board, human, mission, act } = setup(t);
  const key = randomUUID(),
    input = { body: "One instruction" };
  const one = act(human, "message_post", input, key);
  assert.equal(act(human, "message_post", input, key).id, one.id);
  assert.throws(
    () => act(human, "message_post", { body: "Different change" }, key),
    /Idempotency key/,
  );
  act(human, "mission_update", {
    ...mission,
    version: mission.version,
    name: "Updated",
    objective: "New objective",
    criteria: mission.criteria,
  });
  assert.throws(
    () =>
      act(human, "mission_update", {
        ...mission,
        name: "Stale",
        version: mission.version,
      }),
    /changed/,
  );
  assert.equal(board.get(mission.defaultStreamId).goal, "New objective");
});

test("Paused agents can read and reach the human, but cannot continue ordinary work", (t) => {
  const { board, human, mission, act, register } = setup(t);
  const a = register("one");
  act(human, "agent_control", {
    agent_id: a.agent.id,
    control: "pause",
    reason: "Wait for clarification.",
  });
  assert.equal(board.heartbeat(a.actor, "idle").control, "pause");
  assert.throws(
    () => act(a.actor, "direction_set", { direction: "Continue anyway" }),
    /Work is paused/,
  );
  act(a.actor, "message_post", {
    body: "Ready when you are.",
    audience: "human",
  });
  assert.equal(board.context(a.actor, mission.id).mission.id, mission.id);
  act(human, "agent_control", {
    agent_id: a.agent.id,
    control: "resume",
    reason: "Proceed.",
  });
  act(a.actor, "direction_set", { direction: "Continuing." });
  act(human, "mission_state", { state: "closed", reason: "Finished." });
  assert.throws(
    () => act(a.actor, "message_post", { body: "Ordinary work" }),
    /Work is paused/,
  );
  act(human, "message_post", { body: "Human follow-up after closure." });
});

test("History is paged, threads stay in their workstream, and direct updates are targeted", (t) => {
  const { board, human, mission, act, register } = setup(t);
  const a = register("one"),
    b = register("two");
  const start = board.context(a.actor, mission.id).cursor;
  const direct = act(human, "message_post", {
    body: "For one",
    audience: a.agent.id,
  });
  assert.ok(
    act(a.actor, "updates_read", { after: start }).events.some(
      (e) => e.data.id === direct.id,
    ),
  );
  assert.ok(
    !act(b.actor, "updates_read", { after: start }).events.some(
      (e) => e.data.id === direct.id,
    ),
  );
  assert.throws(
    () => act(a.actor, "updates_read", { acknowledge: 1e9 }),
    /not delivered/,
  );
  const stream = act(a.actor, "stream_create", {
    name: "Side direction",
    goal: "Keep the conversation focused",
  });
  const root = act(a.actor, "message_post", {
    stream_id: stream.id,
    body: "Root finding",
  });
  const reply = act(b.actor, "message_post", {
    thread_id: root.id,
    stream_id: mission.defaultStreamId,
    body: "Reply in the same stream",
  });
  assert.equal(reply.streamId, stream.id);
  assert.deepEqual(
    act(a.actor, "messages_read", { thread_id: root.id }).messages.map(
      (m) => m.id,
    ),
    [reply.id],
  );
  for (let i = 0; i < 115; i++)
    act(human, "message_post", { body: `History ${i}` });
  const latest = act(a.actor, "messages_read", { limit: 50 }),
    older = act(a.actor, "messages_read", {
      before: latest.nextBefore,
      limit: 50,
    });
  assert.equal(latest.messages.length, 50);
  assert.equal(older.messages.length, 50);
  assert.ok(latest.more);
  assert.ok(older.messages.at(-1).sequence < latest.messages[0].sequence);
});

test("300 registered instances retain distinct identities and bounded agent context", (t) => {
  const { board, human, mission, act, register, invite } = setup(t);
  const link = invite();
  const instances = [];
  for (let i = 0; i < 300; i++)
    instances.push(
      register(`instance-${i}`, i % 2 ? "claude" : "codex", link.token),
    );
  assert.equal(new Set(instances.map((a) => a.agent.id)).size, 300);
  const actor = instances[299].actor,
    ctx = board.context(actor, mission.id);
  assert.equal(ctx.totals.agents, 300);
  assert.ok(ctx.agents.length <= 30);
  assert.ok(ctx.agents.some((a) => a.id === actor.id));
  let offset = 0;
  const all = [];
  do {
    const page = act(actor, "records_read", {
      type: "agent",
      offset,
      limit: 100,
    });
    all.push(...page.items);
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(all.length, 300);
  assert.equal(board.context(human, mission.id).agents.length, 300);
  assert.ok(act(actor, "updates_read", { after: 0 }).events.length <= 100);
});

test("Mission, identity, workstream, and replay cursor survive restart", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "harakiri-persist-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let board = new Blackboard(join(directory, "board.sqlite"));
  const human = board.auth(board.ownerToken);
  const op = (actor, name, input) =>
    board.execute(actor, name, input, randomUUID());
  const m = op(human, "mission_create", {
    name: "Persistent",
    objective: "Remember evidence",
  });
  const link = op(human, "invitation_create", { channel_id: m.id });
  const a = board.join({
      invitation: link.token,
      name: "returning",
      runtime: "codex",
    }),
    actor = board.auth(a.token);
  const before = board.context(actor, m.id).cursor;
  op(actor, "updates_read", {
    channel_id: m.id,
    after: before,
    acknowledge: before,
  });
  const message = op(human, "message_post", {
    channel_id: m.id,
    body: "Read this after reconnect.",
  });
  board.close();
  board = new Blackboard(join(directory, "board.sqlite"));
  try {
    assert.equal(board.auth(a.token).id, actor.id);
    assert.equal(board.get(actor.id).cursor, before);
    assert.ok(
      board
        .updates(actor, { channel_id: m.id, after: before })
        .events.some((e) => e.data.id === message.id),
    );
  } finally {
    board.close();
  }
});
