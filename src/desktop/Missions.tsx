import {
  MissionJourney,
  MissionDecisions,
  MissionActivity,
} from "./MissionJourney";
import {
  ExecutionStatusProvider,
  useExecutionStates,
  useExecutionObservations,
  useExecutionClock,
} from "./ExecutionStatus";
import { AgentSetup } from "./Onboarding";
import { useSetupDraft } from "./useSetupDraft";
import {
  missionPresentation,
  type PresentationAction,
} from "../../shared/mission-presentation.mjs";
import { BudgetPanel } from "./BudgetPanel";
import type { StartJob } from "./onboarding-types";
import { MissionProgress } from "./MissionProgress";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Hash,
  LockKeyhole,
  Plus,
  Pause,
  Square,
  X,
} from "lucide-react";
import { node, type NodeState, type Contribution } from "./bridge";
import { MissionControl, phaseLabel } from "./Lifecycle";
import { People } from "./Peers";
import { ContextPanel } from "./ContextPanel";
import { Conversation, type MissionSession } from "./Conversation";
export type { MissionSession } from "./Conversation";
import { ArtifactPanel } from "./Artifacts";
import { TaskPanel } from "./Tasks";
import { WorkstreamPanel } from "./Workstream";
import { AgentRoster } from "./Agents";
import { PublishMission } from "./Discovery";
import type {
  Coordination,
  Participation,
  MissionDefinition,
  MissionView,
  WithdrawalView,
  WorkstreamView,
  AgentView,
  JoinView,
  CriterionView,
  ArtifactSummary,
} from "./node-contract";
import { Heading, Status, type Perform } from "./ui";

export function MyMissions({
  state,
  busy,
  create,
  join,
  open,
  withdraw,
}: {
  state: NodeState | null;
  busy: boolean;
  create: () => void;
  join: () => void;
  open: (id: string) => void;
  withdraw: (id: string) => void;
}) {
  return (
    <>
      <Heading
        section="This node / My missions"
        title="Your missions, on your computer."
        action={
          <div className="n-action-row">
            <button className="d-button" disabled={busy} onClick={join}>
              Join a mission
            </button>
            <button
              className="d-button primary"
              disabled={busy || !state}
              onClick={create}
            >
              <Plus size={16} />
              Create mission
            </button>
          </div>
        }
      >
        Define a goal, gather the context and start a shared conversation.
      </Heading>
      {!state ? (
        <p role="status">Opening your local node…</p>
      ) : state.missions.length ? (
        <section className="n-mission-list" aria-label="My missions">
          {state.missions
            .filter((m) => m.lifecycle.phase !== "archived")
            .map((m) => (
              <button
                key={m.id}
                className="n-mission-row"
                onClick={() => open(m.id)}
              >
                <Hash size={22} />
                <span>
                  <strong>{m.definition.name}</strong>
                  <small>{m.definition.objective}</small>
                </span>
                <Status muted>{phaseLabel(m)}</Status>
              </button>
            ))}
        </section>
      ) : (
        <section className="d-empty n-empty">
          <Hash size={30} />
          <h2>Start a mission here.</h2>
          <p>
            Give it an objective, a scope and a clear idea of success. Main is
            your shared starting point.
          </p>
          <button className="d-button" disabled={busy} onClick={create}>
            <Plus size={16} />
            Define the first mission
          </button>
        </section>
      )}
      {state?.missions.some((m) => m.lifecycle.phase === "archived") ? (
        <details className="n-archived">
          <summary>Archived channels</summary>
          <section className="n-mission-list">
            {state.missions
              .filter((m) => m.lifecycle.phase === "archived")
              .map((m) => (
                <button
                  key={m.id}
                  className="n-mission-row"
                  onClick={() => open(m.id)}
                >
                  <Hash size={22} />
                  <span>
                    <strong>{m.definition.name}</strong>
                    <small>Saved history · read only</small>
                  </span>
                </button>
              ))}
          </section>
        </details>
      ) : null}
      {state?.joins.some((j) => j.status !== "admitted") ? (
        <section className="d-panel n-pending-joins">
          <header>
            <h2>Your join requests</h2>
          </header>
          {state.joins
            .filter((j) => j.status !== "admitted")
            .map((j) => (
              <div className="n-peer-row" key={j.mission}>
                <strong>{j.name}</strong>
                <Status muted>
                  {j.status === "pending"
                    ? "Waiting for owner approval"
                    : j.status === "review_required"
                      ? "Mission changed · inspect again to request"
                      : j.status}
                </Status>
                {j.status === "pending" ||
                j.status === "expired" ||
                j.status === "review_required" ? (
                  <button
                    className="d-button"
                    disabled={busy}
                    onClick={() => withdraw(j.mission)}
                  >
                    Withdraw request
                  </button>
                ) : null}
              </div>
            ))}
        </section>
      ) : null}
      <div className="d-explainer">
        <LockKeyhole size={17} />
        <p>
          Saved locally, available offline. Your node identity is protected by
          this computer’s secure key storage. Enable peer networking to invite
          people and share a mission. Add Claude Code, Codex or Grok Build
          agents in isolated environments on this Mac.
        </p>
      </div>
    </>
  );
}

