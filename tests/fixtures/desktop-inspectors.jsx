import { ApplicationProvider } from "../../src/desktop/ApplicationProvider";
// Renderer-only fixtures. No database, native authority, provider or credentials.
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "../../src/desktop/desktop.css";
import { MissionCompletionScene } from "./mission-completion";

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
      scene === "running" || scene === "network-running"
        ? "running"
        : scene === "planning" || scene === "network-stopped"
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
const denied = () =>
  Promise.reject(new Error("Renderer fixture cannot execute native actions"));
const networkCalls = [];
window.networkFixture = { calls: networkCalls };
const client = {
  workspace: {},
  missions: {
    state: async () => ({ identity: { owner: "owner" }, missions: [mission] }),
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
    state: async () => ({ ...execution, observedAt: Date.now() }),
    signIn: denied,
    stop: denied,
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
        {scene === "network-setup" ? (
          <AgentSetup
            mission={mission}
            localKey="owner"
            role="agent"
            contributions={[]}
            updated={async () => {}}
          />
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
