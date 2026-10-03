import { BudgetPanel } from "./BudgetPanel";
import { MissionProgress } from "./MissionProgress";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Hash,
  LockKeyhole,
  Plus,
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
          people and share a mission. Agent execution is not enabled yet.
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
  const [criteria, setCriteria] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [limited, setLimited] = useState(false);
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
            if (!enrolled) await node.enroll();
            const result = await node.createMission(definition);
            await complete(result.mission);
          });
        }}
      >
        <fieldset disabled={busy} className="n-fields">
          <label className="d-field">
            Channel name
            <input
              name="name"
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
          <div className="d-two-columns">
            <label className="d-field">
              Coordination
              <select name="coordination" defaultValue="coordinated">
                <option value="coordinated">Coordinator-led</option>
                <option value="peer">Peer collaboration</option>
              </select>
              <span className="d-field-help">
                In coordinated mode, this node hosts the initial Coordinator.
              </span>
            </label>
            <label className="d-field">
              Participation
              <select name="participation" defaultValue="private">
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
              onChange={(event) => setLimited(event.target.value === "limited")}
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
                  defaultValue={100}
                />
              </label>
              <label className="d-field">
                Concurrent turns
                <input
                  name="concurrency"
                  type="number"
                  min={1}
                  max={1024}
                  placeholder="No cap"
                />
              </label>
              <label className="d-field">
                Deadline
                <input name="deadline" type="datetime-local" />
              </label>
            </div>
          ) : (
            <p className="d-field-help">
              Track work without a mission limit. Your model provider’s
              subscription limits still apply.
            </p>
          )}
        </fieldset>
        <footer className="n-form-actions">
          <p>
            {busy
              ? "Unlock your operating system’s key storage if prompted."
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

export function MissionRoom({
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
  prepare,
  contributions,
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
}) {
  const [panel, setPanel] = useState<
    | "controls"
    | "members"
    | "contribution"
    | "tasks"
    | "workstream"
    | "budget"
    | "artifacts"
    | null
  >(null);
  const closePanel = useCallback(() => setPanel(null), []);
  const [streams, setStreams] = useState<WorkstreamView[]>([]);
  const [workAgents, setWorkAgents] = useState<AgentView[]>([]);
  const [taskCount, setTaskCount] = useState(0);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [artifactCount, setArtifactCount] = useState(0);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [streamId, setStreamId] = useState<string | null>(null);
  const [workError, setWorkError] = useState("");
  const loadWork = useCallback(async () => {
    const [streams, tasks, artifacts] = await Promise.all([
      node.workstreams(mission.id),
      node.tasks(mission.id, {}),
      node.artifacts(mission.id, {}),
    ]);
    const agents: AgentView[] = [];
    let after: string | null = null;
    do {
      const page = await node.agents(mission.id, after);
      agents.push(...page.items);
      after = page.after;
    } while (after && agents.length < 512);
    return { streams, tasks, agents, artifacts };
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
  return (
    <section
      className="n-room"
      aria-label={`Mission ${mission.definition.name}`}
    >
      <header className="n-room-header">
        <div>
          <h1>
            <span className="d-hash">#</span> {mission.definition.name}
          </h1>
        </div>
        <div className="n-action-row">
          <button
            className="d-button"
            aria-expanded={panel === "budget"}
            onClick={() => setPanel(panel === "budget" ? null : "budget")}
          >
            Budget & permissions
          </button>
          <button
            className="d-button n-tasks-header"
            aria-expanded={panel === "tasks"}
            onClick={() => {
              setTaskId(null);
              setPanel(panel === "tasks" ? null : "tasks");
            }}
          >
            Tasks <span className="d-count">{taskCount}</span>
          </button>
          <button
            className="d-button"
            aria-expanded={controls}
            onClick={() => setPanel(controls ? null : "controls")}
          >
            Mission controls
          </button>
          <button
            className="d-button"
            aria-expanded={participation}
            onClick={() => setPanel(participation ? null : "contribution")}
          >
            Your contribution
          </button>
          <button
            className="d-button"
            aria-expanded={people}
            onClick={() => setPanel(people ? null : "members")}
          >
            Members
          </button>
        </div>
      </header>
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
              These are preparation terms; this preview cannot start agents.
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
                    {mission.owner === owner &&
                    mission.definition.policy?.coordination ===
                      "coordinated" ? (
                      <option value="coordinator">Coordinator</option>
                    ) : null}
                  </select>
                </label>
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
        <ContextPanel title="Mission controls" close={closePanel} error={error}>
          <MissionControl
            mission={mission}
            isOwner={mission.owner === owner}
            blocked={blocked}
            busy={busy}
            open
            detailsOnly
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
        </ContextPanel>
      ) : null}
      <div className="n-mission-brief">
        <details>
          <summary>
            <ChevronRight size={15} aria-hidden="true" />
            <span className="n-objective">{mission.definition.objective}</span>
            <span className="n-details-label">Mission details</span>
          </summary>
          <h2 className="n-preserve">{mission.definition.objective}</h2>
          {mission.definition.scope ? (
            <p className="n-preserve">{mission.definition.scope}</p>
          ) : null}
          <ul className="n-success-criteria">
            {mission.definition.criteria.map((criterion, i) => (
              <li key={i}>
                <span className="n-square" />
                {criterion}
              </li>
            ))}
          </ul>
          <dl className="d-facts">
            <div>
              <dt>Coordination</dt>
              <dd>
                {mission.coordinator_node
                  ? mission.owner === owner
                    ? "Coordinator-led · hosted on this node"
                    : "Coordinator-led · hosted on the creator’s node"
                  : "Peer collaboration"}
              </dd>
            </div>
            <div>
              <dt>Budget</dt>
              <dd>
                {budget?.mode === "unlimited"
                  ? "No budget · Unlimited"
                  : budget?.mode === "limited"
                    ? `${budget.turns ?? "Uncapped"} turns · ${budget.concurrency ?? "Uncapped"} concurrent`
                    : "Policy unavailable"}
              </dd>
            </div>
            <div>
              <dt>Participation</dt>
              <dd>
                {mission.definition.policy?.participation === "approval"
                  ? "Approval required · owner controls public listing"
                  : "Private invitation"}
              </dd>
            </div>
          </dl>
        </details>
        {blocked ? (
          <div className="n-preparing">
            <span className="n-square" />
            <span>
              {withdrawal
                ? "You withdrew this node. Saved history remains readable; new contributions and mission synchronization are stopped."
                : revoked
                  ? "Your membership was revoked. Your saved history remains readable; new contributions are blocked."
                  : blocked
                    ? "Conflicting signed history needs recovery. New messages are suspended."
                    : "Use Main for shared discussion. Joining grants membership; Start and local contribution consent govern work."}
            </span>
          </div>
        ) : null}
      </div>
      <MissionControl
        mission={mission}
        isOwner={mission.owner === owner}
        blocked={blocked}
        busy={busy}
        open={false}
        contributions={contributions}
        perform={perform}
        updated={updated}
        prepare={() => prepare("coordinator")}
      />
      {workError ? (
        <p className="d-alert" role="alert">
          {workError}
        </p>
      ) : null}
      <Conversation
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
