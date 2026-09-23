import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { createServer } from "../server/http.mjs";
import { call, request } from "../server/remote.mjs";
import {
  runtimeArguments,
  prepareWorkspace,
  prepareAgentWorkspace,
} from "../bin/runtime.mjs";
import { runtimeLog } from "../bin/runtime-logs.mjs";
import runtimes from "../shared/runtimes.json" with { type: "json" };
import { pathToFileURL } from "node:url";
import { RunnerController } from "../bin/runner.mjs";
import { LocalProcessProvider } from "../bin/providers/local-process.mjs";

const exec = promisify(execFile);
const cli = resolve("bin/harakiri.mjs");

async function until(read, message) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out: ${message}`);
}

async function fixture(t, preparing = false) {
  const directory = await mkdtemp(join(tmpdir(), "harakiri-launch-"));
  const { server, board } = createServer({ database: ":memory:" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    board.close();
    await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const owner = { url, token: board.ownerToken };
  const mission = await call(owner, "mission_create", {
    name: "Launch fixture",
    objective: "Inspect execution without model calls",
    coordination_mode: preparing ? "coordinated" : "peer",
  });
  owner.channelId = mission.id;
  if (!preparing)
    await call(owner, "mission_state", {
      version: mission.version,
      state: "active",
      reason: "Start the launcher fixture",
    });
  const invitation = await call(owner, "invitation_create");
  const commands = join(directory, "commands"),
    sessions = join(directory, "sessions"),
    workspace = join(directory, "mission files ' with spaces");
  await mkdir(commands);
  const fake = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),runtime=path.basename(process.argv[1]);
if(args.includes('--version')){console.log(runtime+' fixture 1.0');process.exit(0);}
if(args.includes('--help')){console.log(process.env.HARAKIRI_TEST_UNSUPPORTED?'old runtime':'--dangerously-bypass-approvals-and-sandbox --dangerously-skip-permissions --settings');process.exit(0);}
(async()=>{
 const file=runtime==='codex'?JSON.parse(args.find(a=>a.startsWith('mcp_servers.harakiri.args=')).split('=').slice(1).join('='))[1]:JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.harakiri.args[1];
 const state=JSON.parse(fs.readFileSync(file,'utf8'));
 let input='';for await(const data of process.stdin)input+=data;
 const prompt=runtime==='codex'?input:args.at(-1);
 if(!prompt.includes('Local execution workspace:')||!prompt.includes(JSON.stringify(state.cwd))||fs.realpathSync(state.cwd)!==process.cwd())throw Error('Missing workspace instructions');
 const native='native-'+state.agentId;
 if(state.nativeSession&&!args.includes(native))throw Error('Resume lost native session');
 fs.appendFileSync(path.join(process.cwd(),'observations.jsonl'),JSON.stringify({args,cwd:process.cwd(),prompt})+'\\n');
 if(process.env.HARAKIRI_TEST_PREPARE){
   if(!prompt.includes('PREPARATION ONLY'))throw Error('Coordinator received execution instructions during preparation');
   const call=async(operation,input={})=>{const res=await fetch(state.url+'/api/rpc',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+state.token},body:JSON.stringify({operation,input:{channel_id:state.channelId,...input},key:require('node:crypto').randomUUID()})});const data=await res.json();if(!res.ok)throw Error(data.error);return data;};
   let ctx=await call('context_read');
   await call('plan_update',{version:ctx.mission.version,plan:'Compare distinct alternatives in Main; tasks are optional.'});
   ctx=await call('context_read');
   await call('coordinator_ready',{revision:ctx.mission.startupRevision});
 }
 console.log(JSON.stringify(runtime==='codex'?{type:'thread.started',thread_id:native}:{type:'system',session_id:native}));
 console.error('stderr is live');
 if(process.env.HARAKIRI_TEST_FAIL){console.error('Managed policy blocked execution (network policy) '+state.token);process.exitCode=23;return;}
 if(process.env.HARAKIRI_TEST_HOLD){await new Promise(r=>setTimeout(r,30000));}
 console.log(JSON.stringify({type:'turn.completed'}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
`;
  for (const runtime of ["claude", "codex"])
    await writeFile(join(commands, runtime), fake, { mode: 0o700 });
  await writeFile(
    join(commands, "grok"),
    `#!/usr/bin/env node
import(${JSON.stringify(pathToFileURL(resolve("tests/fixtures/grok.mjs")).href)});
`,
    { mode: 0o700 },
  );
  const env = { ...process.env, PATH: commands + ":" + process.env.PATH };
  const args = (runtime, ...extra) => [
    cli,
    "launch",
    "--board",
    `${url}/j/${invitation.token}`,
    "--runtime",
    runtime,
    "--workspace",
    workspace,
    "--state-dir",
    sessions,
    "--max-turns",
    "1",
    ...extra,
  ];
  const states = async () =>
    Promise.all(
      (await readdir(sessions)).map(async (name) => {
        const file = join(sessions, name, "session.json");
        return { file, state: JSON.parse(await readFile(file, "utf8")) };
      }),
    );
  return {
    directory,
    url,
    owner,
    board,
    server,
    mission,
    env,
    args,
    states,
    workspace,
    sessions,
  };
}

