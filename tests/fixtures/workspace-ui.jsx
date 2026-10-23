// Isolated, deterministic application ports; never connects to a desktop profile.
import { createRoot } from "react-dom/client";
import { ApplicationProvider } from "../../src/desktop/ApplicationProvider";
import Workspace from "../../src/workspace/Workspace";
import "../../src/desktop/desktop.css";
import "../../src/workspace/workspace.css";
const hash = (n) => n.toString(16).padStart(64, "0");
const owner = hash(2);
const empty = new URLSearchParams(location.search).has("empty");
const makeMission = (n, name, phase) => ({
  id: hash(n),
  owner,
  definition: {
    name,
    objective: "Create an engaging science festival for local families.",
    scope: "Two days, three venues. A renderer test only.",
    criteria: ["An accessible programme with a clear schedule."],
    policy: {
      coordination: "peer",
      participation: "private",
      budget: { mode: "unlimited" },
    },
  },
  state: "ready",
  event_count: 3,
  conflicted: false,
  coordinator_node: null,
  lifecycle: {
    phase,
    revision: hash(n + 10),
    terms_revision: hash(n + 20),
    readiness: null,
    coordinator: null,
    plan: null,
    start_blockers: [],
  },
});
const missions = empty
  ? []
  : [
      makeMission(1, "Science festival", "active"),
      makeMission(5, "Community garden", "preparing"),
    ];
