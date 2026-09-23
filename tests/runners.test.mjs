import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Blackboard } from "../server/board.mjs";
import { RunnerController } from "../bin/runner.mjs";
import { LocalProcessProvider } from "../bin/providers/local-process.mjs";
import { createServer } from "../server/http.mjs";
import { request, call, isRetryable } from "../server/remote.mjs";

function fixture(t, file, provider = LocalProcessProvider.descriptor) {
  let board = new Blackboard(file);
  t.after(() => board.close());
  const human = board.auth(board.ownerToken);
  const mission = board.execute(
    human,
    "mission_create",
    {
      name: "Recovery fixture",
      objective: "Recover the same identity",
      coordination_mode: "peer",
    },
    randomUUID(),
  );
  const act = (operation, input = {}, actor = human, key = randomUUID()) =>
    board.execute(actor, operation, { channel_id: mission.id, ...input }, key);
  const invite = act("invitation_create");
  const joined = board.join({
    invitation: invite.token,
    name: "saved-worker",
    runtime: "codex",
  });
  const agent = board.auth(joined.token);
  board.heartbeat(agent, "offline");
  const pair = act("runner_pair");
  const joinInput = {
    pairing_token: pair.token,
    registration_id: randomUUID(),
    name: "Test execution machine",
    provider,
  };
  const connection = board.runners.join(joinInput);
  const runner = () => board.runners.auth(connection.token);
  const inventory = {
    execution_id: "ex_saved",
    agent_id: agent.id,
    agent_token: joined.token,
    workspace_ref: "ws_persistent",
    checkpoint_ref: "cp_native",
    resume_command: "human-copy-only",
  };
  board.runners.inventory(runner(), {
    executions: [inventory],
    reconnect_command: "human-copy-launcher",
  });
  return {
    get board() {
      return board;
    },
    human,
    mission,
    agent,
    pair,
    joinInput,
    connection,
    runner,
    inventory,
    act,
    reopen() {
      board.close();
      board = new Blackboard(file);
    },
    tick(observations = []) {
      return board.runners.tick(runner(), { observations });
    },
  };
}

test("Only a human pairs runners and requests resumes; runner, agent, and mission credentials are separate", (t) => {
  const f = fixture(t);
  f.act("mission_state", {
    version: f.board.get(f.mission.id).version,
    state: "active",
    reason: "Activate permission test",
  });
  assert.throws(
    () => f.act("runner_pair", {}, f.agent),
    /human|not authorized/,
  );
  assert.throws(
    () => f.act("agents_resume", { agent_ids: [f.agent.id] }, f.agent),
    /human|not authorized/,
  );
  assert.throws(() => f.board.auth(f.connection.token), /Invalid session/);
  assert.throws(
    () => f.board.runners.auth(f.board.ownerToken),
    /Invalid launcher/,
  );
  assert.deepEqual(f.board.runners.join(f.joinInput), f.connection);
  assert.throws(
    () =>
      f.board.runners.join({ ...f.joinInput, registration_id: randomUUID() }),
    /already been used/,
  );
  assert.equal(
    f.act("context_read").agents[0].recovery.runnerId,
    f.connection.runnerId,
  );
  assert.equal(
    f.act("context_read", {}, f.agent).agents[0].recovery,
    undefined,
  );
  const foreign = f.board.execute(
    f.human,
    "mission_create",
    { name: "Other", objective: "Other" },
    randomUUID(),
  );
  const invitation = f.board.execute(
    f.human,
    "invitation_create",
    { channel_id: foreign.id },
    randomUUID(),
  );
  const outsider = f.board.join({
    invitation: invitation.token,
    name: "other-worker",
    runtime: "claude",
  });
  assert.throws(
    () =>
      f.board.runners.inventory(f.runner(), {
        executions: [
          {
            ...f.inventory,
            execution_id: "ex_other",
            agent_id: outsider.agent.id,
            agent_token: outsider.token,
          },
        ],
      }),
    /does not belong/,
  );
  assert.throws(
    () => f.act("agents_resume", { agent_ids: [outsider.agent.id] }),
    /not found in this mission/,
  );
  assert.throws(
    () =>
      f.tick([{ execution_id: "ex_other", generation: 0, state: "running" }]),
    /does not belong/,
  );
  assert.throws(
    () =>
      f.act("agents_resume", {
        agent_ids: [f.agent.id],
        command: "arbitrary command",
      }),
    /Unrecognized key/,
  );
});

