// Optional native UI proof: three temporary profiles, real Rust sidecars and
// real OS key storage. No runtime agents, public relays or live user data.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ContributorService } from "../desktop/service.mjs";
import { DesktopStore } from "../desktop/store.mjs";
const packaged = process.argv.includes("--packaged");
const discoveryMode = process.argv.includes("--discovery");
const governanceMode = process.argv.includes("--governance");
const artifactsMode = process.argv.includes("--artifacts");
const workMode = process.argv.includes("--work");
const communicationMode = process.argv.includes("--communication") || workMode;
const rosterMode = process.argv.includes("--roster") || communicationMode;
const lifecycleMode = process.argv.includes("--lifecycle") || rosterMode;
const runtime =
  process.argv.find((arg) => arg.startsWith("--runtime="))?.slice(10) || "grok";
const runtimeLabel = {
  grok: "Grok Build",
  claude: "Claude Code",
  codex: "Codex",
}[runtime];
assert.ok(runtimeLabel, "Unsupported test runtime");
const executable = packaged
  ? resolve(
      `var/desktop/packages/Harakiri Desktop-darwin-${process.arch}/Harakiri Desktop.app/Contents/MacOS/Harakiri Desktop`,
    )
  : (await import("electron")).default;
const root = await mkdtemp(join(tmpdir(), "hb-native-peers-"));
const evidence = resolve(
  `var/desktop/${packaged ? "packaged-" : ""}${governanceMode ? "governance" : artifactsMode ? "artifacts" : workMode ? "work" : discoveryMode ? "discovery" : communicationMode ? "communication" : rosterMode ? "roster" : lifecycleMode ? "lifecycle" : "peers"}`,
);
await mkdir(evidence, { recursive: true });
await rm(join(evidence, "result.json"), { force: true });
const apps = [];
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function app(name) {
  const profile = join(root, name);
  await mkdir(profile, { mode: 0o700 });
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  const session = `hb-peers-${process.pid}-${name}`;
  const env = { ...process.env, HARAKIRI_DESKTOP_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.HARAKIRI_DESKTOP_ALLOW_LOOPBACK;
  let child;
  let logs = "";
  const browser = (...args) =>
    execFileSync("agent-browser", ["--session", session, ...args], {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const evaluate = (expression) => JSON.parse(browser("eval", expression));
  const click = (selector) => {
    browser("scrollintoview", selector);
    browser("click", selector);
  };
  const wait = async (expression, description, timeout = 45000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const error = evaluate(
        `document.querySelector('.d-alert:not(.n-revoke)')?.textContent || ''`,
      );
      if (error) throw new Error(`${name}: ${error}`);
      if (evaluate(expression)) return;
      await pause(200);
    }
    throw new Error(
      `${name}: ${description}. Check the saved native-test screenshots.`,
    );
  };
  const button = (label, scope = "document") => {
    const selector = evaluate(`(()=>{
      const root=${scope};const e=[...root.querySelectorAll('button')].find(b=>{const label=b.cloneNode(true);label.querySelectorAll('.d-count').forEach(e=>e.remove());return b.checkVisibility({visibilityProperty:true}) && label.textContent.trim()===${JSON.stringify(label)}});
      if(!e) return null;const parts=[];for(let x=e;x&&x!==document.documentElement;x=x.parentElement) parts.unshift(x.tagName.toLowerCase()+':nth-child('+([...x.parentElement.children].indexOf(x)+1)+')');return 'html>'+parts.join('>');
    })()`);
    assert.ok(selector, `${name}: missing ${label}`);
    click(selector);
  };
  const start = async () => {
    child = spawn(
      executable,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        ...(packaged ? [] : [resolve("var/desktop/build")]),
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (b) => (logs += b));
    child.stderr.on("data", (b) => (logs += b));
    let ready = false;
    const end = Date.now() + 20000;
    while (Date.now() < end && child.exitCode === null) {
      try {
        const entries = await (
          await fetch(`http://127.0.0.1:${port}/json/list`, {
            signal: AbortSignal.timeout(500),
          })
        ).json();
        if (entries.some((e) => e.url === "harakiri://desktop/index.html")) {
          ready = true;
          break;
        }
      } catch {}
      await pause(100);
    }
    assert.ok(ready, `${name}: app did not start`);
    browser("connect", String(port));
    await wait(
      `document.querySelector('h1')?.textContent==='Your missions, on your computer.' || !!document.querySelector('.n-conversations')`,
      "Mission home or saved conversation did not load",
    );
    browser("snapshot", "-i");
  };
  const stop = async () => {
    try {
      browser("close");
    } catch {}
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), pause(2000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  };
  const instance = {
    name,
    profile,
    port,
    browser,
    evaluate,
    click,
    button,
    wait,
    start,
    stop,
    logs: () => logs,
  };
  apps.push(instance);
  await start();
  return instance;
}
function closePanel(app) {
  if (app.evaluate("!!document.querySelector('.n-context-panel[open]')"))
    app.browser("press", "Escape");
}
function members(app) {
  if (
    app.evaluate(
      "document.querySelector('.n-context-panel > header h2')?.textContent || ''",
    ) !== "Members"
  ) {
    closePanel(app);
    app.button("Members");
  }
}
function people(app) {
  members(app);
  app.button("People & invitations");
}
function clearComposer(app) {
  // Empty `fill`/select-all is a no-op with this Electron CDP connection.
  // Delete a known character through keyboard input, which emits onChange.
  app.browser("fill", "#main-message", "x");
  app.browser("press", "Backspace");
}

async function rosterProof(a, b) {
  await b.wait(
    "window.blackboardNode.state().then(s=>s.missions[0].definition.policy.coordination==='peer')",
    "Peer mode did not replicate",
  );
  const m = b.evaluate("window.blackboardNode.state()").missions[0];
  // Isolated preparation fixture through the real native service. We do not
  // automate the macOS folder picker or claim this fixture is a running agent.
  await b.stop();
  const workspace = join(root, "roster-workspaces");
  await mkdir(workspace);
  const service = new ContributorService({
    store: new DesktopStore(join(b.profile, "contributor")),
    chooseDirectory: async () => workspace,
    revealDirectory: async () => {},
  });
  const review = service.reviewNode(
    {
      mission: m.id,
      owner: m.owner,
      definition: m.definition,
      reviewed_revision: m.lifecycle.terms_revision,
    },
    "agent",
  );
  const choice = await service.handle("chooseWorkspace", {});
  await service.handle(
    "prepare",
    {
      reviewId: review.reviewId,
      workspaceChoiceId: choice.id,
      runtime,
      limits: { mode: "unlimited", concurrency: 1 },
    },
    { nodeRevision: m.lifecycle.terms_revision },
  );
  await b.start();
  assert.ok(b.evaluate("!!document.querySelector('.n-conversations')"));
  b.browser("fill", "#main-message", "My unsent accessibility question");
  members(b);
  b.button("Agents");
  await b.wait(
    "!!document.querySelector('.n-share-agent')",
    "Prepared contribution missing",
  );
  b.click(".n-agents > details > summary");
  b.browser(
    "fill",
    '.n-share-agent input[name="label"]',
    "Accessibility researcher",
  );
  b.button("Share agent");
  await b.wait(
    "!!document.querySelector('.n-agent-summary')",
    "Shared agent missing",
  );
  assert.ok(
    b
      .evaluate("document.querySelector('.n-agents').textContent")
      .includes("Setting up"),
  );
  b.browser("screenshot", join(evidence, "agent-shared.png"));
  b.click(".n-agent-summary");
  await b.wait(
    "!!document.querySelector('.n-execution')",
    "Local execution controls missing",
  );
  assert.match(
    b.evaluate("document.querySelector('.n-execution').textContent"),
    /Prepare isolated environment/,
  );
  assert.ok(
    b
      .evaluate("document.querySelector('.n-execution').textContent")
      .includes("Prepare this agent’s isolated environment"),
  );
  assert.equal(
    b.evaluate(
      "window.blackboardExecution.state(" +
        JSON.stringify(service.snapshot().contributions[0].id) +
        ")",
    ).record,
    null,
  );
  assert.equal(
    b.evaluate("document.querySelector('#main-message').value"),
    "My unsent accessibility question",
  );
  b.browser("screenshot", join(evidence, "local-execution-controls.png"));
  closePanel(b);
  assert.equal(
    b.evaluate("document.querySelector('#main-message').value"),
    "My unsent accessibility question",
  );
  b.button("My missions", "document.querySelector('aside')");
  b.click(".n-mission-row");
  assert.equal(
    b.evaluate("document.querySelector('#main-message').value"),
    "My unsent accessibility question",
  );
  b.browser("set", "viewport", "900", "650");
  members(b);
  assert.equal(
    b.evaluate(
      "document.querySelector('.n-context-panel').getAttribute('aria-modal')",
    ),
    "true",
  );
  assert.equal(
    b.evaluate("document.documentElement.scrollWidth > innerWidth"),
    false,
  );
  b.browser("screenshot", join(evidence, "members-narrow.png"));
  closePanel(b);
  assert.equal(
    b.evaluate("document.activeElement.textContent.trim()"),
    "Members",
  );
  assert.equal(
    b.evaluate("document.querySelector('#main-message').value"),
    "My unsent accessibility question",
  );
  clearComposer(b);
  b.browser("set", "viewport", "1440", "900");
  members(b);
  b.click(".n-mission-title");
  await b.wait(
    "document.querySelector('.n-context-panel > header h2')?.textContent === 'Mission'",
    "Panel did not switch in context",
  );
  closePanel(b);
  assert.equal(
    b.evaluate("document.activeElement.className"),
    "n-mission-title",
  );
  members(a);
  a.button("Agents");
  await a.wait(
    "document.querySelector('.n-agents')?.textContent.includes('Accessibility researcher')",
    "Remote roster missing",
  );
  a.browser("fill", ".n-agent-filter input", runtimeLabel);
  assert.equal(
    a.evaluate("document.querySelectorAll('.n-agent-summary').length"),
    1,
  );
  const remoteAgent = a.evaluate(
    "document.querySelector('.n-agent-summary').textContent",
  );
  assert.match(remoteAgent, /Contributed by Participant [a-f0-9]{8}/);
  assert.match(
    remoteAgent,
    /(?:reported|Waiting for a fresh report from Participant [a-f0-9]{8})/,
  );
  assert.doesNotMatch(remoteAgent, /controlled by you\b/i);
  a.browser("screenshot", join(evidence, "mission-members.png"));
  closePanel(a);
}
async function directionProof(a, b) {
  members(a);
  a.button("Agents");
  await a.wait(
    "document.querySelector('.n-agent-state') && !document.querySelector('.n-agent-state').textContent.includes('Running')",
    "A remote assignment must not masquerade as a running process",
  );
  const assigned = a.evaluate(
    "(async () => window.blackboardNode.agents((await window.blackboardNode.state()).missions[0].id))()",
  );
  assert.equal(
    assigned.items[0].status,
    "direction_assigned",
    "Start assigns authority separately from execution",
  );
  a.click(".n-agent-summary");
  a.button("Give direction");
  a.browser(
    "fill",
    ".n-agent-direction textarea",
    "Check access to every activity and publish the evidence in Main.",
  );
  a.button("Assign direction");
  await a.wait(
    "!document.querySelector('.n-agent-direction')",
    "Direction was not saved",
  );
  members(b);
  b.button("Agents");
  b.click(".n-agent-summary");
  await b.wait(
    "document.querySelector('.n-agent-detail')?.textContent.includes('Check access to every activity')",
    "Individual direction did not replicate",
  );
  assert.ok(
    b
      .evaluate("document.querySelector('.n-agent-detail').textContent")
      .includes("Awaiting agent acknowledgment"),
  );
  a.browser("screenshot", join(evidence, "agent-direction.png"));
  assert.equal(
    b.evaluate(
      "[...document.querySelectorAll('.n-agent-detail button')].some(b => b.textContent.trim() === 'Review run permission')",
    ),
    false,
    "A contributor must not receive the owner's grant action",
  );
  a.button("Review contribution");
  a.button("Approve contribution");
  await a.wait(
    "document.querySelector('.n-contribution-consent')?.textContent.includes('Work authorized')",
    "Remote authorization did not identify the contributor's separate approval",
  );
  const permission = a.evaluate(
    "(async()=>{const m=(await window.blackboardNode.state()).missions[0];return (await window.blackboardNode.governance(m.id)).grants.at(-1)})()",
  );
  assert.equal(permission.registration, assigned.items[0].id);
  assert.equal(permission.turns, 5);
  assert.equal(permission.consent, null);
  assert.equal(permission.reserved, 0);
  assert.equal(permission.charged, 0);
  a.browser("screenshot", join(evidence, "remote-run-permission.png"));
  closePanel(a);
  closePanel(b);
}

async function conversationProof(a, b) {
  // Exercise the same Markdown renderer used by the original web workspace,
  // with remote content kept inert inside the privileged desktop shell.
  const markdown = [
    "## Accessibility review",
    "**Evidence** is shared with everyone in Main.",
    "| Activity | Access |",
    "| --- | --- |",
    ...Array.from(
      { length: 14 },
      (_, i) => `| Activity ${i + 1} | Step-free |`,
    ),
    "",
    "```text",
    "Long evidence reference: " + "bounded-evidence-".repeat(30),
    "```",
    "[Reference](https://example.invalid/evidence)",
    "![Remote image](https://example.invalid/never-fetch.png)",
    "<script>window.untrustedMessageExecuted = true</script>",
  ].join("\n");
  a.browser("fill", "#main-message", markdown);
  a.click(".n-composer button[type=submit]");
  await b.wait(
    "document.querySelector('.n-message-text h2')?.textContent === 'Accessibility review'",
    "Formatted message did not replicate",
  );
  assert.equal(
    b.evaluate(
      "document.querySelectorAll('.n-message-text table tbody tr').length",
    ),
    14,
  );
  assert.equal(
    b.evaluate(
      "document.querySelectorAll('.n-message-text img, .n-message-text script, .n-message-text a[href^=\"https:\"]').length",
    ),
    0,
  );
  assert.equal(b.evaluate("!!window.untrustedMessageExecuted"), false);
  assert.equal(
    b.evaluate("document.documentElement.scrollWidth > innerWidth"),
    false,
  );
  b.evaluate("document.querySelector('.n-messages').scrollTop = 0");
  await send(
    a,
    "A fresh accessibility finding while you are reading earlier evidence.",
  );
  await b.wait(
    "!!document.querySelector('.n-new-messages')",
    "New-message indicator missing",
  );
  assert.ok(
    b.evaluate("document.querySelector('.n-messages').scrollTop") < 100,
  );
  b.click(".n-new-messages");
  await b.wait(
    "!document.querySelector('.n-new-messages')",
    "New-message indicator did not clear",
  );
  await b.wait(
    "(()=>{const e=document.querySelector('.n-messages');return e.scrollHeight-e.clientHeight-e.scrollTop < 48})()",
    "Jump to latest did not reach the end of the conversation",
  );
  b.browser(
    "fill",
    "#main-message",
    "Draft retained while inspecting an agent",
  );
  b.button("View agent");
  await b.wait(
    "!!document.querySelector('.n-agent-detail')",
    "Activity did not open the agent profile",
  );
  closePanel(b);
  assert.equal(
    b.evaluate("document.querySelector('#main-message').value"),
    "Draft retained while inspecting an agent",
  );
  clearComposer(b);
  await b.wait(
    "document.querySelector('#main-message').value === ''",
    "Composer did not clear",
  );
  b.browser("set", "viewport", "900", "650");
  assert.equal(
    b.evaluate("document.documentElement.scrollWidth > innerWidth"),
    false,
  );
  assert.ok(
    b.evaluate(
      "document.querySelector('.n-composer').getBoundingClientRect().bottom <= innerHeight",
    ),
  );
  const metrics = b.evaluate(
    `Object.fromEntries(['.n-messages','.n-composer','.n-room-header','.n-channel-title','.n-control','.n-mission-brief'].map(s=>[s,document.querySelector(s)?.getBoundingClientRect().toJSON()]))`,
  );
  await writeFile(
    join(evidence, "narrow-layout.json"),
    JSON.stringify(metrics, null, 2),
  );
  assert.ok(
    metrics[".n-messages"].height >= 180,
    "The narrow window must keep a usable conversation area: " +
      JSON.stringify(metrics),
  );
  b.evaluate(
    "(()=>{document.querySelector('.n-message-text h2').scrollIntoView({block:'start'});return true})()",
  );
  b.evaluate(
    "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))",
  );
  b.browser("screenshot", join(evidence, "formatted-conversation-narrow.png"));
  b.browser("set", "viewport", "1440", "900");
  b.evaluate(
    "(()=>{document.querySelector('.n-message-text h2').scrollIntoView({block:'start'});return true})()",
  );
  b.evaluate(
    "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))",
  );
  b.browser("screenshot", join(evidence, "formatted-conversation.png"));
}

async function communicationProof(a, b, c) {
  members(a);
  a.button("Agents");
  a.click(".n-agent-summary");
  await a.wait(
    "!!document.querySelector('.n-agent-detail')",
    "Agent details missing",
  );
  a.button("Address in Main");
  await a.wait(
    "document.querySelector('[aria-label=\"Address message to\"]').value !== ''",
    "Addressed recipient missing",
  );
  await send(a, "Please review step-free access to every venue.");
  await b.wait(
    "[...document.querySelectorAll('.n-message')].some(e=>e.textContent.includes('Please review step-free access')&&e.textContent.includes('to Accessibility researcher'))",
    "Public agent addressing missing",
  );
  a.button("Sent", "document.querySelector('.n-conversation-nav')");
  await a.wait(
    "[...document.querySelectorAll('.n-message')].some(e=>e.textContent.includes('Please review step-free access'))",
    "Addressed message missing from Sent",
  );
  a.browser("screenshot", join(evidence, "sent-addressed.png"));
  const root = b.evaluate(
    "[...document.querySelectorAll('.n-message')].find(e=>e.textContent.includes('Please review step-free access')).id",
  );
  // A stable message ID survives polling and the disappearing new-message
  // indicator; a positional DOM path does not.
  b.click(`#${root} .n-message-actions button`);
  await b.wait(
    "!!document.querySelector('#thread-message')",
    "Thread composer missing",
  );
  b.browser(
    "fill",
    "#thread-message",
    "Human reply: check the north entrance first.",
  );
  b.click(".n-thread .n-composer button[type=submit]");
  await b.wait(
    "document.querySelector('.n-thread')?.textContent.includes('Human reply: check the north entrance first.')",
    "Thread reply missing",
  );
  b.browser("screenshot", join(evidence, "public-thread.png"));
  closePanel(b);
  a.button("Inbox", "document.querySelector('.n-conversation-nav')");
  await a.wait(
    "document.querySelector('.n-messages')?.textContent.includes('Human reply: check the north entrance first.')",
    "Public reply missing from Inbox",
  );
  a.browser("screenshot", join(evidence, "inbox-reply.png"));
  a.button("Open conversation", "document.querySelector('.n-messages')");
  await a.wait(
    "!!document.querySelector('.n-thread')",
    "Inbox did not open original thread",
  );
  assert.ok(
    a.evaluate(
      "document.querySelector('.n-thread').textContent.includes('Public · Main')",
    ),
  );
  closePanel(a);
  a.button("Back to latest");
  members(a);
  a.button("Agents");
  a.click(".n-agent-summary");
  await a.wait(
    "!!document.querySelector('.n-agent-detail')",
    "Agent details missing for private message",
  );
  a.button("Message privately");
  await a.wait(
    "document.querySelector('.n-channel-title h2')?.textContent==='Accessibility researcher'",
    "Private agent conversation missing",
  );
  await send(
    a,
    "Private instruction: preserve the accessibility concern here.",
  );
  await a.wait(
    "document.querySelector('.n-messages')?.textContent.includes('Private instruction: preserve')",
    "Private message missing",
  );
  const state = a.evaluate("window.blackboardNode.state()");
  const mission = state.missions[0].id;
  const scopes = a.evaluate(
    `window.blackboardNode.audiences(${JSON.stringify(mission)})`,
  );
  const privateScope = scopes.find((s) => s.agent_registration);
  assert.ok(privateScope);
  await b.wait(
    `window.blackboardNode.messages(${JSON.stringify(mission)},null,${JSON.stringify(privateScope.id)}).then(()=>false,()=>true)`,
    "Host human unexpectedly gained the hosted agent's private conversation",
  );
  assert.ok(
    c.evaluate(
      `window.blackboardNode.audiences(${JSON.stringify(mission)}).then(xs=>!xs.some(s=>s.id===${JSON.stringify(privateScope.id)}))`,
    ),
  );
  a.browser("screenshot", join(evidence, "private-agent-conversation.png"));
  a.button("Sent", "document.querySelector('.n-conversation-nav')");
  await a.wait(
    "document.querySelector('.n-messages')?.textContent.includes('Private instruction: preserve')",
    "Private message missing from Sent",
  );
  a.browser("fill", '[aria-label="Search Sent"]', "Private instruction");
  await a.wait(
    "document.querySelectorAll('.n-messages .n-message').length===1",
    "Full-history Sent filter did not narrow results",
  );
  a.button("Open conversation", "document.querySelector('.n-messages')");
  await a.wait(
    "document.querySelector('.n-channel-title h2')?.textContent==='Accessibility researcher'",
    "Search result lost the private conversation",
  );
  a.browser("set", "viewport", "900", "650");
  assert.equal(
    a.evaluate("document.documentElement.scrollWidth>innerWidth"),
    false,
  );
  assert.ok(
    a.evaluate(
      "document.querySelector('.n-composer').getBoundingClientRect().bottom<=innerHeight",
    ),
  );
  a.browser("screenshot", join(evidence, "private-agent-narrow.png"));
  a.browser("set", "viewport", "1440", "900");
  a.button("Main", "document.querySelector('.n-conversation-nav')");
}

async function workProof(a, b, c) {
  a.button("Add workstream", "document.querySelector('.n-conversation-nav')");
  a.browser("fill", '.n-context-panel input[name="name"]', "Accessibility");
  a.browser(
    "fill",
    '.n-context-panel textarea[name="goal"]',
    "Compare two step-free routes, with distances and wet-weather access.",
  );
  a.button("Create workstream");
  for (const n of [a, b, c])
    await n.wait(
      "!!document.querySelector('[data-workstream]')",
      "Workstream did not replicate",
    );
  await a.wait(
    "document.querySelector('.n-channel-title h2')?.textContent==='Accessibility'",
    "New workstream not selected",
  );
  b.click("[data-workstream]");
  await send(
    b,
    "North entrance: 240 m, level approach. South entrance: 160 m, steep ramp.",
  );
  await a.wait(
    "document.querySelector('.n-messages')?.textContent.includes('North entrance: 240 m')",
    "Public workstream message missing",
  );
  a.browser("fill", "#main-message", "Draft: compare the wet-weather option");
  a.button("Goal & agents");
  const agent = a.evaluate(
    "document.querySelector('.n-context-panel select[name=agent] option:not([disabled])')?.value",
  );
  assert.ok(agent);
  a.browser("select", '.n-context-panel select[name="agent"]', agent);
  a.browser(
    "fill",
    '.n-context-panel textarea[name="direction"]',
    "Measure both approaches and record the accessibility trade-offs.",
  );
  // Another authoritative update can arrive while a direction is being drafted.
  // Keep the reviewed goal fixed until the human explicitly reviews the new one.
  const revisedGoal =
    "Compare both step-free routes and identify covered waiting areas.";
  a.evaluate(`(async()=>{
    const mission=(await window.blackboardNode.state()).missions[0];
    const [stream]=await window.blackboardNode.workstreams(mission.id);
    return window.blackboardNode.work(mission.id,mission.lifecycle.revision,{
      type:'revise_workstream',workstream:stream.id,
      bases:stream.heads.map(h=>h.id),name:stream.name,goal:${JSON.stringify(revisedGoal)}
    });
  })()`);
  await a.wait(
    "[...document.querySelectorAll('.n-context-panel button')].some(b=>b.textContent==='Use reviewed goal')",
    "Changed goal did not require a new review",
  );
  assert.equal(
    a.evaluate(
      "[...document.querySelectorAll('.n-context-panel button')].find(b=>b.textContent==='Assign direction').disabled",
    ),
    true,
  );
  assert.equal(
    a.evaluate(
      "document.querySelector('.n-context-panel textarea[name=direction]').value",
    ),
    "Measure both approaches and record the accessibility trade-offs.",
  );
  a.button("Use reviewed goal");
  a.button("Assign direction");
  await a.wait(
    "document.querySelector('.n-work-assignees')?.textContent.includes('Awaiting acknowledgment')",
    "Assignment was not shown as pending",
  );
  a.browser("screenshot", join(evidence, "workstream-assignment.png"));
  closePanel(a);
  assert.equal(
    a.evaluate("document.querySelector('#main-message').value"),
    "Draft: compare the wet-weather option",
  );
  a.browser("screenshot", join(evidence, "workstream-conversation.png"));
  a.button("Tasks", "document.querySelector('.n-conversation-nav')");
  a.click(".n-work-overrides > summary");
  a.button("Create a task");
  a.browser(
    "fill",
    '.n-work-editor input[name="title"]',
    "Choose a step-free route",
  );
  a.browser(
    "fill",
    '.n-work-editor textarea[name="description"]',
    "Compare the north and south entrances and recommend a route families can use in rain.",
  );
  a.browser(
    "fill",
    '.n-work-editor textarea[name="criteria"]',
    "Measured distance for both options\nDocumented slope and wet-weather risk",
  );
  const stream = a.evaluate(
    "document.querySelector('[data-workstream]').dataset.workstream",
  );
  a.browser("select", '.n-work-editor select[name="workstream"]', stream);
  a.button("Save task");
  await a.wait(
    "document.querySelector('.n-task-row')?.textContent.includes('Choose a step-free route')",
    "Task missing after save",
  );
  a.click(".n-task-row");
  await a.wait(
    "document.querySelector('.n-work-detail h2')?.textContent==='Choose a step-free route'",
    "Task detail missing",
  );
  for (const approach of [
    "Measure the longer, level north entrance.",
    "Test a shorter southern route with a portable ramp.",
  ]) {
    if (!a.evaluate("document.querySelector('.n-work-overrides').open"))
      a.click(".n-work-overrides > summary");
    a.browser("select", '.n-work-overrides select[name="agent"]', agent);
    a.browser("fill", '.n-work-overrides textarea[name="approach"]', approach);
    a.button("Add an attempt");
    await a.wait(
      `document.querySelector('.n-work-detail')?.textContent.includes(${JSON.stringify(approach)})`,
      "Attempt missing",
    );
  }
  a.button("Override report", "document.querySelector('.n-task-attempt')");
  a.browser("select", '.n-task-attempt select[name="status"]', "in_progress");
  a.browser(
    "fill",
    '.n-task-attempt textarea[name="summary"]',
    "Operator fixture: north approach measurements recorded; rain check still pending.",
  );
  a.button("Record human override");
  await a.wait(
    "document.querySelector('.n-task-report')?.textContent.includes('rain check still pending')",
    "Attributed progress missing",
  );
  a.evaluate(
    "document.querySelector('.n-work-overrides').open=false;document.querySelector('.n-context-body').scrollTop=0",
  );
  a.browser("screenshot", join(evidence, "task-parallel-attempts.png"));
  b.button("Tasks", "document.querySelector('.n-conversation-nav')");
  await b.wait(
    "document.querySelector('.n-task-row')?.textContent.includes('2 attempts')",
    "Parallel attempts did not replicate",
  );
  b.browser("screenshot", join(evidence, "task-list.png"));
  b.click(".n-task-row");
  await b.wait(
    "document.querySelectorAll('.n-task-attempt').length===2",
    "Task detail lost an attempt",
  );
  assert.equal(
    b.evaluate("!!document.querySelector('.n-work-overrides')"),
    false,
  );
  b.browser("set", "viewport", "900", "650");
  assert.equal(
    b.evaluate("document.documentElement.scrollWidth>innerWidth"),
    false,
  );
  b.browser("screenshot", join(evidence, "task-narrow.png"));
  closePanel(b);
  b.browser("set", "viewport", "1440", "900");
  closePanel(a);
  assert.equal(
    a.evaluate("document.querySelector('#main-message').value"),
    "Draft: compare the wet-weather option",
  );
  clearComposer(a);
  for (const n of [a, b])
    n.button("Main", "document.querySelector('.n-conversation-nav')");
}

async function network(app) {
  app.button("This device");
  app.browser("select", ".n-network select", "direct");
  app.browser("check", ".n-network input[type=checkbox]");
  app.button("Save network settings");
  await app.wait(
    `document.querySelector('.n-network .d-status')?.textContent==='Networking on'`,
    "Network not enabled",
  );
}
async function send(app, text) {
  app.browser("fill", "#main-message", text);
  app.click(".n-composer button[type=submit]");
  await app.wait(
    `[...document.querySelectorAll('.n-message-text')].some(e=>e.textContent===${JSON.stringify(text)})`,
    "Message not saved",
  );
}

async function discoverySetup(node, bootstrap = "") {
  if (!node.evaluate("!!document.querySelector('.n-discovery-settings')"))
    node.button("Discovery settings");
  node.browser("check", ".n-discovery-settings .n-check:first-of-type input");
  node.browser("fill", ".n-discovery-settings textarea", bootstrap);
  node.button("Save discovery settings");
  await node.wait(
    "!!document.querySelector('.n-discovery-settings .n-invite-copy input')",
    "Community address not available",
  );
  return node.evaluate(
    "document.querySelector('.n-discovery-settings .n-invite-copy input').value",
  );
}
async function discoveryProof(a) {
  const aPeer = await discoverySetup(a);
  a.click(".n-channel-nav");
  people(a);
  a.browser(
    "fill",
    '.n-publish input[placeholder="What can people help with?"]',
    "Help plan a hands-on science day for local families.",
  );
  a.browser(
    "fill",
    '.n-publish input[placeholder="Research, accessibility, testing"]',
    "Research, planning",
  );
  a.button("Publish public brief");
  await a.wait(
    "document.querySelector('.n-publish .d-status')?.textContent==='Listed'",
    "Public brief not published",
  );
  a.browser("screenshot", join(evidence, "public-brief.png"));
  const b = await app("community-peer");
  await network(b);
  const bPeer = await discoverySetup(b, aPeer);
  const c = await app("contributor");
  await network(c);
  await discoverySetup(c, bPeer);
  c.button("Discover");
  await c.wait(
    "!!document.querySelector('.n-listing')",
    "Mission was not discovered through the community peer",
  );
  assert.equal(c.evaluate("window.blackboardNode.state()").missions.length, 0);
  c.browser("screenshot", join(evidence, "discover.png"));
  c.button("Review mission");
  await c.wait(
    "!!document.querySelector('.n-review')",
    "Signed mission review missing",
  );
  c.browser("screenshot", join(evidence, "mission-review.png"));
  c.button("Request to join");
  await a.wait(
    "!!document.querySelector('.n-requests button.primary')",
    "Admission request missing",
  );
  a.click(".n-requests button.primary");
  await c.wait(
    "!!document.querySelector('.n-channel-nav')",
    "Approved channel missing",
  );
  c.click(".n-channel-nav");
  await send(
    c,
    "I will investigate accessible activities and share the evidence here.",
  );
  closePanel(c);
  c.click(".n-more-actions summary");
  c.button("Your contribution", "document.querySelector('.n-more-actions')");
  await c.wait(
    "!!document.querySelector('.n-participation')",
    "Contribution review did not open",
  );
  c.browser("select", ".n-participation select", "coordinator");
  assert.ok(
    c.evaluate(
      "document.querySelector('.n-participation').textContent.includes('It waits for appointment')",
    ),
    "A remote contributor can prepare a Coordinator without self-appointment",
  );
  c.browser("screenshot", join(evidence, "remote-coordinator-preparation.png"));
  c.button("Prepare contribution");
  await c.wait(
    "!!document.querySelector('.n-guided-setup')",
    "Local Coordinator setup did not open",
  );
  c.browser("screenshot", join(evidence, "local-contribution.png"));
  assert.equal(
    c.evaluate("window.blackboardNode.state()").missions[0].lifecycle
      .coordinator,
    null,
    "Reviewing a remote Coordinator contribution does not appoint it",
  );
  assert.equal(
    c.evaluate("window.blackboardNode.state()").execution,
    "unavailable",
  );
  closePanel(c);
  c.click(".n-more-actions summary");
  c.button("Your contribution", "document.querySelector('.n-more-actions')");
  c.button("Withdraw from mission…");
  c.button("Withdraw participation");
  await c.wait(
    "document.querySelector('.n-mission-summary')?.textContent.includes('You withdrew')",
    "Withdrawal was not visible",
  );
  assert.equal(
    c.evaluate("document.querySelector('#main-message').disabled"),
    true,
  );
  c.browser("screenshot", join(evidence, "withdrawn.png"));
  await a.wait(
    "document.querySelector('.n-peer-list')?.textContent.includes('Participation withdrawn')",
    "Owner did not learn withdrawal",
  );
  a.button("Stop listing");
  b.button("Discover");
  await b.wait(
    "!document.querySelector('.n-listing')",
    "Signed unlisting did not propagate",
  );
  await c.stop();
  await c.start();
  assert.ok(c.evaluate("!!document.querySelector('.n-conversations')"));
  await c.wait(
    "document.querySelector('.n-mission-summary')?.textContent.includes('You withdrew')",
    "Withdrawal did not survive restart",
  );
  c.browser("set", "viewport", "900", "650");
  assert.equal(
    c.evaluate("document.documentElement.scrollWidth>innerWidth"),
    false,
  );
  c.browser("screenshot", join(evidence, "withdrawn-small.png"));
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        packaged,
        profiles: 3,
        publicListingViaIntermediatePeer: true,
        reviewAndApprovalThroughUI: true,
        reviewedLocalOfferScreen: true,
        withdrawalAndRestart: true,
        signedUnlisting: true,
        noAgentsStarted: true,
        overflowAt900: false,
        independentHumanConsentTest: false,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Native three-profile discovery, approval, local offer review, withdrawal and unlisting passed. No agents launched.",
  );
}

async function lifecycleProof(a, b, c) {
  closePanel(a);
  if (!a.evaluate("!!document.querySelector('.n-control')"))
    a.click(".n-mission-title");
  assert.equal(
    a.evaluate(
      "document.querySelector('.n-control-bar button').textContent.trim()",
    ),
    "Set up Coordinator",
  );
  assert.equal(
    b.evaluate("!!document.querySelector('.n-control-bar button')"),
    false,
  );
  a.click(".n-control-details > details.n-secondary-section > summary");
  a.button("Write a plan yourself");
  a.browser(
    "fill",
    "textarea[name=plan]",
    "Compare two activity schedules, check accessibility, then publish a usable plan.",
  );
  a.button("Save shared plan");
  await a.wait(
    "!document.querySelector('.n-control-editor')",
    "Human plan did not save",
  );
  assert.equal(
    a.evaluate(
      "document.querySelector('.n-control-bar button').textContent.trim()",
    ),
    "Set up Coordinator",
  );
  a.browser("scrollintoview", ".n-room-header");
  a.browser("screenshot", join(evidence, "coordinator-waiting.png"));
  a.button("Change coordination");
  a.browser("select", "select[name=mode]", "peer");
  a.button("Apply coordination mode");
  await a.wait(
    "document.querySelector('.n-control-bar button')?.disabled===false",
    "Peer mission not startable",
  );
  closePanel(a);
  if (rosterMode) await rosterProof(a, b);
  a.button("Review and start", "document.querySelector('.n-mission-summary')");
  a.button("Start and run");
  for (const n of [a, b, c])
    await n.wait(
      "(async() => (await window.blackboardNode.state()).missions[0].lifecycle.phase === 'active')()",
      "Start did not replicate",
    );
  await c.wait(
    "[...document.querySelectorAll('.n-message-text')].some(e=>e.textContent.includes('Mission started by the owner'))",
    "Start activity not replicated into Main",
  );
  a.browser("screenshot", join(evidence, "mission-active.png"));
  if (rosterMode) {
    await directionProof(a, b);
    await conversationProof(a, b);
    if (communicationMode) await communicationProof(a, b, c);
    if (workMode) await workProof(a, b, c);
  }
  await a.stop();
  await a.start();
  assert.ok(a.evaluate("!!document.querySelector('.n-conversations')"));
  await a.wait(
    "(async() => (await window.blackboardNode.state()).missions[0].lifecycle.phase === 'active')()",
    "Start did not survive restart",
  );
  if (!a.evaluate("!!document.querySelector('.n-control')"))
    a.click(".n-mission-title");
  a.button("Pause mission");
  for (const n of [a, b, c])
    await n.wait(
      "(async() => (await window.blackboardNode.state()).missions[0].lifecycle.phase === 'paused')()",
      "Pause did not replicate",
    );
  a.browser("screenshot", join(evidence, "mission-paused.png"));
  closePanel(a);
  a.button("Review and resume", "document.querySelector('.n-mission-summary')");
  a.button("Resume and run");
  await a.wait(
    "(async() => (await window.blackboardNode.state()).missions[0].lifecycle.phase === 'active')()",
    "Resume not applied",
  );
  if (!a.evaluate("!!document.querySelector('.n-control')"))
    a.click(".n-mission-title");
  a.button("Edit mission");
  a.browser(
    "fill",
    "textarea[name=scope]",
    "The outdoor area is unavailable. Plan indoor activities only; no purchases.",
  );
  a.button("Save instructions");
  for (const n of [a, b, c])
    await n.wait(
      "(async() => (await window.blackboardNode.state()).missions[0].lifecycle.phase === 'preparing')()",
      "Instruction edit did not return mission to Preparing",
    );
  const updated = a.evaluate("window.blackboardNode.state()").missions[0];
  assert.ok(updated.definition.scope.includes("indoor activities"));
  assert.equal(updated.definition.criteria.length, 1);
  c.browser("set", "viewport", "900", "650");
  assert.equal(
    c.evaluate("document.documentElement.scrollWidth>innerWidth"),
    false,
  );
  c.browser("screenshot", join(evidence, "replicated-preparing-small.png"));
  for (const n of [a, b, c])
    assert.equal(
      n.evaluate("window.blackboardNode.state()").execution,
      "unavailable",
    );
  if (!a.evaluate("!!document.querySelector('.n-control')"))
    a.click(".n-mission-title");
  people(a);
}

try {
  const a = await app("owner");
  a.click(".n-empty .d-button");
  a.browser("fill", "input[name=name]", "Community science day");
  a.browser(
    "fill",
    "textarea[name=objective]",
    "Plan a hands-on science day for families.",
  );
  a.browser(
    "fill",
    "textarea[name=scope]",
    "Six activities, accessible spaces and a practical afternoon schedule.",
  );
  a.browser(
    "fill",
    "#criterion",
    "Every activity has an age range and a materials list.",
  );
  a.click(".n-inline button");
  if (discoveryMode)
    a.browser("select", "select[name=participation]", "approval");
  a.click("button[type=submit]");
  await a.wait(
    `!!document.querySelector('.n-room')`,
    "Mission not created",
    packaged ? 180000 : 45000,
  );
  await network(a);
  if (discoveryMode) {
    await discoveryProof(a);
  } else {
    a.click(".n-channel-nav");
    people(a);
    a.button("Create invitation");
    await a.wait(
      `!!document.querySelector('.n-invite-copy textarea')`,
      "Invitation missing",
    );
    const ticket = a.evaluate(
      `document.querySelector('.n-invite-copy textarea').value`,
    );
    const b = await app("participant-b");
    const c = await app("participant-c");
    for (const participant of [b, c]) {
      await network(participant);
      participant.button("Join a mission", "document.querySelector('aside')");
      participant.browser("fill", ".n-join input", ticket);
      participant.click(".n-join button[type=submit]");
      await participant.wait(
        `!!document.querySelector('.n-review')`,
        "Mission review missing",
      );
      assert.equal(
        participant.evaluate(`window.blackboardNode.state()`).missions.length,
        0,
      );
      participant.browser(
        "screenshot",
        join(evidence, `${participant.name}-review.png`),
      );
      participant.button("Request to join");
      await a.wait(
        `!!document.querySelector('.n-requests button.primary')`,
        "Owner approval request missing",
      );
      a.browser(
        "screenshot",
        join(evidence, `${participant.name}-approval.png`),
      );
      a.click(".n-requests button.primary");
      await participant.wait(
        `!!document.querySelector('.n-channel-nav')`,
        "Admitted mission did not appear",
      );
      participant.click(".n-channel-nav");
      assert.equal(
        participant.evaluate(`window.blackboardNode.state()`).execution,
        "unavailable",
      );
    }
    await send(
      b,
      "I will compare the activity options and record the materials needed.",
    );
    await c.wait(
      `document.querySelector('.n-message-text')?.textContent.startsWith('I will compare')`,
      "Public message did not synchronize",
    );
    const cKey = c.evaluate(`window.blackboardNode.state()`).identity.owner;
    people(b);
    await b.wait(
      `document.querySelector('.n-peer-list')?.textContent.includes(${JSON.stringify(cKey)})`,
      "Peer roster incomplete",
    );
    b.button(
      "Message privately",
      `[...document.querySelectorAll('.n-peer-list .n-peer-row')].find(e=>e.textContent.includes(${JSON.stringify(cKey)}))`,
    );
    await b.wait(
      `document.querySelector('.n-channel-title h2')?.textContent==='Private conversation'`,
      "Private conversation missing",
    );
    await send(
      b,
      "Private: check the accessibility details together before sharing a recommendation.",
    );
    await c.wait(
      `!!document.querySelector('.n-conversation-picker option[value^=\"private:\"]')`,
      "Private audience not replicated",
    );
    const privateScope = c.evaluate(
      `document.querySelector('.n-conversation-picker option[value^=\"private:\"]').value`,
    );
    c.click(`.n-conversation-nav [data-audience="${privateScope}"]`);
    await c.wait(
      `document.querySelector('.n-message-text')?.textContent.startsWith('Private:')`,
      "Private message missing",
    );
    const mission = a.evaluate(`window.blackboardNode.state()`).missions[0].id;
    assert.deepEqual(
      a.evaluate(`window.blackboardNode.audiences(${JSON.stringify(mission)})`),
      [],
    );
    c.browser("screenshot", join(evidence, "private-conversation.png"));
    await a.stop();
    b.button("Main", "document.querySelector('.n-conversation-nav')");
    c.button("Main", "document.querySelector('.n-conversation-nav')");
    await send(
      b,
      "The creator is offline. Our shared planning conversation is still available.",
    );
    await c.wait(
      `document.querySelector('.n-messages')?.textContent.includes('The creator is offline.')`,
      "Creator-free conversation failed",
    );
    c.browser("screenshot", join(evidence, "creator-offline.png"));
    c.browser("set", "viewport", "900", "650");
    assert.equal(
      c.evaluate(`document.documentElement.scrollWidth>innerWidth`),
      false,
    );
    c.browser("screenshot", join(evidence, "conversation-small.png"));
    await a.start();
    assert.ok(
      a.evaluate("!!document.querySelector('.n-conversations')"),
      "The owner returns directly to the saved mission after restart",
    );
    await a.wait(
      `document.querySelector('.n-messages')?.textContent.includes('The creator is offline.')`,
      "Owner did not catch up on restart",
    );
    people(a);
    a.browser("screenshot", join(evidence, "owner-reconnected.png"));
    if (lifecycleMode) await lifecycleProof(a, b, c);
    const governance = governanceMode
      ? await (
          await import("./helpers/governance-native.mjs")
        ).governanceProof(a, b, c, {
          evidence,
          closePanel,
          people,
          rosterProof,
        })
      : undefined;
    const artifacts = artifactsMode
      ? await (
          await import("./helpers/artifact-native.mjs")
        ).artifactProof(a, b, c, { root, evidence, closePanel, people })
      : undefined;
    const bKey = b.evaluate("window.blackboardNode.state()").identity.owner;
    await a.wait(
      `document.querySelector('.n-peer-list')?.textContent.includes(${JSON.stringify(bKey)})`,
      "Reconnected roster incomplete",
    );
    a.button(
      "Revoke access…",
      `[...document.querySelectorAll('.n-peer-list .n-peer-row')].find(e=>e.textContent.includes(${JSON.stringify(bKey)}))`,
    );
    a.click(".n-revoke button.primary");
    await b.wait(
      `document.querySelector('.n-mission-summary')?.textContent.includes('membership was revoked')`,
      "Revoked participant did not see the stop notice",
    );
    assert.equal(
      b.evaluate("document.querySelector('#main-message').disabled"),
      true,
    );
    b.browser("screenshot", join(evidence, "revoked-membership.png"));
    await writeFile(
      join(evidence, "result.json"),
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          artifacts,
          governance,
          packaged,
          profiles: 3,
          createInspectRequestApproveThroughUI: true,
          lifecycleThroughUI: lifecycleMode,
          optionalWorkstreamsTasksAndParallelAttempts: workMode,
          sharedRosterThroughUI: rosterMode,
          addressedMessagesThreadsPrivateInboxSent: communicationMode,
          scopedAgentProtocolTestedSeparately: communicationMode,
          contextualPanelsAndDraftRetention: rosterMode,
          formattedMessagesAndReadingPosition: rosterMode,
          privateOwnerExcluded: true,
          creatorOfflineMessages: true,
          restartedOwnerCaughtUp: true,
          revocationThroughUIBlockedWrites: true,
          noAgentsStarted: true,
          overflowAt900: false,
          independentHumanConsentTest: false,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      "Native three-profile create, inspect, approve, public/private messaging and creator restart passed. No agents launched.",
    );
  }
} catch (error) {
  for (const a of apps) {
    try {
      a.browser("screenshot", join(evidence, `${a.name}-failure.png`));
    } catch {}
  }
  throw error;
} finally {
  for (const a of apps) await a.stop();
  await rm(root, { recursive: true, force: true });
}
