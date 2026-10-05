import { useEffect, useState } from "react";
import { node, type Contribution } from "./bridge";
import type { AgentView, MissionView, ArtifactSummary } from "./node-contract";
import { agentLifecycle } from "../../shared/agent-lifecycle.mjs";
import {
  useExecutionStates,
  useExecutionObservations,
} from "./ExecutionStatus";
import { phaseLabel } from "./Lifecycle";
type Props = {
  mission: MissionView;
  owner: string;
  agents: AgentView[];
  contributions: Contribution[];
  controls: (reviewStart?: boolean) => void;
  people: () => void;
  setup: (role: "agent" | "coordinator") => void;
  agent: (id: string) => void;
};

export function MissionJourney({
  mission,
  owner,
  agents,
  contributions,
  controls,
  setup,
  agent,
}: Props) {
  const states = useExecutionStates();
  const observations = useExecutionObservations();
  const isOwner = owner === mission.owner;
  const phase = mission.lifecycle.phase;
  const [result, setResult] = useState<ArtifactSummary | null>(null);
  const [resultError, setResultError] = useState("");
  useEffect(() => {
    if (!["closed", "archived"].includes(phase)) {
      setResult(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const page = await node.artifacts(mission.id, { conversation: "main" });
        const candidates = page.items.filter(
          (a) => a.accepted && !a.stale && a.heads.length === 1,
        );
        const chosen =
          candidates.find((a) => a.highlighted) ?? candidates[0] ?? null;
        if (!cancelled) {
          setResult(chosen);
          setResultError("");
        }
      } catch (e) {
        if (!cancelled) setResultError((e as Error).message);
      }
      if (!cancelled) timer = setTimeout(load, 10000);
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mission.id, phase]);
  const coordinator = agents.find(
    (a) => a.identity.author === mission.lifecycle.coordinator?.identity.author,
  );
  const c = contributions.find(
    (c) => c.sharedAgent?.registration === coordinator?.id,
  );
  const status = coordinator
    ? agentLifecycle({
        agent: coordinator,
        contribution: c,
        mission,
        execution: c ? states?.[c.id] : undefined,
        observation: observations[coordinator.id],
      })
    : null;
  const mine = contributions.filter(
    (c) =>
      c.mission.missionId === mission.id &&
      c.status === "prepared" &&
      !c.sharedAgent?.withdrawn,
  );
  let title = phaseLabel(mission),
    detail = "",
    label = "Review mission",
    action: () => void = () => controls();
  if (phase === "closed" || phase === "archived") {
    title = "Mission complete";
    detail = "Saved conversations and deliverables remain available.";
    label = "Review results";
  } else if (mission.conflicted) {
    title = "History needs recovery";
    detail = "Resolve conflicting records before continuing.";
  } else if (phase === "paused") {
    title = "Mission paused";
    detail =
      mission.definition.policy?.coordination === "peer"
        ? "The owner can resume work under the current mission instructions."
        : mission.lifecycle.readiness
          ? "The accepted plan is saved. The owner can resume it."
          : "The owner needs to review the plan before resuming.";
    label = isOwner ? "Review and resume" : "View pause reason";
    action = () => controls(isOwner);
  } else if (
    phase === "preparing" &&
    !coordinator &&
    mission.definition.policy?.coordination === "coordinated"
  ) {
    title = isOwner
      ? "Set up your Coordinator"
      : "Waiting for the mission owner";
    detail =
      "The Coordinator prepares a plan; work starts after the owner’s review.";
    label = isOwner ? "Set up Coordinator" : "Add my agents";
    action = () => setup(isOwner ? "coordinator" : "agent");
  } else if (
    phase === "preparing" &&
    !mission.lifecycle.start_blockers.length
  ) {
    title = "Ready for owner review";
    detail =
      mission.definition.policy?.coordination === "coordinated"
        ? "The plan is acknowledged. Agents are waiting for Start."
        : "Agents are waiting for the owner to Start. A Coordinator is optional.";
    label = isOwner ? "Review and start" : "Read the plan";
    action = () => controls(isOwner);
  } else if (phase === "preparing" && coordinator) {
    title = `${coordinator.identity.label} · ${status?.label ?? "Preparing"}`;
    detail = status?.reason ?? "Waiting for the Coordinator’s plan.";
    label = c ? "Continue Coordinator setup" : "View Coordinator";
    action = () => (c ? setup("coordinator") : agent(coordinator.id));
  } else if (phase === "active") {
    const local = agents.filter((a) =>
      mine.some((c) => c.sharedAgent?.registration === a.id),
    );
    const blocked = local.find((a) => {
      const c = mine.find((v) => v.sharedAgent?.registration === a.id)!;
      return agentLifecycle({
        agent: a,
        contribution: c,
        mission,
        execution: states?.[c.id],
      }).attention;
    });
    title = "Mission active";
    detail =
      "Contributors control their own agents. Check results and decisions in Main.";
    label = "View progress";
    if (blocked) {
      title = `${blocked.identity.label} needs your attention`;
      const c = mine.find((c) => c.sharedAgent?.registration === blocked.id)!;
      detail = agentLifecycle({
        agent: blocked,
        contribution: c,
        mission,
        execution: states?.[c.id],
      }).reason;
      label = "Continue agent";
      action = () => agent(blocked.id);
    } else if (!mine.length) {
      detail =
        "You have joined the conversation. Add an agent when you are ready to contribute compute.";
      label = "Add my agents";
      action = () => setup("agent");
    }
  }
  return (
    <section className="n-journey" aria-label="Mission next step">
      <div>
        <strong>{title}</strong>
        <p title={detail}>{detail}</p>
      </div>
      <div>
        {result ? (
          <button
            className="d-button primary"
            title={result.title}
            onClick={async () => {
              try {
                const detail = await node.artifactDetail(
                  mission.id,
                  result.revision,
                );
                const path =
                  detail.document.entrypoint ?? detail.document.files[0]?.path;
                if (!path) {
                  controls();
                  return;
                }
                await node.artifactOpen(mission.id, result.revision, path);
              } catch (e) {
                setResultError((e as Error).message);
              }
            }}
          >
            Open accepted result
          </button>
        ) : null}
        <button className="d-button" onClick={action}>
          {label}
        </button>
        {resultError ? <p role="alert">{resultError}</p> : null}
      </div>
    </section>
  );
}

export function MissionDecisions({
  mission,
  owner,
  agents,
  contributions,
  controls,
  people,
  setup,
  agent,
}: Props) {
  const states = useExecutionStates();
  const observations = useExecutionObservations();
  const [requests, setRequests] = useState(0);
  const [results, setResults] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [peers, ledger] = await Promise.all([
          node.peers(mission.id),
          node.governance(mission.id),
        ]);
        if (!stopped) {
          setRequests(
            peers.requests.filter((r) => r.status === "pending").length,
          );
          setResults(
            !!ledger.criteria.length &&
              ledger.criteria.every((c) => c.met && !c.stale),
          );
          setError("");
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
      if (!stopped) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [mission.id]);
  const ended = ["closed", "archived"].includes(mission.lifecycle.phase);
  const own = mission.owner === owner;
  const coordinated = mission.definition.policy?.coordination === "coordinated";
  const decisions: {
    id: string;
    title: string;
    detail: string;
    action: () => void;
    label: string;
  }[] = [];
  const waiting: {
    id: string;
    title: string;
    detail: string;
    action: () => void;
    label: string;
  }[] = [];
  if (own && requests && !ended)
    decisions.push({
      id: "requests",
      title: `${requests} people want to join`,
      detail:
        "Their request waits for your decision; reading it does not admit them.",
      action: people,
      label: "Review people",
    });
  if (
    own &&
    mission.lifecycle.phase === "preparing" &&
    !mission.lifecycle.start_blockers.length
  )
    decisions.push({
      id: "start",
      title: coordinated
        ? "The plan is ready"
        : "The mission is ready to start",
      detail: coordinated
        ? "Review the Coordinator’s plan and authorize Start."
        : "Review the mission instructions and authorize Start.",
      action: () => controls(true),
      label: "Review and start",
    });
  if (own && results && !ended)
    decisions.push({
      id: "results",
      title: "Results are ready for your review",
      detail:
        "Inspect evidence, accept exact deliverables and close the mission when satisfied.",
      action: controls,
      label: "Review results",
    });
  for (const a of agents) {
    const c = contributions.find((v) => v.sharedAgent?.registration === a.id);
    const s = agentLifecycle({
      mission,
      agent: a,
      contribution: c,
      execution: c ? states?.[c.id] : undefined,
      observation: observations[a.id],
    });
    if (s.attention && c)
      decisions.push({
        id: a.id,
        title: `${a.identity.label} · ${s.label}`,
        detail: s.reason,
        action: () => agent(a.id),
        label: "Open agent",
      });
    else if (
      !ended &&
      ["waiting", "unknown", "setup", "ready", "sign_in"].includes(s.state)
    )
      waiting.push({
        id: a.id,
        title: `${a.identity.label} · ${s.label}`,
        detail: s.reason,
        action: () => agent(a.id),
        label: "View agent",
      });
  }
  if (!ended && !agents.length)
    (own ? decisions : waiting).push({
      id: "setup",
      title: own ? "Prepare the mission" : "Waiting for the mission owner",
      detail: own
        ? coordinated
          ? "Set up a Coordinator to prepare the plan."
          : "Add an agent when you are ready to contribute compute."
        : "You can read Main and add your agents while the owner prepares.",
      action: () => setup(own && coordinated ? "coordinator" : "agent"),
      label: own && coordinated ? "Set up Coordinator" : "Add my agents",
    });
  return (
    <section className="n-decisions" aria-label="Mission decisions">
      <h2>Needs your decision</h2>
      {error ? <p role="alert">Decision status unavailable: {error}</p> : null}
      {!decisions.length ? (
        <p className="d-field-help">Nothing is waiting for your decision.</p>
      ) : (
        decisions.map((d) => (
          <div className="n-decision-row" key={d.id}>
            <div>
              <strong>{d.title}</strong>
              <p>{d.detail}</p>
            </div>
            <button className="d-button" onClick={d.action}>
              {d.label}
            </button>
          </div>
        ))
      )}
      {waiting.length ? (
        <details>
          <summary>Waiting on others · {waiting.length}</summary>
          {waiting.map((d) => (
            <div className="n-decision-row" key={d.id}>
              <div>
                <strong>{d.title}</strong>
                <p>{d.detail}</p>
              </div>
              <button className="d-button" onClick={d.action}>
                {d.label}
              </button>
            </div>
          ))}
        </details>
      ) : null}
    </section>
  );
}
