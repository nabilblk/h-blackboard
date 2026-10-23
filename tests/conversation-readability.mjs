// Real components, isolated renderer, no mission state or account access.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
const directory = await mkdtemp(join(tmpdir(), "hb-conversation-"));
const evidence = resolve("var/iterations/agent-experience-2026-10-11");
const session = `hb-readability-${process.pid}`;
const browser = async (...args) =>
  (
    await promisify(execFile)(
      "agent-browser",
      ["--session", session, ...args],
      { timeout: 20000 },
    )
  ).stdout;
const evaluate = async (code) => JSON.parse(await browser("eval", code));
let server;
try {
  await mkdir(evidence, { recursive: true });
  await build({
    entryPoints: ["tests/fixtures/conversation-readability.jsx"],
    bundle: true,
    format: "esm",
    jsx: "automatic",
    outdir: directory,
    loader: { ".woff2": "file", ".woff": "file", ".svg": "dataurl" },
  });
  server = createServer(async (req, res) => {
    try {
      const file = basename(new URL(req.url, "http://localhost").pathname);
      if (!file) {
        res.setHeader("Content-Type", "text/html");
        res.end(
          '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/conversation-readability.css"><div id="root"></div><script type="module" src="/conversation-readability.js"></script>',
        );
      } else {
        res.setHeader(
          "Content-Type",
          file.endsWith(".js")
            ? "text/javascript"
            : file.endsWith(".css")
              ? "text/css"
              : "font/woff2",
        );
        res.end(await readFile(join(directory, file)));
      }
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  await browser("open", `http://127.0.0.1:${server.address().port}`);
  await browser("wait", ".markdown-reference");
  assert.equal(
    await evaluate("document.querySelector('.n-message-role').innerText"),
    "Coordinator",
  );
  assert.equal(
    await evaluate("document.querySelector('.n-avatar').innerText"),
    "GR",
  );
  assert.equal(
    await evaluate("document.querySelectorAll('a[href^=javascript]').length"),
    0,
  );
  await browser("focus", ".markdown-reference");
  await browser("press", "Enter");
  assert.deepEqual(await evaluate("window.calls[0]"), {
    kind: "artifact",
    id: "a".repeat(64),
  });
  const visible = await evaluate(
    "document.querySelector('.n-message-text').innerText",
  );
  assert.ok(!visible.includes("a".repeat(64)));
  assert.ok(!visible.includes("b".repeat(64)));
  await browser("click", "summary");
  assert.ok(
    (
      await evaluate("document.querySelector('.n-message-source').innerText")
    ).includes("a".repeat(64)),
  );
  await browser("click", "summary");
  for (const width of [1280, 390]) {
    await browser("set", "viewport", String(width), "900");
    assert.ok(
      await evaluate("document.documentElement.scrollWidth <= innerWidth"),
    );
    await browser("screenshot", join(evidence, `conversation-${width}.png`));
  }
  console.log(
    "Conversation references, exact source, role, keyboard activation, URL safety and narrow layout passed.",
  );
} finally {
  await browser("close").catch(() => {});
  await new Promise((r) => (server ? server.close(r) : r()));
  await rm(directory, { recursive: true, force: true });
}