for (const runtime of Object.keys(runtimes)) {
  test(`${runtime}: a restarted waiting session still cannot start until a human releases it`, async (t) => {
    const f = await fixture(t, true);
    await call(f.owner, "coordination_set", {
      version: f.board.get(f.mission.id).version,
      mode: "peer",
    });
    const children = [];
    const run = (args) => {
      const child = spawn(process.execPath, args, {
        env: f.env,
        stdio: "ignore",
      });
      const exited = once(child, "exit");
      children.push({ child, exited });
      return { child, exited };
    };
    t.after(async () => {
      for (const { child, exited } of children) {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGTERM");
        await exited;
      }
    });
    const first = run(f.args(runtime));
    const agent = await until(
      () =>
        f.board.list(f.mission.id, "agent").find((a) => a.status === "waiting"),
      "first worker waits",
    );
    const [{ file, state }] = await f.states();
    assert.deepEqual(await readdir(state.cwd), []);
    first.child.kill("SIGTERM");
    await first.exited;
    const resumed = run([cli, "resume", "--session", file, "--max-turns", "1"]);
    await until(
      () => f.board.get(agent.id).status === "waiting",
      "resumed worker waits",
    );
    assert.equal(f.board.list(f.mission.id, "agent").length, 1);
    assert.deepEqual(await readdir(state.cwd), []);
    await call(f.owner, "mission_state", {
      version: f.board.get(f.mission.id).version,
      state: "active",
      reason: "Release peer mission",
    });
    const [code] = await resumed.exited;
    assert.equal(code, 0);
    assert.equal(
      (await readFile(join(state.cwd, "observations.jsonl"), "utf8"))
        .trim()
        .split("\n").length,
      1,
    );
  });

  test(`${runtime}: bulk workers consume no model turns until coordinator readiness AND human start`, async (t) => {
    const f = await fixture(t, true);
    const child = spawn(process.execPath, f.args(runtime, "--count", "3"), {
      env: f.env,
      stdio: "ignore",
    });
    const exited = once(child, "exit");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      await exited;
    });
    await until(
      () =>
        f.board
          .list(f.mission.id, "agent")
          .filter((a) => a.status === "waiting").length === 3,
      "three waiting workers",
    );
    const sessions = await f.states();
    for (const { state } of sessions)
      assert.deepEqual(await readdir(state.cwd), []);
    const link = await call(f.owner, "invitation_create", {
      role: "coordinator",
    });
    const joined = await request(f.url, "/api/join", {
      invitation: link.token,
      name: "manual-lead",
      runtime,
    });
    const lead = { url: f.url, channelId: f.mission.id, token: joined.token };
    const plan = await call(lead, "plan_update", {
      version: f.board.get(f.mission.id).version,
      plan: "Explore separate directions in Main",
    });
    await call(lead, "coordinator_ready", { revision: plan.startupRevision });
    // Wait through another control read: readiness alone must not release work.
    const lastSeen = f.board.get(sessions[0].state.agentId).lastSeen;
    await until(
      () => f.board.get(sessions[0].state.agentId).lastSeen > lastSeen,
      "worker checked ready-but-not-started mission",
    );
    for (const { state } of sessions)
      assert.deepEqual(await readdir(state.cwd), []);
    await call(f.owner, "mission_state", {
      version: f.board.get(f.mission.id).version,
      state: "active",
      reason: "Human starts prepared work",
    });
    const [code] = await exited;
    assert.equal(code, 0);
    for (const { state } of sessions) {
      const turns = (
        await readFile(join(state.cwd, "observations.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(turns.length, 1);
      assert.match(turns[0].prompt, /Execution is authorized/);
      assert.match(turns[0].prompt, /Explore separate directions in Main/);
      assert.equal(
        JSON.parse(
          await readFile(
            join(f.sessions, state.agentId, "session.json"),
            "utf8",
          ),
        ).nativeSession,
        "native-" + state.agentId,
      );
    }
    assert.equal(f.board.list(f.mission.id, "task").length, 0);
  });

  test(`${runtime}: promoting an already joined worker runs planning without starting execution`, async (t) => {
    const f = await fixture(t, true);
    const child = spawn(process.execPath, f.args(runtime), {
      env: { ...f.env, HARAKIRI_TEST_PREPARE: "1" },
      stdio: "ignore",
    });
    const exited = once(child, "exit");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      await exited;
    });
    const agent = await until(
      () =>
        f.board.list(f.mission.id, "agent").find((a) => a.status === "waiting"),
      "worker waits before coordinator appointment",
    );
    const [{ state }] = await f.states();
    assert.deepEqual(await readdir(state.cwd), []);
    await call(f.owner, "coordinator_set", {
      version: f.board.get(f.mission.id).version,
      agent_id: agent.id,
      reason: "Appoint after the agent joined",
    });
    const [code] = await exited;
    assert.equal(code, 0);
    const ctx = await call(f.owner, "context_read");
    assert.equal(ctx.mission.state, "preparing");
    assert.equal(ctx.startup.coordinatorReady, true);
    assert.equal(
      ctx.startup.canStart,
      false,
      "an exited coordinator is unavailable even if it acknowledged readiness",
    );
    assert.match(ctx.mission.plan, /Compare distinct alternatives/);
    assert.equal(ctx.tasks.length, 0);
  });

  test(`${runtime}: full access, custom folders, identity and permissions survive resume`, async (t) => {
    const f = await fixture(t);
    await exec(
      process.execPath,
      f.args(runtime, "--permissions", "full", "--count", "2"),
      { env: f.env },
    );
    const sessions = await f.states();
    assert.equal(sessions.length, 2);
    assert.notEqual(sessions[0].state.cwd, sessions[1].state.cwd);
    for (const { state, file } of sessions) {
      assert.equal(state.execution.permissions, "full");
      assert.equal(state.execution.layout, "per-agent");
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.notEqual(state.cwd, dirname(file));
      assert.deepEqual(await readdir(state.cwd), ["observations.jsonl"]);
    }
    const { file, state } = sessions[0];
    await exec(
      process.execPath,
      [cli, "resume", "--session", file, "--max-turns", "1"],
      { env: f.env },
    );
    const resumed = JSON.parse(await readFile(file, "utf8"));
    assert.equal(resumed.agentId, state.agentId);
    assert.equal(resumed.nativeSession, state.nativeSession);
    assert.equal(resumed.cwd, state.cwd);
    const turns = (
      await readFile(join(state.cwd, "observations.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(turns.length, 2);
    for (const turn of turns) {
      if (runtime === "codex") {
        assert.ok(
          turn.args.includes("--dangerously-bypass-approvals-and-sandbox"),
        );
        assert.ok(turn.args.includes('approval_policy="never"'));
      } else if (runtime === "grok") {
        assert.ok(turn.args.includes("--always-approve"));
        assert.ok(turn.args.includes("--no-leader"));
        assert.equal(turn.sandbox, "off");
        assert.equal(turn.config._meta.yoloMode, true);
      } else {
        assert.ok(turn.args.includes("--dangerously-skip-permissions"));
        assert.deepEqual(
          JSON.parse(turn.args[turn.args.indexOf("--settings") + 1]),
          { sandbox: { enabled: false } },
        );
      }
    }
    assert.ok(
      runtime === "grok"
        ? turns[1].method === "session/load"
        : turns[1].args.includes(runtime === "codex" ? "resume" : "--resume"),
    );
    assert.match(turns[0].prompt, /Shared mission folder:/);
    const record = await call(f.owner, "record_read", { id: state.agentId });
    assert.equal(record.execution.workspace, state.cwd);
    assert.equal(record.execution.permissions, "full");
    assert.equal(record.execution.lastError, null);
    assert.equal(record.status, "offline");
    assert.equal(
      (await readFile(record.execution.stdoutPath, "utf8")).trim().split("\n")
        .length,
      4,
    );
    assert.match(
      await readFile(record.execution.stderrPath, "utf8"),
      /stderr is live/,
    );
    // Reports never ride along in agent reads or shared event payloads.
    const peer = { ...sessions[1].state, url: f.url };
    assert.equal(
      (await call(peer, "record_read", { id: state.agentId })).execution,
      undefined,
    );
    assert.ok(
      (await call(peer, "records_read", { type: "agent" })).items.every(
        (a) => !a.execution,
      ),
    );
    assert.ok(
      (await call(peer, "context_read")).agents.every((a) => !a.execution),
    );
    assert.ok(
      !JSON.stringify(await call(peer, "updates_read")).includes(state.cwd),
    );
    await assert.rejects(
      exec(
        process.execPath,
        [cli, "resume", "--session", file, "--permissions", "default"],
        { env: f.env },
      ),
      /Resume uses the saved workspace/,
    );
  });
}

test("Grok agents share a workspace without sharing MCP identity or modifying project configuration", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.workspace, ".grok"), { recursive: true });
  const config = join(f.workspace, ".grok", "config.toml");
  const projectMcp = join(f.workspace, ".mcp.json");
  await writeFile(config, "# Existing user configuration\n");
  await writeFile(projectMcp, '{"mcpServers":{}}\n');
  await exec(
    process.execPath,
    f.args("grok", "--layout", "shared", "--count", "2"),
    {
      env: {
        ...f.env,
        HARAKIRI_TEST_MCP: "1",
        HARAKIRI_SESSION: "/foreign/session.json",
      },
    },
  );
  const sessions = await f.states();
  assert.equal(sessions.length, 2);
  assert.notEqual(
    sessions[0].state.nativeSession,
    sessions[1].state.nativeSession,
  );
  for (const { state } of sessions) {
    assert.equal(state.cwd, await realpath(f.workspace));
    assert.ok(
      f.board
        .list(f.mission.id, "message")
        .some(
          (m) =>
            m.authorId === state.agentId &&
            m.body === "ACP_MCP_" + state.agentId,
        ),
    );
  }
  assert.equal(
    await readFile(config, "utf8"),
    "# Existing user configuration\n",
  );
  assert.equal(await readFile(projectMcp, "utf8"), '{"mcpServers":{}}\n');
  // The same board admits all three runtimes; no runtime-specific mission data.
  for (const runtime of ["claude", "codex"])
    await exec(process.execPath, f.args(runtime), { env: f.env });
  assert.deepEqual(
    new Set(f.board.list(f.mission.id, "agent").map((agent) => agent.runtime)),
    new Set(Object.keys(runtimes)),
  );
});

