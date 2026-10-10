import test from "node:test";
import assert from "node:assert/strict";
import {
  agentPresentation,
  missionPresentation,
  missionDecisions,
} from "../shared/mission-presentation.mjs";

function fixture() {
  const mission = {
    id: "mission",
    owner: "owner",
    definition: { policy: { coordination: "coordinated" } },
    lifecycle: {
      phase: "preparing",
      revision: "control",
      terms_revision: "terms",
      coordinator: { identity: { author: "coordinator" } },
      start_blockers: ["coordinator_not_ready"],
    },
  };
  const agent = {
    id: "agent",
    contributor: "owner",
    identity: {
      author: "coordinator",
      runtime: "grok",
      label: "Coordinator",
      contributor_name: "Leïla",
    },
  };
  const contribution = {
    id: "local",
    mission: { missionId: "mission" },
    status: "prepared",
    sharedAgent: { registration: "agent" },
    nodeBinding: { revision: "terms" },
  };
  const execution = {
    observedAt: 1000,
    record: { status: "ready" },
    permissions: [],
  };
  return {
    mission,
    agent,
    contribution,
    execution,
    viewer: "owner",
    now: 2000,
  };
}
const project = (f, more = {}) =>
  missionPresentation({
    ...f,
    agents: [f.agent],
    contributions: [f.contribution],
    states: { local: f.execution },
    ...more,
  });

test("a new mission has one setup dependency; peer collaboration does not invent a Coordinator requirement", () => {
  const f = fixture();
  f.mission.lifecycle.coordinator = null;
  f.mission.lifecycle.start_blockers = ["coordinator_missing", "plan_missing"];
  let p = project(f, { agents: [], contributions: [] });
  assert.equal(p.decisions.length, 1);
  assert.equal(p.next.kind, "setup");
  assert.match(p.next.reason, /approve planning and mission Start separately/);
  p = project(f, { agents: [], contributions: [], viewer: "visitor" });
  assert.equal(p.next, null);
  assert.equal(p.waiting[0].responsible, "the mission owner");
  f.mission.definition.policy.coordination = "peer";
  f.mission.lifecycle.start_blockers = [];
  p = project(f, { agents: [], contributions: [] });
  assert.equal(p.next.kind, "start");
  assert.equal(
    p.decisions.some((d) => d.kind === "setup"),
    false,
  );
});

test("paused plan re-review is the same next step in the summary and inspector", () => {
  const f = fixture();
  f.mission.lifecycle.phase = "paused";
  f.mission.lifecycle.plan = { text: "Compare the alternatives" };
  const p = project(f, { agents: [], contributions: [] });
  assert.equal(p.decisions.length, 1);
  assert.equal(p.next.action.label, "Review plan to resume");
  assert.equal(p.next.action.review, true);
  assert.equal(project(f, { viewer: "visitor", agents: [] }).next, null);
  f.mission.lifecycle.phase = "archived";
  assert.equal(project(f, { agents: [] }).next, null);
});

test("planning, human Start and execution are separate without competing next actions", () => {
  const f = fixture();
  assert.equal(project(f).next.action.label, "Review planning session");
  f.execution.record.status = "running";
  assert.equal(project(f).summary, "Coordinator is preparing the plan");
  assert.equal(project(f).next, null);
  f.execution.record.status = "stopped";
  f.mission.lifecycle.readiness = { id: "ack" };
  f.mission.lifecycle.start_blockers = [];
  assert.equal(project(f).summary, "Plan ready for your review");
  assert.equal(project(f).decisions.length, 1);
  assert.equal(project(f).next.action.destination, "controls");
  assert.equal(project(f, { viewer: "contributor" }).next, null);
});

test("remote signed reports never offer another person's sign-in or local consent", () => {
  const f = fixture();
  const observation = {
    expiresAt: 6000,
    report: { control: "control", state: "sign_in", issued_ms: 1000 },
  };
  let s = agentPresentation({
    ...f,
    contribution: undefined,
    execution: undefined,
    observation,
  });
  assert.equal(s.action, null);
  assert.equal(s.state, "setup");
  assert.match(s.reason, /Leïla.*sign in/);
  observation.report.state = "awaiting_approval";
  s = agentPresentation({ ...f, contribution: undefined, observation });
  assert.equal(s.action, null);
  assert.match(s.reason, /Leïla.*approve/);
  f.mission.lifecycle.phase = "active";
  observation.report.state = "awaiting_owner";
  assert.equal(
    agentPresentation({ ...f, contribution: undefined, observation }).action
      .label,
    "Review authorization",
  );
  assert.equal(
    agentPresentation({
      ...f,
      viewer: "other",
      contribution: undefined,
      observation,
    }).action,
    null,
  );
});

test("stale or different-control observations cannot establish a stop or useful work", () => {
  const f = fixture();
  f.mission.lifecycle.phase = "paused";
  const observation = {
    expiresAt: 1500,
    report: { control: "control", state: "stopped", issued_ms: 1000 },
  };
  const result = project(f, {
    contributions: [],
    observations: { agent: observation },
  });
  assert.match(result.summary, /0 stopped, 1 unconfirmed/);
  assert.equal(result.rows[0].status.stopConfirmed, false);
  assert.equal(result.urgent, true);
  observation.expiresAt = 10000;
  observation.report.control = "older-control";
  assert.equal(
    project(f, { contributions: [], observations: { agent: observation } })
      .rows[0].status.state,
    "unknown",
  );
});

