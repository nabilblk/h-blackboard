// Optional native smoke check; requires macOS and the agent-browser CLI.
// Kept outside *.test.mjs so normal unit tests never launch a GUI or download
// an Electron binary. No mission fixture, paid runtime or real profile is used.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const packaged = process.argv.includes("--packaged");
const executable = packaged
  ? resolve(
      `var/desktop/packages/Harakiri Desktop-darwin-${process.arch}/Harakiri Desktop.app/Contents/MacOS/Harakiri Desktop`,
    )
  : (await import("electron")).default;

const profile = await mkdtemp(join(tmpdir(), "harakiri-native-smoke-"));
const server = createServer();
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
await new Promise((done) => server.close(done));
const name = `harakiri-smoke-${process.pid}`;
const env = { ...process.env, HARAKIRI_DESKTOP_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.HARAKIRI_DESKTOP_ALLOW_LOOPBACK;
// Prove that this development escape hatch is ignored by packaged builds.
if (packaged) env.HARAKIRI_DESKTOP_ALLOW_LOOPBACK = "1";
let output = "";
let child;
const browser = (...args) =>
  execFileSync("agent-browser", ["--session", name, ...args], {
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  });
async function startApp() {
  let startupError;
  child = spawn(
    executable,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      ...(packaged ? [] : [resolve("var/desktop/build")]),
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  child.on("error", (error) => {
    startupError = error;
  });
  const deadline = Date.now() + 20000;
  let ready = false;
  while (Date.now() < deadline && child.exitCode === null && !startupError) {
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(500),
        })
      ).json();
      if (
        targets.some((entry) => entry.url === "harakiri://desktop/index.html")
      ) {
        ready = true;
        break;
      }
    } catch {
      /* Readiness includes Electron startup and main-module evaluation. */
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(
    ready,
    startupError?.message ||
      "The native app did not load its bundled UI within 20 seconds.",
  );
  browser("connect", String(port));
  browser("wait", "--text", "Contribute on your terms.");
  browser("snapshot", "-i");
}
async function stopApp() {
  try {
    browser("close");
  } catch {
    /* The app may already have quit. */
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit"),
      new Promise((done) => setTimeout(done, 2000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
}
try {
  await startApp();
  let evaluated = JSON.parse(
    browser(
      "eval",
      `(async () => ({
    title: document.title,
    heading: document.querySelector('h1')?.textContent,
    node: typeof process,
    require: typeof require,
    bridge: Object.keys(window.contributor),
    state: await window.contributor.state(),
    remoteBlocked: await fetch('https://example.com').then(() => false, () => true),
    fileBlocked: await fetch('file:///etc/passwd').then(() => false, () => true),
    forgedRequestBlocked: await window.contributor.prepare({workspace:'/tmp',permissions:'full-access'}).then(() => false, () => true),
    insecureInvitationRejected: await window.contributor.inspect('http://127.0.0.1:9/j/desktop_fixture_0123456789').then(() => false, e => e.message.includes('HTTPS')),
    renamed: (await window.contributor.rename('Native smoke test')).contributor.name,
    overflow: document.documentElement.scrollWidth > innerWidth
  }))()`,
    ),
  );
  if (typeof evaluated === "string") evaluated = JSON.parse(evaluated);
  assert.equal(evaluated.heading, "Contribute on your terms.");
  assert.equal(evaluated.node, "undefined");
  assert.equal(evaluated.require, "undefined");
  assert.deepEqual(
    evaluated.bridge.sort(),
    [
      "state",
      "inspect",
      "chooseWorkspace",
      "prepare",
      "revoke",
      "reveal",
      "rename",
    ].sort(),
  );
  assert.equal(evaluated.state.contributions.length, 0);
  assert.equal(evaluated.remoteBlocked, true);
  assert.equal(evaluated.fileBlocked, true);
  assert.equal(evaluated.forgedRequestBlocked, true);
  assert.equal(evaluated.insecureInvitationRejected, true);
  assert.equal(evaluated.renamed, "Native smoke test");
  assert.equal(evaluated.overflow, false);
  await access(join(profile, "contributor/contributions.json"));
  await stopApp();
  await startApp();
  let restarted = JSON.parse(browser("eval", "window.contributor.state()"));
  if (typeof restarted === "string") restarted = JSON.parse(restarted);
  assert.equal(restarted.contributor.name, "Native smoke test");
  assert.equal(restarted.contributor.id, evaluated.state.contributor.id);
  assert.equal(restarted.device.id, evaluated.state.device.id);
  assert.equal(restarted.activity[0].type, "contributor_named");
  await writeFile(
    packaged
      ? "var/desktop/package-smoke.json"
      : "var/desktop/native-smoke.json",
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        restartPreservedState: true,
        ...evaluated,
      },
      null,
      2,
    ),
  );
  console.log(
    `${packaged ? "Packaged" : "Development"} native startup, isolated IPC, denied network/file requests and real local persistence passed.`,
  );
} catch (error) {
  console.error(output);
  throw error;
} finally {
  await stopApp();
  await rm(profile, { recursive: true, force: true });
}
