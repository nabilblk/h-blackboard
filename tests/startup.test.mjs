import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Blackboard } from "../server/board.mjs";

function fixture(t, mode = "coordinated", file) {
  const board = new Blackboard(file);
  t.after(() => board.close());
  const human = board.auth(board.ownerToken);
  const mission = board.execute(
    human,
    "mission_create",
    {
      name: "Startup regression",
      objective: "Explore useful alternatives",
      coordination_mode: mode,
    },
    randomUUID(),
  );
  const act = (actor, op, input = {}, key = randomUUID()) =>
    board.execute(actor, op, { channel_id: mission.id, ...input }, key);
  const current = () => board.get(mission.id);
  const register = (name, role = "agent") => {
    const invite = act(human, "invitation_create", { role });
    const result = board.join({
      invitation: invite.token,
      name,
      runtime: "codex",
    });
    return { ...result, actor: board.auth(result.token) };
  };
  const appoint = (agent) =>
    act(human, "coordinator_set", {
      version: current().version,
      agent_id: agent?.agent.id || null,
      reason: "Human chose the coordinator",
    });
  const ready = (lead) => {
    act(lead.actor, "plan_update", {
      version: current().version,
      plan: "Explore alternatives in Main. Announce distinct approaches and publish evidence.",
    });
    return act(lead.actor, "coordinator_ready", {
      revision: current().startupRevision,
    });
  };
  const start = () =>
    act(human, "mission_state", {
      version: current().version,
      state: "active",
      reason: "Start this mission",
    });
  return {
    board,
    human,
    mission,
    act,
    current,
    register,
    appoint,
    ready,
    start,
  };
}

test("A default mission admits members but blocks execution until an explicit coordinated start", (t) => {
  const f = fixture(t);
  assert.equal(f.current().state, "preparing");
  assert.equal(f.current().coordinationMode, "coordinated");
  const agents = Array.from({ length: 6 }, (_, i) => f.register(`worker-${i}`));
  const one = agents[0];
  for (const agent of agents) {
    assert.equal(
      f.board.heartbeat(agent.actor, "idle").participation.state,
      "waiting",
    );
    for (const [op, input] of [
      ["task_create", { title: "Claim the entire mission" }],
      ["direction_set", { direction: "Starting all the work" }],
      ["stream_create", { name: "Unapproved", goal: "Compete" }],
      [
        "stream_join",
        { stream_id: f.current().defaultStreamId, direction: "Begin" },
      ],
    ])
      assert.throws(() => f.act(agent.actor, op, input), /not authorized/);
  }
  const msg = f.act(one.actor, "message_post", {
    body: "Available to help with research.",
  });
  assert.equal(
    f.act(agents[1].actor, "record_read", { id: msg.id }).body,
    msg.body,
  );
  const dm = f.act(f.human, "message_post", {
    direct_agent_id: one.agent.id,
    body: "Private preparation",
  });
  assert.throws(
    () => f.act(agents[1].actor, "record_read", { id: dm.id }),
    /not found/,
  );
  assert.throws(f.start, /Appoint a coordinator/);
  assert.equal(f.board.list(f.mission.id, "task").length, 0);
});

