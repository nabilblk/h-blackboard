import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { DraftingService } from "../desktop/drafting/service.mjs";
import { DraftRequests } from "../desktop/drafting/contract.mjs";
import { briefFields, briefReadiness } from "../shared/mission-draft.mjs";
import { JsonLines, startProcess } from "../desktop/drafting/transport.mjs";
import {
  draftingEnvironment,
  claudeArguments,
  codexArguments,
  grokConfigurationIsClean,
  parseDraftReply,
} from "../desktop/drafting/runtime.mjs";

const answer = (patch = {}) => ({
  reply:
    "Here is a first brief. The team can investigate the remaining questions.",
  patch: { ...Object.fromEntries(briefFields.map((f) => [f, null])), ...patch },
  question: {
    text: "Who should use the result?",
    choices: ["Families", "Organizers"],
  },
  assessment: { ready: true, reason: "The outcome is clear enough to review." },
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
async function fixture(
  t,
  run = async () =>
    answer({
      name: "Festival",
      objective: "Design an accessible festival plan.",
    }),
) {
  const directory = await mkdtemp(join(tmpdir(), "hb-drafting-"));
  const calls = [],
    missions = [];
  let enrolled = false;
  const node = {
    state: async () => ({
      status: enrolled ? "ready" : "not_enrolled",
      identity: enrolled ? { owner: "a".repeat(64) } : null,
      missions,
    }),
    handle: async (method, input) => {
      calls.push({ method, input });
      if (method === "enroll") {
        enrolled = true;
        return {};
      }
      if (method !== "createMission")
        throw new Error("Unexpected mission capability");
      const id = (missions.length + 1).toString(16).padStart(64, "0");
      missions.push({
        id,
        owner: "a".repeat(64),
        definition: structuredClone(input.definition),
      });
      return { mission: id };
    },
  };
  const runtime = { run, list: async () => [] };
  const service = new DraftingService({ directory, runtime, node });
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  const draft = await service.current();
  return { service, draft, calls, missions, directory, runtime, node };
}
async function finish(service) {
  await service.active?.done;
  return service.current();
}

test("drafting: manual and assisted modes share a persisted private draft without node enrollment", async (t) => {
  const f = await fixture(t);
  f.service.edit({
    id: f.draft.id,
    changes: {
      idea: "A rough festival idea",
      composer: "Do not lose this",
      mode: "manual",
      runtime: "codex",
      objective: "Explore accessible routes",
      listInputs: { criteria: "An unfinished criterion" },
    },
  });
  f.service.edit({ id: f.draft.id, changes: { mode: "assisted" } });
  const reopened = new DraftingService(f).read();
  assert.equal(reopened.composer, "Do not lose this");
  assert.equal(reopened.brief.objective, "Explore accessible routes");
  assert.equal(reopened.runtime, "codex");
  assert.equal(reopened.listInputs.criteria, "An unfinished criterion");
  assert.deepEqual(f.calls, []);
  const info = await stat(
    join(f.directory, "00000000-0000-4000-8000-000000000001.json"),
  );
  assert.equal(info.mode & 0o777, 0o600);
});
test("drafting: saves the user's message before runtime startup, accepts a useful first draft", async (t) => {
  const pending = deferred();
  const f = await fixture(t, async ({ draft }) => {
    assert.equal(draft.messages.at(-1).text, "Plan a festival");
    return pending.promise;
  });
  await f.service.send({ id: f.draft.id, text: "Plan a festival" });
  assert.equal(f.service.read().messages[0].text, "Plan a festival");
  pending.resolve(
    answer({
      name: "Festival",
      objective: "Create an accessible festival plan",
      assumptions: ["Suggest 200 guests; not yet confirmed"],
    }),
  );
  const result = await finish(f.service);
  assert.equal(result.brief.name, "Festival");
  assert.equal(result.changes.length, 1);
  assert.equal(result.messages.length, 2);
  assert.deepEqual(f.calls, []);
});
test("drafting: human edits during inference survive; conflicting suggestions require an explicit choice", async (t) => {
  const pending = deferred(),
    f = await fixture(t, () => pending.promise);
  await f.service.send({ id: f.draft.id, text: "Plan it" });
  f.service.edit({
    id: f.draft.id,
    changes: { objective: "My more precise goal" },
  });
  pending.resolve(
    answer({ name: "Festival", objective: "The helper's alternative" }),
  );
  let result = await finish(f.service);
  assert.equal(result.brief.objective, "My more precise goal");
  assert.equal(result.brief.name, "Festival");
  assert.equal(result.conflicts[0].field, "objective");
  assert.throws(() => f.service.review({ id: result.id }), /suggested changes/);
  result = f.service.resolve({
    id: result.id,
    field: "objective",
    accept: false,
  });
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.brief.objective, "My more precise goal");
});
test("drafting: undo restores only fields untouched since the suggestion", async (t) => {
  const f = await fixture(t);
  await f.service.send({ id: f.draft.id, text: "Plan it" });
  const result = await finish(f.service);
  f.service.edit({ id: f.draft.id, changes: { name: "My own name" } });
  const undone = f.service.undo({
    id: f.draft.id,
    change: result.changes[0].id,
  });
  assert.equal(undone.brief.name, "My own name");
  assert.equal(undone.brief.objective, "");
});
test("drafting: malformed responses never corrupt a brief or acquire mission authority", async (t) => {
  const f = await fixture(t, async () => ({
    ...answer({ name: "Attacker" }),
    createMission: true,
  }));
  f.service.edit({ id: f.draft.id, changes: { name: "Keep me" } });
  await f.service.send({ id: f.draft.id, text: "Continue" });
  const result = await finish(f.service);
  assert.equal(result.status, "error");
  assert.equal(result.brief.name, "Keep me");
  assert.deepEqual(f.calls, []);
  for (const [method, input] of [
    ["edit", { id: f.draft.id, changes: { command: "sh" } }],
    [
      "create",
      {
        id: f.draft.id,
        review: f.draft.id,
        acknowledgeOpenDecisions: true,
        definition: {},
      },
    ],
  ])
    assert.throws(() => DraftRequests[method].parse(input));
});
test("drafting: stop, close and restart preserve work and ignore a late success", async (t) => {
  const f = await fixture(
    t,
    ({ signal }) =>
      new Promise((resolve) =>
        signal.addEventListener(
          "abort",
          () => resolve(answer({ name: "Must not apply" })),
          { once: true },
        ),
      ),
  );
  await f.service.send({
    id: f.draft.id,
    text: "Research transport alternatives",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const stopped = await f.service.stop({ id: f.draft.id });
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.brief.name, "");
  assert.equal(stopped.messages.length, 1);
  const d = f.service.read();
  d.status = "thinking";
  f.service.save(d);
  const recovered = new DraftingService(f).read();
  assert.equal(recovered.status, "stopped");
  assert.equal(recovered.messages.length, 1);
});
test("drafting: explicit review freezes exact shared content and leaves the transcript private", async (t) => {
  const f = await fixture(t);
  f.service.edit({
    id: f.draft.id,
    changes: {
      name: "Research",
      objective: "Compare transport options",
      deliverables: ["Evidence-backed report"],
      assumptions: ["Public sources only"],
      openQuestions: ["Ask the team to identify constraints"],
    },
  });
  const review = f.service.review({ id: f.draft.id });
  assert.match(
    review.definition.scope,
    /Working assumptions\n- Public sources only/,
  );
  await assert.rejects(
    f.service.create({
      id: f.draft.id,
      review: review.id,
      acknowledgeOpenDecisions: false,
    }),
    /Acknowledge/,
  );
  const created = await f.service.create({
    id: f.draft.id,
    review: review.id,
    acknowledgeOpenDecisions: true,
  });
  assert.deepEqual(
    f.calls.map((x) => x.method),
    ["enroll", "createMission"],
  );
  assert.deepEqual(f.calls[1].input.definition, review.definition);
  assert.equal(Object.hasOwn(f.calls[1].input, "messages"), false);
  assert.throws(
    () =>
      f.service.edit({
        id: created.id,
        changes: { objective: "Late mutation" },
      }),
    /frozen/,
  );
  assert.equal(
    (
      await f.service.create({
        id: f.draft.id,
        review: review.id,
        acknowledgeOpenDecisions: true,
      })
    ).mission,
    created.mission,
  );
  assert.equal(f.calls.filter((x) => x.method === "createMission").length, 1);
});
test("drafting: changed brief invalidates review and concurrent creation is not duplicated", async (t) => {
  const f = await fixture(t);
  f.service.edit({
    id: f.draft.id,
    changes: { name: "Study", objective: "Explore feasible approaches" },
  });
  let review = f.service.review({ id: f.draft.id });
  f.service.edit({ id: f.draft.id, changes: { scope: "Use public evidence" } });
  await assert.rejects(
    f.service.create({
      id: f.draft.id,
      review: review.id,
      acknowledgeOpenDecisions: true,
    }),
    /Review it again/,
  );
  review = f.service.review({ id: f.draft.id });
  const pending = deferred(),
    original = f.node.handle;
  f.node.handle = async (...args) => {
    if (args[0] === "createMission") await pending.promise;
    return original(...args);
  };
  const request = {
    id: f.draft.id,
    review: review.id,
    acknowledgeOpenDecisions: true,
  };
  const creating = f.service.create(request);
  await assert.rejects(f.service.create(request), /already in progress/);
  pending.resolve();
  await creating;
  assert.equal(f.missions.length, 1);
});
test("drafting: uncertain creation reconciles the native record after restart without another create", async (t) => {
  const f = await fixture(t);
  f.service.edit({
    id: f.draft.id,
    changes: { name: "Study", objective: "Explore options" },
  });
  const review = f.service.review({ id: f.draft.id }),
    original = f.node.handle;
  f.node.handle = async (...args) => {
    const result = await original(...args);
    if (args[0] === "createMission") {
      // Native serialization is free to use a different property order.
      f.missions[0].definition = Object.fromEntries(
        Object.entries(f.missions[0].definition).reverse(),
      );
      throw new Error("lost response");
    }
    return result;
  };
  await assert.rejects(
    f.service.create({
      id: f.draft.id,
      review: review.id,
      acknowledgeOpenDecisions: true,
    }),
    /uncertain/,
  );
  const recovered = new DraftingService(f);
  const current = await recovered.current();
  assert.equal(current.status, "created");
  assert.equal(current.mission, f.missions[0].id);
  assert.equal(f.missions.length, 1);
});
test("drafting: unfinished list entries survive restart and are included once in exact review", async (t) => {
  const f = await fixture(t);
  f.service.edit({
    id: f.draft.id,
    changes: {
      name: "Science fair",
      objective: "Design an accessible science fair",
      listInputs: {
        criteria: "Activities include accessibility guidance",
        deliverables: "An organizer guide",
      },
    },
  });
  const restored = new DraftingService(f);
  const reviewed = restored.review({ id: f.draft.id });
  assert.deepEqual(reviewed.definition.criteria, [
    "Activities include accessibility guidance",
  ]);
  assert.match(reviewed.definition.scope, /An organizer guide/);
  assert.equal(restored.read().listInputs.criteria, "");
  assert.deepEqual(
    restored.review({ id: f.draft.id }).definition,
    reviewed.definition,
  );
});
test("drafting: a damaged private journal does not prevent application startup or replace saved data", async (t) => {
  const f = await fixture(t);
  const file = join(f.directory, "00000000-0000-4000-8000-000000000001.json");
  const damaged = '{"draft": "incomplete';
  await writeFile(file, damaged);
  const restored = new DraftingService(f);
  await assert.rejects(
    restored.current(),
    /preserved.*existing missions remain available/,
  );
  assert.equal(await readFile(file, "utf8"), damaged);
  assert.deepEqual(f.calls, []);
});
test("drafting: exploratory briefs do not require invented tasks, criteria, or workforce", async (t) => {
  const f = await fixture(t);
  const result = f.service.edit({
    id: f.draft.id,
    changes: {
      name: "Explore",
      objective: "Investigate which approaches deserve a deeper experiment.",
    },
  });
  assert.equal(briefReadiness(result.brief, result.policy).valid, true);
  assert.ok(briefReadiness(result.brief, result.policy).suggestions.length);
  const review = f.service.review({ id: result.id });
  assert.deepEqual(review.definition.criteria, []);
});
test("drafting: restricted launch profiles strip inherited secrets and integrations", () => {
  const env = draftingEnvironment("/tmp/example");
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "XAI_API_KEY",
    "NODE_OPTIONS",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GROK_CONFIG",
  ])
    assert.equal(Object.hasOwn(env, key), false);
  const claude = claudeArguments();
  assert.ok(claude.includes("--safe-mode"));
  assert.ok(claude.includes("--restricted"));
  assert.equal(claude[claude.indexOf("--tools") + 1], "");
  const codex = codexArguments();
  assert.ok(codex.includes("mcp_servers={}"));
  assert.ok(codex.includes("features.hooks=false"));
  assert.ok(codex.includes("features.shell_tool=false"));
  const clean = {
    hooks: [],
    plugins: [],
    mcpServers: [],
    lspServers: [],
    projectInstructions: [],
  };
  assert.equal(grokConfigurationIsClean(clean), true);
  for (const key of Object.keys(clean))
    assert.equal(grokConfigurationIsClean({ ...clean, [key]: [{}] }), false);
  assert.equal(grokConfigurationIsClean({}), false);
});
test("drafting: RPC refuses all approval/tool requests before returning output", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  let stopped = false;
  child.stop = () => {
    stopped = true;
  };
  const wire = new JsonLines(child);
  const reply = wire.request("turn/start", {});
  child.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 91,
      method: "item/commandExecution/requestApproval",
      params: {},
    }) + "\n",
  );
  await assert.rejects(reply, /no tools|requested a tool/);
  assert.equal(stopped, true);
  assert.throws(() => parseDraftReply('{"reply":"hi"}'), /invalid brief/);
});
test(
  "drafting: cancellation terminates descendants even when the process leader exits first",
  { skip: process.platform === "win32", timeout: 5000 },
  async (t) => {
    const controller = new AbortController();
    const child = startProcess(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { spawn } from 'node:child_process';
    const worker = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    worker.stdout.once('data', () => process.stdout.write(String(worker.pid) + '\\n'));
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  `,
      ],
      { cwd: tmpdir(), env: draftingEnvironment(), signal: controller.signal },
    );
    t.after(() => child.stop());
    child.stderr.resume();
    const [output] = await once(child.stdout, "data");
    const descendant = Number(String(output).trim());
    assert.ok(Number.isInteger(descendant) && descendant > 1);
    const closed = once(child, "close");
    controller.abort();
    await closed;
    let alive = true;
    for (let attempt = 0; attempt < 100 && alive; attempt++) {
      try {
        process.kill(descendant, 0);
      } catch (e) {
        if (e.code === "ESRCH") alive = false;
        else throw e;
      }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(alive, false, "no descendant remains after cancellation");
  },
);
