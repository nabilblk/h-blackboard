// Isolated renderer data. No native node, runtime, database or credentials.
import { useState } from "react";
import { ApplicationProvider } from "../../src/desktop/ApplicationProvider";
import { MissionProgress } from "../../src/desktop/MissionProgress";
import { MissionActivity } from "../../src/desktop/MissionJourney";
import { ArtifactPanel } from "../../src/desktop/Artifacts";
import { missionPresentation } from "../../shared/mission-presentation.mjs";

const h = (value) => value.repeat(64);
export function MissionCompletionScene({ scene }) {
  const [model] = useState(() => {
    const mission = {
      id: h("a"),
      owner: h("b"),
      conflicted: false,
      definition: {
        name: "Community science day",
        objective: "Create a working science playground.",
        policy: { coordination: "coordinated" },
      },
      lifecycle: {
        revision: h("c"),
        terms_revision: h("a"),
        phase:
          scene === "completion-plan-preparing"
            ? "preparing"
            : scene === "completion-closed"
              ? "closed"
              : "active",
        plan: { artifact: h("d") },
        coordinator: { identity: { author: h("f") } },
        readiness: null,
        start_blockers: scene === "completion-closed" ? ["closed"] : [],
      },
    };
    const artifact = {
      id: h("d"),
      revision: h("d"),
      title: "Shared plan",
      kind: "plan",
      stage: "complete",
      conversation: "main",
      stale: false,
      heads: [h("d")],
    };
    const detail = {
      artifact,
      revision: artifact.revision,
      author: h("f"),
      stale: false,
      document: {
        kind: "plan",
        title: "Shared plan",
        summary:
          "A plan to build and test the playground. The playground has not been delivered.",
        stage: "complete",
        inputs: [],
        files: [],
      },
      history: [],
      reviews: [],
      acceptance: null,
      may_accept: true,
      available_files: [],
    };
    const agent = {
      id: h("f"),
      contributor: mission.owner,
      identity: {
        author: h("f"),
        label: "Coordinator",
        role: "coordinator",
        runtime: "grok",
      },
    };
    const calls = [];
    const criteria = [
      {
        index: 0,
        wording: "A playable playground with two learning activities",
        met: ["completion-results", "completion-saved"].includes(scene),
        stale: false,
        evidence: [h("d")],
      },
    ];
    let job =
      scene === "completion-saved"
        ? {
            id: "d2518b71-cce6-4197-8858-ecbd5d698cf2",
            status: "interrupted",
            accepted: [],
            message: "Earlier completion was interrupted.",
            request: {
              id: "d2518b71-cce6-4197-8858-ecbd5d698cf2",
              mission: mission.id,
              control: mission.lifecycle.revision,
              revisions: [artifact.revision],
              reason: "Perfect",
            },
          }
        : null;
    const client = {
      missions: {
        governance: async () => ({
          criteria: structuredClone(criteria),
          grants: [],
          handover_blockers: [],
        }),
        artifacts: async () => ({
          items: [structuredClone(artifact)],
          after: null,
        }),
        artifactDetail: async () => structuredClone(detail),
        artifactAction: async (mission, control, conversation, action) => {
          calls.push({ type: "artifact", action });
          detail.acceptance = { ...action, author: h("b"), stale: false };
        },
        missionAction: async (id, revision, action) => {
          calls.push({ type: "mission", action });
          mission.lifecycle.phase =
            action.type === "close" ? "closed" : "archived";
        },
      },
      setup: {
        completionState: async () => (job ? [structuredClone(job)] : []),
        completeMission: async (request) => {
          calls.push({ type: "completion", request });
          if (request.closeConfirmed !== true)
            throw new Error("Explicit close confirmation required");
          mission.lifecycle.phase = "closed";
          job = {
            id: request.id,
            request,
            status: "complete",
            accepted: request.revisions,
            message: "Mission closed",
          };
          return job;
        },
        discardCompletion: async () => {
          calls.push({ type: "discard" });
          job = null;
        },
      },
    };
    return { mission, artifact, agent, client, calls, criteria };
  });
  const [, render] = useState(0);
  const [selected, select] = useState(null);
  const updated = async () => render((v) => v + 1);
  const perform = async (action) => {
    await action();
    await updated();
  };
  window.completionFixture = {
    calls: model.calls,
    phase: model.mission.lifecycle.phase,
    changeControl: () => {
      model.mission.lifecycle.revision = h("e");
      void updated();
    },
    staleArtifact: () => {
      model.artifact.stale = true;
    },
    meetCriteria: () => {
      model.criteria[0].met = true;
    },
  };
  const { mission, agent } = model;
  const contribution = {
    id: "local",
    status: "prepared",
    mission: { missionId: mission.id },
    nodeBinding: { revision: mission.lifecycle.terms_revision },
  };
  return (
    <ApplicationProvider client={model.client}>
      <p data-testid="completion-phase">{mission.lifecycle.phase}</p>
      {scene === "completion-closed" ? (
        <MissionActivity
          mission={mission}
          act={() => {}}
          value={missionPresentation({
            mission,
            viewer: mission.owner,
            agents: [agent],
            contributions: [
              { ...contribution, sharedAgent: { registration: agent.id } },
            ],
            states: {
              local: {
                observedAt: Date.now(),
                record: { status: "stopped" },
                permissions: [],
              },
            },
          })}
        />
      ) : selected ? (
        <ArtifactPanel
          mission={mission}
          owner={mission.owner}
          agents={[agent]}
          streams={[]}
          initial={selected}
          conversation="main"
          busy={false}
          blocked={false}
          perform={perform}
          changed={updated}
          openConversation={() => select(null)}
        />
      ) : (
        <MissionProgress
          mission={mission}
          owner={mission.owner}
          agents={[agent]}
          busy={false}
          perform={perform}
          updated={updated}
          openArtifact={select}
        />
      )}
    </ApplicationProvider>
  );
}
