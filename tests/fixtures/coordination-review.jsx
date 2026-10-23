// Honest renderer-only fixtures: no provider, keys or native mutations.
import { useState } from "react";
import { ApplicationProvider } from "../../src/desktop/ApplicationProvider";
import { ArtifactPanel } from "../../src/desktop/Artifacts";
import { People } from "../../src/desktop/Peers";

const h = (c) => c.repeat(64);
export function CoordinationReviewScene({ scene }) {
  const [model] = useState(() => {
    const mission = {
      id: h("a"),
      owner: h("b"),
      conflicted: false,
      definition: {
        name: "Science studio",
        policy: { coordination: "coordinated" },
      },
      lifecycle: { revision: h("c"), phase: "active" },
    };
    const artifact = {
      id: h("d"),
      revision: h("e"),
      heads: [h("e")],
      conversation: "main",
      title: "Circuit explorer",
      summary: "Explore how a switch controls current.",
      kind: "application",
      stage: "complete",
      author: h("f"),
      updated_at_ms: Date.now(),
      revision_count: 2,
      file_count: 1,
      entrypoint: "index.html",
      stale: false,
      review_status: "reviewed",
      review_methods: ["source_inspection", "executed_tests"],
      accepted: false,
      highlighted: false,
    };
    const detail = {
      artifact,
      revision: artifact.revision,
      author: artifact.author,
      document: {
        title: artifact.title,
        summary: artifact.summary,
        kind: artifact.kind,
        stage: "complete",
        limitations: "Visual and science reviews are still needed.",
        inputs: [],
        references: [],
        entrypoint: "index.html",
        files: [
          {
            path: "index.html",
            size: 256,
            hash: h("1"),
            media_type: "text/html",
          },
        ],
      },
      parents: [],
      stale: false,
      history: [],
      reviews: [],
      acceptance: null,
      freshness_notes: [],
      available_files: ["index.html"],
      highlighted: false,
      may_publish: false,
      may_review: true,
      may_accept: true,
      may_highlight: true,
    };
    const agent = {
      id: h("f"),
      contributor: h("2"),
      identity: {
        author: h("f"),
        label: "Grok builder",
        contributor_name: "Riley",
        runtime: "grok",
        role: "agent",
      },
    };
    const calls = [];
    const candidates = [
      {
        id: h("3"),
        revision: artifact.revision,
        title: artifact.title,
        stale: true,
      },
    ];
    const client = {
      missions: {
        artifacts: async (_mission, query) => {
          calls.push({ type: "query", query });
          const items =
            (!query.kind || query.kind === artifact.kind) &&
            (!query.review_status ||
              query.review_status === artifact.review_status)
              ? [structuredClone(artifact)]
              : [];
          return {
            items,
            total: items.length,
            after: null,
            candidates: structuredClone(candidates),
          };
        },
        artifactDetail: async () => structuredClone(detail),
        artifactOpen: async (mission, revision, path) =>
          calls.push({ type: "open", mission, revision, path }),
        artifactAction: async (mission, control, conversation, action) =>
          calls.push({
            type: "action",
            mission,
            control,
            conversation,
            action,
          }),
        peers: async () => ({
          requests: [],
          members: [
            {
              author: h("2"),
              endpoint: h("4"),
              revoked: false,
              withdrawn: false,
            },
          ],
          delivery: [
            {
              endpoint: h("4"),
              last_success_ms: Date.now(),
              last_error: null,
              pending: true,
              stalled_exchanges: 3,
              control_acknowledged: false,
              last_progress_ms: Date.now() - 60000,
              last_converged_ms: null,
            },
          ],
        }),
      },
    };
    return { mission, agent, calls, client };
  });
  window.coordinationFixture = { calls: model.calls };
  const perform = async (operation) => {
    await operation();
    return true;
  };
  return (
    <ApplicationProvider client={model.client}>
      {scene === "coordination-peers" ? (
        <People
          mission={model.mission.id}
          agents={[model.agent]}
          owner={model.mission.owner}
          localKey={model.mission.owner}
          enabled
          busy={false}
          perform={perform}
          network={() => {}}
          privateMessage={() => {}}
        />
      ) : (
        <ArtifactPanel
          mission={model.mission}
          owner={model.mission.owner}
          agents={[model.agent]}
          streams={[]}
          initial={null}
          conversation="main"
          busy={false}
          blocked={false}
          perform={perform}
          changed={async () => {}}
          openConversation={() => {}}
        />
      )}
    </ApplicationProvider>
  );
}
