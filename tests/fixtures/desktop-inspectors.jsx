// Renderer-only fixtures. No database, native authority, provider or credentials.
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "../../src/desktop/desktop.css";

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
  agent,
  observedAt: now,
  permissions: [],
  events: [],
  record: {
    status:
      scene === "running"
        ? "running"
        : scene === "planning"
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
Object.assign(window, {
  contributor: {},
  blackboardNode: {
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
  blackboardExecution: {
    state: async () => ({ ...execution, observedAt: Date.now() }),
    signIn: denied,
    stop: denied,
  },
  blackboardSetup: {
    agreements: async () => [],
    startState: async () => [],
    completionState: async () => [],
  },
});
const { ExecutionPanel } = await import("../../src/desktop/ExecutionPanel");
const { BudgetPanel } = await import("../../src/desktop/BudgetPanel");
createRoot(document.getElementById("root")).render(
  <main style={{ width: "min(100%, 500px)", margin: "24px auto" }}>
    <p className="d-label">Isolated UI fixture · {scene}</p>
    <div className="n-context-body">
      {scene.startsWith("budget") ? (
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
  </main>,
);
