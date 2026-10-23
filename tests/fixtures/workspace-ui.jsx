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
    criteria: [
      { id: "one", text: "An accessible programme with a clear schedule." },
    ],
    policy: { coordination: "peer" },
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
    artifacts: async () => ({
      items: [],
      after: null,
      total: 0,
      candidates: [],
    }),
    governance: async () => ({
      criteria: [],
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
    state: async () => [],
  },
  execution: { overview: async () => ({}) },
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