test("Grok preflight rejects missing auth, incompatible protocol, and unsupported modes before registration", async (t) => {
  const f = await fixture(t);
  for (const [flag, pattern] of [
    ["HARAKIRI_TEST_NO_AUTH", /needs authentication/],
    ["HARAKIRI_TEST_BAD_AUTH", /Credentials expired/],
    ["HARAKIRI_TEST_NO_RESUME", /required ACP session\/resume protocol/],
    ["HARAKIRI_TEST_UNSUPPORTED", /does not support/],
    ["HARAKIRI_TEST_BAD_PROTOCOL", /Invalid Grok ACP response/],
  ]) {
    await assert.rejects(
      exec(process.execPath, f.args("grok", "--count", "3"), {
        env: { ...f.env, [flag]: "1" },
      }),
      pattern,
    );
    assert.equal(f.board.list(f.mission.id, "agent").length, 0);
  }
  await assert.rejects(
    exec(process.execPath, f.args("grok", "--board-only"), { env: f.env }),
    /does not yet support --board-only/,
  );
  assert.equal(f.board.list(f.mission.id, "agent").length, 0);
});

for (const [flag, value, pattern] of [
  ["HARAKIRI_TEST_FAIL", "1", /Managed policy blocked/],
  ["HARAKIRI_TEST_CRASH", "1", /disconnected/],
  ["HARAKIRI_TEST_STOP", "max_tokens", /stop reason: max_tokens/],
  ["HARAKIRI_TEST_STOP", "cancelled", /stop reason: cancelled/],
])
  test(`Grok ${flag}/${value}: failure is visible and the original identity can resume`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      exec(process.execPath, f.args("grok"), {
        env: { ...f.env, [flag]: value },
      }),
      pattern,
    );
    const [{ state, file }] = await f.states();
    assert.equal(state.nativeSession, "native-" + state.agentId);
    const agent = await call(f.owner, "record_read", { id: state.agentId });
    assert.match(agent.execution.lastError, pattern);
    assert.ok(!agent.execution.lastError.includes(state.token));
    await exec(
      process.execPath,
      [cli, "resume", "--session", file, "--max-turns", "1"],
      { env: f.env },
    );
    assert.equal(
      (await call(f.owner, "record_read", { id: state.agentId })).execution
        .lastError,
      null,
    );
    assert.equal(f.board.list(f.mission.id, "agent").length, 1);
    assert.equal(
      JSON.parse(await readFile(file, "utf8")).nativeSession,
      state.nativeSession,
    );
  });

