import test from "node:test";
import assert from "node:assert/strict";
import runtimes from "../shared/runtimes.json" with { type: "json" };
import {
  adapters,
  runtimeArguments,
  runtimeEvent,
} from "../bin/runtime-adapters.mjs";
import { permissionOutcome } from "../bin/grok-acp.mjs";

test("Every advertised runtime has a launcher adapter; unknown runtimes fail closed", () => {
  assert.deepEqual(Object.keys(adapters).sort(), Object.keys(runtimes).sort());
  for (const runtime of ["unknown", "toString", "__proto__", undefined])
    assert.throws(
      () => runtimeArguments({ runtime }, "file", "prompt", "mcp"),
      /Runtime must be/,
    );
});

test("Grok transports large prompts and per-instance MCP paths over stdin on new and resumed turns", () => {
  const prompt = "long prompt with quotes and \n".repeat(10000);
  for (const mode of ["default", "full"])
    for (const nativeSession of [null, "uuid-saved"]) {
      const spec = runtimeArguments(
        {
          runtime: "grok",
          cwd: "/work/agent 1",
          nativeSession,
          execution: { permissions: mode, shared: "/work/shared" },
        },
        "/private/session.json",
        prompt,
        "/code/server/mcp.mjs",
      );
      assert.equal(spec.command, process.execPath);
      assert.equal(spec.args.length, 1);
      assert.deepEqual(JSON.parse(spec.input), {
        cwd: "/work/agent 1",
        shared: "/work/shared",
        nativeSession,
        permissions: mode,
        file: "/private/session.json",
        mcp: "/code/server/mcp.mjs",
        prompt,
      });
      assert.ok(!spec.args.join(" ").includes(prompt));
    }
  assert.throws(
    () => runtimeArguments({ runtime: "grok", boardOnly: true }, "", "", ""),
    /does not yet support --board-only/,
  );
});

test("Each runtime owns its native session and failure event format", () => {
  assert.equal(
    runtimeEvent("claude", { type: "system", session_id: "cc-1" }).sessionId,
    "cc-1",
  );
  assert.equal(
    runtimeEvent("codex", { type: "thread.started", thread_id: "cx-1" })
      .sessionId,
    "cx-1",
  );
  assert.equal(
    runtimeEvent("grok", { type: "session.started", sessionId: "gk-1" })
      .sessionId,
    "gk-1",
  );
  assert.deepEqual(
    runtimeEvent("grok", { type: "system", session_id: "unrelated" }),
    {},
  );
  for (const runtime of Object.keys(runtimes)) {
    assert.equal(
      runtimeEvent(runtime, { type: "error", message: "provider unavailable" })
        .error,
      "provider unavailable",
    );
    assert.equal(
      runtimeEvent(runtime, {
        type: "turn.failed",
        error: { message: "quota" },
      }).error,
      "quota",
    );
  }
});

test("Grok approves only identified Blackboard MCP calls by default and never persists approval", () => {
  const options = [
    { kind: "allow_always", optionId: "persist" },
    { kind: "allow_once", optionId: "once" },
    { kind: "reject_once", optionId: "no" },
  ];
  const outcome = (toolCall, mode = "default", extra = {}) =>
    permissionOutcome({ toolCall, options, ...extra }, mode).outcome;
  const tool = (name, rawInput) => ({
    _meta: { "x.ai/tool": { name } },
    rawInput,
  });
  assert.deepEqual(outcome(tool("harakiri__message_post")), {
    outcome: "selected",
    optionId: "once",
  });
  assert.equal(
    outcome(tool("use_tool", { tool_name: "harakiri__context_read" })).optionId,
    "once",
  );
  for (const call of [
    { title: "harakiri__message_post" },
    tool("bash", { tool_name: "harakiri__message_post" }),
    tool("other__message_post"),
    tool("use_tool", { tool_name: "other__message_post" }),
    tool("use_tool", {
      tool_name: "harakiri__message_post",
      tool_input_file: "/private/file",
    }),
    tool("use_tool", { file: "/private/file" }),
    tool("harakiri_impostor__message_post"),
  ])
    assert.equal(outcome(call).optionId, "no");
  assert.equal(outcome(tool("bash"), "full").optionId, "once");
  assert.equal(
    outcome(tool("harakiri__message_post"), "default", {
      _meta: { hookAsk: {} },
    }).optionId,
    "no",
  );
  assert.deepEqual(
    permissionOutcome(
      { toolCall: tool("bash"), options: options.slice(0, 1) },
      "full",
    ).outcome,
    { outcome: "cancelled" },
  );
  assert.equal(
    permissionOutcome(
      { toolCall: { toolCallId: "t" }, options },
      "default",
      tool("harakiri__message_post"),
    ).outcome.optionId,
    "once",
  );
});
