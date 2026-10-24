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
  await browser("find", "role", "button", "click", "--name", "More", "--exact");
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Add my agents",
    "--exact",
  );
  await browser("wait", ".n-guided-setup");
  await browser("click", 'input[type="radio"][value="claude"]');
  await browser("select", 'select[name="networkAccess"]', "internet");
  await browser("fill", '.n-guided-setup input[type="number"]', "2");
  assert.equal(
    await evaluate("window.calls.some(c => c[0] === 'prepare')"),
    false,
  );
  await browser("check", ".n-guided-setup .n-check input");
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Prepare agents",
    "--exact",
  );
  await browser("wait", "--fn", "window.calls.some(c => c[0] === 'prepare')");
  const request = await evaluate("window.calls.find(c=>c[0] === 'prepare')[1]");
  assert.equal(request.runtime, "claude");
  assert.equal(request.count, 2);
  assert.equal(request.networkAccess, "internet");
  assert.equal(request.role, "agent");
  assert.equal(await evaluate("window.calls.some(c=>c[0] === 'start')"), false);
  await browser("screenshot", join(evidence, "connected-setup.png"));
  await browser("press", "Escape");
  assert.equal(
    await evaluate(
      "document.querySelector('.w-mission-tabs button').checkVisibility()",
    ),
    true,
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
  assert.equal(await evaluate("document.getElementById('main').inert"), true);
  await browser("press", "Escape");
  assert.equal(await evaluate("document.getElementById('main').inert"), false);
  assert.equal(
    await evaluate("document.activeElement.getAttribute('aria-label')"),
    "Toggle navigation",
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
  await browser("press", "Control+k");
  await browser("wait", "dialog[open]");
  assert.equal(await evaluate("document.getElementById('main').inert"), false);
  assert.equal(
    await evaluate("!!document.querySelector('.w-nav-open')"),
    false,
  );
  await browser("press", "Escape");
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
  await browser("set", "viewport", "1440", "960");
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Join with an invitation",
    "--exact",
  );
  await browser("fill", ".n-join input", "harakiri://join/fixture");
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Connect and review",
    "--exact",
  );
  await browser("wait", "--text", "Shared workshop");
  assert.equal(await evaluate("window.calls.some(c=>c[0] === 'join')"), false);
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Request to join",
    "--exact",
  );
  await browser(
    "wait",
    "--text",
    "Request sent. Waiting for the mission owner",
  );
  await browser("find", "text", "Verify your join request", "click", "--exact");
  const verification = 'input[aria-label="Your verification key"]';
  assert.deepEqual(
    await evaluate(
      `(()=>{const input=document.querySelector('${verification}');return {value:input.value,readOnly:input.readOnly}})()`,
    ),
    { value: (2).toString(16).padStart(64, "0"), readOnly: true },
  );
  await browser("screenshot", join(evidence, "connected-join.png"));
  await browser("find", "role", "button", "click", "--name", "Home", "--exact");
  await browser("wait", "--text", "Join requests");
  assert.equal(
    await evaluate(`document.querySelector('${verification}')?.value`),
    (2).toString(16).padStart(64, "0"),
  );
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Withdraw request",
    "--exact",
  );
  await browser("open", `${origin}/?agents`);
  await browser("wait", ".w-sidebar");
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "My agents",
    "--exact",
  );
  await browser("wait", "--text", "Executing the approved work.");
  await browser("screenshot", join(evidence, "connected-agents.png"));
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Stop all 2 agents",
    "--exact",
  );
  await browser("wait", "--text", "Stop remains unconfirmed");
  assert.equal(
    await evaluate("window.calls.filter(c=>c[0] === 'stop').length"),
    2,
  );
  assert.ok(
    await evaluate(
      "document.querySelector('.w-agent-list').textContent.includes('Unknown')",
    ),
  );
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Settings",
    "--exact",
  );
  await browser("wait", "--text", "How people see you");
  await browser("fill", '.w-settings input[name="name"]', "Alex Rivera");
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Save name",
    "--exact",
  );
  await browser("wait", "--text", "Saved on this Mac");
  await browser("screenshot", join(evidence, "connected-settings.png"));
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
  await browser("open", `${origin}/?work`);
  await browser("wait", ".w-sidebar");
  await browser("click", '.w-mission-link[title="Science festival"]');
  await browser("wait", ".n-message");
  await browser("click", ".w-mission-tabs button:nth-child(2)");
  await browser("wait", ".n-artifact-candidate");
  await browser("screenshot", join(evidence, "connected-work.png"));
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Open result",
    "--exact",
  );
  assert.equal(
    await evaluate("window.calls.filter(c=>c[0]==='open-artifact').length"),
    1,
  );
  assert.equal(
    await evaluate("window.calls.find(c=>c[0]==='open-artifact')[2]"),
    (201).toString(16).padStart(64, "0"),
  );
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Review details",
    "--exact",
  );
  await browser("wait", "--text", "This revision has not been accepted.");
  await browser("scrollintoview", ".n-artifact-reviews");
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Record acceptance",
    "--exact",
  );
  await browser("scrollintoview", 'select[name="accepted"]');
  await browser(
    "fill",
    'textarea[name="reason"]',
    "Reviewed for the visitor briefing.",
  );
  await browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Save decision",
    "--exact",
  );
  await browser("wait", "--text", "Accepted by You");
  const acceptance = await evaluate(
    "window.calls.find(c=>c[0]==='artifact-action')",
  );
  assert.equal(acceptance[4].type, "accept");
  assert.equal(acceptance[4].revision, (201).toString(16).padStart(64, "0"));
  assert.equal(
    await evaluate("window.calls.some(c=>c[0]==='close-mission')"),
    false,
  );
  await browser("click", ".w-work-tabs button:nth-child(2)");
  await browser("wait", "--text", "No tasks yet.");
  await browser("click", ".w-mission-tabs button:nth-child(4)");
  await browser("wait", 'nav[aria-label="Brief views"]');
  await browser("click", 'nav[aria-label="Brief views"] button:nth-child(3)');
  await browser("wait", "--text", "Accounted turns");
  await browser("screenshot", join(evidence, "connected-budget.png"));
  await browser("click", ".w-mission-tabs button:nth-child(3)");
  await browser("wait", 'nav[aria-label="Member views"]');
  assert.equal(
    await evaluate("document.querySelector('.w-surface-title h2').textContent"),
    "People",
  );
  assert.equal(
    await evaluate("!!document.querySelector('.d-screen-error')"),
    false,
  );
  await browser("open", `${origin}/?contributor`);
  await browser("wait", ".w-sidebar");
  await browser("click", '.w-mission-link[title="Science festival"]');
  await browser("wait", ".n-message");
  await browser("fill", "#main-message", "Sam checking the plan.");
  await browser("click", ".n-composer button[type=submit]");
  await browser("wait", "--text", "Sam checking the plan.");
  assert.deepEqual(
    await evaluate(`Array.from(document.querySelectorAll('.n-message')).map(m=>({
      author:m.querySelector('header strong').textContent,
      missionOwner:Array.from(m.querySelectorAll('.n-activity-kind')).some(b=>b.textContent==='Mission owner')
    }))`),
    [
      { author: "Alex", missionOwner: true },
      { author: "Sam", missionOwner: false },
    ],
    "The owner's badge must not follow the local viewer's identity",
  );
  await browser(
    "screenshot",
    join(evidence, "connected-contributor-authorship.png"),
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
