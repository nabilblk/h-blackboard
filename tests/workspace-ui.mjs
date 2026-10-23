// Real components, isolated renderer, no mission state or account access.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
const directory = await mkdtemp(join(tmpdir(), "hb-workspace-"));
const evidence = resolve("var/iterations/frontend-v2-2026-10-23");
const session = `hb-workspace-${process.pid}`;
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
    entryPoints: ["tests/fixtures/workspace-ui.jsx"],
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
          '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/workspace-ui.css"><div id="root"></div><script type="module" src="/workspace-ui.js"></script>',
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
  const origin = `http://127.0.0.1:${server.address().port}`;
  await browser("open", origin);
  await browser("set", "viewport", "1440", "960");
  await browser("wait", "--text", "Pick up where you left off.");
  assert.equal(
    await evaluate("document.documentElement.dataset.theme"),
    "light",
  );
  await browser("screenshot", join(evidence, "connected-home.png"));
  await browser("click", '.w-mission-link[title="Science festival"]');
  await browser("wait", ".n-message");
  await browser("fill", ".n-composer textarea", "Keep my mission draft");
  await browser("find", "role", "button", "click", "--name", "Work", "--exact");
  await browser("wait", ".w-surface");
  assert.equal(
    await evaluate("document.querySelector('dialog[open]') === null"),
    true,
  );
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Conversation",
    "--exact",
  );
  assert.equal(
    await evaluate("document.querySelector('.n-composer textarea').value"),
    "Keep my mission draft",
  );
  await browser("scrollintoview", '.w-mission-link[title="Community garden"]');
  await browser("click", '.w-mission-link[title="Community garden"]');
  await browser(
    "wait",
    "--fn",
    "document.querySelector('.n-mission-title').textContent.includes('Community garden')",
  );
  await browser("fill", ".n-composer textarea", "A different mission draft");
  await browser("click", '.w-mission-link[title="Science festival"]');
  await browser(
    "wait",
    "--fn",
    "document.querySelector('.n-composer textarea')?.value === 'Keep my mission draft'",
  );
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Reply in thread",
    "--exact",
  );
  await browser("wait", "--text", "Thread");
  assert.equal(
    await evaluate("document.querySelectorAll('.w-surface').length"),
    1,
  );
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Close Thread",
    "--exact",
  );
  await browser("select", 'select[aria-label="Message text size"]', "large");
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('.n-message .reading')).fontSize",
    ),
    "16px",
  );
  await browser("select", 'select[aria-label="Message text size"]', "standard");
  await browser("screenshot", join(evidence, "connected-main.png"));
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Use dark theme",
    "--exact",
  );
  await browser("screenshot", join(evidence, "connected-dark.png"));
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Use light theme",
    "--exact",
  );
  await browser(
    "click",
    'nav[aria-label="Your workspace"] button:nth-child(2)',
  );
  await browser("wait", ".w-inbox-item");
  await browser("click", ".w-inbox-item:first-child");
  await browser("wait", "--text", "Viewing earlier conversation");
  await browser("click", ".w-search-trigger");
  await browser(
    "fill",
    'input[aria-label="Find a mission or action"]',
    "Garden",
  );
  await browser("click", ".w-command-results button:first-child");
  await browser(
    "wait",
    "--fn",
    "document.querySelector('.n-mission-title').textContent.includes('Community garden')",
  );
  await browser("set", "viewport", "390", "844");
  await browser("screenshot", join(evidence, "connected-mobile.png"));
  assert.equal(
    await evaluate("document.documentElement.scrollWidth <= innerWidth"),
    true,
  );
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Toggle navigation",
    "--exact",
  );
  await browser("find", "role", "button", "click", "--name", "Home", "--exact");
  await browser("wait", "--text", "Pick up where you left off.");
  assert.equal(
    await evaluate("document.querySelector('.w-nav-open') === null"),
    true,
  );
  await browser("open", `${origin}/?empty`);
  await evaluate(
    "localStorage.removeItem('harakiri.last-view.v1'); location.reload()",
  );
  await browser("wait", "--text", "Big ideas. Shared effort.");
  await browser("screenshot", join(evidence, "connected-empty.png"));
  assert.equal(
    await evaluate(
      "window.calls.some(c => /start|prepare|approve/.test(c[0]))",
    ),
    false,
  );
  console.log(
    "Workspace journeys passed: missions, inbox, conversation, draft continuity, search, appearance, mobile and empty state.",
  );
} catch (error) {
  console.error(await browser("snapshot").catch(String));
  console.error(await browser("errors").catch(String));
  throw error;
} finally {
  await browser("close").catch(() => {});
  await new Promise((r) => (server ? server.close(r) : r()));
  await rm(directory, { recursive: true, force: true });
}