test("Stopping a Grok launcher interrupts its owned ACP process and preserves the native session", async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, f.args("grok"), {
    env: { ...f.env, HARAKIRI_TEST_HOLD: "1" },
    stdio: "ignore",
  });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await exited;
  });
  const session = await until(async () => {
    try {
      const [value] = await f.states();
      return value?.state.nativeSession && value;
    } catch {
      return false;
    }
  }, "native identity persisted during the model turn");
  const observed = await until(async () => {
    try {
      return JSON.parse(
        (
          await readFile(join(session.state.cwd, "observations.jsonl"), "utf8")
        ).trim(),
      );
    } catch {
      return false;
    }
  }, "Grok process running");
  process.kill(observed.pid, 0);
  child.kill("SIGTERM");
  await exited;
  await until(() => {
    try {
      process.kill(observed.pid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  }, "Grok process stopped");
  assert.equal(
    JSON.parse(await readFile(session.file, "utf8")).nativeSession,
    session.state.nativeSession,
  );
});

test("Shared folders and the legacy --cwd alias use one deliberate working folder", async (t) => {
  const f = await fixture(t);
  const args = f.args("codex", "--layout", "shared", "--count", "2");
  await exec(process.execPath, args, { env: f.env });
  const states = await f.states();
  for (const { state } of states) {
    assert.equal(state.cwd, states[0].state.cwd);
    assert.equal(state.execution.shared, state.cwd);
    assert.equal(state.execution.layout, "shared");
  }
  const observations = (
    await readFile(join(states[0].state.cwd, "observations.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(observations.length, 2);
  assert.ok(
    observations.every(
      (o) =>
        o.args.includes('sandbox_mode="workspace-write"') &&
        !o.args.includes("--dangerously-bypass-approvals-and-sandbox"),
    ),
  );
  const config = await prepareWorkspace(
    { cwd: f.workspace, "state-dir": f.sessions },
    f.mission.id,
    f.sessions,
  );
  assert.equal(config.layout, "shared");
  assert.equal(
    (await prepareAgentWorkspace(config, "legacy")).cwd,
    states[0].state.cwd,
  );
});

test("Legacy sessions resume in their original folder without losing identity or raising permissions", async (t) => {
  const f = await fixture(t);
  await exec(process.execPath, f.args("codex"), { env: f.env });
  const [{ file, state }] = await f.states();
  delete state.execution;
  state.cwd = dirname(file);
  await writeFile(file, JSON.stringify(state), { mode: 0o600 });
  await exec(
    process.execPath,
    [cli, "resume", "--session", file, "--max-turns", "1"],
    { env: f.env },
  );
  const resumed = JSON.parse(await readFile(file, "utf8"));
  assert.equal(resumed.cwd, state.cwd);
  assert.equal(resumed.nativeSession, state.nativeSession);
  const { execution } = await call(f.owner, "record_read", {
    id: state.agentId,
  });
  assert.equal(execution.layout, "legacy");
  assert.equal(execution.permissions, "default");
  assert.equal(execution.shared, null);
});

test("Validation rejects unsupported access and conflicting/unwritable folders before any registration", async (t) => {
  const f = await fixture(t);
  const occupied = join(f.directory, "not-a-folder");
  await writeFile(occupied, "fixture");
  for (const [extra, pattern] of [
    [["--permissions", "full", "--board-only"], /cannot be combined/],
    [["--permissions", "guess"], /must be default or full/],
    [["--layout", "guess"], /must be per-agent or shared/],
    [["--cwd", f.workspace], /either --cwd or --workspace/],
  ])
    await assert.rejects(
      exec(process.execPath, f.args("codex", ...extra), { env: f.env }),
      pattern,
    );
  const badPath = f.args("codex");
  badPath[badPath.indexOf("--workspace") + 1] = occupied;
  await assert.rejects(
    exec(process.execPath, badPath, { env: f.env }),
    /EEXIST|Not a folder/,
  );
  await assert.rejects(
    exec(process.execPath, f.args("codex", "--permissions", "full"), {
      env: { ...f.env, HARAKIRI_TEST_UNSUPPORTED: "1" },
    }),
    /does not support/,
  );
  assert.equal(f.board.list(f.mission.id, "agent").length, 0);
  await assert.rejects(
    prepareWorkspace(
      { workspace: f.sessions, "state-dir": f.sessions },
      f.mission.id,
      f.sessions,
    ),
    /separate folders/,
  );
  const alias = join(f.directory, "session-alias");
  await symlink(f.sessions, alias);
  await assert.rejects(
    prepareWorkspace(
      { workspace: alias, "state-dir": f.sessions },
      f.mission.id,
      f.sessions,
    ),
    /separate folders/,
  );
});

test("An older board service fails visibly before the launcher starts any model turn", async (t) => {
  const f = await fixture(t);
  const heartbeat = f.board.heartbeat.bind(f.board);
  f.board.heartbeat = (...args) => {
    const response = heartbeat(...args);
    delete response.participation;
    return response;
  };
  await assert.rejects(
    exec(process.execPath, f.args("codex"), { env: f.env }),
    /board service does not support mission preparation/,
  );
  const [{ state }] = await f.states();
  assert.deepEqual(await readdir(state.cwd), []);
  assert.equal(f.board.get(state.agentId).status, "error");
});

test("Logs arrive during execution, and shutdown persists the native session", async (t) => {
  const f = await fixture(t);
  const child = spawn(
    process.execPath,
    f.args("claude", "--permissions", "full"),
    { env: { ...f.env, HARAKIRI_TEST_HOLD: "1" }, stdio: "ignore" },
  );
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
  });
  const report = await until(
    async () =>
      (await call(f.owner, "context_read")).agents.find(
        (a) => a.execution && a.status === "working",
      ),
    "working agent report",
  );
  await until(
    async () =>
      (
        await readFile(report.execution.stdoutPath, "utf8").catch(() => "")
      ).includes("session_id"),
    "live stdout before turn exit",
  );
  await until(
    async () =>
      (
        await readFile(report.execution.stderrPath, "utf8").catch(() => "")
      ).includes("stderr is live"),
    "live stderr before turn exit",
  );
  assert.equal(child.exitCode, null);
  child.kill("SIGTERM");
  await exited;
  const [{ state }] = await f.states();
  assert.equal(state.nativeSession, "native-" + state.agentId);
  assert.equal(f.board.get(state.agentId).status, "offline");
});

test("Runtime failures remain private, redact credentials and clear after successful resume", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    exec(process.execPath, f.args("claude", "--permissions", "full"), {
      env: { ...f.env, HARAKIRI_TEST_FAIL: "1" },
    }),
    /Managed policy blocked execution/,
  );
  const [{ state, file }] = await f.states();
  const record = await call(f.owner, "record_read", { id: state.agentId });
  assert.equal(record.status, "error");
  assert.match(record.execution.lastError, /Managed policy blocked execution/);
  assert.ok(!record.execution.lastError.includes(state.token));
  assert.match(record.execution.lastError, /\[redacted\]/);
  assert.ok(
    !(await call(f.owner, "messages_read")).messages.some((m) =>
      m.body.includes("Managed policy"),
    ),
  );
  const privateMessages = await call(f.owner, "messages_read", {
    direct_agent_id: state.agentId,
  });
  assert.ok(
    privateMessages.messages.some((m) => m.body.includes("Managed policy")),
  );
  await assert.rejects(
    request(
      f.url,
      "/api/heartbeat",
      {
        status: "idle",
        execution: {
          ...record.execution,
          token: "never accept arbitrary fields",
        },
      },
      state.token,
    ),
    /Invalid launcher execution report/,
  );
  await request(f.url, "/api/heartbeat", { status: "idle" }, state.token);
  assert.equal(
    (await call(f.owner, "record_read", { id: state.agentId })).execution
      .lastError,
    record.execution.lastError,
    "old heartbeat clients do not erase execution reports",
  );
  await exec(
    process.execPath,
    [cli, "resume", "--session", file, "--max-turns", "1"],
    { env: f.env },
  );
  assert.equal(
    (await call(f.owner, "record_read", { id: state.agentId })).execution
      .lastError,
    null,
  );
});

