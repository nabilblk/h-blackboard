import test from "node:test";
import assert from "node:assert/strict";
import {
  agentContributorLabel,
  agentLifecycle,
  lifecycleSummary,
} from "../shared/agent-lifecycle.mjs";
import {
  loginURL,
  cleanLoginOutput,
  loginLinks,
} from "../desktop/execution/authentication.mjs";
import { invitationLink } from "../desktop/invitation-links.mjs";
import { OnboardingRequests } from "../desktop/onboarding.mjs";

test("remote first-person names never attribute execution control to the viewer", () => {
  const mission = { owner: "owner" };
  const agent = {
    contributor: "owner",
    identity: { contributor_name: "You" },
  };
  assert.equal(agentContributorLabel(agent, mission, true), "you");
  const remote = agentLifecycle({ agent, mission });
  assert.equal(remote.local, false);
  assert.equal(remote.action, null);
  assert.match(remote.reason, /controlled by the mission owner/);
  agent.contributor = "12345678other";
  assert.equal(agentContributorLabel(agent, mission), "Participant 12345678");
  agent.identity.contributor_name = "Puzzle contributor";
  assert.equal(agentContributorLabel(agent, mission), "Puzzle contributor");
  agent.identity.contributor_name = "";
  assert.equal(agentContributorLabel(agent, mission), "Participant 12345678");
  assert.equal(
    agentContributorLabel(undefined, mission),
    "another contributor",
  );
});

test("status distinguishes authority, idle, confirmed stop and unknown observation", () => {
  const mission = {
    lifecycle: {
      phase: "preparing",
      terms_revision: "terms",
      coordinator: null,
    },
  };
  const contribution = {
    status: "prepared",
    nodeBinding: { revision: "terms" },
  };
  const execution = {
    observedAt: 1000,
    record: { status: "ready" },
    permissions: [],
  };
  const input = { mission, contribution, execution, now: 2000 };
  assert.match(agentLifecycle(input).reason, /owner to start/);
  mission.lifecycle.phase = "active";
  assert.equal(agentLifecycle(input).state, "waiting");
  execution.permissions = [{ consent: null }];
  assert.equal(agentLifecycle(input).label, "Approval needed");
  execution.permissions[0].consent = "yes";
  assert.equal(agentLifecycle(input).state, "ready");
  execution.record.status = "running";
  mission.lifecycle.phase = "paused";
  assert.equal(agentLifecycle(input).state, "running");
  assert.match(agentLifecycle(input).reason, /waiting.*stop/);
  execution.record.status = "stopping";
  assert.equal(agentLifecycle(input).state, "stopping");
  execution.record.status = "waiting";
  assert.equal(agentLifecycle(input).state, "idle");
  execution.record.status = "stopped";
  assert.equal(agentLifecycle(input).state, "waiting");
  assert.equal(agentLifecycle({ ...input, now: 20000 }).state, "unknown");
  assert.equal(
    agentLifecycle({ ...input, contribution: undefined }).state,
    "unknown",
  );
  assert.match(lifecycleSummary([agentLifecycle(input)]), /1 waiting/);
});

test("authentication links and OS invitations have narrow independent trust boundaries", () => {
  assert.equal(loginURL("codex", "https://auth.openai.com/device"), true);
  for (const url of [
    "https://auth.openai.com.evil.test/",
    "file:///tmp/foo",
    "https://x@auth.openai.com/",
    "https://auth.openai.com:444/device",
    "http://auth.openai.com/",
  ])
    assert.equal(loginURL("codex", url), false);
  assert.equal(loginURL("grok", "https://auth.openai.com/device"), false);
  assert.equal(loginURL("claude", "https://claude.com/oauth/authorize"), true);
  assert.equal(loginURL("claude", "https://claude.com.evil.test/oauth"), false);
  assert.deepEqual(
    loginLinks(
      "grok",
      "Visit https://accounts.x.ai/device. Then https://evil.test/",
    ),
    ["https://accounts.x.ai/device"],
  );
  assert.equal(cleanLoginOutput("\x1b[31mCode ABC\x1b[0m"), "Code ABC");
  assert.ok(invitationLink("harakiri://join/aabbcc"));
  for (const url of [
    "harakiri://desktop/index.html",
    "harakiri://join/aa?run=1",
    "harakiri://user@join/aa",
    "harakiri://join/../aa",
    "file:///etc/passwd",
  ])
    assert.equal(invitationLink(url), null);
  assert.throws(() =>
    OnboardingRequests.setup.parse({ command: "sh", workspace: "/Users" }),
  );
});

