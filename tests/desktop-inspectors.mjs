// Optional renderer integration checks alongside the native desktop journeys.
// Uses real React components and isolated read-only fixtures; never starts agents.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const directory = await mkdtemp(join(tmpdir(), "hb-inspector-ui-"));
const evidence = resolve("var/desktop/inspector-ui");
const session = `hb-inspectors-${process.pid}`;
const browser = async (...args) =>
  (
    await promisify(execFile)(
      "agent-browser",
      ["--session", session, ...args],
      { encoding: "utf8", timeout: 20000 },
    )
  ).stdout;
const evaluate = async (source) => JSON.parse(await browser("eval", source));
let server;
try {
  await mkdir(evidence, { recursive: true });
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
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const buttons = () =>
    evaluate(
      "[...document.querySelectorAll('button')].filter(b => b.checkVisibility()).map(b=>b.textContent.trim())",
    );
  const results = [];
  for (const scene of [
    "sign-in",
    "signing-in",
    "expired",
    "planning",
    "running",
    "budget",
    "budget-reserved",
    "budget-expired",
  ]) {
    await browser("open", `${origin}/?scene=${scene}`);
    await browser(
      "wait",
      "--fn",
      scene.startsWith("budget")
        ? "!!document.querySelector('.n-governance nav')"
        : "document.querySelector('.n-execution h3')?.textContent.trim() !== 'Unknown'",
    );
    if (scene === "sign-in")
      assert.equal(
        (await buttons()).filter((b) => b.startsWith("Sign in to")).length,
        1,
      );
    if (scene === "signing-in") {
      assert.ok((await buttons()).includes("Open provider sign-in"));
      assert.equal(
        (await buttons()).some((b) => b.startsWith("Sign in to")),
        false,
      );
    }
    if (scene === "expired") {
      assert.equal(
        (await buttons()).filter((b) => b === "Get a fresh sign-in").length,
        1,
      );
      assert.equal(
        (await buttons()).some(
          (b) => b.startsWith("Sign in to") || b === "Open provider sign-in",
        ),
        false,
      );
      assert.equal(
        await evaluate(
          "!!document.querySelector('input[value=\"EXPIRED-FIXTURE\"]')",
        ),
        false,
      );
    }
    if (scene === "planning")
      assert.ok((await buttons()).includes("Review planning session"));
    if (scene === "running") {
      assert.ok((await buttons()).includes("Stop environment"));
      await browser(
        "find",
        "role",
        "button",
        "click",
        "--name",
        "Technical",
        "--exact",
      );
      assert.ok(
        (await buttons()).includes("Stop environment"),
        "Stop remains reachable when inspecting details",
      );
    }
    if (scene === "budget") {
      assert.equal(
        await evaluate(
          "document.body.innerText.includes('No execution permissions issued.')",
        ),
        false,
      );
      await browser(
        "find",
        "role",
        "button",
        "click",
        "--name",
        "Technical",
        "--exact",
      );
      assert.equal(
        await evaluate(
          "document.body.innerText.includes('No execution permissions issued.')",
        ),
        true,
      );
    }
    if (scene === "budget-reserved" || scene === "budget-expired") {
      assert.equal(
        await evaluate(
          "document.body.innerText.includes('Contributor distant-co')",
        ),
        true,
        "Budget includes contributors absent from the current agent roster",
      );
      assert.equal(
        await evaluate(
          "document.body.innerText.includes('Execution needs reconciliation')",
        ),
        scene === "budget-expired",
        "A valid running reservation is not a recovery failure",
      );
    }
    assert.equal(
      await evaluate("document.documentElement.scrollWidth > innerWidth"),
      false,
    );
    await browser("screenshot", join(evidence, `${scene}.png`));
    results.push({ scene, passed: true });
  }
  await browser("set", "viewport", "390", "844");
  await browser("open", `${origin}/?scene=signing-in`);
  await browser("wait", "--text", "Open provider sign-in");
  assert.equal(
    await evaluate("document.documentElement.scrollWidth > innerWidth"),
    false,
  );
  await browser("screenshot", join(evidence, "sign-in-narrow.png"));
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        fixturesOnly: true,
        results,
        narrow: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "Eight inspector states and narrow sign-in passed. No native actions or providers used.",
  );
} finally {
  try {
    await browser("close");
  } catch {}
  if (server) await new Promise((r) => server.close(r));
  await rm(directory, { recursive: true, force: true });
}
