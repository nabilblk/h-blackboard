import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ApplicationProvider } from "../../src/desktop/ApplicationProvider";
import { Conversation } from "../../src/desktop/Conversation";
import { ExecutionRecovery } from "../../src/desktop/ExecutionRecovery";
import { NodeRecovery } from "../../src/desktop/NodeRecovery";
import { ArtifactOffline } from "../../src/desktop/ArtifactOffline";
import { MissionRoom } from "../../src/desktop/Missions";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "../../src/desktop/desktop.css";
const hash = (n) => n.toString(16).padStart(64, "0"),
  mission = {
    id: hash(1),
    owner: hash(2),
    definition: {
      name: "Shared investigation",
      objective: "Compare evidence and deliver a recommendation",
      scope: "An isolated renderer fixture",
      criteria: [],
    },
    lifecycle: { phase: "active", revision: hash(3), terms_revision: hash(4) },
    conflicted: false,
  };
window.calls = [];
let messages = Array.from({ length: 240 }, (_, i) => ({
  id: hash(i + 100),
  text: `Finding ${i + 1}: the proposed approach needs an independent check.`,
  kind: "message",
  author: hash(2),
  created_at_ms: Date.now() + i,
  audience: "main",
  unread: false,
  provisional: false,
  replies: 0,
  to: null,
  thread: null,
}));
window.addMessage = () =>
  messages.push({
    ...messages[0],
    id: hash(9999),
    text: "A new result is ready.",
  });
const client = {
  missions: {
    agents: async () => ({ items: [], after: null }),
    observations: async () => [],
    peers: async () => ({ members: [], requests: [], delivery: [] }),
    audiences: async () => [
      { id: "main", label: "Main", writable: true, unread: 0 },
    ],
    queryMessages: async (_m, q) => ({
      items: q.thread
        ? messages.filter((m) => m.id === q.thread || m.thread === q.thread)
        : q.search
          ? messages.filter((m) => m.text.includes(q.search))
          : q.anchor
            ? messages.filter((m) => m.id <= q.anchor)
            : messages,
      before: null,
    }),
    markMessagesRead: async () => {},
    copyMessageReference: async (_m, id) => window.calls.push(["copy", id]),
    readMessage: async (_m, id) => messages.find((m) => m.id === id),
    catchUp: async (_m, after) => ({
      items: after ? messages.filter((m) => m.id > after).slice(0, 32) : [],
      after: after
        ? (messages
            .filter((m) => m.id > after)
            .slice(0, 32)
            .at(-1)?.id ?? after)
        : messages.at(-1).id,
      has_more: false,
      start_after: after,
    }),
    workstreams: async () => [],
    tasks: async () => ({ items: [], total: 0, after: null }),
    artifacts: async () => ({
      items: [],
      total: 0,
      after: null,
      candidates: [],
    }),
    governance: async () => ({
      criteria: [],
      grants: [],
      reservations: [],
      claims: [],
    }),
    backupNode: async () => {
      window.calls.push("backup");
      return { cancelled: false };
    },
    artifactCache: async (_m, _r, action) => {
      if (action !== "status") window.calls.push(action);
      return {
        state: "partial",
        completed: 1,
        total: 3,
        bytes: 65536,
        error: null,
      };
    },
  },
  setup: { startState: async () => [] },
  execution: {
    overview: async () => ({}),
    restoreCheckpoint: async () => {
      window.calls.push("restore");
      return { destination: "recovered-123", imported: 4 };
    },
    cancelOperation: async () => window.calls.push("cancel"),
  },
};
function Fixture() {
  const [session, setSession] = useState({
    audience: "main",
    drafts: { main: "Keep this draft" },
  });
  const scene = new URLSearchParams(location.search).get("scene");
  if (scene === "workspace")
    return (
      <main
        className="d-main d-main-mission"
        style={{ height: "100dvh", marginLeft: 0 }}
      >
        <MissionRoom
          mission={mission}
          owner={hash(2)}
          name="You"
          contributions={[]}
          busy={false}
          error=""
          readScroll={() => undefined}
          rememberScroll={() => {}}
          session={session}
          updateSession={setSession}
          updated={async () => {}}
          enabled={false}
          network={() => {}}
          prepare={() => {}}
          perform={async (fn) => {
            await fn();
            return true;
          }}
        />
      </main>
    );
  if (scene === "recovery")
    return (
      <main
        style={{
          maxWidth: 640,
          margin: "0 auto",
          padding: 24,
          height: "100dvh",
          overflow: "auto",
        }}
      >
        <ExecutionRecovery
          id="fixture"
          api={client.execution}
          stopped
          changed={() => {}}
          state={{
            operations: [
              {
                id: hash(5),
                kind: "publish",
                label: "Publish source bundle",
                state: "running",
                updatedAt: Date.now(),
                progress: {
                  completed: 2,
                  total: 4,
                  detail: "Verifying received files",
                },
              },
            ],
            checkpoints: [
              {
                id: hash(6),
                at: Date.now(),
                files: 4,
                bytes: 128,
                exclusions: [
                  { path: "node_modules", reason: "Dependency cache" },
                ],
              },
            ],
          }}
        />
        <NodeRecovery
          enrolled
          perform={async (fn) => {
            await fn();
            return true;
          }}
          updated={async () => {}}
        />
        <ArtifactOffline mission={mission.id} revision={hash(8)} />
      </main>
    );
  return (
    <main
      className="d-main d-main-mission"
      style={{ height: "100dvh", marginLeft: 0 }}
    >
      <section className="n-room">
        <Conversation
          contributions={[]}
          streams={[]}
          taskCount={0}
          artifactCount={0}
          artifacts={() => {}}
          tasks={() => {}}
          editStream={() => {}}
          mission={mission}
          owner={hash(2)}
          name="You"
          busy={false}
          blocked={false}
          session={session}
          updateSession={setSession}
          readScroll={() => undefined}
          rememberScroll={() => {}}
          perform={async (fn) => {
            await fn();
            return true;
          }}
          members={() => {}}
          profile={() => {}}
          detailsOpen={false}
          closeDetails={() => {}}
        />
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")).render(
  <ApplicationProvider client={client}>
    <Fixture />
  </ApplicationProvider>,
);
