// Opt-in model usage. All board records, credentials and working files use a
// temporary directory. Grok still uses the launcher's existing account and
// native session storage. Runtime defaults is not a filesystem sandbox.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "../server/http.mjs";
import { call } from "../server/remote.mjs";
import { preflightRuntime } from "../bin/runtime.mjs";

const directory = await mkdtemp(join(tmpdir(), "harakiri-grok-live-"));
const children = [];
let server, board;
async function until(check, label) {
  const end = Date.now() + 150000;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error(`Timed out: ${label}`);
}
function run(args) {
  const child = spawn(
    process.execPath,
    [resolve("bin/harakiri.mjs"), ...args],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.finished = once(child, "exit");
  // Store privately for diagnosis during this check; never print session tokens.
  child.output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      child.output = (child.output + data.toString()).slice(-8000);
    });
  children.push(child);
  return child;
}
async function completed(child) {
  await until(
    () => child.exitCode !== null || child.signalCode !== null,
    "managed turn finishes",
  );
  assert.equal(
    child.exitCode,
    0,
    "Managed Grok turn failed. Check Grok authentication, account access and runtime compatibility.",
  );
}

try {
  const version = await preflightRuntime("grok", "default", directory);
  console.log(`Checking ${version} using the configured account.`);
  ({ server, board } = createServer({
    database: join(directory, "board.sqlite"),
  }));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const owner = {
    url: `http://127.0.0.1:${server.address().port}`,
    token: board.ownerToken,
  };
  const marker = randomUUID();
  const mission = await call(owner, "mission_create", {
    name: "Isolated Grok Build integration",
    objective: `Verify Blackboard integration only. First read context_read and publish GROK_READY_${marker} to the human once. If a private human message asks for GROK_RESUMED_${marker}, reply with that exact marker in the same private conversation, then finish. Otherwise finish and wait. Never respond to your own messages. Do not create tasks or workstreams.`,
    scope:
      "Use only Harakiri MCP tools. Do not read or modify external files, browse the web, or start subagents. This is a bounded transport test.",
    coordination_mode: "peer",
  });
  owner.channelId = mission.id;
  const invitation = await call(owner, "invitation_create");
  const sessions = join(directory, "sessions");
  const first = run([
    "launch",
    "--board",
    `${owner.url}/j/${invitation.token}`,
    "--runtime",
    "grok",
    "--name",
    "live-grok",
    "--max-turns",
    "1",
    "--state-dir",
    sessions,
    "--workspace",
    join(directory, "work"),
  ]);
  await until(() => {
    if (first.exitCode !== null)
      throw new Error("Grok launch failed before joining the test mission.");
    return board
      .list(mission.id, "agent")
      .some((agent) => agent.status === "waiting");
  }, "waiting agent");
  const [agent] = board.list(mission.id, "agent");
  const [sessionDirectory] = await readdir(sessions);
  const file = join(sessions, sessionDirectory, "session.json");
  assert.equal(JSON.parse(await readFile(file, "utf8")).nativeSession, null);
  await call(owner, "mission_state", {
    version: board.get(mission.id).version,
    state: "active",
    reason: "Start isolated protocol test",
  });
  await completed(first);
  assert.ok(
    board
      .list(mission.id, "message")
      .some(
        (m) =>
          m.authorId === agent.id && m.body.includes(`GROK_READY_${marker}`),
      ),
    "Grok did not publish its initial MCP finding",
  );
  const initial = JSON.parse(await readFile(file, "utf8"));
  assert.ok(initial.nativeSession);
  await call(owner, "message_post", {
    body: `Reply privately with GROK_RESUMED_${marker}, then finish.`,
    direct_agent_id: agent.id,
  });
  const resumed = run(["resume", "--session", file, "--max-turns", "1"]);
  await completed(resumed);
  const current = JSON.parse(await readFile(file, "utf8"));
  assert.equal(current.nativeSession, initial.nativeSession);
  assert.equal(current.agentId, initial.agentId);
  const privateMessages = await call(owner, "messages_read", {
    direct_agent_id: agent.id,
  });
  assert.ok(
    privateMessages.messages.some(
      (m) =>
        m.authorId === agent.id && m.body.includes(`GROK_RESUMED_${marker}`),
    ),
    "Grok did not reply in the private conversation after resume",
  );
  console.log(
    "PASS: human start gate, real Grok MCP publication, private follow-up, and native-session resume.",
  );
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await child.finished;
  }
  server?.closeAllConnections();
  server?.close();
  board?.close();
  await rm(directory, { recursive: true, force: true });
}
