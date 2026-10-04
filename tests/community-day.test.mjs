import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyDisruption,
  checkPlan,
  deliveryPaths,
  hasIndependentReview,
} from "../experiments/community-day/check.mjs";

test("handoff review cannot be replaced by publication, self-review or stale evidence", () => {
  const review = {
    verdict: "verified",
    stale: false,
    self_review: false,
    checks: [{ method: "source_inspection", result: "passed" }],
  };
  assert.equal(hasIndependentReview([], "source_inspection"), false);
  assert.equal(hasIndependentReview([review], "source_inspection"), true);
  assert.equal(hasIndependentReview([review], "executed_tests"), false);
  for (const change of [{ stale: true }, { self_review: true }, { checks: [] }])
    assert.equal(
      hasIndependentReview([{ ...review, ...change }], "source_inspection"),
      false,
    );
});

test("an outstanding review objection blocks the experiment despite another positive review", () => {
  const positive = {
    verdict: "verified",
    stale: false,
    self_review: false,
    checks: [{ method: "source_inspection", result: "passed" }],
  };
  const objection = {
    ...positive,
    verdict: "changes_requested",
    checks: [{ method: "source_inspection", result: "failed" }],
  };
  assert.equal(hasIndependentReview([objection], "source_inspection"), false);
  assert.equal(
    hasIndependentReview([positive, objection], "source_inspection"),
    false,
  );
  assert.equal(
    hasIndependentReview(
      [positive, { ...objection, stale: true }],
      "source_inspection",
    ),
    true,
  );
});

test("delivery evaluation accepts data beside a nested HTML entrypoint without selecting unrelated files", () => {
  const doc = (entrypoint, paths) => ({
    entrypoint,
    files: paths.map((path) => ({ path })),
  });
  assert.deepEqual(
    deliveryPaths(
      doc("guide/index.html", [
        "guide/index.html",
        "guide/schedule.json",
        "guide/budget.json",
        "guide/check.py",
      ]),
    ),
    { schedule: "guide/schedule.json", budget: "guide/budget.json" },
  );
  assert.deepEqual(
    deliveryPaths(
      doc("index.html", [
        "index.html",
        "schedule.json",
        "budget.json",
        "check.py",
      ]),
    ),
    { schedule: "schedule.json", budget: "budget.json" },
  );
  assert.equal(
    deliveryPaths(
      doc("guide/index.html", [
        "guide/index.html",
        "unrelated/schedule.json",
        "budget.json",
        "check.py",
      ]),
    ),
    null,
  );
  assert.equal(
    deliveryPaths(
      doc("missing.html", [
        "index.html",
        "schedule.json",
        "budget.json",
        "check.py",
      ]),
    ),
    null,
  );
});

const baseline = JSON.parse(
  readFileSync(
    new URL("../experiments/community-day/baseline.json", import.meta.url),
  ),
);
const change = JSON.parse(
  readFileSync(
    new URL("../experiments/community-day/disruption.json", import.meta.url),
  ),
);
const revised = applyDisruption(baseline, change);
const budget = (input) => {
  const subtotal_cents = input.costs.reduce(
    (n, i) => n + i.quantity * i.unit_cost_cents,
    0,
  );
  const reserve_cents = Math.ceil(
    (subtotal_cents * input.reserve_percent) / 100,
  );
  return {
    input_revision: input.revision,
    items: structuredClone(input.costs),
    subtotal_cents,
    reserve_cents,
    total_cents: subtotal_cents + reserve_cents,
  };
};
// Feasibility witnesses for the evaluator only. Not part of the agent prompt.
function schedule(input) {
  const changed = input.revision === "venue-change";
  return {
    input_revision: input.revision,
    sessions: [
      ["welcome", "hall", 615],
      ["bridges", changed ? "hall" : "lab", 660],
      ["robots", "lab", changed ? 750 : 720],
      ["repair", "hall", changed ? 720 : 660],
      ["gardens", "courtyard", changed ? 795 : 735],
      ["solar", "lab", changed ? 825 : 795],
      ["first-aid", "hall", 795],
      ["finale", "hall", changed ? 885 : 855],
    ].map(([activity, room, start]) => ({ activity, room, start })),
  };
}
test("community-day baseline and changed inputs both have feasible solutions", () => {
  for (const input of [baseline, revised])
    assert.deepEqual(
      checkPlan(input, schedule(input), budget(input)).errors,
      [],
    );
  assert.equal(baseline.rooms[1].closures.length, 0, "Input remains immutable");
  assert.throws(() => applyDisruption(revised, change), /does not apply/);
});
test("independent checker rejects superseded input and catches constraint failures", () => {
  assert.equal(
    checkPlan(revised, schedule(baseline), budget(baseline)).passed,
    false,
  );
  const mutations = [
    ["coverage", (s) => s.sessions.pop()],
    ["coverage", (s) => (s.sessions[1].activity = "welcome")],
    ["session_shape", (s) => (s.sessions[1].start = "660")],
    ["room", (s) => (s.sessions[0].room = "lab")],
    ["hours", (s) => (s.sessions[0].start = 600)],
    ["dependency", (s) => (s.sessions[7].start = 810)],
    ["closure", (s) => (s.sessions[1].room = "lab")],
    ["room_overlap", (s) => (s.sessions[3].start = 705)],
    ["facilitator_hours", (s) => (s.sessions[6].start = 735)],
    ["facilitator_overlap", (s) => (s.sessions[2].start = 675)],
    ["equipment", (s) => (s.sessions[5].start = 795)],
    [
      "volunteers",
      (s) => {
        s.sessions[3].start = 795;
        s.sessions[5].start = 795;
      },
    ],
    ["cost", (_, b) => (b.items[0].unit_cost_cents = 0)],
    ["cost_coverage", (_, b) => b.items.push(b.items[0])],
    ["totals", (_, b) => (b.total_cents = 0)],
  ];
  for (const [code, mutate] of mutations) {
    const s = schedule(revised),
      b = budget(revised);
    mutate(s, b);
    const result = checkPlan(revised, s, b);
    assert.ok(
      result.errors.some((e) => e.code === code),
      `${code}: ${JSON.stringify(result.errors)}`,
    );
  }
  assert.equal(checkPlan(revised, null, null).passed, false);
  assert.ok(
    checkPlan(
      { ...revised, spending_cap_cents: 1 },
      schedule(revised),
      budget(revised),
    ).errors.some((e) => e.code === "spending_cap"),
  );
});
