import { ApplicationProvider } from "../../src/desktop/ApplicationProvider";
// Renderer-only fixtures. No database, native authority, provider or credentials.
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "../../src/desktop/desktop.css";
import { MissionCompletionScene } from "./mission-completion";
import { CoordinationReviewScene } from "./coordination-review";
import { MissionControl } from "../../src/desktop/Lifecycle";
import { missionPresentation } from "../../shared/mission-presentation.mjs";

const scene = new URLSearchParams(location.search).get("scene") ?? "sign-in";
const mission = {
  id: "fixture-mission",
  owner: "owner",
  conflicted: false,
  definition: {
    name: "Community science day",
    objective: "Plan a science day for families.",
    scope:
      "Six activities, accessible spaces and a practical afternoon schedule.",
    criteria: ["Activities have an age range and materials list."],
    policy: { coordination: "coordinated", budget: { mode: "unlimited" } },
  },
  lifecycle: {
    phase:
      scene === "running" || scene.startsWith("budget")
        ? "active"
        : "preparing",
    revision: "control",
    terms_revision: "terms",
    start_blockers: ["plan_missing"],
    coordinator: { identity: { author: "coordinator", label: "Coordinator" } },
  },
};
const agent = {
  id: "fixture-agent",
  contributor: "owner",
  status: "ready",
  identity: {
    author: "coordinator",
    label: "Coordinator",
    runtime: "grok",
    role: "coordinator",
    contributor_name: "Fixture owner",
  },
};
const item = {
  id: "fixture-local",
  status: "prepared",
  runtime: "grok",
  mission: { missionId: mission.id, role: "coordinator" },
  nodeBinding: { revision: "terms", owner: "owner" },
  sharedAgent: {
    registration: agent.id,
    author: "coordinator",
    label: "Coordinator",
  },
  limits: { mode: "unlimited", concurrency: 1 },
};
if (scene === "terms-review") item.nodeBinding.revision = "old-terms";
if (scene === "plan-ready") {
  mission.lifecycle.readiness = { id: "ready" };
  mission.lifecycle.start_blockers = [];
}
if (scene.startsWith("mission-paused-")) {
  mission.lifecycle.phase = "paused";
  mission.lifecycle.plan = {
    id: "plan",
    text: "Continue the saved science activities.",
  };
  mission.lifecycle.start_blockers =
    scene === "mission-paused-plan" ? ["coordinator_not_ready"] : [];
  mission.lifecycle.readiness =
    scene === "mission-paused-plan" ? null : { id: "readiness" };
}
const now = Date.now();
const execution = {
  networkAccess: "restricted",
  networkRevision: null,
  agent,
  observedAt: now,
  permissions: [],
  events: [],
  record: {
    status:
      scene === "running" ||
      scene === "network-running" ||
      scene === "limits-running"
        ? "running"
        : [
              "planning",
              "network-stopped",
              "terms-review",
              "plan-ready",
              "limits-stopped",
              "limits-save-error",
            ].includes(scene)
          ? "ready"
          : "login_required",
    reason: "Fixture observation",
    transitions: [],
  },
  authentication:
    scene === "expired"
      ? {
          status: "failed",
          failure: "expired",
          code: "EXPIRED-FIXTURE",
          urls: ["https://example.invalid/expired"],
          expiresAt: now - 1000,
          text: "Expired fixture sign-in",
        }
      : scene === "signing-in"
        ? {
            status: "waiting",
            code: "FIXTURE-ONLY",
            urls: ["https://example.invalid/login"],
            expiresAt: now + 60000,
            text: "Fixture sign-in",
          }
        : null,
};
if (scene.startsWith("limits-")) {
  execution.limits = {
    mode: "bounded",
    concurrency: 1,
    turns: 20,
    minutes: 60,
  };
  execution.limitsRevision = null;
  execution.localAllowance = {
    used: 3,
    remaining: 17,
    deadline: now - 1000,
    issue: "The local time cap has expired.",
  };
}
if (["running", "resume-launching", "resume-failed"].includes(scene)) {
  execution.events = [
    {
      at: now - 10000,
      type: "agent",
      message: "Old planning message must not appear as a current update.",
    },
    { at: now - 1000, type: "runtime_ready", message: "{}" },
    {
      at: now - 900,
      type: "agent",
      message:
        "Building the **shared shell** before integrating the activities.",
    },
    {
      at: now - 100,
      type: "tool_outcome",
      message: JSON.stringify({ outcome: "ok", operation: "post_message" }),
    },
    {
      at: now,
      type: "tool_outcome",
      message: JSON.stringify({
        outcome: "rejected",
        operation: "review_artifact",
      }),
    },
  ];
  execution.operations = [
    { id: "old", kind: "publish", state: "complete", updatedAt: now - 2000 },
    { id: "current", kind: "import", state: "complete", updatedAt: now - 50 },
    { id: "failed", kind: "publish", state: "failed", updatedAt: now },
  ];
  if (scene.startsWith("resume-")) {
    execution.record.status =
      scene === "resume-launching" ? "launching" : "stopped";
    execution.record.transitions = [
      {
        at: now + 1,
        from: "stopped",
        to: "reserving",
        reason: "New permission",
      },
      { at: now + 2, from: "reserving", to: "launching", reason: "Starting" },
      ...(scene === "resume-failed"
        ? [
            {
              at: now + 3,
              from: "launching",
              to: "stopped",
              reason: "Runtime did not start",
            },
          ]
        : []),
    ];
  }
}
const denied = () =>
  Promise.reject(new Error("Renderer fixture cannot execute native actions"));