test("an owner-local Coordinator needs the viewer’s planning approval, not someone else’s", () => {
  const result = agentLifecycle({
    agent: { contributor: "owner", identity: { author: "coordinator" } },
    mission: {
      owner: "owner",
      lifecycle: {
        phase: "preparing",
        terms_revision: "terms",
        coordinator: { identity: { author: "coordinator" } },
      },
    },
    contribution: { status: "prepared", nodeBinding: { revision: "terms" } },
    execution: {
      observedAt: 1000,
      record: { status: "ready" },
      permissions: [],
    },
    now: 2000,
  });
  assert.equal(result.state, "waiting");
  assert.equal(result.attention, true);
  assert.match(result.reason, /Review and approve.*planning.*this Mac/);
});

test("mission closure removes expected stop warnings without hiding a still-running process", () => {
  const mission = { lifecycle: { phase: "closed", terms_revision: "terms" } };
  const contribution = {
    status: "prepared",
    nodeBinding: { revision: "terms" },
  };
  const execution = {
    observedAt: 1000,
    record: { status: "stopped" },
    permissions: [],
  };
  assert.equal(
    agentLifecycle({ mission, contribution, execution, now: 2000 }).attention,
    false,
  );
  assert.equal(
    agentLifecycle({ mission, contribution, execution, now: 2000 }).label,
    "Work ended",
  );
  execution.record.status = "running";
  assert.equal(
    agentLifecycle({ mission, contribution, execution, now: 2000 }).label,
    "Running",
  );
});

test("remote status expires without inferring a stopped process", () => {
  const mission = {
    owner: "owner",
    lifecycle: { phase: "active", revision: "current" },
  };
  const agent = { contributor: "owner" };
  const observation = {
    expiresAt: 4000,
    report: { control: "current", state: "running", issued_ms: 1000 },
  };
  assert.equal(
    agentLifecycle({ mission, agent, observation, now: 2000 }).label,
    "Running",
  );
  assert.equal(
    agentLifecycle({ mission, agent, observation, now: 5000 }).label,
    "Status unknown",
  );
  assert.match(
    agentLifecycle({ mission, agent, observation, now: 5000 }).reason,
    /expired/,
  );
});

test("provider expiry is explicit, does not slide on output and differs from the local login deadline", async () => {
  const { loginPresentation } =
    await import("../desktop/execution/authentication.mjs");
  const noExpiry = loginPresentation(
    "grok",
    "https://accounts.x.ai/oauth2/device?user_code=AAAA-BBBB",
    1000,
  );
  assert.equal(noExpiry.code, "AAAA-BBBB");
  assert.equal(noExpiry.expiresAt, null);
  assert.equal(noExpiry.localDeadline, 601000);
  const provided = loginPresentation(
    "grok",
    "https://accounts.x.ai/oauth2/device?user_code=AAAA-BBBB valid for 5 minutes",
    1000,
  );
  assert.ok(provided.expiresAt > Date.now());
  const repeated = loginPresentation(
    "grok",
    "https://accounts.x.ai/oauth2/device?user_code=AAAA-BBBB valid for 5 minutes\nWaiting…",
    1000,
    provided,
  );
  assert.equal(repeated.expiresAt, provided.expiresAt);
  assert.equal(
    loginPresentation("grok", "Code expired", 1000).failure,
    "expired",
  );
  assert.equal(
    loginPresentation("codex", "https://evil.test/?user_code=LEAK-CODE", 1000)
      .code,
    null,
  );
});

