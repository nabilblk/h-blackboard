import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  writeFile,
  rm,
  mkdir,
  readdir,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { get as httpGet } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "../server/http.mjs";
import { call, request } from "../server/remote.mjs";
const exec = promisify(execFile);
async function fixture(t) {
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
    name: "Transport test",
    objective: "Exercise the real board API",
    scope: "Test fixture only.",
    coordination_mode: "peer",
  });
  owner.channelId = mission.id;
  await call(owner, "mission_state", {
    version: mission.version,
    state: "active",
    reason: "Start the transport fixture",
  });
  const link = await call(owner, "invitation_create");
  const joined = await request(url, "/api/join", {
    invitation: link.token,
    name: "transport-agent",
    runtime: "codex",
  });
  const agent = {
    url,
    channelId: mission.id,
    agentId: joined.agent.id,
    token: joined.token,
  };
  return { url, board, owner, mission, link, agent };
}

test("HTTP boundaries, concurrent posts, and long-poll wakeup use persistent board operations", async (t) => {
  const { url, board, owner, mission, agent } = await fixture(t);
  const session = await fetch(url + "/api/session");
  assert.match(session.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(url + "/api/channels")).status, 401);
  assert.equal(
    (
      await fetch(url + "/api/session", {
        headers: { Origin: "https://outside.example" },
      })
    ).status,
    403,
  );
  const foreignHost = await new Promise((resolve, reject) =>
    httpGet(
      url + "/api/session",
      { headers: { Host: "outside.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    ).on("error", reject),
  );
  assert.equal(foreignHost, 403);
  const start = (await call(agent, "context_read")).cursor;
  const wait = request(
    url,
    "/api/watch",
    { channel_id: mission.id, after: start, timeout: 2000 },
    agent.token,
  );
  const message = await call(owner, "message_post", {
    body: "Wake this agent.",
    audience: agent.agentId,
  });
  const updates = await wait;
  assert.ok(updates.events.some((e) => e.data.id === message.id));
  assert.equal(
    board.listenerCount("change"),
    0,
    "Long-poll listener is cleaned up",
  );
  const idempotency = randomUUID();
  const duplicates = await Promise.all(
    Array.from({ length: 20 }, () =>
      call(owner, "message_post", { body: "Exactly once" }, idempotency),
    ),
  );
  assert.equal(new Set(duplicates.map((m) => m.id)).size, 1);
  const posts = await Promise.all(
    Array.from({ length: 300 }, (_, i) =>
      call(agent, "message_post", { body: `Concurrent publication ${i}` }),
    ),
  );
  assert.equal(new Set(posts.map((m) => m.sequence)).size, 300);
  assert.equal(
    board
      .list(mission.id, "message")
      .filter((m) => m.body.startsWith("Concurrent")).length,
    300,
  );
});

test("HTTP channel lists separate archived missions and archived invitations reject new joins", async (t) => {
  const { url, board, owner, mission, link, agent } = await fixture(t);
  const current = (await call(owner, "context_read")).mission;
  const archived = await call(owner, "mission_archive", {
    archived: true,
    version: current.version,
  });
  const channels = await request(url, "/api/channels", undefined, owner.token);
  assert.deepEqual(channels.missions, []);
  assert.equal(channels.archivedMissions[0].id, mission.id);
  const invitation = await fetch(`${url}/j/${link.token}?format=json`);
  assert.equal(invitation.status, 409);
  assert.equal(
    (await request(url, "/api/heartbeat", { status: "working" }, agent.token))
      .missionState,
    "archived",
  );
  await assert.rejects(
    call(agent, "message_post", { body: "Late write" }),
    /archived and read-only/,
  );
  assert.equal((await call(agent, "context_read")).mission.id, mission.id);
  await call(owner, "mission_archive", {
    archived: false,
    version: archived.version,
  });
  assert.equal(board.get(mission.id).state, "paused");
  assert.equal(
    (await request(url, "/api/channels", undefined, owner.token)).missions
      .length,
    1,
  );
});

test("MCP discovers agent operations and skills, and writes authenticated findings", async (t) => {
  const { url, owner, agent } = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), "harakiri-mcp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "session.json");
  await writeFile(file, JSON.stringify(agent), { mode: 0o600 });
  const client = new Client({ name: "integration-check", version: "1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("server/mcp.mjs"), file],
  });
  await client.connect(transport);
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.ok(tools.some((x) => x.name === "records_read"));
  assert.ok(tools.some((x) => x.name === "assignment_ack"));
  assert.ok(!tools.some((x) => x.name === "coordinator_set"));
  assert.ok(!tools.some((x) => x.name === "coordination_set"));
  assert.ok(tools.some((x) => x.name === "coordinator_ready"));
  assert.ok(tools.some((x) => x.name === "agent_admit"));
  assert.ok(tools.some((x) => x.name === "criterion_update"));
  assert.ok(!tools.some((x) => x.name === "mission_update"));
  assert.ok(!tools.some((x) => x.name === "runner_pair"));
  assert.ok(!tools.some((x) => x.name === "agents_resume"));
  assert.ok(!tools.some((x) => x.name === "messages_seen"));
  assert.ok(!tools.some((x) => x.name === "mission_archive"));
  assert.ok(
    !tools.find((x) => x.name === "message_post").inputSchema.properties
      .channel_id,
  );
  const context = await client.callTool({
    name: "context_read",
    arguments: {},
  });
  assert.equal(JSON.parse(context.content[0].text).selfId, agent.agentId);
  const result = await client.callTool({
    name: "message_post",
    arguments: { body: "MCP finding with no task.", kind: "finding" },
  });
  assert.ok(!result.isError);
  const record = JSON.parse(result.content[0].text);
  assert.equal(record.authorId, agent.agentId);
  const privateInstruction = await call(owner, "message_post", {
    body: "Private human instruction via HTTP",
    direct_agent_id: agent.agentId,
  });
  const privateReply = await client.callTool({
    name: "message_post",
    arguments: {
      body: "Private reply through MCP",
      thread_id: privateInstruction.id,
    },
  });
  assert.ok(!privateReply.isError);
  const privateRecord = JSON.parse(privateReply.content[0].text);
  assert.equal(privateRecord.directAgentId, agent.agentId);
  assert.equal(privateRecord.visibility, "private");
  assert.ok(
    !(await call(owner, "messages_read")).messages.some(
      (m) => m.id === privateRecord.id,
    ),
  );
  assert.ok(
    (
      await call(owner, "messages_read", { direct_agent_id: agent.agentId })
    ).messages.some((m) => m.id === privateRecord.id),
  );
  const resources = await client.listResources();
  assert.equal(resources.resources.length, 2);
  const skill = await client.readResource({
    uri: "harakiri://skills/participation",
  });
  assert.match(skill.contents[0].text, /task/i);
  assert.equal((await call(owner, "context_read")).tasks.length, 0);

  await call(owner, "coordination_set", {
    version: (await call(owner, "context_read")).mission.version,
    mode: "coordinated",
  });
  const leadInvite = await call(owner, "invitation_create", {
    role: "coordinator",
  });
  const leadJoin = await request(url, "/api/join", {
    invitation: leadInvite.token,
    name: "transport-coordinator",
    runtime: "claude",
  });
  const lead = { url, channelId: owner.channelId, token: leadJoin.token };
  let current = (await call(lead, "context_read")).mission;
  await call(lead, "plan_update", {
    version: current.version,
    plan: "Verify the shared finding",
  });
  current = (await call(lead, "context_read")).mission;
  await call(lead, "coordinator_ready", { revision: current.startupRevision });
  await call(owner, "mission_state", {
    version: (await call(owner, "context_read")).mission.version,
    state: "active",
    reason: "Start coordinated work",
  });
  const created = await client.callTool({
    name: "task_create",
    arguments: {
      title: "Verify the shared finding",
      mode: "individual",
      criteria: "Publish the evidence and a conclusion.",
    },
  });
  assert.ok(!created.isError);
  const task = JSON.parse(created.content[0].text);
  assert.deepEqual(task.agentIds, [agent.agentId]);
  const published = await client.callTool({
    name: "artifact_publish",
    arguments: {
      title: "Evidence",
      summary: "Verified shared finding",
      outcome: "complete",
      refs: [record.id],
      files: [
        { name: "result.md", content: "Reproduced the expected finding." },
      ],
    },
  });
  assert.ok(!published.isError);
  const output = JSON.parse(published.content[0].text);
  const reported = await client.callTool({
    name: "task_update",
    arguments: {
      task_id: task.id,
      version: task.version,
      status: "done",
      summary: "Verified the shared finding against the evidence.",
      refs: [output.revision.id],
    },
  });
  assert.ok(!reported.isError);
  const visible = (await call(owner, "context_read")).tasks[0];
  assert.equal(visible.status, "done");
  assert.equal(visible.updatedBy, agent.agentId);
  assert.deepEqual(visible.refs, [output.revision.id]);
});

test("MCP exposes criterion reporting and enforces current coordinator authority through HTTP", async (t) => {
  const { owner, agent } = await fixture(t);
  let mission = (await call(owner, "context_read")).mission;
  mission = await call(owner, "mission_update", {
    version: mission.version,
    name: mission.name,
    objective: mission.objective,
    criteria: [{ text: "The experiment has independently checked evidence" }],
  });
  const directory = await mkdtemp(join(tmpdir(), "harakiri-criterion-mcp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "session.json");
  await writeFile(file, JSON.stringify(agent), { mode: 0o600 });
  const client = new Client({ name: "criterion-check", version: "1.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve("server/mcp.mjs"), file],
      env: { ...process.env, HARAKIRI_SESSION: file },
    }),
  );
  t.after(() => client.close());
  const tool = (name, args = {}) => client.callTool({ name, arguments: args });
  const definition = (await client.listTools()).tools.find(
    (x) => x.name === "criterion_update",
  );
  assert.ok(definition);
  assert.equal(definition.inputSchema.properties.channel_id, undefined);
  assert.ok(definition.inputSchema.required.includes("summary"));
  const input = {
    version: mission.version,
    criterion_id: mission.criteria[0].id,
    met: true,
    summary: "The independent experiment passed; evidence is linked.",
  };
  const denied = await tool("criterion_update", input);
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /current coordinator or human/);
  await call(owner, "coordinator_set", {
    version: mission.version,
    agent_id: agent.agentId,
    reason: "Appoint the reviewer",
  });
  mission = (await call(owner, "context_read")).mission;
  assert.ok(
    !(
      await tool("plan_update", {
        version: mission.version,
        plan: "Review experimental evidence",
      })
    ).isError,
  );
  mission = (await call(owner, "context_read")).mission;
  assert.ok(
    !(await tool("coordinator_ready", { revision: mission.startupRevision }))
      .isError,
  );
  mission = await call(owner, "mission_state", {
    version: (await call(owner, "context_read")).mission.version,
    state: "active",
    reason: "Start review",
  });
  input.version = mission.version;
  const missingEvidence = await tool("criterion_update", input);
  assert.equal(missingEvidence.isError, true);
  assert.match(missingEvidence.content[0].text, /supporting evidence/);
  const published = await tool("message_post", {
    kind: "finding",
    body: "Independent run: all cases passed. Reproducible results in the shared report.",
  });
  assert.ok(!published.isError);
  const evidence = JSON.parse(published.content[0].text);
  const reported = await tool("criterion_update", {
    ...input,
    refs: [evidence.id],
  });
  assert.ok(!reported.isError, reported.content[0].text);
  const visible = (await call(owner, "context_read")).mission;
  assert.equal(visible.criteria[0].met, true);
  assert.equal(visible.criteria[0].assessment.updatedBy, agent.agentId);
  assert.deepEqual(visible.criteria[0].assessment.refs, [evidence.id]);
  assert.equal(visible.state, "active");
  const guidance = await client.readResource({
    uri: "harakiri://skills/coordination",
  });
  assert.match(guidance.contents[0].text, /criterion_update/);
});

test("An existing session joins through the CLI, then reads, posts, and watches with its private identity", async (t) => {
  const { url, owner, link } = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), "harakiri-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = resolve("bin/harakiri.mjs");
  const joinResult = await exec(process.execPath, [
    cli,
    "join",
    "--board",
    `${url}/j/${link.token}`,
    "--runtime",
    "claude",
    "--name",
    "existing-session",
    "--state-dir",
    directory,
  ]);
  const joined = JSON.parse(joinResult.stdout);
  assert.ok(joined.session);
  assert.equal(joined.token, undefined);
  const ctx = await exec(process.execPath, [
    cli,
    "context",
    "--session",
    joined.session,
  ]);
  assert.equal(JSON.parse(ctx.stdout).selfId, joined.agentId);
  await exec(process.execPath, [
    cli,
    "post",
    "--session",
    joined.session,
    "--body",
    "An existing session can contribute.",
  ]);
  const message = await call(owner, "message_post", {
    body: "Follow-up instruction.",
    audience: joined.agentId,
  });
  const watched = await exec(process.execPath, [
    cli,
    "watch",
    "--session",
    joined.session,
  ]);
  assert.ok(
    JSON.parse(watched.stdout).events.some((e) => e.data.id === message.id),
  );
  const direct = await exec(process.execPath, [
    cli,
    "post",
    "--session",
    joined.session,
    "--private",
    "--body",
    "CLI private answer",
  ]);
  const directMessage = JSON.parse(direct.stdout);
  assert.equal(directMessage.directAgentId, joined.agentId);
  const reply = await exec(process.execPath, [
    cli,
    "post",
    "--session",
    joined.session,
    "--thread",
    directMessage.id,
    "--body",
    "CLI private follow-up",
  ]);
  assert.equal(JSON.parse(reply.stdout).visibility, "private");
  assert.equal(
    (await call(owner, "messages_read", { direct_agent_id: joined.agentId }))
      .messages.length,
    2,
  );
});

