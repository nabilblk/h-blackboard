// Optional native smoke check; requires macOS and the agent-browser CLI.
// Kept outside *.test.mjs so normal unit tests never launch a GUI or download
// an Electron binary. Mission fixtures use an isolated temporary profile; no
// paid runtime, peer connection or real workspace is used.
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
function click(selector) {
  browser("scrollintoview", selector);
  browser("click", selector);
}
async function waitForMission() {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const status = JSON.parse(
      browser(
        "eval",
        `({ready:!!document.querySelector('.n-conversation-start'), error:document.querySelector('[role=alert]')?.textContent})`,
      ),
    );
    if (status.error) throw new Error(status.error);
    if (status.ready) return;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(
    "Mission creation did not finish. Check for a pending macOS Keychain prompt; the native test never approves it automatically.",
  );
}
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
  browser("wait", "--text", "Your missions, on your computer.");
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
    nodeBridge: Object.keys(window.blackboardNode),
    nodeState: await window.blackboardNode.state(),
    state: await window.contributor.state(),
    remoteBlocked: await fetch('https://example.com').then(() => false, () => true),
    fileBlocked: await fetch('file:///etc/passwd').then(() => false, () => true),
    forgedRequestBlocked: await window.contributor.prepare({workspace:'/tmp',permissions:'full-access'}).then(() => false, () => true),
    forgedNodeRequestBlocked: await window.blackboardNode.createMission({profile:'/tmp',command:'launch'}).then(() => false, () => true),
    insecureInvitationRejected: await window.contributor.inspect('http://127.0.0.1:9/j/desktop_fixture_0123456789').then(() => false, e => e.message.includes('HTTPS')),
    renamed: (await window.contributor.rename('Native smoke test')).contributor.name,
    overflow: document.documentElement.scrollWidth > innerWidth
  }))()`,
    ),
  );
  if (typeof evaluated === "string") evaluated = JSON.parse(evaluated);
  assert.equal(evaluated.heading, "Your missions, on your computer.");
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
  assert.deepEqual(
    evaluated.nodeBridge.sort(),
    [
      "state",
      "enroll",
      "createMission",
      "updateInstructions",
      "setCoordination",
      "setPlan",
      "startMission",
      "pauseMission",
      "appointCoordinator",
      "governance",
      "govern",
      "consentGrant",
      "missionAction",
      "privateRecovery",
      "reconcilePrivate",
      "agents",
      "shareAgent",
      "withdrawAgent",
      "directAgent",
      "postMessage",
      "openAgentConversation",
      "artifacts",
      "copyArtifactReference",
      "artifactDetail",
      "artifactAction",
      "artifactTransfer",
      "artifactOpen",
      "artifactSave",
      "workEvidence",
      "workstreams",
      "tasks",
      "work",
      "queryMessages",
      "markMessagesRead",
      "messages",
      "networkState",
      "configureNetwork",
      "issueInvitation",
      "copyInvitation",
      "discoveryState",
      "configureDiscovery",
      "publishListing",
      "copyPeerTicket",
      "withdrawMission",
      "reviewContribution",
      "prepareContribution",
      "inspectInvitation",
      "requestJoin",
      "localJoins",
      "peers",
      "decideJoin",
      "revokeInvitations",
      "revokeMember",
      "createAudience",
      "audiences",
    ].sort(),
  );
  assert.equal(evaluated.nodeState.status, "not_enrolled");
  assert.equal(evaluated.nodeState.identity, null);
  assert.equal(evaluated.forgedNodeRequestBlocked, true);
  assert.equal(evaluated.remoteBlocked, true);
  assert.equal(evaluated.fileBlocked, true);
  assert.equal(evaluated.forgedRequestBlocked, true);
  assert.equal(evaluated.insecureInvitationRejected, true);
  assert.equal(evaluated.renamed, "Native smoke test");
  assert.equal(evaluated.overflow, false);
  await access(join(profile, "contributor/contributions.json"));

  // Use actual form interactions and the OS key store, then restart the app.
  // No renderer mock or direct DB insert can make this path pass.
  click(".n-empty .d-button");
  browser("wait", "--text", "Define the mission.");
  browser("snapshot", "-i");
  browser("fill", "input[name=name]", "Community science day");
  browser(
    "fill",
    "textarea[name=objective]",
    "Plan a science day that families can explore together.",
  );
  browser(
    "fill",
    "textarea[name=scope]",
    "Six activities, accessible spaces and a practical afternoon schedule.",
  );
  browser(
    "fill",
    "#criterion",
    "Every activity has an age range and a materials list.",
  );
  click(".n-inline button");
  click("button[type=submit]");
  await waitForMission();
  browser("snapshot", "-i");
  browser(
    "fill",
    "#main-message",
    "Start with hands-on experiments. Keep every activity under 20 minutes, with time to reset between groups.",
  );
  click("button[type=submit]");
  browser("wait", "--text", "Start with hands-on experiments.");
  click(".n-mission-brief summary");
  const savedNode = JSON.parse(
    browser("eval", "window.blackboardNode.state()"),
  );
  assert.equal(savedNode.missions.length, 1);
  assert.equal(savedNode.missions[0].state, "preparing");
  assert.equal(savedNode.execution, "unavailable");
  assert.equal(savedNode.network, "disabled");
  assert.equal(savedNode.missions[0].definition.criteria.length, 1);
  assert.equal(
    savedNode.missions[0].definition.policy.budget.mode,
    "unlimited",
  );
  browser(
    "screenshot",
    resolve(`var/desktop/${packaged ? "package" : "native"}-mission.png`),
  );
  browser("set", "viewport", "900", "650");
  assert.equal(
    JSON.parse(
      browser("eval", "document.documentElement.scrollWidth > innerWidth"),
    ),
    false,
  );
  browser(
    "screenshot",
    resolve(`var/desktop/${packaged ? "package" : "native"}-mission-small.png`),
  );
  await stopApp();
  await startApp();
  let restarted = JSON.parse(browser("eval", "window.contributor.state()"));
  if (typeof restarted === "string") restarted = JSON.parse(restarted);
  assert.equal(restarted.contributor.name, "Native smoke test");
  assert.equal(restarted.contributor.id, evaluated.state.contributor.id);
  assert.equal(restarted.device.id, evaluated.state.device.id);
  assert.equal(restarted.activity[0].type, "contributor_named");
  assert.deepEqual(
    JSON.parse(browser("eval", "window.blackboardNode.state()")),
    savedNode,
  );
  click(".n-mission-row");
  browser("wait", "--text", "Start with hands-on experiments.");
  const restoredMessages = JSON.parse(
    browser(
      "eval",
      `window.blackboardNode.messages(${JSON.stringify(savedNode.missions[0].id)})`,
    ),
  );
  assert.equal(restoredMessages.items.length, 1);
  assert.equal(restoredMessages.items[0].author, savedNode.identity.owner);
  await writeFile(
    packaged
      ? "var/desktop/package-smoke.json"
      : "var/desktop/native-smoke.json",
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        restartPreservedState: true,
        localMissionCreatedThroughUI: true,
        encryptedNodeIdentityAndSignedHistorySurvivedRestart: true,
        executionRemainedDisabled: true,
        ...evaluated,
      },
      null,
      2,
    ),
  );
  console.log(
    `${packaged ? "Packaged" : "Development"} native startup, isolated IPC, denied network/file requests, OS-protected identity, mission creation and signed history across restart passed.`,
  );
} catch (error) {
  try {
    console.error(browser("snapshot", "-i"));
  } catch {
    /* Startup may have failed. */
  }
  console.error(output);
  throw error;
} finally {
  await stopApp();
  await rm(profile, { recursive: true, force: true });
}
