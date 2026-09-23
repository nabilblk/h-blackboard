// Protocol fixture, not a model. Only connects to the temporary board supplied
// by launcher tests. Its ACP messages follow Grok Build 1.0.5's wire format.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);
const env = process.env;
if (args.includes("--version")) {
  console.log("grok fixture 1.0.5");
  process.exit(0);
}
if (args.includes("--help")) {
  console.log(
    env.HARAKIRI_TEST_UNSUPPORTED
      ? "old runtime"
      : "--no-leader --always-approve",
  );
  process.exit(0);
}
if (!args.includes("stdio") || !args.includes("--no-leader"))
  throw Error("Use the private ACP transport");

const send = (data) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...data }) + "\n");
const pending = new Map();
async function ask(method, params) {
  const id = randomUUID();
  return new Promise((done) => {
    pending.set(id, done);
    send({ id, method, params });
  });
}
let session, state, method, client, config;
async function handle(req) {
  let result = {};
  if (req.method === "initialize") {
    if (env.HARAKIRI_TEST_BAD_PROTOCOL) {
      process.stdout.write("{bad json}\n");
      return;
    }
    result = {
      protocolVersion: 1,
      agentCapabilities: { loadSession: !env.HARAKIRI_TEST_NO_RESUME },
      authMethods: env.HARAKIRI_TEST_NO_AUTH
        ? [{ id: "grok.com" }]
        : [{ id: "cached_token" }, { id: "xai.api_key" }],
      _meta: {
        defaultAuthMethodId: env.HARAKIRI_TEST_NO_AUTH ? null : "cached_token",
      },
    };
  } else if (req.method === "authenticate") {
    if (req.params.methodId !== "cached_token" || !req.params._meta.headless)
      throw Error("Authentication preference was lost");
    if (env.HARAKIRI_TEST_BAD_AUTH)
      throw Error("Credentials expired; sign in again");
  } else if (["session/new", "session/load"].includes(req.method)) {
    method = req.method;
    config = req.params;
    const mcp = config.mcpServers[0];
    if (
      mcp.name !== "harakiri" ||
      mcp.env.length !== 1 ||
      mcp.env[0].name !== "HARAKIRI_SESSION" ||
      mcp.env[0].value !== mcp.args[1]
    )
      throw Error("Invalid per-session MCP configuration");
    state = JSON.parse(fs.readFileSync(mcp.args[1], "utf8"));
    session = "native-" + state.agentId;
    if (
      state.nativeSession &&
      (method !== "session/load" ||
        config.sessionId !== session ||
        !config._meta.noReplay ||
        config._meta["x.ai/restore_code"] !== false)
    )
      throw Error("Resume lost native identity or restored files");
    if (config.cwd !== process.cwd() || config.cwd !== state.cwd)
      throw Error("Wrong working directory");
    if (env.HARAKIRI_TEST_MCP) {
      client = new Client({ name: "grok-fixture", version: "1.0" });
      await client.connect(
        new StdioClientTransport({
          command: mcp.command,
          args: mcp.args,
          env: {
            ...process.env,
            ...Object.fromEntries(
              mcp.env.map(({ name, value }) => [name, value]),
            ),
          },
          stderr: "inherit",
        }),
      );
      const tools = await client.listTools();
      if (!tools.tools.some((tool) => tool.name === "message_post"))
        throw Error("Board tools missing");
    }
    result = method === "session/new" ? { sessionId: session } : {};
  } else if (req.method === "session/prompt") {
    if (req.params.sessionId !== session)
      throw Error("Prompt sent to wrong native session");
    const prompt = req.params.prompt[0].text;
    if (
      !prompt.includes("Local execution workspace:") ||
      !prompt.includes(JSON.stringify(state.cwd))
    )
      throw Error("Missing workspace instructions");
    fs.appendFileSync(
      path.join(process.cwd(), "observations.jsonl"),
      JSON.stringify({
        args,
        method,
        config,
        cwd: process.cwd(),
        prompt,
        sandbox: env.GROK_SANDBOX,
        agentId: state.agentId,
        pid: process.pid,
      }) + "\n",
    );
    const call = async (operation, input = {}) => {
      const res = await fetch(state.url + "/api/rpc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + state.token,
        },
        body: JSON.stringify({
          operation,
          input: { channel_id: state.channelId, ...input },
          key: randomUUID(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw Error(data.error);
      return data;
    };
    if (env.HARAKIRI_TEST_PREPARE) {
      if (!prompt.includes("PREPARATION ONLY"))
        throw Error("Coordinator executed during preparation");
      const ctx = await call("context_read");
      await call("plan_update", {
        version: ctx.mission.version,
        plan: "Compare distinct alternatives in Main; tasks are optional.",
      });
      const current = await call("context_read");
      await call("coordinator_ready", {
        revision: current.mission.startupRevision,
      });
    }
    if (client) {
      const toolCallId = randomUUID();
      send({
        method: "session/update",
        params: {
          sessionId: session,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Blackboard message",
            _meta: { "x.ai/tool": { name: "use_tool" } },
            rawInput: {
              tool_name: "harakiri__message_post",
              tool_input: { body: "fixture" },
            },
          },
        },
      });
      const options = [
        { optionId: "yes", kind: "allow_once", name: "Allow" },
        { optionId: "no", kind: "reject_once", name: "Decline" },
      ];
      const response = await ask("session/request_permission", {
        sessionId: session,
        toolCall: { toolCallId },
        options,
      });
      if (response.result?.outcome?.optionId !== "yes")
        throw Error("Blackboard MCP permission was not approved");
      const denied = await ask("session/request_permission", {
        sessionId: session,
        toolCall: {
          toolCallId: "shell",
          _meta: { "x.ai/tool": { name: "bash" } },
        },
        options,
      });
      if (denied.result?.outcome?.optionId !== "no")
        throw Error("Default permissions approved an unrelated shell call");
      const unsupported = await ask("fs/read_text_file", {
        path: "/private/file",
      });
      if (unsupported.error?.code !== -32601)
        throw Error("Unadvertised filesystem access was accepted");
      send({
        method: "session/update",
        params: {
          sessionId: session,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
          },
        },
      });
      const published = await client.callTool({
        name: "message_post",
        arguments: { body: "ACP_MCP_" + state.agentId, audience: "human" },
      });
      if (published.isError) throw Error(JSON.stringify(published.content));
    }
    console.error("stderr is live");
    if (env.HARAKIRI_TEST_FAIL)
      throw Error(
        "Managed policy blocked execution (network policy) " + state.token,
      );
    if (env.HARAKIRI_TEST_CRASH) process.exit(23);
    if (env.HARAKIRI_TEST_HOLD) await new Promise((r) => setTimeout(r, 30000));
    result = { stopReason: env.HARAKIRI_TEST_STOP || "end_turn" };
  } else if (req.method) {
    throw Error("Unexpected ACP method " + req.method);
  }
  if (req.id !== undefined) send({ id: req.id, result });
}

let queue = Promise.resolve();
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const req = JSON.parse(line);
  if (!req.method) {
    pending.get(req.id)?.(req);
    pending.delete(req.id);
    return;
  }
  queue = queue
    .then(() => handle(req))
    .catch((error) =>
      send({ id: req.id, error: { code: -32603, message: error.message } }),
    );
});
lines.on("close", async () => {
  await queue;
  await client?.close();
});
process.once("SIGTERM", async () => {
  await client?.close();
  process.exit(0);
});