const networkCalls = [];
window.networkFixture = { calls: networkCalls };
const client = {
  workspace: {},
  missions: {
    state: async () => ({ identity: { owner: "owner" }, missions: [mission] }),
    reviewContribution: async (id, role) => {
      networkCalls.push({ type: "review-terms", id, role });
      return {
        reviewId: "review-fixture",
        definition: mission.definition,
        mission: item.mission,
        nodeBinding: {
          owner: mission.owner,
          revision: mission.lifecycle.terms_revision,
        },
      };
    },
    renewContribution: async (input) => {
      networkCalls.push({ type: "renew-terms", input });
      item.nodeBinding.revision = mission.lifecycle.terms_revision;
      return {};
    },
    governance: async () => ({
      criteria: [],
      allocations:
        scene === "budget-reserved" || scene === "budget-expired"
          ? [
              {
                id: "allocation",
                node: "distant-contributor",
                charged: 2,
                reserved: 1,
                slots: 1,
                turns: 10,
              },
            ]
          : [],
      grants:
        scene === "budget-reserved" || scene === "budget-expired"
          ? [
              {
                id: "grant",
                registration: "agent",
                node: "distant-contributor",
                expires_ms: scene === "budget-expired" ? now - 1 : now + 60000,
                issued_ms: now - 1000,
                offline_ms: 61000,
                turns: 10,
                charged: 2,
                reserved: 1,
              },
            ]
          : [],
      reservations:
        scene === "budget-reserved" || scene === "budget-expired"
          ? [
              {
                id: "reservation",
                grant: "grant",
                receipt: null,
                resolution: null,
                stopped: false,
                used: null,
              },
            ]
          : [],
      handover_blockers: [],
    }),
    artifacts: async () => ({ items: [], after: null }),
  },
  execution: {
    overview: async () => ({
      [item.id]: await client.execution.state(item.id),
    }),
    state: async () => ({ ...execution, observedAt: Date.now() }),
    signIn: denied,
    stop: denied,
    setLimits: async (id, limits, expectedRevision) => {
      if (scene === "limits-save-error")
        throw new Error("Stop could not be confirmed. Limits are unchanged.");
      networkCalls.push({ type: "limits", id, limits, expectedRevision });
      execution.limits = limits;
      execution.limitsRevision = crypto.randomUUID();
      execution.localAllowance = {
        used: 3,
        remaining: 17,
        deadline: now + 3600000,
        issue: null,
      };
    },
    setCapabilityPack: async (id, capabilityPack, expectedRevision) => {
      networkCalls.push({
        type: "toolkit",
        id,
        capabilityPack,
        expectedRevision,
      });
      execution.capabilityPack = capabilityPack;
      execution.capabilityRevision = crypto.randomUUID();
    },
    setNetwork: async (id, networkAccess, expectedRevision) => {
      networkCalls.push({
        type: "network",
        id,
        networkAccess,
        expectedRevision,
      });
      execution.networkAccess = networkAccess;
      execution.networkRevision = crypto.randomUUID();
    },
  },
  setup: {
    state: async () => [],
    preflight: async () => ({
      available: true,
      supported: true,
      capacity: 2,
      capacityCeiling: 4,
      freeDiskBytes: 1024 ** 4,
      minimumDiskBytes: 4 * 1024 ** 3,
      installer: { active: false },
    }),
    setup: async (request) => networkCalls.push({ type: "setup", request }),
    agreements: async () => [],
    startState: async () => [],
    reviewedStart: async (request) =>
      networkCalls.push({ type: "reviewed-start", request }),
    completionState: async () => [],
  },
};
const { ExecutionPanel } = await import("../../src/desktop/ExecutionPanel");
const { BudgetPanel } = await import("../../src/desktop/BudgetPanel");
const { AgentSetup } = await import("../../src/desktop/Onboarding");
createRoot(document.getElementById("root")).render(
  <ApplicationProvider client={client}>
    <main
      style={{
        width: "min(100%, 500px)",
        margin: "24px auto",
        height: "calc(100dvh - 48px)",
        overflow: "auto",
      }}
    >
      <p className="d-label">Isolated UI fixture · {scene}</p>
      <div className="n-context-body">
        {scene.startsWith("mission-paused-") ? (
          <MissionControl
            mission={mission}
            isOwner={scene !== "mission-paused-contributor"}
            blocked={false}
            busy={false}
            open
            contributions={[]}
            agents={[]}
            perform={async (operation) => {
              await operation();
              return true;
            }}
            updated={async () => {}}
            presentation={missionPresentation({
              mission,
              viewer:
                scene === "mission-paused-contributor"
                  ? "contributor"
                  : "owner",
            })}
            act={denied}
          />
        ) : scene === "network-setup" ? (
          <AgentSetup
            mission={mission}
            localKey="owner"
            role="agent"
            contributions={[]}
            updated={async () => {}}
          />
        ) : scene.startsWith("coordination-") ? (
          <CoordinationReviewScene scene={scene} />
        ) : scene.startsWith("completion-") ? (
          <MissionCompletionScene scene={scene} />
        ) : scene.startsWith("budget") ? (
          <BudgetPanel
            mission={mission}
            owner="owner"
            agents={[]}
            contributions={[]}
            busy={false}
            perform={denied}
          />
        ) : (
          <ExecutionPanel item={item} mission={mission} />
        )}
      </div>
    </main>
  </ApplicationProvider>,
);