let nodeState = {
  status: "ready",
  identity: { owner, endpoint: hash(8), version: 1 },
  missions,
  network: "disabled",
  connection: null,
  joins: [],
  withdrawals: [],
};
let localState = {
  schemaVersion: 1,
  contributor: { id: "local", name: "Alex" },
  device: { id: "device", name: "Test Mac" },
  contributions: [],
  activity: [],
};
const workScene = new URLSearchParams(location.search).has("work");
const artifact = {
  id: hash(200),
  revision: hash(201),
  heads: [hash(201)],
  conversation: "main",
  title: "Festival programme",
  summary:
    "The two-day programme, accessible venue map and practical visitor guide.",
  kind: "application",
  stage: "complete",
  author: hash(3),
  updated_at_ms: Date.now(),
  revision_count: 2,
  file_count: 1,
  entrypoint: "index.html",
  stale: false,
  review_status: "reviewed",
  review_methods: ["browser_check", "visual_inspection"],
  accepted: false,
  highlighted: true,
};
const detail = {
  artifact,
  revision: artifact.revision,
  author: artifact.author,
  parents: [hash(199)],
  stale: false,
  document: {
    title: artifact.title,
    summary: artifact.summary,
    kind: "application",
    stage: "complete",
    limitations: "Venue capacities still need confirmation.",
    entrypoint: "index.html",
    inputs: [],
    files: [
      {
        path: "index.html",
        hash: hash(202),
        size: 4096,
        media_type: "text/html",
      },
    ],
  },
  history: [],
  freshness_notes: [],
  reviews: [],
  acceptance: null,
  highlighted: true,
  available_files: ["index.html"],
  may_publish: true,
  may_review: true,
  may_accept: true,
  may_highlight: true,
};
const agentScene = new URLSearchParams(location.search).has("agents");
const executionRecords = {};
if (agentScene) {
  localState.contributions = ["grok", "claude", "codex"].map(
    (runtime, index) => ({
      id: `local-${index}`,
      mission: {
        missionId: hash(1),
        name: "Science festival",
        role: index === 0 ? "coordinator" : "agent",
        origin: "local",
        inspectedAt: new Date().toISOString(),
      },
      contributorId: "local",
      deviceId: "device",
      runtime,
      limits: { mode: "bounded", concurrency: 1, turns: 20, minutes: 60 },
      status: "prepared",
      nodeBinding: { owner, revision: hash(21) },
      sharedAgent: {
        registration: hash(50 + index),
        author: hash(60 + index),
        label: ["Robin", "Finch", "Wren"][index],
        withdrawn: false,
      },
      workspace: "/isolated-test/export",
      createdAt: new Date().toISOString(),
      revokedAt: null,
    }),
  );
  for (const [index, item] of localState.contributions.entries())
    executionRecords[item.id] = {
      record: {
        status: ["running", "stopped", "recovery_required"][index],
        reason: [
          "Checking the venue evidence.",
          "Process stopped. Saved work is available.",
          "No termination receipt was received.",
        ][index],
        session: "test-session",
        generation: 1,
        expiresAt: Date.now() + 3600000,
      },
      permissions: [],
      direction: null,
      permissionProblem: null,
      capacity: 3,
      busy: false,
      events: [],
    };
}
const messages = [
  {
    id: hash(100),
    text: "We have two possible venues. The library has step-free access; the hall has more space.\n\n**Recommendation:** check capacity before choosing.",
    author: hash(3),
    author_label: "Robin",
    author_agent: null,
    kind: "message",
    audience: "main",
    unread: true,
    provisional: false,
    replies: 0,
    to: owner,
    thread: null,
    created_at_ms: Date.now(),
  },
];
window.calls = [];
const client = {
  workspace: {
    state: async () => localState,
    rename: async (name) =>
      (localState = {
        ...localState,
        contributor: { ...localState.contributor, name },
      }),
  },
  missions: {
    state: async () => nodeState,
    agents: async () => ({ items: [], after: null, total: 0 }),
    observations: async () => [],
    peers: async () => ({ members: [], requests: [], delivery: [] }),
    configureNetwork: async (config) => {
      window.calls.push(["network", config]);
      nodeState = {
        ...nodeState,
        network: "enabled",
        connection: { config, running: true, error: null },
      };
    },
    inspectInvitation: async () => ({
      mission: hash(6),
      owner: hash(70),
      endpoint: hash(71),
      definition: makeMission(6, "Shared workshop", "preparing").definition,
      reviewed_revision: hash(16),
      expires_ms: Date.now() + 600000,
    }),
    requestJoin: async () => {
      window.calls.push(["join"]);
      nodeState = {
        ...nodeState,
        joins: [
          { mission: hash(6), name: "Shared workshop", status: "pending" },
        ],
      };
    },
    withdrawMission: async () => {
      nodeState = { ...nodeState, joins: [] };
      window.calls.push(["withdraw"]);
    },
    audiences: async () => [],
    queryMessages: async (_m, q) => ({
      items: messages.filter(
        (m) =>
          (!q.thread || m.id === q.thread || m.thread === q.thread) &&
          (!q.search || m.text.toLowerCase().includes(q.search.toLowerCase())),
      ),
      before: null,
    }),
    markMessagesRead: async (_m, ids) => {
      window.calls.push(["read", ids]);
    },
    readMessage: async (_m, id) => messages.find((m) => m.id === id),
    postMessage: async (_m, text, audience, to) => {
      messages.push({
        ...messages[0],
        id: hash(101 + messages.length),
        author: owner,
        author_label: "Alex",
        text,
        audience,
        to,
        unread: false,
      });
      window.calls.push(["post", _m, text, audience, to]);
    },
    catchUp: async () => ({ items: [], after: hash(100), has_more: false }),
    workstreams: async () => [],
    tasks: async () => ({ items: [], after: null, total: 0 }),
    artifacts: async (_m, query) => ({
      items:
        workScene &&
        (!query?.search ||
          artifact.title.toLowerCase().includes(query.search.toLowerCase()))
          ? [artifact]
          : [],
      after: null,
      total: workScene ? 1 : 0,
      candidates: workScene
        ? [
            {
              id: hash(203),
              revision: artifact.revision,
              title: artifact.title,
              stale: false,
            },
          ]
        : [],
    }),
    artifactDetail: async () => structuredClone(detail),
    artifactOpen: async (...args) => {
      window.calls.push(["open-artifact", ...args]);
    },
    artifactCache: async () => ({
      state: "saved",
      completed: 1,
      total: 1,
      bytes: 4096,
    }),
    artifactAction: async (_m, control, audience, action) => {
      window.calls.push(["artifact-action", _m, control, audience, action]);
      if (action.type === "accept") {
        detail.acceptance = {
          id: hash(204),
          author: owner,
          accepted: action.accepted,
          reason: action.reason,
          stale: false,
        };
        artifact.accepted = action.accepted;
      }
    },
    governance: async () => ({
      criteria: [],
      allocations: [],
      handover_blockers: [],
      execution_available: true,
      grants: [],
      reservations: [],
      claims: [],
    }),
    pauseMission: async (id) => {
      nodeState = {
        ...nodeState,
        missions: nodeState.missions.map((m) =>
          m.id === id
            ? { ...m, lifecycle: { ...m.lifecycle, phase: "paused" } }
            : m,
        ),
      };
      window.calls.push(["pause", id]);
    },
  },
  setup: {
    takeInvitation: async () => null,
    takeNotification: async () => null,
    startState: async () => [],
    completionState: async () => [],
    appPreferences: async () => ({
      background: false,
      notifications: false,
      notificationsSupported: true,
    }),
    journeyDiagnostics: async () => ({ enabled: false, events: 0 }),
    state: async () => [],
    preflight: async () => ({
      supported: true,
      available: true,
      capacity: 3,
      capacityCeiling: 5,
      freeDiskBytes: 20 * 1024 ** 3,
      minimumDiskBytes: 4 * 1024 ** 3,
      installer: { active: false },
    }),
    setup: async (request) => {
      window.calls.push(["prepare", request]);
    },
  },
  execution: {
    overview: async () =>
      Object.fromEntries(
        Object.entries(executionRecords).map(([id, state]) => [
          id,
          { ...state, observedAt: Date.now() },
        ]),
      ),
    stop: async (id) => {
      window.calls.push(["stop", id]);
      if (id === "local-2")
        throw new Error("Stop remains unconfirmed. Retry recovery.");
      executionRecords[id] = {
        ...executionRecords[id],
        record: {
          ...executionRecords[id].record,
          status: "stopped",
          reason: "Stopped by you.",
        },
      };
    },
  },
  drafting: {
    providers: async () => ({ providers: [] }),
    state: async () => null,
  },
};
createRoot(document.getElementById("root")).render(
  <ApplicationProvider client={client}>
    <Workspace />
  </ApplicationProvider>,
);