test("Default and board-only permissions are explicit on both fresh and resumed runtime turns", () => {
  for (const nativeSession of [null, "native-session"]) {
    const codex = runtimeArguments(
      { runtime: "codex", nativeSession, boardOnly: true },
      "/state/session.json",
      "prompt",
      "/mcp.mjs",
    );
    assert.ok(codex.args.includes('sandbox_mode="read-only"'));
    assert.ok(
      !codex.args.includes("--dangerously-bypass-approvals-and-sandbox"),
    );
    const claude = runtimeArguments(
      { runtime: "claude", nativeSession, boardOnly: true },
      "/state/session.json",
      "prompt",
      "/mcp.mjs",
    );
    assert.equal(claude.args[claude.args.indexOf("--tools") + 1], "");
    assert.ok(!claude.args.includes("--dangerously-skip-permissions"));
    for (const runtime of ["claude", "codex"]) {
      const args = runtimeArguments(
        {
          runtime,
          nativeSession,
          cwd: "/work/agent",
          execution: { permissions: "default", shared: "/work/shared" },
        },
        "/state/session.json",
        "prompt",
        "/mcp.mjs",
      ).args;
      assert.ok(!args.some((v) => v.startsWith("--dangerously")));
      assert.ok(
        runtime === "claude"
          ? args.includes("/work/shared")
          : args.includes(
              'sandbox_workspace_write.writable_roots=["/work/shared"]',
            ),
      );
    }
  }
});