test("Resume is a durable idempotent intent and never starts a mission or overwrites storage references", (t) => {
  const f = fixture(t);
  const key = randomUUID();
  const first = f.act(
    "agents_resume",
    { agent_ids: [f.agent.id] },
    f.human,
    key,
  );
  assert.equal(first.executions[0].state, "queued");
  assert.equal(first.executions[0].generation, 1);
  assert.deepEqual(
    f.act("agents_resume", { agent_ids: [f.agent.id] }, f.human, key),
    first,
  );
  assert.equal(
    f.act("agents_resume", { agent_ids: [f.agent.id] }).executions[0]
      .generation,
    1,
  );
  assert.equal(f.board.get(f.mission.id).state, "preparing");
  assert.equal(
    f.tick().executions[0].resume_allowed,
    true,
    "Connecting during preparation does not authorize model calls",
  );
  f.tick([
    {
      execution_id: "ex_saved",
      generation: 1,
      state: "failed",
      error: "Runtime unavailable",
    },
  ]);
  assert.equal(
    f.act("agents_resume", { agent_ids: [f.agent.id] }).executions[0]
      .generation,
    2,
  );
  f.tick([{ execution_id: "ex_saved", generation: 0, state: "running" }]);
  assert.equal(
    f.board.runners.view(f.agent.id).state,
    "queued",
    "A late observation cannot clear a newer restart request",
  );
  assert.throws(
    () =>
      f.tick([{ execution_id: "ex_saved", generation: 3, state: "running" }]),
    /Unknown execution generation/,
  );
  assert.throws(
    () =>
      f.board.runners.inventory(f.runner(), {
        executions: [{ ...f.inventory, workspace_ref: "ws_replaced" }],
      }),
    /silently replace/,
  );
  f.act("mission_state", { state: "closed", reason: "Stop this mission" });
  assert.equal(f.tick().executions[0].resume_allowed, false);
  assert.throws(
    () => f.act("agents_resume", { agent_ids: [f.agent.id] }),
    /reopen/,
  );
  assert.equal(f.board.list(f.mission.id, "agent").length, 1);
});

test("Pending recovery, runner credentials and agent identity survive a board restart", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "harakiri-runner-persistence-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture(t, join(directory, "board.sqlite"));
  f.act("agents_resume", { agent_ids: [f.agent.id] });
  f.reopen();
  assert.equal(f.tick().executions[0].generation, 1);
  assert.equal(f.board.runners.view(f.agent.id).state, "queued");
  assert.equal(f.board.auth(f.inventory.agent_token).id, f.agent.id);
  assert.equal(f.board.get(f.mission.id).state, "preparing");
});

test("A sandbox-shaped provider uses the same protocol without local paths, PIDs, or shell commands", async (t) => {
  const descriptor = {
    id: "sandbox-contract-fixture",
    label: "Contract fixture",
    isolation: "vm",
    capabilities: { resume: true },
  };
  const f = fixture(t, undefined, descriptor);
  const state = { generation: 0, state: "stopped", error: null };
  let starts = 0;
  const provider = {
    descriptor,
    async discover() {
      return [f.inventory];
    },
    async inspect(execution_id) {
      return { execution_id, ...state };
    },
    async resume(intent) {
      assert.equal(intent.workspace_ref, "ws_persistent");
      assert.equal(intent.checkpoint_ref, "cp_native");
      assert.equal(intent.command, undefined);
      assert.equal(intent.sessionFile, undefined);
      if (intent.generation > state.generation) {
        starts++;
        state.generation = intent.generation;
        state.state = "running";
      }
      return this.inspect(intent.execution_id);
    },
  };
  let loseAcknowledgement = true;
  const transport = async (_url, path, input, token) => {
    if (
      loseAcknowledgement &&
      path.endsWith("tick") &&
      input.observations.some((o) => o.generation === 1)
    ) {
      loseAcknowledgement = false;
      throw new Error("Lost resume acknowledgement");
    }
    const runner = f.board.runners.auth(token);
    return path.endsWith("inventory")
      ? f.board.runners.inventory(runner, input)
      : f.board.runners.tick(runner, input);
  };
  const controller = new RunnerController({
    connection: f.connection,
    provider,
    transport,
  });
  await controller.sync();
  assert.equal(starts, 0, "Registration never starts work");
  f.act("agents_resume", { agent_ids: [f.agent.id] });
  await assert.rejects(controller.sync(), /Lost resume acknowledgement/);
  assert.equal(starts, 1);
  assert.equal(f.board.runners.view(f.agent.id).state, "queued");
  await controller.sync();
  assert.equal(starts, 1);
  assert.equal(f.board.runners.view(f.agent.id).state, "running");
  assert.equal(f.board.runners.view(f.agent.id).provider.isolation, "vm");
  const reconnected = new RunnerController({
    connection: f.connection,
    provider,
    transport,
  });
  await reconnected.sync();
  assert.equal(
    starts,
    1,
    "Restarting the runner reattaches instead of launching a twin",
  );
});