export function CreateMission({
  busy,
  enrolled,
  perform,
  cancel,
  complete,
}: {
  busy: boolean;
  enrolled: boolean;
  perform: Perform;
  cancel: () => void;
  complete: (id: string) => Promise<void>;
}) {
  const [saved, saveDraft, clearDraft, draftError] = useSetupDraft<{
    fields: Record<string, string>;
    criteria: string[];
    criterion: string;
    limited: boolean;
  }>(
    "new-mission",
    { fields: {}, criteria: [], criterion: "", limited: false },
    (
      value,
    ): value is {
      fields: Record<string, string>;
      criteria: string[];
      criterion: string;
      limited: boolean;
    } => {
      if (!value || typeof value !== "object") return false;
      const v = value as {
        fields: Record<string, string>;
        criteria: string[];
        criterion: string;
        limited: boolean;
      };
      return (
        !!v.fields &&
        typeof v.fields === "object" &&
        Object.values(v.fields).every(
          (x) => typeof x === "string" && x.length <= 8192,
        ) &&
        Array.isArray(v.criteria) &&
        v.criteria.length <= 32 &&
        v.criteria.every((x) => typeof x === "string" && x.length <= 1024) &&
        typeof v.criterion === "string" &&
        typeof v.limited === "boolean"
      );
    },
  );
  const [criteria, setCriteria] = useState(saved.criteria);
  const [draft, setDraft] = useState(saved.criterion);
  const [limited, setLimited] = useState(saved.limited);
  const [fields, setFields] = useState(saved.fields);
  const [savingIdentity, setSavingIdentity] = useState(false);
  useEffect(() => {
    saveDraft({ fields, criteria, criterion: draft, limited });
  }, [fields, criteria, draft, limited]);
  const add = () => {
    if (draft.trim() && criteria.length < 32) {
      setCriteria((current) => [...current, draft.trim()]);
      setDraft("");
    }
  };
  return (
    <>
      <button className="d-back" onClick={cancel} disabled={busy}>
        <ArrowLeft size={15} />
        My missions
      </button>
      <Heading section="New mission" title="Define the mission.">
        A clear goal gives every contribution a direction.
      </Heading>
      <form
        className="d-panel n-mission-form"
        onChange={(e) => {
          const element = e.target;
          if (
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement
          ) {
            if (element.name)
              setFields((current) => ({
                ...current,
                [element.name]: element.value,
              }));
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const count = (field: string) =>
            data.get(field) ? Number(data.get(field)) : null;
          const definition: MissionDefinition = {
            name: String(data.get("name")).trim(),
            objective: String(data.get("objective")).trim(),
            scope: String(data.get("scope")).trim(),
            criteria: draft.trim() ? [...criteria, draft.trim()] : criteria,
            policy: {
              coordination: data.get("coordination") as Coordination,
              participation: data.get("participation") as Participation,
              budget: limited
                ? {
                    mode: "limited",
                    turns: count("turns"),
                    concurrency: count("concurrency"),
                    deadline_ms: data.get("deadline")
                      ? new Date(String(data.get("deadline"))).getTime()
                      : null,
                    tokens: null,
                    model_cost_microusd: null,
                  }
                : { mode: "unlimited" },
            },
          };
          void perform(async () => {
            if (!enrolled) {
              setSavingIdentity(true);
              try {
                await node.enroll();
              } finally {
                setSavingIdentity(false);
              }
            }
            const result = await node.createMission(definition);
            clearDraft();
            await complete(result.mission);
          });
        }}
      >
        {draftError ? <p role="alert">{draftError}</p> : null}
        {savingIdentity ? (
          <p className="d-notice" role="status">
            Securing your node identity. If macOS shows a Keychain prompt for
            “Harakiri Desktop”, approve it there. Setup continues automatically;
            your mission brief is saved.
          </p>
        ) : null}
        <fieldset disabled={busy} className="n-fields">
          <label className="d-field">
            Channel name
            <input
              name="name"
              defaultValue={fields.name ?? ""}
              required
              maxLength={120}
              placeholder="A short, recognizable name"
              autoFocus
            />
          </label>
          <label className="d-field">
            Objective
            <textarea
              name="objective"
              defaultValue={fields.objective ?? ""}
              required
              rows={2}
              maxLength={4096}
              placeholder="What should this mission accomplish?"
            />
          </label>
          <label className="d-field">
            Scope
            <textarea
              name="scope"
              defaultValue={fields.scope ?? ""}
              rows={3}
              maxLength={8192}
              placeholder="What is in, what is out, and what the agents may change."
            />
          </label>
          <div className="d-field">
            <label htmlFor="criterion">
              Completion criteria · {criteria.length}
            </label>
            <div className="n-criteria">
              {criteria.map((criterion, index) => (
                <div key={index}>
                  <span className="d-mono">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span>{criterion}</span>
                  <button
                    type="button"
                    className="d-icon"
                    aria-label={`Remove criterion ${index + 1}`}
                    onClick={() =>
                      setCriteria((current) =>
                        current.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <X size={15} />
                  </button>
                </div>
              ))}
            </div>
            <div className="n-inline">
              <input
                id="criterion"
                value={draft}
                maxLength={1024}
                disabled={criteria.length >= 32}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    add();
                  }
                }}
                placeholder="Add a criterion and press Enter"
              />
              <button
                type="button"
                className="d-button"
                disabled={!draft.trim() || criteria.length >= 32}
                onClick={add}
              >
                Add
              </button>
            </div>
          </div>
          <details>
            <summary>
              Mission settings ·{" "}
              {fields.coordination === "peer"
                ? "Peer collaboration"
                : "Coordinator-led"}{" "}
              ·{" "}
              {fields.participation === "approval"
                ? "Approval required"
                : "Private"}{" "}
              · {limited ? "Limited budget" : "Unlimited budget"}
            </summary>
            <div className="d-two-columns">
              <label className="d-field">
                Coordination
                <select
                  name="coordination"
                  defaultValue={fields.coordination ?? "coordinated"}
                >
                  <option value="coordinated">Coordinator-led</option>
                  <option value="peer">Peer collaboration</option>
                </select>
                <span className="d-field-help">
                  In coordinated mode, this node hosts the initial Coordinator.
                </span>
              </label>
              <label className="d-field">
                Participation
                <select
                  name="participation"
                  defaultValue={fields.participation ?? "private"}
                >
                  <option value="private">Private invitation</option>
                  <option value="approval">
                    Discoverable · approval required
                  </option>
                </select>
                <span className="d-field-help">
                  Discoverable missions stay unlisted until you publish a public
                  brief.
                </span>
              </label>
            </div>
            <label className="d-field">
              Mission budget
              <select
                value={limited ? "limited" : "unlimited"}
                onChange={(event) =>
                  setLimited(event.target.value === "limited")
                }
              >
                <option value="unlimited">No budget · Unlimited</option>
                <option value="limited">Set limits</option>
              </select>
            </label>
            {limited ? (
              <div className="n-budget-fields">
                <label className="d-field">
                  Turns
                  <input
                    name="turns"
                    type="number"
                    required
                    min={1}
                    max={4294967295}
                    defaultValue={fields.turns ?? "100"}
                  />
                </label>
                <label className="d-field">
                  Concurrent turns
                  <input
                    name="concurrency"
                    defaultValue={fields.concurrency ?? ""}
                    type="number"
                    min={1}
                    max={1024}
                    placeholder="No cap"
                  />
                </label>
                <label className="d-field">
                  Deadline
                  <input
                    name="deadline"
                    defaultValue={fields.deadline ?? ""}
                    type="datetime-local"
                  />
                </label>
              </div>
            ) : (
              <p className="d-field-help">
                Track work without a mission limit. Your model provider’s
                subscription limits still apply.
              </p>
            )}
          </details>
        </fieldset>
        <footer className="n-form-actions">
          <p>
            {busy
              ? "If macOS shows a Keychain prompt for Harakiri Desktop, select Allow and authenticate with your Mac account. Keep the app open while it creates your protected identity."
              : enrolled
                ? "The mission begins in Preparing."
                : "This also creates your protected node identity on this computer."}
          </p>
          <button
            type="button"
            className="d-button"
            disabled={busy}
            onClick={cancel}
          >
            Cancel
          </button>
          <button className="d-button primary" disabled={busy} type="submit">
            {busy ? "Creating…" : "Create mission"}
          </button>
        </footer>
      </form>
    </>
  );
}