test("Pause does not claim termination; confirmed stops are distinct from idle sessions", () => {
  const f = fixture();
  f.mission.lifecycle.phase = "paused";
  for (const status of [
    "running",
    "waiting",
    "stopping",
    "recovery_required",
  ]) {
    f.execution.record.status = status;
    assert.match(project(f).summary, /1 unconfirmed/, status);
  }
  f.execution.record.status = "stopped";
  assert.equal(project(f).rows[0].status.label, "Stopped");
  assert.equal(project(f).summary, "Mission paused");
  assert.equal(project(f).rows[0].status.action, null);
});

test("archiving is not completion; acceptance remains distinct from closure", () => {
  const f = fixture();
  f.execution.record.status = "stopped";
  f.mission.lifecycle.phase = "archived";
  assert.equal(project(f).summary, "Archived");
  assert.match(
    project(f).rows[0].status.reason,
    /Mission archived; this agent is stopped/,
  );
  assert.equal(project(f).next, null);
  f.mission.lifecycle.phase = "closed";
  assert.equal(project(f).summary, "Closed");
  assert.match(
    project(f).rows[0].status.reason,
    /Mission closed; this agent is stopped/,
  );
  assert.equal(
    project(f, { acceptedResult: { revision: "exact" } }).summary,
    "Closed · result accepted",
  );
});

test("final review waits for work and current criteria; plan completion alone is not a handoff", () => {
  const f = fixture();
  f.mission.lifecycle.plan = { artifact: "completed-plan" };
  for (const phase of ["preparing", "active", "paused", "closed", "archived"]) {
    f.mission.lifecycle.phase = phase;
    const results = (criteria) =>
      missionDecisions({ ...f, criteria }).some((d) => d.kind === "results");
    assert.equal(results([]), false);
    assert.equal(results([{ met: false, stale: false }]), false);
    assert.equal(results([{ met: true, stale: true }]), false);
    assert.equal(
      results([{ met: true, stale: false }]),
      ["active", "paused"].includes(phase),
    );
  }
});

test("agreement waiting doesn't offer another run approval and changed instructions do", () => {
  const f = fixture();
  f.mission.lifecycle.phase = "active";
  f.execution.agreement = {
    status: "active",
    message: "Queued for capacity on this Mac.",
  };
  assert.equal(project(f).next, null);
  assert.equal(
    project(f).rows[0].status.reason,
    "Queued for capacity on this Mac.",
  );
  f.mission.lifecycle.terms_revision = "changed";
  assert.equal(project(f).next.action.label, "Review changed instructions");
});

test("safety uncertainty outranks Start; peer collaboration needs no invented plan", () => {
  const f = fixture();
  f.mission.lifecycle.start_blockers = [];
  f.execution.record.status = "recovery_required";
  assert.equal(project(f).next.action.label, "Confirm stop");
  f.mission.definition.policy.coordination = "peer";
  f.mission.lifecycle.coordinator = null;
  const result = project(f, { agents: [], contributions: [] });
  assert.equal(result.next.action.label, "Review and start");
  assert.equal(result.next.kind, "start");
});

test("mission decision identity is stable until the underlying request changes", () => {
  const f = fixture();
  const requests = [
    { author: "b", status: "pending" },
    { author: "a", status: "pending" },
  ];
  assert.deepEqual(
    missionDecisions({ ...f, requests }),
    missionDecisions({ ...f, requests: requests.toReversed() }),
  );
  assert.equal(missionDecisions({ ...f, requests, viewer: "guest" }).length, 0);
  assert.equal(
    missionDecisions({ ...f, criteria: [{ met: true, stale: true }] }).length,
    0,
  );
});

test("interrupted Start stays actionable after the mission became active and resolves from the saved job", () => {
  const f = fixture();
  f.mission.lifecycle.phase = "active";
  f.execution.record.status = "running";
  const startJobs = [{ id: "saved-review", phase: "started" }];
  const result = project(f, { startJobs });
  assert.equal(result.next.id, "start-review:saved-review");
  assert.equal(result.next.action.label, "Continue Start review");
  startJobs[0].phase = "complete";
  assert.equal(project(f, { startJobs }).next, null);
});

test("capacity and new-work waits preserve confirmed process state and name the automatic dependency", () => {
  const f = fixture();
  f.mission.lifecycle.phase = "active";
  f.execution.record.status = "stopped";
  f.execution.agreement = {
    status: "active",
    waitingFor: "capacity",
    message: "Waiting for a slot on this Mac.",
  };
  const s = project(f).rows[0].status;
  assert.equal(s.state, "waiting");
  assert.equal(s.stopConfirmed, true);
  assert.equal(s.cause, "capacity");
  assert.equal(s.responsible, "automatic within your approval");
  assert.equal(s.action, null);
});
