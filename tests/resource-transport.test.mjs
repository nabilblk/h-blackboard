import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "../server/http.mjs";
import { call, request } from "../server/remote.mjs";
import { TurnBudget } from "../bin/budget-client.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "bb-resources-transport-"));
  const { server, board } = createServer({
    database: join(directory, "board.sqlite"),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    board.close();
    await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const human = { url, token: board.ownerToken };
  const mission = await call(human, "mission_create", {
    name: "Transport",
    objective: "Preserve output and accounting",
    coordination_mode: "peer",
  });
  human.channelId = mission.id;
  await call(human, "mission_state", {
    state: "active",
    version: mission.version,
    reason: "Start isolated test",
  });
  const invitation = await call(human, "invitation_create");
  const joined = await request(url, "/api/join", {
    invitation: invitation.token,
    name: "worker",
    runtime: "codex",
  });
  const state = {
    url,
    channelId: mission.id,
    agentId: joined.agent.id,
    token: joined.token,
  };
  return { directory, server, board, human, state };
}

test("HTTP and the file CLI preserve large Unicode/binary contributions and explicit relative bundle names", async (t) => {
  const f = await fixture(t);
  const content = "Évidence • 日本語 • 🧪\n".repeat(20000);
  const output = await call(f.state, "artifact_publish", {
    title: "Large report",
    summary: "Unicode transport",
    files: [{ name: "report.md", content, media_type: "text/markdown" }],
  });
  const read = await call(f.state, "artifact_file", {
    revision_id: output.revision.id,
    name: "report.md",
  });
  assert.equal(Buffer.from(read.content, "base64").toString("utf8"), content);
  await writeFile(
    join(f.directory, "data.bin"),
    Buffer.from([0, 255, 127, 12]),
  );
  await writeFile(join(f.directory, "session.json"), JSON.stringify(f.state));
  await writeFile(
    join(f.directory, "artifact.json"),
    JSON.stringify({
      title: "Bundle",
      summary: "Binary payload",
      outcome: "complete",
      files: [{ path: "data.bin", name: "assets/data.bin" }],
    }),
  );
  const { stdout } = await promisify(execFile)(process.execPath, [
    resolve("bin/harakiri.mjs"),
    "publish",
    "--session",
    join(f.directory, "session.json"),
    "--manifest",
    join(f.directory, "artifact.json"),
  ]);
  const delivered = JSON.parse(stdout);
  const binary = await call(f.state, "artifact_file", {
    revision_id: delivered.revision.id,
    name: "assets/data.bin",
  });
  assert.deepEqual(
    Buffer.from(binary.content, "base64"),
    Buffer.from([0, 255, 127, 12]),
  );
});

test("A durable settlement outbox replays exactly once, even when the mission has been archived", async (t) => {
  const f = await fixture(t);
  const context = await call(f.state, "context_read");
  let saved;
  const client = new TurnBudget(f.state, async () => {
    saved = structuredClone(f.state);
  });
  const { run } = await client.reserve(context);
  const report = {
    run_id: run.id,
    usage: {
      tokens: 123,
      costUsd: 0.04,
      quality: "reported",
      source: "Terminal report",
    },
    outcome: "completed",
  };
  // Server committed, but the launcher died before recording the acknowledgment.
  await call(f.state, "budget_settle", report, `settle:${run.id}`);
  f.state.pendingBudget.phase = "settling";
  f.state.pendingBudget.report = report;
  await call(f.human, "mission_archive", {
    version: (await call(f.human, "context_read")).mission.version,
    archived: true,
  });
  await client.recover();
  assert.equal(saved.pendingBudget, undefined);
  const budget = await call(f.human, "budget_read");
  assert.equal(budget.totalRuns, 1);
  assert.equal(budget.consumed.tokens, 123);
  assert.equal(budget.active, 0);
});

test("Lost reservation responses recover after pause; ambiguous native processes keep their allowance until reconciliation", async (t) => {
  const f = await fixture(t);
  const client = new TurnBudget(f.state, async () => {});
  const { run } = await client.reserve(await call(f.state, "context_read"));
  await call(f.human, "mission_state", {
    state: "paused",
    reason: "Pause during admission",
  });
  await client.recover();
  assert.equal(
    (await call(f.human, "budget_run_read", { run_id: run.id })).usage.tokens,
    0,
  );
  await call(f.human, "mission_state", {
    state: "active",
    version: (await call(f.human, "context_read")).mission.version,
    reason: "Resume",
  });
  const next = await client.reserve(await call(f.state, "context_read"));
  await client.starting();
  await assert.rejects(client.recover(), /cannot be confirmed stopped/);
  assert.equal((await call(f.human, "budget_read")).active, 1);
  await call(f.human, "budget_reconcile", {
    run_id: next.run.id,
    version: next.run.version,
    usage: {
      tokens: 20,
      costUsd: 0.01,
      quality: "estimated",
      source: "Inspected stopped process",
    },
    reason: "Confirmed stopped and checked runtime log",
    confirmed_stopped: true,
  });
  await client.recover();
  assert.equal(f.state.pendingBudget, undefined);
  assert.equal((await call(f.human, "budget_read")).quality.estimated, 1);
});