export function MissionRoom(props: Parameters<typeof MissionWorkspace>[0]) {
  return (
    <ExecutionStatusProvider mission={props.mission.id}>
      <MissionWorkspace {...props} />
    </ExecutionStatusProvider>
  );
}
function MissionWorkspace({
  error,
  readScroll,
  rememberScroll,
  session,
  updateSession,
  mission,
  owner,
  name,
  busy,
  perform,
  updated,
  enabled,
  network,
  withdrawal,
  prepare: _legacyPrepare,
  contributions,
  initialSetup = false,
}: {
  mission: MissionView;
  error: string;
  readScroll: (audience: string) => number | undefined;
  rememberScroll: (audience: string, top: number) => void;
  session: MissionSession;
  updateSession: (change: (session: MissionSession) => MissionSession) => void;
  contributions: Contribution[];
  owner: string;
  name: string;
  busy: boolean;
  perform: Perform;
  updated: () => Promise<void>;
  enabled: boolean;
  network: () => void;
  withdrawal?: WithdrawalView;
  prepare: (role: "agent" | "coordinator") => void;
  initialSetup?: boolean;
}) {
  const [panel, setPanel] = useState<
    | "controls"
    | "setup"
    | "members"
    | "contribution"
    | "tasks"
    | "workstream"
    | "budget"
    | "artifacts"
    | null
  >(initialSetup ? "setup" : null);
  const executionStates = useExecutionStates();
  const observations = useExecutionObservations();
  const clock = useExecutionClock();
  const [inspectorTab, setInspectorTab] = useState<
    "overview" | "decisions" | "technical"
  >("overview");
  const [startReviewRequest, setStartReviewRequest] = useState(0);
  const openControls = (review = false) => {
    setInspectorTab("overview");
    setStartReviewRequest(review ? (v) => v + 1 : 0);
    setPanel("controls");
  };
  const [setupRole, setSetupRole] = useState<"agent" | "coordinator">("agent");
  const prepare = (role: "agent" | "coordinator") => {
    setSetupRole(role);
    setPanel("setup");
  };
  const closePanel = useCallback(() => {
    setPanel(null);
    setStartReviewRequest(0);
  }, []);
  const [streams, setStreams] = useState<WorkstreamView[]>([]);
  const [workAgents, setWorkAgents] = useState<AgentView[]>([]);
  const [taskCount, setTaskCount] = useState(0);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [artifactCount, setArtifactCount] = useState(0);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [streamId, setStreamId] = useState<string | null>(null);
  const [workError, setWorkError] = useState("");
  const [workLoaded, setWorkLoaded] = useState(false);
  const [startJobs, setStartJobs] = useState<StartJob[]>([]);
  const [requests, setRequests] = useState<JoinView[]>([]);
  const [criteria, setCriteria] = useState<CriterionView[]>([]);
  const [acceptedResult, setAcceptedResult] = useState<ArtifactSummary | null>(
    null,
  );
  const loadWork = useCallback(async () => {
    const [streams, tasks, artifacts, peers, governance, starts] =
      await Promise.all([
        node.workstreams(mission.id),
        node.tasks(mission.id, {}),
        node.artifacts(mission.id, {}),
        node.peers(mission.id),
        node.governance(mission.id),
        window.blackboardSetup.startState(mission.id),
      ]);
    const agents: AgentView[] = [];
    let after: string | null = null;
    do {
      const page = await node.agents(mission.id, after);
      agents.push(...page.items);
      after = page.after;
    } while (after && agents.length < 512);
    return { streams, tasks, agents, artifacts, peers, governance, starts };
  }, [mission.id]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await loadWork();
        if (!cancelled) {
          setStreams(data.streams);
          setTaskCount(data.tasks.total);
          setArtifactCount(data.artifacts.total);
          setWorkAgents(data.agents);
          setWorkError("");
          setRequests(data.peers.requests);
          setStartJobs(data.starts);
          setCriteria(data.governance.criteria);
          setAcceptedResult(
            data.artifacts.items.find(
              (a) =>
                a.conversation === "main" &&
                a.accepted &&
                !a.stale &&
                a.heads.length === 1,
            ) ?? null,
          );
          setWorkLoaded(true);
        }
      } catch (e) {
        if (!cancelled)
          setWorkError(
            e instanceof Error ? e.message : "Unable to load mission work.",
          );
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [loadWork]);
  const changed = async () => {
    const data = await loadWork();
    setStreams(data.streams);
    setWorkAgents(data.agents);
    setTaskCount(data.tasks.total);
    setArtifactCount(data.artifacts.total);
    setRequests(data.peers.requests);
    setStartJobs(data.starts);
    setCriteria(data.governance.criteria);
    await updated();
  };
  const openWorkstream = (id: string) => {
    updateSession((s) => ({
      ...s,
      feed: "conversation",
      audience: `workstream:${id}`,
    }));
    setPanel(null);
  };
  const controls = panel === "controls";
  const people = panel === "members";
  const participation = panel === "contribution";
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [permissionAgent, setPermissionAgent] = useState<string | null>(null);
  const [memberTab, setMemberTab] = useState<"agents" | "people">("agents");
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [role, setRole] = useState<"agent" | "coordinator">(
    mission.owner === owner &&
      mission.definition.policy?.coordination === "coordinated"
      ? "coordinator"
      : "agent",
  );
  const [revoked, setRevoked] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const roster = await node.peers(mission.id);
        if (!cancelled)
          setRevoked(
            roster.members.some((m) => m.author === owner && m.revoked),
          );
      } finally {
        if (!cancelled)
          timer = setTimeout(() => void poll().catch(() => {}), 2500);
      }
    };
    void poll().catch(() => {});
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mission.id, owner]);
  const privateMessage = (author: string) =>
    void perform(async () => {
      const existing = (await node.audiences(mission.id)).find(
        (a) =>
          a.readers.length === 2 &&
          a.readers.includes(author) &&
          a.readers.includes(owner),
      );
      const id =
        existing?.id ??
        (await node.createAudience(mission.id, [author])).audience;
      updateSession((s) => ({ ...s, audience: id, feed: "conversation" }));
      setPanel(null);
    });
  const blocked = !!withdrawal || revoked || mission.conflicted;
  const budget = mission.definition.policy?.budget;
  const openAgent = (id: string) => {
    setSelectedAgent(id);
    setMemberTab("agents");
    setPanel("members");
  };
  const experience = missionPresentation({
    mission,
    viewer: owner,
    agents: workAgents,
    contributions,
    states: executionStates ?? {},
    observations,
    requests,
    criteria,
    acceptedResult,
    startJobs,
    loaded: workLoaded,
    blocked,
    access: withdrawal ? "withdrawn" : revoked ? "revoked" : null,
    now: clock,
  });
  const inspect = (
    tab: "overview" | "decisions" | "technical" = "overview",
  ) => {
    setInspectorTab(tab);
    setStartReviewRequest(0);
    setPanel("controls");
  };
  const act = (action: PresentationAction) => {
    if (action.destination === "artifact" && action.revision) {
      void perform(async () => {
        const detail = await node.artifactDetail(mission.id, action.revision!);
        const path =
          detail.document.entrypoint ?? detail.document.files[0]?.path;
        if (path) await node.artifactOpen(mission.id, action.revision!, path);
        else {
          setArtifactId(action.revision!);
          setPanel("artifacts");
        }
      });
    } else if (action.destination === "setup") prepare(action.role ?? "agent");
    else if (action.destination === "agent" && action.agent)
      openAgent(action.agent);
    else if (action.destination === "people") {
      setMemberTab("people");
      setPanel("members");
    } else if (action.destination === "technical") inspect("technical");
    else openControls(action.review);
  };
  const coordinatorAction = experience.rows.find(
    (r) =>
      r.agent.identity.author ===
      mission.lifecycle.coordinator?.identity.author,
  )?.status.action;
  const nextAction =
    !mission.lifecycle.coordinator &&
    mission.definition.policy?.coordination === "coordinated" &&
    mission.owner === owner
      ? { label: "Set up Coordinator", act: () => prepare("coordinator") }
      : coordinatorAction
        ? { label: coordinatorAction.label, act: () => act(coordinatorAction) }
        : undefined;
  const localAgents = contributions.filter(
    (c) =>
      c.mission.missionId === mission.id && !!executionStates?.[c.id]?.record,
  );
  const stopMine = () =>
    void perform(async () => {
      const results = await Promise.allSettled(
        localAgents.map((c) => window.blackboardExecution.stop(c.id)),
      );
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length)
        throw new Error(
          `${failures.length} local stops could not be confirmed. Inspect the agents before continuing.`,
        );
      await updated();
    });
  return (
    <section
      className="n-room"
      aria-label={`Mission ${mission.definition.name}`}
    >
      <header className="n-room-header">
        <div>
          <h1>
            <button
              className="n-mission-title"
              onClick={() => inspect("overview")}
              aria-label={`Open mission brief: ${mission.definition.name}`}
            >
              <span className="d-hash">#</span> {mission.definition.name}
              <ChevronRight size={16} />
            </button>
          </h1>
        </div>
        <div className="n-action-row">
          <button
            className="d-button"
            aria-expanded={people}
            onClick={() => {
              setMemberTab("agents");
              setPanel(people ? null : "members");
            }}
          >
            Members
          </button>
          {mission.owner === owner &&
          mission.lifecycle.phase === "active" &&
          !blocked ? (
            <button
              className="d-button"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await node.pauseMission(
                    mission.id,
                    mission.lifecycle.revision,
                    "Paused by the mission owner.",
                  );
                  await updated();
                })
              }
            >
              <Pause size={15} />
              Pause mission
            </button>
          ) : null}
          {localAgents.length ? (
            <button className="d-button" disabled={busy} onClick={stopMine}>
              <Square size={14} />
              Stop my agents
            </button>
          ) : null}
          <details className="n-more-actions">
            <summary className="d-button">More</summary>
            <div>
              <button
                className="d-button"
                onClick={(e) => {
                  inspect("overview");
                  e.currentTarget.closest("details")?.removeAttribute("open");
                }}
              >
                Mission details
              </button>
              {!blocked &&
              !["closed", "archived"].includes(mission.lifecycle.phase) ? (
                <button
                  className="d-button"
                  onClick={(e) => {
                    prepare("agent");
                    e.currentTarget.closest("details")?.removeAttribute("open");
                  }}
                >
                  Add my agents
                </button>
              ) : null}
              <button
                className="d-button"
                onClick={(e) => {
                  setPermissionAgent(null);
                  setPanel("budget");
                  e.currentTarget.closest("details")?.removeAttribute("open");
                }}
              >
                Budget &amp; permissions
              </button>
              <button
                className="d-button"
                onClick={(e) => {
                  setPanel("contribution");
                  e.currentTarget.closest("details")?.removeAttribute("open");
                }}
              >
                Your contribution
              </button>
              <button
                className="d-button"
                onClick={(e) => {
                  setMemberTab("people");
                  setPanel("members");
                  e.currentTarget.closest("details")?.removeAttribute("open");
                }}
              >
                Invite people
              </button>
            </div>
          </details>
        </div>
      </header>
      {panel === "setup" ? (
        <ContextPanel
          title={
            setupRole === "coordinator" ? "Set up Coordinator" : "Add my agents"
          }
          close={closePanel}
          error={error}
        >
          <AgentSetup
            reviewMission={() => openControls(true)}
            key={`${mission.id}:${setupRole}:${mission.lifecycle.terms_revision}`}
            mission={mission}
            role={setupRole}
            localKey={owner}
            contributions={contributions}
            updated={changed}
          />
        </ContextPanel>
      ) : null}
      {panel === "tasks" ? (
        <ContextPanel
          title="Tasks"
          close={closePanel}
          error={error || workError}
        >
          <TaskPanel
            initialTask={taskId}
            mission={mission}
            localKey={owner}
            busy={busy}
            blocked={blocked}
            perform={perform}
            changed={changed}
            streams={streams}
            agents={workAgents}
            open={(audience) => {
              updateSession((s) => ({ ...s, feed: "conversation", audience }));
              setPanel(null);
            }}
          />
        </ContextPanel>
      ) : null}
      {panel === "artifacts" ? (
        <ContextPanel
          title="Artifacts"
          close={closePanel}
          error={error || workError}
        >
          <ArtifactPanel
            key={artifactId ?? "list"}
            mission={mission}
            owner={owner}
            agents={workAgents}
            streams={streams}
            initial={artifactId}
            conversation={session.audience}
            busy={busy}
            blocked={blocked}
            perform={perform}
            changed={changed}
            openConversation={(audience) => {
              updateSession((s) => ({ ...s, feed: "conversation", audience }));
              setPanel(null);
            }}
          />
        </ContextPanel>
      ) : null}
      {panel === "workstream" ? (
        <ContextPanel
          title={streamId ? "Workstream details" : "New workstream"}
          close={closePanel}
          error={error || workError}
        >
          <WorkstreamPanel
            key={streamId ?? "new"}
            mission={mission}
            localKey={owner}
            busy={busy}
            blocked={blocked}
            perform={perform}
            changed={changed}
            stream={streams.find((s) => s.id === streamId) ?? null}
            agents={workAgents}
            open={openWorkstream}
          />
        </ContextPanel>
      ) : null}
      {people ? (
        <ContextPanel title="Members" close={closePanel} error={error}>
          <nav className="n-member-tabs" aria-label="Member views">
            <button
              aria-pressed={memberTab === "agents"}
              onClick={() => setMemberTab("agents")}
            >
              Agents
            </button>
            <button
              aria-pressed={memberTab === "people"}
              onClick={() => setMemberTab("people")}
            >
              People &amp; invitations
            </button>
          </nav>
          <div hidden={memberTab !== "agents"}>
            <AgentRoster
              permissions={(agent) => {
                setPermissionAgent(agent.id);
                setPanel("budget");
              }}
              message={(agent, privateChat) => {
                if (privateChat)
                  void perform(async () => {
                    const { audience } = await node.openAgentConversation(
                      mission.id,
                      agent.id,
                    );
                    updateSession((s) => ({
                      ...s,
                      audience,
                      feed: "conversation",
                    }));
                    setPanel(null);
                  });
                else {
                  updateSession((s) => ({
                    ...s,
                    audience: "main",
                    feed: "conversation",
                    recipients: {
                      ...s.recipients,
                      main: agent.identity.author,
                    },
                  }));
                  setPanel(null);
                }
              }}
              selectedAgent={selectedAgent}
              mission={mission}
              localKey={owner}
              contributions={contributions}
              busy={busy}
              perform={perform}
              updated={updated}
              prepare={() => prepare("agent")}
            />
          </div>
          <div hidden={memberTab !== "people"}>
            <People
              mission={mission.id}
              owner={mission.owner}
              localKey={owner}
              enabled={enabled}
              busy={busy}
              perform={perform}
              network={network}
              privateMessage={privateMessage}
            />
            {mission.owner === owner ? (
              <PublishMission
                mission={mission}
                busy={busy}
                perform={perform}
                network={network}
              />
            ) : null}
          </div>
        </ContextPanel>
      ) : null}
      {participation ? (
        <ContextPanel
          title="Your contribution"
          close={closePanel}
          error={error}
        >
          <section
            className="d-panel n-participation"
            aria-label="Your participation"
          >
            <header>
              <h2>Your participation</h2>
              <Status muted>
                {withdrawal
                  ? "Withdrawn"
                  : revoked
                    ? "Revoked"
                    : mission.lifecycle.phase === "active"
                      ? "Joined · mission active"
                      : mission.lifecycle.phase === "paused"
                        ? "Joined · mission paused"
                        : "Joined · waiting for mission start"}
              </Status>
            </header>
            <p>
              Choose a runtime, a dedicated local folder and your own allowance.
              Preparation does not start work. You approve isolated execution
              separately from your agent’s details.
            </p>
            {!revoked && !withdrawal ? (
              <>
                <label className="d-field">
                  Agent role
                  <select
                    value={role}
                    onChange={(e) =>
                      setRole(e.target.value as "agent" | "coordinator")
                    }
                  >
                    <option value="agent">Agent</option>
                    {mission.definition.policy?.coordination ===
                    "coordinated" ? (
                      <option value="coordinator">Coordinator</option>
                    ) : null}
                  </select>
                </label>
                {role === "coordinator" ? (
                  <p className="d-field-help">
                    Share this contribution in Members so the mission owner can
                    select it for coordination. It waits for appointment;
                    preparing it does not replace the current Coordinator.
                  </p>
                ) : null}
                <div className="n-action-row">
                  <button
                    className="d-button primary"
                    disabled={busy || mission.conflicted}
                    onClick={() =>
                      prepare(
                        mission.definition.policy?.coordination === "peer"
                          ? "agent"
                          : role,
                      )
                    }
                  >
                    Prepare contribution
                  </button>
                  {mission.owner !== owner ? (
                    <button
                      className="d-button"
                      disabled={busy}
                      onClick={() => setConfirmWithdraw(true)}
                    >
                      Withdraw from mission…
                    </button>
                  ) : null}
                </div>
              </>
            ) : null}
            {confirmWithdraw ? (
              <div className="n-withdraw-confirm">
                <h3>Withdraw this node from the mission?</h3>
                <p>
                  New messages and synchronization stop on this device. Your
                  prepared contributions are revoked; saved history and
                  workspace files stay here. Peers are notified when reachable.
                  Rejoining with this identity is not supported yet.
                </p>
                <div className="n-action-row">
                  <button
                    className="d-button"
                    disabled={busy}
                    onClick={() => setConfirmWithdraw(false)}
                  >
                    Keep participating
                  </button>
                  <button
                    className="d-button primary"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await node.withdrawMission(mission.id);
                        setConfirmWithdraw(false);
                        await updated();
                      })
                    }
                  >
                    Withdraw participation
                  </button>
                </div>
              </div>
            ) : null}
            {withdrawal ? (
              <p role="status">
                Withdrawn on this device.{" "}
                {withdrawal.pending_notifications
                  ? `${withdrawal.pending_notifications} peer notifications pending.`
                  : "Known peers have acknowledged the notice."}
              </p>
            ) : null}
          </section>
        </ContextPanel>
      ) : null}
      {panel === "budget" ? (
        <ContextPanel
          title="Budget & permissions"
          close={closePanel}
          error={error}
        >
          <BudgetPanel
            key={permissionAgent ?? "all"}
            initialAgent={permissionAgent}
            mission={mission}
            owner={owner}
            agents={workAgents}
            contributions={contributions}
            busy={busy}
            perform={perform}
          />
        </ContextPanel>
      ) : null}
      {controls ? (
        <ContextPanel
          title="Mission"
          close={closePanel}
          error={error || workError}
        >
          <nav className="n-member-tabs" aria-label="Mission inspector views">
            {(["overview", "decisions", "technical"] as const).map((tab) => (
              <button
                key={tab}
                aria-pressed={inspectorTab === tab}
                onClick={() => setInspectorTab(tab)}
              >
                {tab === "overview"
                  ? "Overview"
                  : tab === "decisions"
                    ? `Decisions${experience.decisions.length ? ` · ${experience.decisions.length}` : ""}`
                    : "Technical"}
              </button>
            ))}
          </nav>
          <div hidden={inspectorTab !== "decisions"}>
            <MissionDecisions value={experience} act={act} />
          </div>
          <div hidden={inspectorTab !== "technical"}>
            <MissionActivity value={experience} mission={mission} act={act} />
          </div>
          <div hidden={inspectorTab !== "overview"}>
            <h2 className="n-preserve">{mission.definition.objective}</h2>
            {mission.definition.scope ? (
              <p className="n-preserve">{mission.definition.scope}</p>
            ) : null}
            <MissionControl
              key={startReviewRequest}
              reviewStart={startReviewRequest > 0}
              mission={mission}
              isOwner={mission.owner === owner}
              blocked={blocked}
              busy={busy}
              open
              agents={workAgents}
              nextAction={nextAction}
              contributions={contributions}
              perform={perform}
              updated={updated}
              prepare={() => prepare("coordinator")}
            />
            <MissionProgress
              mission={mission}
              owner={owner}
              agents={workAgents}
              busy={busy}
              perform={perform}
              updated={updated}
              openArtifact={(id) => {
                setArtifactId(id);
                setPanel("artifacts");
              }}
            />
          </div>
        </ContextPanel>
      ) : null}
      <MissionJourney
        value={experience}
        act={act}
        inspect={inspect}
        inspectorOpen={panel !== null}
      />
      {workError ? (
        <p className="d-alert" role="alert">
          {workError}
        </p>
      ) : null}
      <Conversation
        decisions={<MissionDecisions value={experience} act={act} />}
        contributions={contributions}
        streams={streams}
        taskCount={taskCount}
        tasks={(id) => {
          setTaskId(id ?? null);
          setPanel("tasks");
        }}
        artifactCount={artifactCount}
        artifacts={(id) => {
          setArtifactId(id ?? null);
          setPanel("artifacts");
        }}
        editStream={(id) => {
          setStreamId(id);
          setPanel("workstream");
        }}
        mission={mission}
        owner={owner}
        name={name}
        busy={busy}
        blocked={blocked || mission.lifecycle.phase === "archived"}
        session={session}
        updateSession={updateSession}
        readScroll={readScroll}
        rememberScroll={rememberScroll}
        perform={perform}
        detailsOpen={panel !== null}
        closeDetails={closePanel}
        members={() => {
          setMemberTab("agents");
          setPanel("members");
        }}
        profile={(registration) => {
          setSelectedAgent(registration);
          setMemberTab("agents");
          setPanel("members");
        }}
      />
    </section>
  );
}