test("Live logs rotate with bounded retention and private file permissions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harakiri-log-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "output.log");
  const log = await runtimeLog(file, 16);
  log.end(Buffer.from("a".repeat(100)));
  await finished(log);
  assert.deepEqual((await readdir(directory)).sort(), [
    "output.log",
    "output.log.1",
    "output.log.2",
    "output.log.3",
  ]);
  assert.equal((await stat(file)).size, 4);
  for (const path of await readdir(directory)) {
    const s = await stat(join(directory, path));
    assert.ok(s.size <= 16);
    assert.equal(s.mode & 0o777, 0o600);
  }
});

test("A paired local runner resumes the saved identity and survives a temporary HTML gateway failure", async (t) => {
  const f = await fixture(t);
  await exec(process.execPath, f.args("codex"), { env: f.env });
  const [{ file, state }] = await f.states();
  const originalNative = state.nativeSession;
  for (let i = 0; i < 75; i++)
    await call(f.owner, "message_post", {
      body: `Saved-cursor instruction ${i}`,
      audience: state.agentId,
    });
  const pair = await call(f.owner, "runner_pair");
  const connection = await request(f.url, "/api/runners/join", {
    pairing_token: pair.token,
    registration_id: crypto.randomUUID(),
    name: "Local recovery test",
    provider: LocalProcessProvider.descriptor,
  });
  Object.assign(connection, { url: f.url, stateRoot: f.sessions });
  const provider = new LocalProcessProvider({
    connection,
    directory: join(f.directory, "runner"),
    env: f.env,
  });
  const controller = new RunnerController({ connection, provider });
  const handlers = f.server.listeners("request");
  let outage = false;
  f.server.removeAllListeners("request");
  f.server.on("request", (req, res) => {
    if (outage && req.headers.authorization === `Bearer ${state.token}`) {
      res.writeHead(502, { "Content-Type": "text/html" });
      res.end("<html>Gateway restarting</html>");
    } else handlers.forEach((handler) => handler(req, res));
  });
  try {
    await controller.sync();
    assert.equal(
      provider.bindings[0].pid,
      null,
      "Attaching a saved session does not launch it",
    );
    const beforeResume = f.board.get(state.agentId).lastSeen;
    await call(f.owner, "agents_resume", { agent_ids: [state.agentId] });
    await controller.sync();
    const resumed = await until(async () => {
      const agent = f.board.get(state.agentId);
      return agent.status === "idle" && agent.lastSeen > beforeResume && agent;
    }, "resumed agent heartbeat");
    assert.ok(resumed);
    const pid = provider.bindings[0].pid;
    assert.ok(pid);
    await until(
      async () =>
        (await readFile(join(state.cwd, "observations.jsonl"), "utf8"))
          .trim()
          .split("\n").length >= 2,
      "native session resumed",
    );
    assert.equal(
      JSON.parse(await readFile(file, "utf8")).nativeSession,
      originalNative,
    );
    await controller.sync();
    assert.equal(
      provider.bindings[0].pid,
      pid,
      "Repeated sync cannot start a second worker",
    );
    assert.equal(f.board.list(f.mission.id, "agent").length, 1);
    outage = true;
    const before = f.board.get(state.agentId).lastSeen;
    await call(f.owner, "message_post", {
      body: "A follow-up delivered through the reconnecting launcher",
      audience: state.agentId,
    });
    await new Promise((resolve) => setTimeout(resolve, 1600));
    process.kill(pid, 0);
    outage = false;
    await until(
      async () => f.board.get(state.agentId).lastSeen > before,
      "heartbeat after gateway recovery",
    );
    process.kill(pid, 0);
    assert.equal(
      JSON.parse(await readFile(file, "utf8")).nativeSession,
      originalNative,
    );
    assert.equal(f.board.list(f.mission.id, "agent").length, 1);
    const nativeCalls = (
      await readFile(join(state.cwd, "observations.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.ok(
      nativeCalls
        .slice(1)
        .every((entry) => entry.args.includes(originalNative)),
    );
    assert.ok(
      nativeCalls
        .slice(1)
        .some((entry) => entry.prompt.includes("Saved-cursor instruction 0")),
      "An older unread instruction is not lost to the bounded context snapshot",
    );
  } finally {
    outage = false;
    for (const binding of provider.bindings || [])
      if (binding.pid) {
        try {
          process.kill(binding.pid, "SIGTERM");
        } catch {}
      }
    await until(async () => {
      try {
        await stat(file + ".lock");
        return false;
      } catch {
        return true;
      }
    }, "worker cleanup");
    await until(
      async () => provider.bindings.every((b) => !b.pid),
      "provider exit observation",
    );
    await provider.saving;
  }
});