test("background and capacity preferences survive restart without silently opting in", async (t) => {
  const { BackgroundPreference } = await import("../desktop/background.mjs");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "hb-preferences-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const preference = new BackgroundPreference(directory);
  assert.equal(preference.read(), false);
  assert.equal(preference.notifications(), false);
  preference.setCapacity(2);
  assert.equal(preference.read(), false);
  preference.set(true);
  preference.setNotifications(true);
  const restored = new BackgroundPreference(directory);
  assert.equal(restored.read(), true);
  assert.equal(restored.capacity(), 2);
  assert.equal(restored.notifications(), true);
  restored.set(false);
  assert.equal(restored.capacity(), 2);
  assert.throws(() => restored.setCapacity(-1));
  restored.setNotifications(false);
  assert.equal(restored.notifications(), false);
});

test("background decisions are opt-in, coalesced and disclose no mission or provider text", async () => {
  const { DecisionNotifications } =
    await import("../desktop/decision-notifications.mjs");
  const sent = [];
  let reads = 0;
  const m = {
    id: "a".repeat(64),
    owner: "owner",
    definition: { objective: "PRIVATE OBJECTIVE" },
    lifecycle: {
      phase: "preparing",
      revision: "b".repeat(64),
      start_blockers: [],
    },
  };
  const monitor = new DecisionNotifications({
    node: {
      handle: async (method) => {
        reads++;
        return method === "peers"
          ? { requests: [{ author: "PRIVATE INVITE", status: "pending" }] }
          : {
              criteria: [{ met: true, stale: false, report: "PRIVATE REPORT" }],
            };
      },
    },
    agreements: {
      list: () => [
        { id: "local", status: "interrupted", message: "PROVIDER TOKEN" },
        { id: "another", status: "interrupted", message: "PRIVATE OUTPUT" },
      ],
    },
    onboarding: { state: () => [] },
    show: (notice) => sent.push(notice),
  });
  const snapshot = { identity: { owner: "owner" }, missions: [m] };
  await monitor.poll(snapshot, { enabled: false, focused: false });
  assert.equal(reads, 0);
  await monitor.poll(snapshot, { enabled: true, focused: false });
  assert.equal(sent.length, 2, "At most two alerts per exchange");
  await monitor.poll(snapshot, { enabled: true, focused: false });
  assert.equal(sent.length, 4);
  await monitor.poll(snapshot, { enabled: true, focused: false });
  assert.equal(sent.length, 4, "Identical conditions are not repeated");
  assert.doesNotMatch(JSON.stringify(sent), /PRIVATE|PROVIDER|TOKEN/);
  assert.doesNotMatch(
    JSON.stringify([...monitor.seen]),
    /PRIVATE|PROVIDER|TOKEN/,
  );
  m.lifecycle.revision = "c".repeat(64);
  await monitor.poll(snapshot, { enabled: true, focused: true });
  await monitor.poll(snapshot, { enabled: true, focused: false });
  assert.equal(
    sent.length,
    4,
    "A condition already seen in the window does not interrupt later",
  );
  m.lifecycle.phase = "closed";
  m.lifecycle.revision = "d".repeat(64);
  await monitor.poll(snapshot, { enabled: true, focused: false });
  assert.equal(sent.length, 4, "Closure never prompts to start work again");
});

test("optional journey diagnostics retain only bounded structured states, never provider output", async (t) => {
  const { JourneyDiagnostics } =
    await import("../desktop/journey-diagnostics.mjs");
  const { mkdtempSync, rmSync, readdirSync, readFileSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "hb-journey-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = new JourneyDiagnostics(root);
  log.transition("fixture-identity", "sign_in", "waiting");
  log.transition("fixture-identity", "sign_in", "waiting");
  assert.equal(log.summary().events, 1);
  assert.throws(() =>
    log.transition(
      "fixture-identity",
      "sign_in",
      "TOKEN-secret https://auth.example/code",
    ),
  );
  log.transition("fixture-identity", "sign_in", "complete");
  const stored = readFileSync(join(root, readdirSync(root)[0]), "utf8");
  assert.doesNotMatch(stored, /fixture-identity|TOKEN|https:/);
  const restored = new JourneyDiagnostics(root);
  assert.equal(restored.summary().events, 2);
  restored.clear();
  assert.equal(restored.summary().events, 0);
});
