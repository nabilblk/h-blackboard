import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { guestTools } from "../desktop/execution/tools.mjs";
import { buildTurnPrompt } from "../desktop/execution/prompt.mjs";
import { AgentOperation } from "../desktop/node-service.mjs";
import { ArtifactBrowserRequest } from "../desktop/artifact-browser.mjs";
import { nodeError } from "../desktop/node-bridge.mjs";
const id = "a".repeat(64);

test("new protocol operations are available to the scoped runtime without authority escalation", () => {
  for (const operation of [
    { type: "snapshot", watch: [id] },
    {
      type: "artifact_action",
      control: id,
      conversation: "main",
      action: { type: "candidate", revision: id, previous: [] },
    },
  ])
    assert.ok(AgentOperation.safeParse(operation).success);
  assert.equal(
    AgentOperation.safeParse({ type: "snapshot", watch: [id], mission: id })
      .success,
    false,
  );
  const tools = guestTools();
  assert.ok(tools.find((t) => t.name === "artifact_browser"));
  assert.ok(tools.find((t) => t.name === "wait_for_work"));
  assert.ok(tools.find((t) => t.name === "read_tool_result"));
  assert.ok(!tools.some((t) => /start|grant|credentials/.test(t.name)));
  const instructions = readFileSync("desktop/execution/guest/agent.md", "utf8");
  for (const concept of [
    "thread",
    "OPTIONAL",
    'relation:"citation"',
    "counterexamples",
    "human must Start",
    "wait_for_work",
    "candidate",
    "not_run",
  ])
    assert.ok(instructions.includes(concept), `runtime guide lost ${concept}`);
});

test("briefing preserves the mission and current identity while explicitly bounding repeated history", () => {
  const context = {
    context: {
      definition: { objective: "A premium learning experience" },
      agent: { identity: { role: "coordinator" } },
    },
    main: {
      items: Array.from({ length: 100 }, (_, i) => ({
        id: i,
        text: `message-${i}`,
      })),
    },
  };
  const prompt = buildTurnPrompt({
    context,
    purpose: "planning",
    networkAccess: "restricted",
    seconds: 300,
  });
  assert.match(prompt, /Coordinator/);
  assert.match(prompt, /protocol 13/);
  assert.match(prompt, /resuming an older saved conversation/);
  assert.match(prompt, /relation:"citation"/);
  assert.match(prompt, /must Start before implementation/);
  assert.match(prompt, /300 seconds/);
  assert.match(prompt, /premium learning experience/);
  assert.match(prompt, /message-99/);
  assert.doesNotMatch(prompt, /message-0"/);
  assert.match(prompt, /briefing_truncated/);
});

test("browser requests are data, bounded and never a host scripting interface", () => {
  const input = {
    revision: id,
    path: "index.html",
    width: 390,
    height: 700,
    steps: [{ type: "fill", selector: "#distance", value: "0" }],
  };
  assert.ok(ArtifactBrowserRequest.safeParse(input).success);
  for (const bad of [
    { ...input, url: "https://localhost" },
    { ...input, script: "process.env" },
    { ...input, steps: [{ type: "evaluate", script: "x" }] },
    { ...input, steps: Array(9).fill({ type: "click", selector: "button" }) },
  ])
    assert.equal(ArtifactBrowserRequest.safeParse(bad).success, false);
  assert.equal(nodeError("capacity_busy").retryable, true);
  assert.equal(nodeError("private token").code, "operation_rejected");
  assert.doesNotMatch(nodeError("private token").message, /private token/);
});
