// Real components, isolated renderer, no mission state or account access.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
const directory = await mkdtemp(join(tmpdir(), "hb-continuity-"));
const evidence = resolve("var/iterations/dependable-collaboration-2026-10-23");
const session = `hb-continuity-${process.pid}`;
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
    entryPoints: ["tests/fixtures/continuity-ui.jsx"],
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
          '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/continuity-ui.css"><div id="root"></div><script type="module" src="/continuity-ui.js"></script>',
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
  await browser("wait", ".n-message");
  assert.equal(
    await evaluate("document.querySelectorAll('.n-message').length"),
    200,
  );
  assert.equal(
    await evaluate("document.querySelector('textarea').value"),
    "Keep this draft",
  );
  await browser("select", 'select[aria-label="Message text size"]', "large");
  assert.equal(
    await evaluate("localStorage.getItem('harakiri.reading-size')"),
    "large",
  );
  await browser("scrollintoview", ".n-messages > button:not(.n-new-messages)");
  await browser("find", "text", "Load earlier messages", "click", "--exact");
  await browser("wait", "--text", "Finding 1:");
  assert.ok(
    await evaluate(
      "document.querySelector('.n-messages').innerText.includes('Finding 1:')",
    ),
  );
  await evaluate("window.addMessage()");
  await browser("wait", "--text", "new message");
  assert.ok(
    await evaluate(
      "document.querySelector('.n-messages').innerText.includes('Finding 1:')",
    ),
  );
  assert.equal(
    await evaluate("document.querySelector('textarea').value"),
    "Keep this draft",
  );
  await browser("find", "text", "Back to latest", "click", "--exact");
  await browser("wait", "--text", "A new result is ready.");
  await browser("screenshot", join(evidence, "conversation-window.png"));
  await browser("open", `${origin}/?scene=recovery`);
  await browser("wait", "--text", "Source checkpoint saved");
  await browser(
    "find",
    "text",
    "Recover source or inspect exclusions",
    "click",
    "--exact",
  );
  await browser(
    "find",
    "text",
    "Restore source into a new folder",
    "click",
    "--exact",
  );
  await browser(
    "wait",
    "--text",
    "The next agent briefing will identify this folder.",
  );
  await browser("find", "text", "Recent operations · 1", "click", "--exact");
  await browser("scrollintoview", ".n-execution-log button");
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Cancel transfer",
    "--exact",
  );
  await browser("scrollintoview", "main > details > summary");
  await browser("find", "text", "Protect this node", "click", "--exact");
  await browser(
    "find",
    "label",
    "Recovery passphrase",
    "fill",
    "a long unique test passphrase",
  );
  await browser(
    "find",
    "label",
    "Confirm passphrase",
    "fill",
    "a long unique test passphrase",
  );
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Save protected recovery file",
    "--exact",
  );
  await browser("wait", "--text", "Protected recovery file saved.");
  assert.deepEqual(await evaluate("window.calls"), [
    "restore",
    "cancel",
    "backup",
  ]);
  assert.ok(
    await evaluate(
      "[...document.querySelectorAll('input[type=password]')].every(i=>i.value==='')",
    ),
  );
  for (const width of [1280, 390]) {
    await browser("set", "viewport", String(width), "900");
    assert.ok(
      await evaluate("document.documentElement.scrollWidth<=innerWidth"),
    );
    await browser("screenshot", join(evidence, `recovery-${width}.png`));
  }
  await browser("set", "viewport", "1440", "1000");
  await browser("open", `${origin}/?scene=workspace`);
  await browser("wait", ".n-message");
  await browser(
    "wait",
    "--fn",
    "Object.keys(localStorage).some(k=>k.startsWith('harakiri.catch-up.v1:'))",
  );
  await browser(
    "scrollintoview",
    ".n-message:last-child .n-message-actions button",
  );
  await browser("find", "last", ".n-message-actions button", "click");
  await browser("wait", "#thread-message");
  await browser("fill", "#thread-message", "Keep this thread draft too");
  await evaluate("window.addMessage()");
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Catch up",
    "--exact",
  );
  await browser("wait", ".n-catch-up");
  await browser("wait", ".n-catch-up-list button");
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Open in conversation",
    "--exact",
  );
  await browser("wait", ".n-context-banner");
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Back in workspace",
    "--exact",
  );
  await browser("wait", ".n-catch-up");
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Back in workspace",
    "--exact",
  );
  await browser("wait", "#thread-message");
  assert.equal(
    await evaluate("document.querySelector('#thread-message').value"),
    "Keep this thread draft too",
  );
  assert.equal(
    await evaluate("document.querySelector('#main-message').value"),
    "Keep this draft",
  );
  await browser("press", "Alt+ArrowRight");
  await browser("wait", ".n-catch-up");
  await browser("screenshot", join(evidence, "workspace-catch-up.png"));
  console.log(
    "Conversation window, reading preference, draft retention, source restore, cancellation, protected recovery and responsive layouts passed.",
  );
  console.log(
    "Workspace catch-up sources, thread/inspector Back and Forward, keyboard navigation and preserved drafts passed.",
  );
} finally {
  await browser("close").catch(() => {});
  await new Promise((r) => (server ? server.close(r) : r()));
  await rm(directory, { recursive: true, force: true });
}
