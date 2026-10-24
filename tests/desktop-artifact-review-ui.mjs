// Focused real React form regression. Temporary renderer only; no live profiles.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const directory = await mkdtemp(join(tmpdir(), "hb-review-ui-"));
const session = `hb-review-${process.pid}`;
const browser = async (...args) =>
  (
    await promisify(execFile)(
      "agent-browser",
      ["--session", session, ...args],
      {
        encoding: "utf8",
        timeout: 20000,
      },
    )
  ).stdout;
const evaluate = async (source) => JSON.parse(await browser("eval", source));
const click = (name) =>
  browser("find", "role", "button", "click", "--name", name, "--exact");
let server;
try {
  await build({
    entryPoints: ["tests/fixtures/desktop-inspectors.jsx"],
    bundle: true,
    format: "esm",
    jsx: "automatic",
    outdir: directory,
    loader: { ".woff2": "file", ".woff": "file", ".svg": "dataurl" },
  });
  server = createServer(async (request, response) => {
    try {
      const file = basename(new URL(request.url, "http://localhost").pathname);
      if (!file) {
        response.setHeader("Content-Type", "text/html");
        response.end(
          '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/desktop-inspectors.css"></head><body><div id="root"></div><script type="module" src="/desktop-inspectors.js"></script></body></html>',
        );
      } else {
        response.setHeader(
          "Content-Type",
          file.endsWith(".js")
            ? "text/javascript"
            : file.endsWith(".css")
              ? "text/css"
              : "font/woff2",
        );
        response.end(await readFile(join(directory, file)));
      }
    } catch {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await browser(
    "open",
    `http://127.0.0.1:${server.address().port}/?scene=coordination-artifacts`,
  );
  await browser("set", "viewport", "390", "900");
  await browser("wait", ".n-artifact-candidate");
  await click("Review details");
  await browser("wait", "--text", "Add review");
  await click("Add review");
  await browser("select", 'select[name="verdict"]', "changes_requested");
  await browser("select", 'select[name="check_browser_check"]', "passed");
  await browser("select", 'select[name="check_visual_inspection"]', "failed");
  const fields = {
    summary: "Selected controls worked; the complete-loop drawing has gaps.",
    conditions: "Selected paths only. No source inspection or automated tests.",
    details_browser_check:
      "Fixture preview on this Mac; all selected controls responded.",
    details_visual_inspection:
      "Fixture preview; visible gaps contradict the caption.",
    evidence:
      "Owner artifact-preview observations and screenshot circuit-gap.png.",
  };
  for (const [name, value] of Object.entries(fields))
    await browser("fill", `textarea[name="${name}"]`, value);
  const form = () =>
    evaluate(
      "Object.fromEntries(new FormData(document.querySelector('.n-artifact-reviews form')))",
    );
  const before = await form();
  assert.equal(before.check_source_inspection, "not_run");
  assert.equal(before.check_executed_tests, "not_run");
  assert.equal(before.details_source_inspection, undefined);
  await click("Save review");
  await browser("wait", '.n-artifact-reviews [role="alert"]');
  assert.match(
    await browser("get", "text", '.n-artifact-reviews [role="alert"]'),
    /Move descriptions, filenames and screenshot notes/,
  );
  assert.deepEqual(
    await form(),
    before,
    "Validation preserves every review field",
  );
  assert.equal(await evaluate("document.activeElement.name"), "evidence");
  assert.equal(
    await evaluate(
      "document.querySelector('textarea[name=evidence]').getAttribute('aria-invalid')",
    ),
    "true",
  );
  assert.deepEqual(
    await evaluate(
      "window.coordinationFixture.calls.filter(c=>c.type==='action')",
    ),
    [],
  );
  const message = "a".repeat(64),
    revision = "b".repeat(64);
  await browser(
    "fill",
    'textarea[name="evidence"]',
    `[Message](harakiri://message/${message})\n[Observed revision](harakiri://artifact/${revision})`,
  );
  await click("Save review");
  await browser(
    "wait",
    "--fn",
    "window.coordinationFixture.calls.some(c=>c.type==='action')",
  );
  const [saved] = await evaluate(
    "window.coordinationFixture.calls.filter(c=>c.type==='action')",
  );
  assert.deepEqual(saved.action.evidence, [message, revision]);
  assert.equal(saved.action.summary, fields.summary);
  assert.equal(saved.action.conditions, fields.conditions);
  assert.equal(saved.action.verdict, "changes_requested");
  assert.deepEqual(
    saved.action.checks.map((check) => check.result),
    ["not_run", "not_run", "passed", "failed"],
  );
  assert.equal(saved.action.checks[0].details, "Not checked in this review.");
  assert.equal(saved.action.checks[2].details, fields.details_browser_check);
  assert.equal(
    saved.action.checks[3].details,
    fields.details_visual_inspection,
  );
  assert.equal(
    await evaluate("!!document.querySelector('.n-artifact-reviews form')"),
    false,
  );
  assert.equal(
    await evaluate("document.documentElement.scrollWidth > innerWidth"),
    false,
  );
  console.log(
    "Artifact review form: invalid prose retained with field error; copied links and honest mixed checks saved.",
  );
} finally {
  await browser("close").catch(() => {});
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