test("The appointed coordinator can plan and acknowledge readiness while workers remain blocked", (t) => {
  const f = fixture(t);
  const worker = f.register("worker"),
    lead = f.register("lead");
  f.appoint(lead);
  assert.equal(
    f.board.heartbeat(lead.actor, "idle").participation.state,
    "planning",
  );
  assert.throws(
    () =>
      f.act(lead.actor, "coordinator_ready", {
        revision: f.current().startupRevision,
      }),
    /Publish the initial shared plan/,
  );
  const stream = f.act(lead.actor, "stream_create", {
    name: "Explore",
    goal: "Compare possibilities",
  });
  const assignment = f.act(lead.actor, "assignment_create", {
    agent_id: worker.agent.id,
    stream_id: stream.id,
    instruction: "Compare a different approach",
  });
  const task = f.act(lead.actor, "task_create", {
    title: "Optional planned work",
    agent_ids: [worker.agent.id],
  });
  assert.equal(task.status, "open");
  assert.throws(
    () =>
      f.act(lead.actor, "task_update", {
        task_id: task.id,
        version: task.version,
        status: "working",
      }),
    /Preparation permits planned tasks/,
  );
  assert.throws(
    () =>
      f.act(worker.actor, "assignment_ack", {
        assignment_id: assignment.id,
        direction: "Begin",
      }),
    /not authorized/,
  );
  assert.throws(f.start, /acknowledge readiness/);
  f.ready(lead);
  assert.throws(
    () =>
      f.act(f.human, "coordinator_ready", {
        revision: f.current().startupRevision,
      }),
    /Only the appointed coordinator/,
  );
  assert.throws(
    () =>
      f.act(lead.actor, "mission_state", {
        version: f.current().version,
        state: "active",
        reason: "Self-start",
      }),
    /not authorized|human/i,
  );
  assert.equal(f.current().state, "preparing");
  assert.equal(f.act(f.human, "context_read").startup.canStart, true);
  f.start();
  f.act(worker.actor, "assignment_ack", {
    assignment_id: assignment.id,
    direction: "Compare possibilities",
  });
  assert.equal(
    f.board.heartbeat(worker.actor, "idle").participation.state,
    "authorized",
  );
});

test("Main-only, task-free startup works and later arrivals wait for their own direction", (t) => {
  const f = fixture(t);
  const existing = f.register("existing"),
    lead = f.register("lead", "coordinator");
  f.ready(lead);
  f.start();
  f.act(existing.actor, "direction_set", { direction: "Explore option A" });
  const late = f.register("late");
  assert.equal(
    f.board.heartbeat(existing.actor).participation.state,
    "authorized",
  );
  assert.equal(f.board.heartbeat(late.actor).participation.state, "waiting");
  assert.throws(
    () => f.act(late.actor, "task_create", { title: "Unassigned work" }),
    /not authorized/,
  );
  assert.throws(
    () =>
      f.act(existing.actor, "agent_admit", {
        agent_ids: [late.agent.id],
        instruction: "Start",
      }),
    /Coordinator or human/,
  );
  f.act(lead.actor, "agent_admit", {
    agent_ids: [late.agent.id],
    instruction: "Explore option B in Main",
  });
  assert.equal(
    f.board.heartbeat(late.actor).participation.instruction,
    "Explore option B in Main",
  );
  f.act(late.actor, "direction_set", { direction: "Explore option B" });
  assert.equal(f.board.list(f.mission.id, "workstream").length, 1);
  assert.equal(f.board.list(f.mission.id, "task").length, 0);
});

test("Explicit peer mode still waits for human start, then admits existing and future agents", (t) => {
  const f = fixture(t, "peer");
  const one = f.register("peer-one");
  assert.throws(
    () => f.act(one.actor, "direction_set", { direction: "Too early" }),
    /not authorized/,
  );
  f.start();
  const two = f.register("peer-two");
  for (const a of [one, two])
    f.act(a.actor, "direction_set", { direction: "Independent exploration" });
  assert.equal(f.current().coordinatorId, null);
  assert.equal(f.board.list(f.mission.id, "task").length, 0);
});

test("Pause and resume preserve admission; an unassigned late arrival remains waiting", (t) => {
  const f = fixture(t);
  const lead = f.register("lead", "coordinator"),
    existing = f.register("existing");
  f.ready(lead);
  f.start();
  const late = f.register("late");
  f.act(f.human, "mission_state", { state: "paused", reason: "Human pause" });
  assert.equal(f.board.heartbeat(existing.actor).participation.state, "paused");
  f.start();
  assert.equal(
    f.board.heartbeat(existing.actor).participation.state,
    "authorized",
  );
  assert.equal(f.board.heartbeat(late.actor).participation.state, "waiting");
});

