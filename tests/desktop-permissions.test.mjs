import test from "node:test";
import assert from "node:assert/strict";
import {
  currentPermissions,
  executionBinding,
} from "../desktop/execution/permissions.mjs";

test("permission picker excludes old directions, paused work, exhausted and unreviewed grants", () => {
  const contribution = {
    id: "fixture",
    runtime: "grok",
    sharedAgent: { registration: "agent" },
    limits: { mode: "unlimited" },
    nodeBinding: { revision: "terms" },
  };
  const context = {
    lifecycle: { revision: "control", phase: "active" },
    agent: { status: "direction_assigned", direction: { id: "new" } },
  };
  const good = {
    id: "new-permission",
    registration: "agent",
    control: "control",
    consent_binding: executionBinding(contribution),
    purpose: "work",
    direction: "new",
    issued_ms: 1000,
    expires_ms: 10000,
    offline_ms: 9000,
    turns: 2,
    charged: 0,
    reserved: 0,
    generation: 2,
    execution: "execution",
    sealed: false,
  };
  const record = {
    grant: "old-permission",
    execution: "execution",
    generation: 1,
  };
  const variants = [
    { direction: "old" },
    { control: "old" },
    { registration: "another" },
    { consent_binding: "other-policy" },
    { sealed: true },
    { charged: 2 },
    { reserved: 2 },
    { generation: 1 },
    { id: "old-permission" },
    { expires_ms: 1001 },
    { issued_ms: 40000 },
  ];
  const snapshot = {
    contribution,
    context,
    governance: { grants: [good, ...variants.map((v) => ({ ...good, ...v }))] },
  };
  assert.deepEqual(currentPermissions(snapshot, record, 2000), [good]);
  context.lifecycle.phase = "paused";
  assert.deepEqual(currentPermissions(snapshot, record, 2000), []);
});
