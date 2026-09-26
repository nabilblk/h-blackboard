// Grok Build's ACP transport supplies MCP servers per session. No project or
// global configuration files are written, even with several agents in one cwd.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const setupTimeout = 30000;

export function permissionOutcome(params, mode, previous = {}) {
  const call = { ...previous, ...params.toolCall };
  const name = call._meta?.["x.ai/tool"]?.name;
  const boardTool = (value) =>
    typeof value === "string" && /^harakiri__[a-z][a-z0-9_]*$/.test(value);
  // Never authorize by a display title or by arbitrary text in tool arguments.
  const board =
    !Object.keys(params._meta || {}).length &&
    (boardTool(name) ||
      (name === "use_tool" &&
        boardTool(call.rawInput?.tool_name) &&
        !call.rawInput?.file &&
        !call.rawInput?.tool_input_file));
  const kind = mode === "full" || board ? "allow_once" : "reject_once";
  const option = params.options?.find((item) => item.kind === kind);
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

export class GrokConnection {
  constructor({ cwd, permissions = "default", onEvent = emit } = {}) {
    this.pending = new Map();
    this.calls = new Map();
    this.nextId = 0;
    this.buffer = "";
    this.onEvent = onEvent;
    this.permissions = permissions;
    const args = ["--no-auto-update", "agent", "--no-leader"];
    if (permissions === "full") args.push("--always-approve");
    args.push("stdio");
    // No shared leader: the launcher's process group owns this runtime. Do not
    // detach; a pause/stop must also reach the Grok process and its children.
    this.child = spawn("grok", args, {
      cwd,
      env: {
        ...process.env,
        ...(permissions === "full" ? { GROK_SANDBOX: "off" } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.closed = new Promise((done) => this.child.once("close", done));
    this.child.stderr.pipe(process.stderr, { end: false });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.once("error", (error) =>
      this.fail(new Error(`Cannot start Grok Build: ${error.message}`)),
    );
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.once("close", (code, signal) =>
      this.fail(
        new Error(
          `Grok Build disconnected (${signal || code}) before completing the request.`,
        ),
      ),
    );
  }

  fail(error) {
    this.failure ||= error;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  send(message) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n",
    );
  }

  request(method, params, timeout = setupTimeout) {
    return new Promise((resolveRequest, reject) => {
      const id = ++this.nextId;
      const timer = timeout
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`Grok Build timed out during ${method}.`));
          }, timeout)
        : null;
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      if (newline > 8 * 1024 * 1024) {
        this.fail(
          new Error("Grok ACP response exceeded the 8 MiB line limit."),
        );
        this.buffer = "";
        return;
      }
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        this.message(JSON.parse(line));
      } catch (error) {
        this.fail(new Error(`Invalid Grok ACP response: ${error.message}`));
      }
    }
    if (this.buffer.length > 8 * 1024 * 1024)
      this.fail(new Error("Grok ACP response exceeded the 8 MiB line limit."));
  }

  message(message) {
    if (message.method) {
      if (message.id !== undefined) {
        if (
          message.method === "session/request_permission" &&
          message.params?.sessionId === this.sessionId
        ) {
          const result = permissionOutcome(
            message.params,
            this.permissions,
            this.calls.get(message.params.toolCall?.toolCallId),
          );
          this.send({ id: message.id, result });
          this.onEvent({
            type: "permission",
            toolCallId: message.params.toolCall?.toolCallId,
            ...result,
          });
        } else {
          this.send({
            id: message.id,
            error: {
              code: -32601,
              message:
                "This Blackboard client does not provide interactive, filesystem, or terminal methods.",
            },
          });
        }
        return;
      }
      if (
        message.method === "session/update" &&
        message.params?.sessionId === this.sessionId
      ) {
        const update = message.params.update;
        if (update?.toolCallId) {
          this.calls.set(update.toolCallId, {
            ...this.calls.get(update.toolCallId),
            ...update,
          });
          if (["completed", "failed"].includes(update.status))
            this.calls.delete(update.toolCallId);
        }
        this.onEvent({ type: "update", update });
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      const detail =
        typeof message.error.data === "string" ? `: ${message.error.data}` : "";
      pending.reject(
        new Error(
          `Grok Build: ${message.error.message || "ACP request failed"}${detail}`,
        ),
      );
    } else if (Object.hasOwn(message, "result"))
      pending.resolve(message.result);
    else
      pending.reject(new Error("Grok Build returned an invalid ACP response."));
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "harakiri-blackboard", version: "0.3.0" },
      _meta: { startupHints: { nonInteractive: true } },
    });
    if (result.protocolVersion !== 1 || !result.agentCapabilities?.loadSession)
      throw new Error(
        "This Grok Build version does not support the required ACP session/resume protocol. Update Grok Build.",
      );
    // Respect Grok's selected account rather than silently switching its billing
    // from a signed-in account to an API key. Never initiate browser login here.
    const methodId = result._meta?.defaultAuthMethodId;
    if (
      !["cached_token", "xai.api_key"].includes(methodId) ||
      !result.authMethods?.some((method) => method.id === methodId)
    )
      throw new Error(
        "Grok Build needs authentication. Run `grok` on the launcher machine and sign in, or configure its supported API credentials, then retry. Blackboard never opens an interactive login for a managed agent.",
      );
    await this.request("authenticate", { methodId, _meta: { headless: true } });
  }

  async turn(config) {
    const params = {
      cwd: config.cwd,
      mcpServers: [
        {
          name: "harakiri",
          command: process.execPath,
          args: [config.mcp, config.file],
          // The MCP server also accepts this environment variable. Override an
          // inherited value so nested launches cannot reuse another identity.
          env: [{ name: "HARAKIRI_SESSION", value: config.file }],
        },
      ],
      _meta: {
        sessionKind: "headless",
        yoloMode: config.permissions === "full",
        ...(config.shared && config.shared !== config.cwd
          ? { additionalDirectories: [config.shared] }
          : {}),
        ...(config.nativeSession
          ? { noReplay: true, "x.ai/restore_code": false }
          : {}),
      },
      ...(config.nativeSession ? { sessionId: config.nativeSession } : {}),
    };
    this.sessionId = config.nativeSession;
    const session = await this.request(
      config.nativeSession ? "session/load" : "session/new",
      params,
    );
    const id = config.nativeSession || session.sessionId;
    if (
      typeof id !== "string" ||
      !id ||
      id.length > 256 ||
      (session.sessionId && session.sessionId !== id)
    )
      throw new Error(
        "Grok Build did not return the expected native session identity.",
      );
    this.sessionId = id;
    this.onEvent({ type: "session.started", sessionId: id });
    const result = await this.request(
      "session/prompt",
      {
        sessionId: id,
        prompt: [{ type: "text", text: config.prompt }],
      },
      0,
    );
    this.onEvent({ type: "turn.usage", usage: result._meta?.usage || null });
    if (result.stopReason !== "end_turn")
      throw new Error(
        `Grok Build did not finish its turn (stop reason: ${result.stopReason || "missing"}).`,
      );
    this.onEvent({ type: "turn.completed", sessionId: id });
  }

  async close() {
    this.fail(new Error("Grok connection closed."));
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 1500);
    try {
      await this.closed;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function main() {
  const check = process.argv[2] === "--check";
  let config = {};
  if (!check) {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    config = JSON.parse(input);
    if (!["default", "full"].includes(config.permissions))
      throw new Error("Unsupported Grok Build permission mode.");
  }
  const connection = new GrokConnection(config);
  const stop = () => {
    connection.fail(new Error("Grok Build interrupted by Blackboard."));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await connection.initialize();
    if (!check) await connection.turn(config);
  } finally {
    await connection.close();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    if (process.argv[2] !== "--check")
      emit({ type: "error", message: error.message });
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  });
}
