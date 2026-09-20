// Opt-in: uses the installed Claude Code and Codex accounts for two bounded
// board-only sessions. All records and credentials stay in a temporary folder.
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "../server/http.mjs";
import { call } from "../server/remote.mjs";
const directory = await mkdtemp(join(tmpdir(), "harakiri-live-"));
const { server, board } = createServer({
  database: join(directory, "live.sqlite"),
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const owner = {
  url: `http://127.0.0.1:${server.address().port}`,
  token: board.ownerToken,
};
const children = [];
async function until(check, label, timeout = 150000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(500);
  }
  throw new Error(`Timed out: ${label}`);
}
function run(args) {
  const child = spawn(
    process.execPath,
    [resolve("bin/harakiri.mjs"), ...args],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.output = "";
  for (const source of [child.stdout, child.stderr])
    source.on(
      "data",
      (b) => (child.output = (child.output + b.toString()).slice(-6000)),
    );
  children.push(child);
  return child;
}
try {
  const mission = await call(owner, "mission_create", {
    name: "Isolated runtime integration",
    objective:
      "Verify board participation only. On first joining, publish exactly READY_<your runtime> to the human, once. Do no external work. When the human sends CHECKPOINT_<runtime>, publish ACK_CHECKPOINT_<runtime> to the human. When the human sends RESUMED_<runtime>, publish ACK_RESUMED_<runtime>. Acknowledge a workstream assignment if one arrives. Otherwise finish the turn and wait. Never respond to agent join notices or other agent messages. Do not create tasks.",
    scope:
      "Use Harakiri MCP tools only. Do not read or change external files. This is a test, so claim only what you actually observed.",
    criteria: ["Both runtimes publish and receive instructions."],
  });
  owner.channelId = mission.id;
  const invitation = await call(owner, "invitation_create");
  const stateDir = join(directory, "sessions");
  for (const runtime of ["claude", "codex"]) {
    console.log(
      `Starting one ${runtime} instance with per-process MCP configuration.`,
    );
    run([
      "launch",
      "--board",
      `${owner.url}/j/${invitation.token}`,
      "--runtime",
      runtime,
      "--count",
      "1",
      "--name",
      `live-${runtime}`,
      "--state-dir",
      stateDir,
      "--workspace",
      join(directory, "workspaces"),
      "--board-only",
    ]);
  }
  await until(
    () =>
      ["claude", "codex"].every((runtime) =>
        board
          .list(mission.id, "message")
          .some(
            (m) =>
              m.authorId !== "human" && m.body.includes(`READY_${runtime}`),
          ),
      ),
    "both runtime startup findings",
  );
  console.log("Both runtimes published through MCP without tasks.");
  const agents = board.list(mission.id, "agent");
  assert.equal(agents.length, 2);
  for (const agent of agents)
    await call(owner, "message_post", {
      body: `CHECKPOINT_${agent.runtime}`,
      audience: agent.id,
    });
  await until(
    () =>
      agents.every((agent) =>
        board
          .list(mission.id, "message")
          .some(
            (m) =>
              m.authorId === agent.id &&
              m.body.includes(`ACK_CHECKPOINT_${agent.runtime}`),
          ),
      ),
    "live addressed-message wakeup",
  );
  console.log(
    "Both runtimes received and answered targeted follow-up instructions.",
  );
  const coordinator = agents.find((a) => a.runtime === "claude");
  await call(owner, "coordinator_set", {
    version: board.get(mission.id).version,
    agent_id: coordinator.id,
    reason: "Verify real coordination.",
  });
  await call(owner, "message_post", {
    audience: "coordinator",
    body: "COORDINATE: Create one additional workstream named Acknowledgment check with a goal of confirming workstream participation. Assign the existing live-codex agent to it. Instruct it to acknowledge the assignment with assignment_ack, then finish its turn. Do not create any tasks.",
  });
  await until(
    () => board.list(mission.id, "assignment").length > 0,
    "coordinator allocation",
  );
  const assignment = board.list(mission.id, "assignment")[0];
  assert.equal(assignment.issuedBy, coordinator.id);
  await until(
    () => board.get(assignment.id).status === "acknowledged",
    "assignment acknowledgment",
  );
  console.log(
    "Claude created a workstream and assigned Codex; Codex acknowledged without a task.",
  );
  for (const child of children) child.kill("SIGTERM");
  await until(
    () => children.every((c) => c.exitCode !== null || c.signalCode !== null),
    "launcher shutdown",
    45000,
  );
  const sessions = [];
  for (const name of await readdir(stateDir)) {
    const file = join(stateDir, name, "session.json"),
      state = JSON.parse(await readFile(file, "utf8"));
    assert.ok(state.nativeSession);
    sessions.push({ file, state });
  }
  for (const { file, state } of sessions) {
    await call(owner, "message_post", {
      body: `RESUMED_${state.runtime}`,
      audience: state.agentId,
    });
    run(["resume", "--session", file]);
  }
  await until(
    () =>
      sessions.every(({ state }) =>
        board
          .list(mission.id, "message")
          .some(
            (m) =>
              m.authorId === state.agentId &&
              m.body.includes(`ACK_RESUMED_${state.runtime}`),
          ),
      ),
    "native session resume and missed instructions",
  );
  assert.equal(
    board.list(mission.id, "agent").length,
    2,
    "Resume must retain identities",
  );
  assert.equal(board.list(mission.id, "task").length, 0);
  for (const { file, state } of sessions)
    assert.equal(
      JSON.parse(await readFile(file, "utf8")).nativeSession,
      state.nativeSession,
    );
  console.log(
    "Both native sessions resumed with the same identities and read missed instructions. Live integration passed.",
  );
} catch (error) {
  for (const child of children)
    if (child.output)
      console.error(child.output.replaceAll(directory, "<private-test-dir>"));
  throw error;
} finally {
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
  await Promise.all(
    children.map((c) =>
      c.exitCode !== null || c.signalCode !== null
        ? Promise.resolve()
        : new Promise((r) => c.once("exit", r)),
    ),
  );
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  board.close();
  await rm(directory, { recursive: true, force: true });
}