test("An assignment admits a late arrival and retries cannot duplicate or overwrite that direction", (t) => {
  const f = fixture(t);
  const lead = f.register("lead", "coordinator");
  f.ready(lead);
  f.start();
  const late = f.register("late"),
    other = f.register("other");
  const key = randomUUID();
  const input = {
    agent_id: late.agent.id,
    stream_id: f.current().defaultStreamId,
    instruction: "Check the evidence in Main",
  };
  const first = f.act(lead.actor, "assignment_create", input, key);
  assert.equal(f.act(lead.actor, "assignment_create", input, key).id, first.id);
  assert.equal(
    f.board.heartbeat(late.actor).participation.instruction,
    input.instruction,
  );
  assert.equal(f.board.heartbeat(other.actor).participation.state, "waiting");
  assert.equal(
    f.board.get(first.id).status,
    "pending",
    "admission does not acknowledge the assignment",
  );
  f.act(late.actor, "assignment_ack", {
    assignment_id: first.id,
    direction: "Check sources",
  });
  assert.equal(f.board.list(f.mission.id, "assignment").length, 1);
});

test("Mission edits and plan revisions invalidate readiness; stale starts cannot release workers", (t) => {
  const f = fixture(t);
  const lead = f.register("lead", "coordinator");
  f.ready(lead);
  const old = f.current();
  f.act(f.human, "mission_update", {
    version: old.version,
    name: old.name,
    objective: "A changed objective",
    scope: "New constraints",
    criteria: [],
  });
  assert.equal(f.act(f.human, "context_read").startup.coordinatorReady, false);
  assert.throws(
    () =>
      f.act(lead.actor, "coordinator_ready", { revision: old.startupRevision }),
    /Startup instructions changed/,
  );
  assert.throws(
    () =>
      f.act(f.human, "mission_state", {
        version: old.version,
        state: "active",
        reason: "Stale start",
      }),
    /changed/,
  );
  assert.throws(f.start, /acknowledge readiness/);
  f.ready(lead);
  f.act(f.human, "plan_update", {
    version: f.current().version,
    plan: "Revised plan",
  });
  assert.throws(f.start, /acknowledge readiness/);
  f.act(lead.actor, "coordinator_ready", {
    revision: f.current().startupRevision,
  });
  assert.throws(
    () =>
      f.act(f.human, "mission_state", {
        state: "active",
        reason: "No version",
      }),
    /changed/,
  );
  f.start();
});

test("Removing or replacing a coordinator cannot silently enable peer organization", (t) => {
  const f = fixture(t);
  const lead = f.register("lead", "coordinator"),
    other = f.register("other");
  f.ready(lead);
  f.start();
  f.appoint(null);
  assert.equal(f.current().state, "preparing");
  assert.equal(f.current().coordinationMode, "coordinated");
  assert.throws(
    () =>
      f.act(other.actor, "stream_create", {
        name: "Race",
        goal: "Bypass the missing coordinator",
      }),
    /not authorized/,
  );
  assert.throws(f.start, /Appoint a coordinator/);
  f.appoint(other);
  assert.throws(
    () =>
      f.act(lead.actor, "plan_update", {
        version: f.current().version,
        plan: "Old authority",
      }),
    /not authorized/,
  );
  assert.equal(f.act(f.human, "context_read").startup.coordinatorReady, false);
  f.ready(other);
  f.start();
});

test("A missing heartbeat or paused coordinator blocks startup without changing mode", (t) => {
  const f = fixture(t);
  const lead = f.register("lead", "coordinator");
  f.ready(lead);
  f.board.put({ ...f.board.get(lead.agent.id), lastSeen: Date.now() - 60000 });
  assert.throws(f.start, /unavailable/);
  assert.equal(f.current().coordinationMode, "coordinated");
  f.board.heartbeat(lead.actor, "idle");
  f.act(f.human, "agent_control", {
    agent_id: lead.agent.id,
    control: "pause",
    reason: "Wait",
  });
  assert.throws(f.start, /unavailable/);
  f.act(f.human, "agent_control", {
    agent_id: lead.agent.id,
    control: "resume",
    reason: "Proceed",
  });
  f.start();
});

