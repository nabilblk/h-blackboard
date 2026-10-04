import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import {
  ClaudeConnection,
  CodexConnection,
} from "../desktop/execution/runtime-connection.mjs";
import {
  newRecord,
  POLICY_DIGEST,
  POLICY_DIGESTS,
  policyDigest,
  runtimePolicy,
} from "../desktop/execution/contract.mjs";
import { executionBinding } from "../desktop/node-service.mjs";

const tools = [
  "board",
  "workspace_exec",
  "workspace_read",
  "workspace_write",
  "import_artifact",
  "publish_artifact",
].map((t) => `mcp__harakiri__${t}`);
function transport(respond) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.send = (message) => child.stdout.write(JSON.stringify(message) + "\n");
  child.kill = () => child.emit("close", 0);
  child.stdin = new Writable({
    write(data, _enc, done) {
      setImmediate(() => respond(JSON.parse(data), child));
      done();
    },
    final(done) {
      child.emit("close", 0);
      done();
    },
  });
  return child;
}

test("runtime consent and journals distinguish all three policies while preserving Grok", () => {
  assert.equal(policyDigest("grok"), POLICY_DIGEST);
  assert.equal(new Set(Object.values(POLICY_DIGESTS)).size, 3);
  const contribution = {
    id: randomUUID(),
    workspaceIdentity: "workspace",
    limits: { mode: "unlimited" },
    nodeBinding: "terms",
  };
  const bindings = [];
  for (const runtime of ["grok", "claude", "codex"]) {
    assert.equal(
      newRecord(contribution.id, 1, runtime).policy,
      policyDigest(runtime),
    );
    assert.equal(runtimePolicy(runtime).nativeTools, false);
    bindings.push(executionBinding({ ...contribution, runtime }));
  }
  assert.equal(new Set(bindings).size, 3);
  assert.throws(() => runtimePolicy("__proto__"));
  assert.throws(() => newRecord(contribution.id, 1, "other"));
});

for (const includeImport of [true, false])
  test(`Claude preserves session and scoped tools with ${includeImport ? "current" : "previous"} guest broker`, async (t) => {
    const sessionId = randomUUID(),
      events = [];
    let saved = false;
    const child = transport((message, c) => {
      assert.ok(saved);
      assert.equal(message.session_id, sessionId);
      c.send({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        tools: includeImport
          ? tools
          : tools.filter((name) => !name.endsWith("__import_artifact")),
      });
      c.send({
        type: "assistant",
        session_id: sessionId,
        message: {
          content: [
            { type: "tool_use", name: tools[0] },
            { type: "text", text: "Completed." },
          ],
        },
      });
      c.send({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: sessionId,
        usage: { input_tokens: 5, output_tokens: 2 },
      });
    });
    const connection = new ClaudeConnection({
      transport: child,
      sessionId,
      onEvent: (e) => events.push(e),
    });
    t.after(() => connection.close());
    const result = await connection.run({
      prompt: "Do work",
      seconds: 2,
      onSession: async (id) => {
        assert.equal(id, sessionId);
        saved = true;
      },
    });
    assert.equal(result.session, sessionId);
    assert.equal(result.usage.totalTokens, 7);
    assert.equal(events[0].update.sessionUpdate, "tool_call");
    assert.equal(events[1].update.content.text, "Completed.");
  });

for (const [name, messages, pattern] of [
  [
    "native tool exposure",
    [{ type: "system", subtype: "init", tools: [...tools, "Bash"] }],
    /unreviewed/,
  ],
  [
    "missing broker",
    [{ type: "system", subtype: "init", tools: [] }],
    /broker/,
  ],
  [
    "session substitution",
    [{ type: "system", subtype: "init", tools, session_id: "different" }],
    /another session/,
  ],
  [
    "provider failure",
    [
      { type: "system", subtype: "init", tools },
      { type: "result", subtype: "error_during_execution", is_error: true },
    ],
    /successfully/,
  ],
])
  test(`Claude fails closed on ${name}`, async (t) => {
    const child = transport((_m, c) => messages.forEach((m) => c.send(m)));
    const connection = new ClaudeConnection({
      transport: child,
      sessionId: randomUUID(),
    });
    t.after(() => connection.close());
    await assert.rejects(
      connection.run({ prompt: "Do work", seconds: 2, onSession() {} }),
      pattern,
    );
  });

for (const resume of [false, true])
  test(`Codex ${resume ? "resume" : "new thread"} disables environments on every turn and denies runtime escalation`, async (t) => {
    const session = randomUUID(),
      requests = [];
    let saved = false;
    const child = transport((message, c) => {
      requests.push(message);
      if (message.method === "initialize")
        c.send({ id: message.id, result: {} });
      if (
        message.method === "thread/start" ||
        message.method === "thread/resume"
      ) {
        assert.equal(message.params.approvalPolicy, "never");
        assert.equal(message.params.baseInstructions, "Current instructions");
        if (!resume) assert.deepEqual(message.params.environments, []);
        else assert.equal(message.params.threadId, session);
        c.send({ id: message.id, result: { thread: { id: session } } });
      }
      if (message.method === "turn/start") {
        assert.ok(saved);
        assert.deepEqual(message.params.environments, []);
        assert.equal(message.params.approvalPolicy, "never");
        assert.deepEqual(message.params.sandboxPolicy, {
          type: "externalSandbox",
          networkAccess: "restricted",
        });
        c.send({ id: message.id, result: { turn: { id: "turn1" } } });
        c.send({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: session,
            turnId: "turn1",
            tokenUsage: {
              last: { totalTokens: 100 },
              total: { totalTokens: 800 },
            },
          },
        });
        c.send({
          id: "approval1",
          method: "item/commandExecution/requestApproval",
          params: {},
        });
        c.send({
          method: "turn/completed",
          params: {
            threadId: session,
            turn: { id: "turn1", status: "completed", error: null },
          },
        });
      }
    });
    const connection = new CodexConnection({ transport: child });
    t.after(() => connection.close());
    const result = await connection.run({
      session: resume ? session : null,
      prompt: "Do work",
      seconds: 2,
      instructions: "Current instructions",
      onSession(id) {
        assert.equal(id, session);
        saved = true;
      },
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(result.session, session);
    assert.equal(
      result.usage,
      null,
      "A last-request or thread aggregate is not turn usage",
    );
    assert.equal(result.providerUsage.total.totalTokens, 800);
    assert.equal(requests.find((r) => r.id === "approval1").error.code, -32601);
  });

test("Codex rejects substituted sessions and propagates startup failure without orphan waiters", async (t) => {
  const child = transport((m, c) => {
    if (m.method === "initialize") c.send({ id: m.id, result: {} });
    if (m.method === "thread/resume")
      c.send({ id: m.id, result: { thread: { id: "another" } } });
  });
  const connection = new CodexConnection({ transport: child });
  t.after(() => connection.close());
  await assert.rejects(
    connection.run({
      session: "original",
      prompt: "Do work",
      seconds: 2,
      onSession() {},
    }),
    /another session/,
  );
  assert.equal(connection.pending.size, 0);
});

test("premature runtime exit never counts as a completed Claude turn", async (t) => {
  const child = transport((_m, c) => c.emit("close", 1));
  const connection = new ClaudeConnection({
    transport: child,
    sessionId: randomUUID(),
  });
  t.after(() => connection.close());
  await assert.rejects(
    connection.run({ prompt: "Do work", seconds: 2, onSession() {} }),
    /disconnected/,
  );
});
