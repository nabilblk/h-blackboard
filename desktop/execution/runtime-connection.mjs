import { GrokConnection } from "../../bin/grok-acp.mjs";
import { Session } from "./contract.mjs";

const toolNames = [
  "board",
  "workspace_exec",
  "workspace_read",
  "workspace_write",
  "import_artifact",
  "publish_artifact",
];
const scopedClaudeTool = (name) =>
  toolNames.some((t) => name === `mcp__harakiri__${t}`);
const event = (type, value) => ({
  update:
    type === "text"
      ? { sessionUpdate: "agent_message_chunk", content: { text: value } }
      : { sessionUpdate: "tool_call", title: value },
});

// Both vendor protocols use bounded JSON lines over our VM-owned transport.
// This class never starts a host process or grants a runtime permission.
class JsonConnection {
  constructor({ transport, onEvent = () => {} }) {
    this.child = transport;
    this.onEvent = onEvent;
    this.pending = new Map();
    this.listeners = new Set();
    this.nextId = 0;
    this.buffer = "";
    this.closed = new Promise((resolve) => transport.once("close", resolve));
    transport.stdout.setEncoding("utf8");
    transport.stdout.on("data", (chunk) => {
      try {
        this.buffer += chunk;
        if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024)
          throw new Error("Runtime message too large.");
        let end;
        while ((end = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + 1);
          if (Buffer.byteLength(line) > 2 * 1024 * 1024)
            throw new Error("Runtime message too large.");
          this.consume(JSON.parse(line));
        }
      } catch (error) {
        this.fail(error);
      }
    });
    transport.stderr.resume();
    transport.once("error", (error) => this.fail(error));
    transport.stdin.on("error", (error) => this.fail(error));
    transport.once("close", () =>
      this.fail(new Error("Isolated runtime disconnected before completion.")),
    );
  }
  send(message) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  fail(error) {
    this.failure ||= error;
    for (const waiter of [...this.pending.values(), ...this.listeners])
      waiter.reject(this.failure);
    this.pending.clear();
    this.listeners.clear();
  }
  request(method, params, timeout = 30000) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Runtime timed out during ${method}.`));
      }, timeout);
      const finish = (fn) => (value) => {
        clearTimeout(timer);
        this.pending.delete(id);
        fn(value);
      };
      this.pending.set(id, {
        resolve: finish(resolve),
        reject: finish(reject),
      });
      try {
        this.send({ id, method, params });
      } catch (e) {
        this.pending.get(id)?.reject(e);
      }
    });
  }
  waitFor(match, timeout) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve: finish(resolve),
        reject: finish(reject),
      };
      const timer = setTimeout(
        () => waiter.reject(new Error("Runtime turn timed out.")),
        timeout,
      );
      const self = this;
      function finish(fn) {
        return (value) => {
          clearTimeout(timer);
          self.listeners.delete(waiter);
          fn(value);
        };
      }
      this.listeners.add(waiter);
    });
  }
  consume(message) {
    if (message.id != null && !message.method) {
      const pending = this.pending.get(message.id);
      if (message.error)
        pending?.reject(
          new Error("Runtime rejected the request; check guest diagnostics."),
        );
      else pending?.resolve(message.result);
    } else if (message.id != null && message.method) {
      // No shell, permissions, elicitation or dynamic tool escalation path.
      this.send({
        id: message.id,
        error: {
          code: -32601,
          message:
            "Interactive runtime requests are unavailable; use the scoped Blackboard tools.",
        },
      });
    }
    this.notify(message);
    for (const waiter of [...this.listeners])
      if (waiter.match(message)) waiter.resolve(message);
  }
  notify() {}
  async close() {
    this.child.stdin.end();
    let timer;
    await Promise.race([
      this.closed,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          this.child.kill("SIGTERM");
          resolve();
        }, 1500);
      }),
    ]);
    clearTimeout(timer);
    this.fail(new Error("Runtime connection closed."));
  }
}

export class ClaudeConnection extends JsonConnection {
  constructor(options) {
    super(options);
    this.sessionId = options.sessionId;
  }
  notify(message) {
    if (message.session_id && message.session_id !== this.sessionId)
      throw new Error("Claude resumed another session.");
    if (message.type === "system" && message.subtype === "init") {
      if (
        !Array.isArray(message.tools) ||
        message.tools.some(
          (name) => !scopedClaudeTool(name) && name !== "EndConversation",
        )
      )
        throw new Error("Claude exposed an unreviewed native tool.");
      if (
        !toolNames.every((name) =>
          message.tools.includes(`mcp__harakiri__${name}`),
        )
      )
        throw new Error("Claude did not connect to the scoped tool broker.");
      this.initialized = true;
    }
    if (message.type === "assistant")
      for (const block of message.message?.content || []) {
        if (block.type === "text") this.onEvent(event("text", block.text));
        if (block.type === "tool_use") {
          if (!scopedClaudeTool(block.name) && block.name !== "EndConversation")
            throw new Error("Unreviewed Claude tool call.");
          this.onEvent(event("tool", block.name));
        }
      }
  }
  async run({ prompt, seconds, onSession }) {
    await onSession(Session.parse(this.sessionId));
    const done = this.waitFor((m) => m.type === "result", seconds * 1000);
    this.send({
      type: "user",
      session_id: this.sessionId,
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
    });
    const result = await done;
    if (!this.initialized || result.is_error || result.subtype !== "success")
      throw new Error(
        "Claude did not complete this turn successfully. Check the guest login and provider allowance.",
      );
    const usage = result.usage;
    return {
      session: this.sessionId,
      usage: usage
        ? {
            totalTokens:
              (usage.input_tokens || 0) +
              (usage.output_tokens || 0) +
              (usage.cache_read_input_tokens || 0) +
              (usage.cache_creation_input_tokens || 0),
          }
        : null,
    };
  }
  interrupt() {
    this.send({
      type: "control_request",
      request_id: "harakiri-stop",
      request: { subtype: "interrupt" },
    });
  }
}

export class CodexConnection extends JsonConnection {
  notify(message) {
    const { method, params } = message;
    if (method === "item/agentMessage/delta")
      this.onEvent(event("text", params.delta));
    if (method === "item/started" && params.item?.type === "mcpToolCall") {
      if (
        params.item.server !== "harakiri" ||
        !toolNames.includes(params.item.tool)
      )
        throw new Error("Unreviewed Codex tool call.");
      this.onEvent(event("tool", params.item.tool));
    }
    if (
      method === "item/started" &&
      [
        "commandExecution",
        "fileChange",
        "webSearch",
        "imageGeneration",
        "collabAgentToolCall",
      ].includes(params.item?.type)
    )
      throw new Error("Codex exposed an unreviewed native tool.");
    if (method === "thread/tokenUsage/updated") this.usage = params.tokenUsage;
  }
  async run({ session, prompt, seconds, onSession, instructions }) {
    await this.request("initialize", {
      clientInfo: { name: "harakiri", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized" });
    const opened = await this.request(
      session ? "thread/resume" : "thread/start",
      {
        ...(session
          ? { threadId: session }
          : { environments: [], selectedCapabilityRoots: [] }),
        runtimeWorkspaceRoots: [],
        cwd: "/home/hb-runtime/control",
        approvalPolicy: "never",
        sandbox: "read-only",
        baseInstructions: instructions,
      },
    );
    const actual = Session.parse(opened.thread?.id);
    if (session && actual !== session)
      throw new Error("Codex resumed another session.");
    this.sessionId = actual;
    await onSession(actual);
    // Set environments on EVERY turn, including resumed native threads. An
    // empty list prevents native shell/file tools from being registered.
    const done = this.waitFor(
      (m) => m.method === "turn/completed" && m.params?.threadId === actual,
      seconds * 1000,
    );
    // A turn notification may fail before turn/start returns. Attach a handler
    // immediately; the original promise is still awaited and propagated below.
    void done.catch(() => {});
    try {
      const started = await this.request("turn/start", {
        threadId: actual,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        environments: [],
        runtimeWorkspaceRoots: [],
        approvalPolicy: "never",
        // The VM broker enforces the writable workspace. Calling the whole
        // turn read-only incorrectly tells the model to refuse MCP writes.
        // No native environment is attached; confinement remains external.
        sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" },
      });
      this.turnId = started.turn.id;
      const result = (await done).params.turn;
      if (
        result.id !== this.turnId ||
        result.status !== "completed" ||
        result.error
      )
        throw new Error(
          "Codex did not complete this turn successfully. Check the guest login and provider allowance.",
        );
      return {
        session: actual,
        // `last` is one model request; `total` spans the saved thread. Neither
        // is an outer-turn aggregate, especially after resume. Preserve raw
        // metadata without reporting it as billable turn usage.
        usage: null,
        providerUsage: this.usage ?? null,
      };
    } catch (error) {
      this.fail(error);
      await done.catch(() => {});
      throw error;
    }
  }
  interrupt() {
    if (this.turnId)
      this.send({
        id: ++this.nextId,
        method: "turn/interrupt",
        params: { threadId: this.sessionId, turnId: this.turnId },
      });
    else this.fail(new Error("Codex stopped during initialization."));
  }
}

class GrokAdapter extends GrokConnection {
  async run({ session, prompt, seconds, onSession }) {
    await this.initialize();
    this.sessionId = session;
    const opened = await this.request(
      session ? "session/load" : "session/new",
      {
        cwd: "/home/hb-runtime/control",
        mcpServers: [
          {
            name: "harakiri",
            command: "/usr/bin/python3",
            args: ["/opt/harakiri/mcp.py"],
            env: [],
          },
        ],
        _meta: {
          sessionKind: "headless",
          yoloMode: false,
          ...(session ? { noReplay: true, "x.ai/restore_code": false } : {}),
        },
        ...(session ? { sessionId: session } : {}),
      },
    );
    const actual = Session.parse(session || opened.sessionId);
    if (opened.sessionId && opened.sessionId !== actual)
      throw new Error("Runtime resumed another session.");
    this.sessionId = actual;
    await onSession(actual);
    const result = await this.request(
      "session/prompt",
      { sessionId: actual, prompt: [{ type: "text", text: prompt }] },
      seconds * 1000,
    );
    if (result.stopReason !== "end_turn")
      throw new Error(`Grok stopped: ${result.stopReason || "unknown"}.`);
    return { session: actual, usage: result._meta?.usage || null };
  }
  interrupt() {
    if (this.sessionId)
      this.send({
        method: "session/cancel",
        params: { sessionId: this.sessionId },
      });
  }
}

export function runtimeConnection(runtime, options) {
  const Adapter = {
    grok: GrokAdapter,
    claude: ClaudeConnection,
    codex: CodexConnection,
  }[runtime];
  if (!Adapter) throw new Error("Unsupported runtime adapter.");
  return new Adapter(options);
}