test("Switching mode explicitly invalidates readiness and stale coordinator invitations", (t) => {
  const f = fixture(t);
  const invite = f.act(f.human, "invitation_create", { role: "coordinator" });
  const one = f.register("member");
  f.act(f.human, "coordination_set", {
    version: f.current().version,
    mode: "peer",
  });
  assert.throws(
    () =>
      f.board.join({
        invitation: invite.token,
        name: "stale",
        runtime: "claude",
      }),
    /Choose coordinated mode/,
  );
  assert.equal(f.current().state, "preparing");
  f.start();
  f.act(one.actor, "direction_set", { direction: "Explore" });
  f.act(f.human, "coordination_set", {
    version: f.current().version,
    mode: "coordinated",
  });
  assert.equal(f.current().state, "preparing");
  assert.throws(f.start, /Appoint a coordinator/);
});

test("Admission cannot override a human pause or a direct human assignment", (t) => {
  const f = fixture(t);
  const lead = f.register("lead", "coordinator");
  f.ready(lead);
  f.start();
  const late = f.register("late");
  f.act(f.human, "agent_control", {
    agent_id: late.agent.id,
    control: "pause",
    reason: "Hold",
  });
  f.act(lead.actor, "agent_admit", {
    agent_ids: [late.agent.id],
    instruction: "Research",
  });
  assert.equal(f.board.heartbeat(late.actor).participation.state, "paused");
  f.act(f.human, "assignment_create", {
    agent_id: late.agent.id,
    stream_id: f.current().defaultStreamId,
    instruction: "Human direction",
  });
  assert.throws(
    () =>
      f.act(lead.actor, "agent_admit", {
        agent_ids: [late.agent.id],
        instruction: "Override",
      }),
    /direct human assignment/,
  );
  f.act(f.human, "agent_control", {
    agent_id: late.agent.id,
    control: "resume",
    reason: "Proceed",
  });
  assert.equal(
    f.board.heartbeat(late.actor).participation.instruction,
    "Human direction",
  );
});

test("Preparation and readiness persist across restart without starting the mission", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "harakiri-startup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "board.sqlite");
  const f = fixture(t, "coordinated", file);
  const worker = f.register("waiting"),
    lead = f.register("lead", "coordinator");
  f.ready(lead);
  const reopened = new Blackboard(file);
  t.after(() => reopened.close());
  assert.equal(reopened.get(f.mission.id).state, "preparing");
  assert.equal(
    reopened.context(f.human, f.mission.id).startup.coordinatorReady,
    true,
  );
  assert.equal(reopened.heartbeat(worker.actor).participation.state, "waiting");
});

test("An existing active mission migrates once without stopping participants or inventing readiness", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "harakiri-startup-legacy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "board.sqlite");
  const old = new Blackboard(file);
  const mission = old.new("mission", null, {
    name: "Existing",
    objective: "Continue existing work",
    state: "active",
    coordinatorId: "legacy-coordinator",
    plan: "Existing plan",
  });
  const a = old.new("agent", mission.id, {
    control: "resume",
    lastSeen: Date.now(),
    status: "idle",
  });
  old.db.prepare("DELETE FROM settings WHERE key='startup-v1'").run();
  old.close();
  const migrated = new Blackboard(file);
  assert.equal(migrated.get(mission.id).state, "active");
  assert.equal(migrated.get(mission.id).coordinationMode, "coordinated");
  assert.equal(migrated.get(mission.id).coordinatorReady, null);
  assert.equal(
    migrated.actorView(migrated.get(a.id), migrated.get(mission.id))
      .participation.state,
    "authorized",
  );
  const admission = migrated.get(a.id).admission;
  migrated.close();
  const again = new Blackboard(file);
  t.after(() => again.close());
  assert.deepEqual(again.get(a.id).admission, admission);
});