test("Local recovery refuses changed settings and uncertain locks, and adopts a live worker without spawning a twin", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "harakiri-provider-guards-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sessionDirectory = join(directory, "sessions", "ag_existing");
  await mkdir(sessionDirectory, { recursive: true });
  const file = join(sessionDirectory, "session.json");
  const state = {
    url: "http://localhost:4510",
    channelId: "mi_existing",
    agentId: "ag_existing",
    token: "existing-session-test-credential",
    runtime: "codex",
    cwd: join(directory, "workspace"),
    nativeSession: "native-existing",
    execution: { permissions: "default", layout: "per-agent" },
  };
  await writeFile(file, JSON.stringify(state));
  const provider = new LocalProcessProvider({
    directory: join(directory, "runner"),
    connection: {
      url: state.url,
      channelId: state.channelId,
      stateRoot: join(directory, "sessions"),
    },
    command: "/intentionally-unavailable-test-command",
  });
  const [binding] = await provider.discover();
  const intent = { ...binding, generation: 1 };
  await assert.rejects(
    provider.resume({ ...intent, workspace_ref: "ws_replacement" }),
    /cannot replace/,
  );
  await writeFile(
    file,
    JSON.stringify({
      ...state,
      execution: { ...state.execution, permissions: "full" },
    }),
  );
  const changed = await provider.resume(intent);
  assert.equal(changed.state, "failed");
  assert.match(changed.error, /settings changed/);
  assert.equal(provider.bindings[0].pid, null);
  await writeFile(file, JSON.stringify(state));
  await writeFile(file + ".lock", "");
  const uncertain = await provider.resume({ ...intent, generation: 2 });
  assert.match(uncertain.error, /stale lock/);
  assert.equal(await readFile(file + ".lock", "utf8"), "");
  await writeFile(file + ".lock", String(process.pid));
  const adopted = await provider.resume({ ...intent, generation: 3 });
  assert.equal(adopted.state, "running");
  assert.equal(adopted.generation, 3);
  assert.equal(provider.bindings[0].pid, null, "No child process was spawned");
  assert.equal(await readFile(file + ".lock", "utf8"), String(process.pid));
  assert.deepEqual(
    await provider.resume({ ...intent, generation: 3 }),
    adopted,
  );
});

test("HTTP runner endpoints reject agent credentials; non-JSON gateway failures remain retryable", async (t) => {
  const { server, board } = createServer({ database: ":memory:" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    board.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const owner = { url, token: board.ownerToken };
  const mission = await call(owner, "mission_create", {
    name: "HTTP recovery",
    objective: "Check scope",
  });
  owner.channelId = mission.id;
  const invite = await call(owner, "invitation_create");
  const agent = await request(url, "/api/join", {
    invitation: invite.token,
    name: "agent",
    runtime: "codex",
  });
  await assert.rejects(
    request(url, "/api/runners/tick", {}, agent.token),
    (e) => e.status === 401 && !isRetryable(e),
  );
  const pair = await call(owner, "runner_pair");
  const runner = await request(url, "/api/runners/join", {
    pairing_token: pair.token,
    registration_id: randomUUID(),
    name: "HTTP test",
    provider: LocalProcessProvider.descriptor,
  });
  assert.equal(
    (await request(url, "/api/runners/tick", {}, runner.token)).protocolVersion,
    1,
  );
  await assert.rejects(
    call({ url, token: runner.token, channelId: mission.id }, "context_read"),
    (e) => e.status === 401,
  );
  server.removeAllListeners("request");
  server.on("request", (_req, res) => {
    res.writeHead(502, { "content-type": "text/html" });
    res.end("<html>Gateway restarting</html>");
  });
  await assert.rejects(
    request(url, "/api/watch", {}),
    (e) => e.status === 502 && isRetryable(e) && !e.message.includes("<html>"),
  );
});