test("The launcher manages several distinct workers and resumes their native sessions", async (t) => {
  const { url, owner, board, mission, link } = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), "harakiri-workers-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const commands = join(directory, "commands"),
    sessions = join(directory, "sessions");
  await mkdir(commands);
  // A deterministic CLI process fixture: real HTTP identity and worker lifecycle,
  // without charging model accounts in the normal test suite.
  await writeFile(
    join(commands, "codex"),
    `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('codex fixture');process.exit(0);}
(async()=>{
 const args=process.argv.slice(2),config=args.find(a=>a.startsWith('mcp_servers.harakiri.args='));
 const file=JSON.parse(config.slice(config.indexOf('=')+1))[1],s=JSON.parse(fs.readFileSync(file,'utf8'));
 let prompt='';for await(const b of process.stdin)prompt+=b;
 if(!prompt.includes('Harakiri'))throw Error('Missing participation instructions');
 const native='fixture-'+s.agentId;
 if(args.includes('resume')&&!args.includes(native))throw Error('Wrong resumed session');
 console.log(JSON.stringify({type:'thread.started',thread_id:native}));
 const res=await fetch(s.url+'/api/rpc',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+s.token},body:JSON.stringify({operation:'message_post',input:{channel_id:s.channelId,body:'Runtime process fixture '+s.agentId},key:crypto.randomUUID()})});
 if(!res.ok)throw Error('Could not publish');
 console.log(JSON.stringify({type:'turn.completed'}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
`,
    { mode: 0o700 },
  );
  const cli = resolve("bin/harakiri.mjs"),
    env = { ...process.env, PATH: commands + ":" + process.env.PATH };
  await exec(
    process.execPath,
    [
      cli,
      "launch",
      "--board",
      `${url}/j/${link.token}`,
      "--runtime",
      "codex",
      "--count",
      "3",
      "--name",
      "group",
      "--state-dir",
      sessions,
      "--workspace",
      join(directory, "workspaces"),
      "--max-turns",
      "1",
    ],
    { env },
  );
  const directories = await readdir(sessions);
  assert.equal(directories.length, 3);
  const states = await Promise.all(
    directories.map(async (name) => {
      const file = join(sessions, name, "session.json");
      return { file, state: JSON.parse(await readFile(file, "utf8")) };
    }),
  );
  assert.equal(new Set(states.map((s) => s.state.agentId)).size, 3);
  for (const { state } of states) {
    assert.equal(state.nativeSession, "fixture-" + state.agentId);
    assert.equal(board.get(state.agentId).status, "offline");
    assert.match(state.cwd, /workspaces\/agents\//);
    assert.equal(state.execution.permissions, "default");
  }
  assert.equal(new Set(states.map((s) => s.state.cwd)).size, 3);
  const before = board.list(mission.id, "agent").length;
  await exec(
    process.execPath,
    [cli, "resume", "--session", states[0].file, "--max-turns", "1"],
    { env },
  );
  assert.equal(board.list(mission.id, "agent").length, before);
  assert.equal(
    JSON.parse(await readFile(states[0].file, "utf8")).nativeSession,
    states[0].state.nativeSession,
  );
  assert.equal((await call(owner, "context_read")).tasks.length, 0);
});
