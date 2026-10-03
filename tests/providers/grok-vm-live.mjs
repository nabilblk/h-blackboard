// Opt-in paid/runtime smoke test. Requires explicit guest login. Uses no board,
// host credentials, MCP tools or user files; preserves private test evidence.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { GrokConnection } from "../../bin/grok-acp.mjs";

const exec = promisify(execFile);
const profile = JSON.parse(
  await readFile("var/node/feasibility/vm-profile.json", "utf8"),
);
assert.match(profile.lima_home, /^(\/private)?\/tmp\/hb-lima-[a-zA-Z0-9_-]+$/);
assert.equal(profile.instance, "proof");
const env = { ...process.env, LIMA_HOME: profile.lima_home };
const run = async (...args) =>
  (
    await exec("limactl", ["shell", "--workdir=/tmp", "proof", ...args], {
      env,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim();
const root = (...args) => run("sudo", "--", ...args);
const id = randomUUID();
const cwd = `/workspace/auth-proof-${id}`;
const evidenceDirectory = join("var/node/feasibility", `grok-${id}`);
await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
await root(
  "install",
  "-d",
  "-m",
  "700",
  "-o",
  "agent-worker",
  "-g",
  "agent-worker",
  cwd,
);
const turns = [];
const marker = `HB_GUEST_${randomUUID().replaceAll("-", "")}`;
let sessionId;
let connection;
let unit;
let diagnostic = "";
const diagnostics = new Writable({
  write(bytes, encoding, done) {
    diagnostic = (diagnostic + bytes.toString()).slice(-32768);
    done();
  },
});

async function start(generation) {
  unit = `hb-grok-proof-${id}-${generation}`;
  const args = [
    "shell",
    "--workdir=/tmp",
    "proof",
    "sudo",
    "--",
    "systemd-run",
    "--quiet",
    "--pipe",
    "--wait",
    "--collect",
    `--unit=${unit}`,
    "--uid=agent-worker",
    `--working-directory=${cwd}`,
    "--property=SetLoginEnvironment=yes",
    "--property=NoNewPrivileges=yes",
    "--property=CapabilityBoundingSet=",
    "--property=RestrictNamespaces=yes",
    "--property=ProtectControlGroups=yes",
    "--property=PrivateTmp=yes",
    "--property=ProtectSystem=strict",
    "--property=ProtectHome=read-only",
    `--property=ReadWritePaths=${cwd} /home/agent-worker/.grok`,
    "--property=KillMode=control-group",
    "--property=TimeoutStopSec=2",
    "--property=RuntimeMaxSec=180",
    "/home/agent-worker/.grok/bin/grok",
    "--no-auto-update",
    "agent",
    "--no-leader",
    "stdio",
  ];
  const transport = spawn("limactl", args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const updates = [];
  connection = new GrokConnection({
    transport,
    diagnostics,
    onEvent: (event) => updates.push(event),
  });
  await connection.initialize();
  const params = {
    cwd,
    mcpServers: [],
    _meta: {
      sessionKind: "headless",
      yoloMode: false,
      ...(sessionId ? { noReplay: true, "x.ai/restore_code": false } : {}),
    },
    ...(sessionId ? { sessionId } : {}),
  };
  connection.sessionId = sessionId;
  const session = await connection.request(
    sessionId ? "session/load" : "session/new",
    params,
  );
  sessionId ||= session.sessionId;
  assert.ok(
    sessionId && (!session.sessionId || session.sessionId === sessionId),
  );
  connection.sessionId = sessionId;
  return updates;
}

async function stop() {
  if (unit) await root("systemctl", "stop", unit).catch(() => {});
  if (connection) await connection.close();
  const state = unit
    ? await root("systemctl", "show", unit, "--property=ActiveState", "--value")
    : "inactive";
  assert.ok(
    ["inactive", "failed"].includes(state),
    "runtime unit is still active",
  );
  connection = null;
  unit = null;
}

try {
  for (let generation = 1; generation <= 2; generation++) {
    const updates = await start(generation);
    const text =
      generation === 1
        ? `This is a bounded authentication and context-persistence test. Do not use tools, read files, browse or start other agents. Remember this exact marker in this conversation: ${marker}. Reply with only the marker.`
        : "This is the resumed context-persistence test. Do not use tools, read files, browse or start other agents. Reply with only the exact HB_GUEST_ marker from our previous turn. Do not invent a new marker.";
    const response = await connection.request(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text }] },
      150000,
    );
    assert.equal(response.stopReason, "end_turn");
    const answer = updates
      .filter((event) => event.update?.sessionUpdate === "agent_message_chunk")
      .map((event) => event.update.content?.text || "")
      .join("");
    assert.ok(
      answer.includes(marker),
      `generation ${generation} did not preserve expected context`,
    );
    assert.ok(
      !updates.some((event) => event.update?.sessionUpdate === "tool_call"),
      "this smoke session unexpectedly requested a tool",
    );
    turns.push({
      generation,
      stopReason: response.stopReason,
      contextMatched: true,
      usage: response._meta?.usage ?? null,
      events: updates,
    });
    await stop();
    console.log(
      `PASS: guest authenticated turn ${generation}; native context ${generation === 1 ? "created" : "resumed"}; process tree stopped.`,
    );
  }
  const report = {
    checkedAt: new Date().toISOString(),
    runtime: "grok 1.0.46",
    sessionId,
    workspace: cwd,
    authentication: "guest-owned cached_token",
    generations: turns,
    complete: true,
    limitation:
      "No tools requested or observed; no MCP servers; permission requests denied. Selective provider egress and protection of guest credentials from hostile tools remain G5 gates.",
  };
  await writeFile(
    join(evidenceDirectory, "result.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(`Evidence: ${evidenceDirectory}/result.json`);
} catch (error) {
  await writeFile(
    join(evidenceDirectory, "failure.json"),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        sessionId,
        completedTurns: turns,
        error: error.message,
        diagnostic,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  throw new Error(
    `Guest runtime check failed: ${error.message}. Private evidence: ${evidenceDirectory}/failure.json`,
  );
} finally {
  await stop();
}
