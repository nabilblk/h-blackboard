// Real React + draft service. The provider alone is deterministic; no paid
// calls, node identity or real workspace records are involved.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { DraftingService } from "../desktop/drafting/service.mjs";
import { briefFields } from "../shared/mission-draft.mjs";

const directory = await mkdtemp(join(tmpdir(), "hb-drafting-ui-"));
const evidence = resolve("var/desktop/mission-drafting-ui");
const session = `hb-drafting-ui-${process.pid}`;
const browser = async (...args) =>
  (
    await promisify(execFile)(
      "agent-browser",
      ["--session", session, ...args],
      { encoding: "utf8", timeout: 20000 },
    )
  ).stdout;
const evaluate = async (source) => JSON.parse(await browser("eval", source));
const click = async (selector) => {
  await browser("scrollintoview", selector);
  await browser("click", selector);
};
let service, server, pending;
const calls = [],
  missions = [];
const reply = (patch) => ({
  reply:
    "Here is a first brief. Your newer edits take priority. The team can investigate unresolved choices.",
  patch: { ...Object.fromEntries(briefFields.map((f) => [f, null])), ...patch },
  question: {
    text: "Which age range should the fair serve?",
    choices: ["Ages 6–12", "Mixed ages"],
  },
  assessment: {
    ready: true,
    reason: "The goal is clear; open decisions can stay with the team.",
  },
});
try {
  await mkdir(evidence, { recursive: true });
  service = new DraftingService({
    directory: join(directory, "journal"),
    runtime: {
      list: async () =>
        ["claude", "codex", "grok"].map((runtime) => ({
          runtime,
          label: runtime,
          available: true,
          version: "fixture",
          privateLogin: false,
          login: null,
          detail: "Isolated test provider",
        })),
      run: ({ signal }) =>
        new Promise((resolve, reject) => {
          pending = resolve;
          signal.addEventListener("abort", () => reject(new Error("Stopped")), {
            once: true,
          });
        }),
    },
    node: {
      state: async () => ({
        status: "ready",
        identity: { owner: "a".repeat(64) },
        missions,
      }),
      handle: async (method, input) => {
        assert.equal(method, "createMission");
        calls.push(input);
        const mission = "1".repeat(64);
        missions.push({ id: mission, definition: input.definition });
        return { mission };
      },
    },
  });
  await build({
    entryPoints: ["tests/fixtures/mission-drafting.jsx"],
    bundle: true,
    format: "esm",
    jsx: "automatic",
    outdir: directory,
    loader: { ".woff2": "file", ".woff": "file", ".svg": "dataurl" },
  });
  server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (req.method === "POST" && path.startsWith("/draft/")) {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 65536) throw new Error("Too large");
        }
        try {
          res.end(
            JSON.stringify({
              ok: true,
              value: await service.handle(
                path.slice(7),
                JSON.parse(body || "{}"),
              ),
            }),
          );
        } catch (error) {
          res.end(JSON.stringify({ ok: false, error: error.message }));
        }
      } else if (path === "/") {
        res.setHeader("Content-Type", "text/html");
        res.end(
          '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/mission-drafting.css"></head><body><div id="root"></div><script type="module" src="/mission-drafting.js"></script></body></html>',
        );
      } else {
        res.setHeader(
          "Content-Type",
          path.endsWith(".js")
            ? "text/javascript"
            : path.endsWith(".css")
              ? "text/css"
              : "font/woff2",
        );
        res.end(await readFile(join(directory, basename(path))));
      }
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  await browser("open", `http://127.0.0.1:${server.address().port}`);
  await browser("set", "viewport", "1280", "900");
  await browser("wait", '[aria-label="Your idea"]');
  await browser(
    "fill",
    '[aria-label="Your idea"]',
    "Plan a community science fair for families. Deliver a schedule and an organizer guide.",
  );
  await click(".md-entry-actions .primary");
  await browser("wait", ".md-conversation");
  await browser(
    "fill",
    '[name="objective"]',
    "My more precise goal: a one-day fair with accessible activities.",
  );
  await browser(
    "wait",
    "--fn",
    '!document.querySelector(".d-heading")?.textContent.includes("Saving")',
  );
  pending(
    reply({
      name: "Science fair",
      objective: "An older suggestion",
      scope: "A short initial scope.",
    }),
  );
  await browser("wait", ".md-conflict");
  assert.equal(
    await evaluate('document.querySelector("[name=objective]").value'),
    "My more precise goal: a one-day fair with accessible activities.",
  );
  assert.equal(calls.length, 0);
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Keep mine",
    "--exact",
  );
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Undo suggestion",
    "--exact",
  );
  await browser(
    "wait",
    "--fn",
    'document.querySelector("[name=name]").value === ""',
  );
  assert.match(
    await evaluate('document.querySelector("[name=objective]").value'),
    /My more precise goal/,
  );
  await browser("fill", '[name="name"]', "Human science fair");
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Write it myself",
    "--exact",
  );
  assert.equal(
    await evaluate('document.querySelector("[name=name]").value'),
    "Human science fair",
  );
  await click(".md-back");
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Reopen draft",
    "--exact",
  );
  await browser("wait", '[name="name"]');
  assert.equal(
    await evaluate('document.querySelector("[name=name]").value'),
    "Human science fair",
  );
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "With my agent",
    "--exact",
  );
  await browser(
    "fill",
    '[aria-label="Message your drafting helper"]',
    "Keep the current goal. Add deliverables and leave venue choice for the team.",
  );
  await click(".md-composer .primary");
  await browser(
    "wait",
    "--fn",
    'document.querySelector(".md-composer .primary").disabled',
  );
  pending(
    reply({
      scope: "Plan the event; do not book venues or spend money.",
      deliverables: ["A usable one-day schedule", "A short organizer guide"],
      criteria: ["Every activity includes materials and safety guidance."],
      assumptions: ["Proposed format: one venue"],
      openQuestions: ["Research the venue options."],
    }),
  );
  await browser(
    "wait",
    "--fn",
    `document.querySelector('[aria-label="Deliverables 1"]')?.value === "A usable one-day schedule"`,
  );
  await browser("screenshot", join(evidence, "assisted.png"));
  for (const selector of [
    ".md-composer .primary",
    ".md-brief > .md-actions .primary",
  ])
    assert.equal(
      await evaluate(
        `document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().bottom <= innerHeight`,
      ),
      true,
      `${selector} stays visible`,
    );
  assert.equal(
    await evaluate("document.documentElement.scrollWidth > innerWidth"),
    false,
  );
  await browser("reload");
  await browser("wait", '[name="name"]');
  assert.equal(
    await evaluate('document.querySelector("[name=name]").value'),
    "Human science fair",
  );
  assert.equal(
    await evaluate('document.querySelectorAll(".md-message").length'),
    4,
  );
  await browser("set", "viewport", "900", "760");
  await browser("screenshot", join(evidence, "compact.png"));
  assert.equal(
    await evaluate(
      'document.querySelector(".md-composer .primary").getBoundingClientRect().bottom <= innerHeight',
    ),
    true,
  );
  assert.equal(
    await evaluate("document.documentElement.scrollWidth > innerWidth"),
    false,
  );
  await click(".md-brief > .md-actions .primary");
  await browser("wait", ".md-review");
  assert.equal(
    await evaluate('document.querySelector(".md-review .primary").disabled'),
    true,
  );
  assert.equal(await evaluate("document.activeElement.tagName"), "H2");
  await click(".md-acknowledgment input");
  const definition = structuredClone(service.read().review.definition);
  await browser("screenshot", join(evidence, "review.png"));
  await click(".md-review > .md-actions .primary");
  await browser("wait", "--text", "Mission created in Preparing");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].definition, definition);
  assert.match(definition.scope, /Working assumptions/);
  assert.match(definition.scope, /Questions for the team/);
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        passed: true,
        checks: [
          "first draft",
          "late reply conflict",
          "human edit preserved",
          "undo",
          "mode switching",
          "navigation recovery",
          "restart recovery",
          "compact layout",
          "explicit assumption review",
          "exact creation snapshot",
          "no auto-start",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "Assisted drafting UI: conflict, undo, mode switching, navigation/reload recovery, compact layout and reviewed creation passed.",
  );
} catch (error) {
  try {
    await browser("screenshot", join(evidence, "failure.png"));
    console.error(await browser("snapshot", "-i"));
  } catch {}
  throw error;
} finally {
  await service?.close();
  try {
    await browser("close");
  } catch {}
  if (server) await new Promise((done) => server.close(done));
  await rm(directory, { recursive: true, force: true });
}
