import { useEffect, useState, type FormEvent } from "react";
import { X, Plus, MessageSquare } from "lucide-react";
import { rpc } from "./client";
import { Badge, Empty, Field, Runtime, Text, Time } from "./ui";
import { Conversation } from "./App";
import { TaskList, TaskStatus, taskLabels } from "./Tasks";
import { AgentExecution } from "./Execution";
import { AgentRecovery, connected, connectionLabel } from "./Recovery";
import type {
  Agent,
  AgentRequest,
  Context,
  Modal,
  Panel,
  Message,
  Stream,
  Task,
  Assignment,
} from "./model";
export function SidePanel({
  panel,
  context,
  close,
  edit,
  inspect,
  refresh,
  direct,
  address,
  showTasks,
  archive,
  archiving,
}: {
  panel: Panel;
  context: Context;
  close: () => void;
  edit: (modal: Modal) => void;
  inspect: (id: string) => void;
  refresh: () => Promise<void>;
  direct: (id: string) => void;
  address: (id: string) => void;
  showTasks: () => void;
  archive: (archived: boolean) => Promise<void>;
  archiving: boolean;
}) {
  const [tab, setTab] = useState(
      panel.kind === "record" ? "record" : panel.kind,
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const m = context.mission;
  const needsPreparation =
    m.state === "closed" ||
    (m.state === "paused" &&
      m.coordinationMode === "coordinated" &&
      !context.startup.coordinatorReady);
  const [record, setRecord] = useState(panel.record);
  const [editingMessage, setEditingMessage] = useState(false),
    [messageDraft, setMessageDraft] = useState("");
  useEffect(() => {
    if (!panel.record || tab !== "record") return;
    let active = true;
    rpc("record_read", { channel_id: m.id, id: panel.record.id })
      .then((value) => {
        if (active) setRecord(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [panel.record?.id, context.cursor, m.id, tab]);
  const action = async (op: string, input: object) => {
    setBusy(true);
    setError("");
    try {
      await rpc(op, { channel_id: m.id, ...input });
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("dialog[open]"))
        close();
    };
    addEventListener("keydown", handle);
    return () => removeEventListener("keydown", handle);
  }, [close]);
  const title =
    record?.type === "message"
      ? (record as Message).directAgentId
        ? "Private thread"
        : "Thread"
      : record?.type === "agent"
        ? "Agent"
        : record?.type === "workstream"
          ? "Workstream"
          : record?.type === "task"
            ? "Task"
            : record?.type === "assignment"
              ? "Assignment"
              : tab === "tasks"
                ? "Tasks"
                : "Channel details";
  return (
    <aside
      className={`details ${record?.type === "message" ? "thread-panel" : ""}`}
      aria-label="Channel details"
    >
      <header className="details-heading">
        <h2 className="label">{title}</h2>
        <button className="icon" aria-label="Close details" onClick={close}>
          <X size={17} />
        </button>
      </header>
      {!record ? (
        <nav className="tabs detail-tabs" aria-label="Channel details tabs">
          {[
            ["mission", "Mission"],
            ["agents", "Agents"],
            ["requests", "Attention"],
            ["tasks", "Tasks"],
          ].map(([id, name]) => (
            <button
              key={id}
              className={tab === id ? "selected" : ""}
              onClick={() => setTab(id)}
            >
              {name}
              {id === "tasks" ? (
                <span className="count">{context.tasks.length}</span>
              ) : null}
            </button>
          ))}
        </nav>
      ) : null}
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
      {record?.type === "message" ? (
        <>
          <Conversation
            context={context}
            streamId={
              (record as Message).streamId || context.mission.defaultStreamId
            }
            thread={record as Message}
            inspect={inspect}
            refresh={refresh}
          />
          <div className="thread-human-actions" hidden={!!m.archived}>
            {editingMessage ? (
              <form
                className="stack"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (
                    await action("message_edit", {
                      message_id: record.id,
                      body: messageDraft,
                    })
                  )
                    setEditingMessage(false);
                }}
              >
                <Field label="Edit message">
                  <textarea
                    rows={3}
                    value={messageDraft}
                    onChange={(e) => setMessageDraft(e.target.value)}
                    required
                  />
                </Field>
                <div className="button-row">
                  <button className="button primary" disabled={busy}>
                    Save message
                  </button>
                  <button
                    className="button"
                    type="button"
                    onClick={() => setEditingMessage(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                className="text-button"
                onClick={() => {
                  setMessageDraft((record as Message).body);
                  setEditingMessage(true);
                }}
              >
                Edit message
              </button>
            )}
            <button
              className="text-button danger"
              disabled={busy}
              onClick={() =>
                action("message_edit", { message_id: record.id, remove: true })
              }
            >
              Remove message
            </button>
          </div>
        </>
      ) : (
        <div className="details-body">
          {tab === "mission" ? (
            <>
              <section>
                <div className="section-heading">
                  <h3 className="label">Mission</h3>
                  <button
                    className="text-button"
                    disabled={m.archived}
                    onClick={() => edit({ kind: "edit-mission" })}
                  >
                    Edit instructions
                  </button>
                </div>
                <h2>{m.name}</h2>
                <Text value={m.objective} />
              </section>
              <section>
                <h3 className="label">Scope</h3>
                <Text value={m.scope || "No additional scope specified."} />
              </section>
              <section>
                <h3 className="label">
                  Completion criteria · {m.criteria.filter((c) => c.met).length}
                  /{m.criteria.length}
                </h3>
                {m.criteria.map((c) => (
                  <div className="criterion-report" key={c.id}>
                    <label className="criterion-check">
                      <input
                        type="checkbox"
                        checked={c.met}
                        disabled={busy || m.archived}
                        title="Update status with evidence or a reason"
                        onChange={() =>
                          edit({ kind: "criterion", criterion: c })
                        }
                      />
                      <span>{c.text}</span>
                    </label>
                    <div className="criterion-detail">
                      <p className="task-update-meta">
                        <span>
                          {c.met ? "Reported complete" : "Not yet met"}
                        </span>
                        {c.assessment ? (
                          <>
                            <span>
                              By{" "}
                              {c.assessment.updatedBy === "human"
                                ? "you"
                                : context.agents.find(
                                    (a) => a.id === c.assessment!.updatedBy,
                                  )?.name || c.assessment.updatedBy}
                            </span>
                            <Time at={c.assessment.updatedAt} />
                          </>
                        ) : null}
                      </p>
                      {c.assessment ? (
                        <details className="criterion-evidence">
                          <summary>Evidence and report</summary>
                          <Text value={c.assessment.summary} />
                          <div className="task-evidence">
                            {c.assessment.refs.map((id) => (
                              <button
                                key={id}
                                className="text-button"
                                onClick={() => inspect(id)}
                              >
                                Open evidence · {id}
                              </button>
                            ))}
                            <button
                              className="text-button"
                              onClick={() => inspect(c.assessment!.messageId)}
                            >
                              Open status report
                            </button>
                          </div>
                        </details>
                      ) : null}
                    </div>
                  </div>
                ))}
                {!m.criteria.length ? (
                  <p className="secondary">No criteria defined yet.</p>
                ) : null}
              </section>
              <section className="panel-block">
                <Field
                  label="Coordination"
                  hint="Changing the organization returns the mission to preparation. You decide when execution starts."
                >
                  <select
                    aria-label="Coordination mode"
                    value={m.coordinationMode}
                    disabled={busy || m.archived || m.state === "closed"}
                    onChange={(e) =>
                      action("coordination_set", {
                        version: m.version,
                        mode: e.target.value,
                      })
                    }
                  >
                    <option value="coordinated">Coordinator-led</option>
                    <option value="peer">Peer collaboration</option>
                  </select>
                </Field>
                {m.coordinationMode === "coordinated" ? (
                  <>
                    <h3 className="label">Coordinator</h3>
                    <select
                      aria-label="Coordinator"
                      value={m.coordinatorId || ""}
                      disabled={busy || m.archived || m.state === "closed"}
                      onChange={(e) =>
                        action("coordinator_set", {
                          version: m.version,
                          agent_id: e.target.value || null,
                          reason:
                            "Human changed coordination from mission controls.",
                        })
                      }
                    >
                      <option value="">Awaiting coordinator</option>
                      {context.agents.map((a) => (
                        <option value={a.id} key={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                    {m.state === "preparing" ? (
                      <p className="hint" role="status">
                        {context.startup.reason}
                      </p>
                    ) : null}
                  </>
                ) : null}
                <p className="hint">
                  Your instructions take priority. You can talk to any agent at
                  any time.
                </p>
                {m.coordinatorId ? (
                  <button
                    className="button"
                    onClick={() => direct("coordinator")}
                  >
                    <MessageSquare size={13} />
                    Message coordinator privately
                  </button>
                ) : null}
              </section>
              <section>
                <div className="section-heading">
                  <h3 className="label">Shared plan</h3>
                  <button
                    className="text-button"
                    disabled={m.archived}
                    onClick={() => edit({ kind: "plan" })}
                  >
                    Edit plan
                  </button>
                </div>
                <Text
                  value={
                    m.plan ||
                    (m.coordinationMode === "coordinated"
                      ? "The coordinator prepares an initial direction before you start the mission."
                      : "Agents can organize in Main after you start the mission. A shared plan is optional.")
                  }
                />
              </section>
              <section hidden={!!m.archived}>
                <h3 className="label">Mission controls</h3>
                <div className="button-row">
                  <Badge tone={m.state === "active" ? "success" : "warning"}>
                    {m.state}
                  </Badge>
                  <button
                    className="button"
                    disabled={
                      busy ||
                      (m.state !== "active" &&
                        !needsPreparation &&
                        !context.startup.canStart)
                    }
                    onClick={() =>
                      action("mission_state", {
                        version: m.version,
                        state:
                          m.state === "active"
                            ? "paused"
                            : needsPreparation
                              ? "preparing"
                              : "active",
                        reason:
                          "Human changed mission state from the channel controls.",
                      })
                    }
                  >
                    {m.state === "active"
                      ? "Pause mission"
                      : m.state === "preparing"
                        ? "Start mission"
                        : needsPreparation
                          ? m.state === "closed"
                            ? "Reopen in preparation"
                            : "Prepare to resume"
                          : m.state === "paused"
                            ? "Resume mission"
                            : "Reopen mission"}
                  </button>
                  {m.state !== "closed" ? (
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() =>
                        action("mission_state", {
                          state: "closed",
                          version: m.version,
                          reason: "Human closed the mission.",
                        })
                      }
                    >
                      Close mission
                    </button>
                  ) : null}
                </div>
              </section>
              <section className="channel-archive-control">
                <h3 className="label">
                  {m.archived ? "Archived channel" : "Archive channel"}
                </h3>
                <p className="secondary">
                  {m.archived
                    ? "Messages, workstreams, tasks, and agent records are preserved. Restoring keeps the mission paused or closed until you resume it."
                    : "Move this channel out of the active list and request agents to pause. Its history stays available and read-only in Archived channels."}
                </p>
                {m.archivedAt ? (
                  <p className="hint">
                    Archived {new Date(m.archivedAt).toLocaleString()}
                  </p>
                ) : null}
                <button
                  className="button"
                  disabled={busy || archiving}
                  onClick={() => archive(!m.archived)}
                >
                  {m.archived ? "Restore channel" : "Archive channel"}
                </button>
              </section>
            </>
          ) : null}
          {tab === "agents" ? (
            <>
              <div className="section-heading">
                <span className="label">
                  {context.agents.length} registered instances
                </span>
                <button
                  className="button"
                  disabled={m.archived}
                  onClick={() => edit({ kind: "invite" })}
                >
                  Invite agents
                </button>
              </div>
              {!m.archived && m.state !== "closed" ? (
                <div className="button-row">
                  <button
                    className="button"
                    onClick={() => edit({ kind: "recovery" })}
                  >
                    Resume offline agents
                  </button>
                </div>
              ) : null}
              {!context.agents.length ? (
                <Empty
                  title={m.archived ? "No recorded agents" : "No agents yet"}
                >
                  {m.archived
                    ? "This mission was archived without any agents."
                    : "Invite one existing session or use the launcher for many instances."}
                </Empty>
              ) : (
                context.agents.map((a) => (
                  <button
                    className="agent-row"
                    key={a.id}
                    onClick={() => inspect(a.id)}
                  >
                    <Runtime runtime={a.runtime} />
                    <div>
                      <strong>{a.name}</strong>
                      <small>
                        {a.role === "coordinator" ? "Coordinator" : "Agent"} ·{" "}
                        {
                          context.workstreams.find((w) => w.id === a.streamId)
                            ?.name
                        }
                      </small>
                      {a.participation.state === "waiting" ? (
                        <small>
                          {m.state === "preparing"
                            ? "Waiting for mission start"
                            : "Waiting for a direction"}
                        </small>
                      ) : null}
                    </div>
                    <Badge
                      tone={
                        connectionLabel(a) === "Failed"
                          ? "danger"
                          : connected(a)
                            ? "success"
                            : "muted"
                      }
                    >
                      {connectionLabel(a)}
                    </Badge>
                  </button>
                ))
              )}
            </>
          ) : null}
          {tab === "requests" ? (
            <>
              <h3 className="label">Requests for human attention</h3>
              {!context.requests.length ? (
                <Empty title="Nothing needs your attention">
                  Coordinator requests for additional agents will appear here.
                </Empty>
              ) : (
                context.requests.map((r) => (
                  <RequestCard
                    key={r.id}
                    request={r}
                    busy={busy}
                    readOnly={!!m.archived}
                    respond={(response, status) =>
                      action("request_respond", {
                        request_id: r.id,
                        response,
                        status,
                      })
                    }
                  />
                ))
              )}
            </>
          ) : null}
          {tab === "tasks" ? (
            <>
              <TaskList context={context} inspect={inspect} />
              <details className="task-override" hidden={!!m.archived}>
                <summary>Human override</summary>
                <p className="hint">
                  Intervene directly when needed. The coordinator and agents
                  normally create and manage tasks.
                </p>
                <button
                  className="button"
                  onClick={() => edit({ kind: "task" })}
                >
                  Create a task manually
                </button>
              </details>
            </>
          ) : null}
          {record?.type === "agent" ? (
            <AgentDetail
              agent={
                context.agents.find((a) => a.id === record.id) ||
                (record as Agent)
              }
              context={context}
              busy={busy}
              action={action}
              edit={edit}
              direct={direct}
              address={address}
              refresh={refresh}
            />
          ) : null}
          {record?.type === "workstream" ? (
            <StreamDetail
              stream={
                context.workstreams.find((s) => s.id === record.id) ||
                (record as Stream)
              }
              context={context}
              edit={edit}
            />
          ) : null}
          {record?.type === "task" ? (
            <>
              <button className="text-button" onClick={showTasks}>
                ← All tasks
              </button>
              <TaskDetail
                key={record.id}
                task={
                  context.tasks.find((t) => t.id === record.id) ||
                  (record as Task)
                }
                context={context}
                busy={busy}
                action={action}
                inspect={inspect}
              />
            </>
          ) : null}
          {record?.type === "request" ? (
            <RequestCard
              request={
                context.requests.find((r) => r.id === record.id) ||
                (record as AgentRequest)
              }
              busy={busy}
              readOnly={!!m.archived}
              respond={(response, status) =>
                action("request_respond", {
                  request_id: record.id,
                  response,
                  status,
                })
              }
            />
          ) : null}
          {record?.type === "assignment" ? (
            <>
              <Badge>
                {
                  (
                    context.assignments.find((a) => a.id === record.id) ||
                    (record as Assignment)
                  ).status
                }
              </Badge>
              <h2>Workstream assignment</h2>
              <Text value={(record as Assignment).instruction} />
              <p>
                {
                  context.agents.find(
                    (a) => a.id === (record as Assignment).agentId,
                  )?.name
                }{" "}
                →{" "}
                {
                  context.workstreams.find(
                    (w) => w.id === (record as Assignment).streamId,
                  )?.name
                }
              </p>
            </>
          ) : null}
          {record ? <span className="record-id">{record.id}</span> : null}
        </div>
      )}
    </aside>
  );
}
function AgentDetail({
  agent: a,
  context,
  busy,
  action,
  edit,
  direct,
  address,
  refresh,
}: {
  agent: Agent;
  context: Context;
  busy: boolean;
  action: (op: string, p: object) => Promise<boolean>;
  edit: (m: Modal) => void;
  direct: (id: string) => void;
  address: (id: string) => void;
  refresh: () => Promise<void>;
}) {
  const pending = context.assignments.find((x) => x.agentId === a.id);
  return (
    <>
      <div className="agent-profile">
        <Runtime runtime={a.runtime} />
        <h2>{a.name}</h2>
        <Badge tone={a.role === "coordinator" ? "accent" : ""}>
          {a.role === "coordinator" ? "Coordinator" : "Agent"}
        </Badge>
      </div>
      <div className="button-row">
        <button className="button primary" onClick={() => direct(a.id)}>
          {context.mission.archived
            ? "View private conversation"
            : "Message privately"}
        </button>
        <button
          className="button"
          disabled={context.mission.archived}
          onClick={() => address(a.id)}
        >
          Address in channel
        </button>
        <button
          className="button"
          disabled={context.mission.archived}
          onClick={() => edit({ kind: "assignment", agent: a })}
        >
          Give direction
        </button>
      </div>
      <section className="panel-block">
        <h3 className="label">Work authorization</h3>
        <Badge
          tone={a.participation.state === "authorized" ? "success" : "warning"}
        >
          {a.participation.state === "authorized"
            ? "Authorized"
            : a.participation.state === "planning"
              ? "Planning only"
              : a.participation.state}
        </Badge>
        <p className="hint">{a.participation.reason}</p>
        {a.participation.instruction ? (
          <Text value={a.participation.instruction} />
        ) : null}
      </section>
      <section>
        <h3 className="label">Current workstream</h3>
        <p>{context.workstreams.find((w) => w.id === a.streamId)?.name}</p>
        <Text value={a.direction || "No direction announced yet."} />
      </section>
      {pending ? (
        <section className="panel-block">
          <Badge tone="warning">Assignment pending</Badge>
          <p>
            {context.workstreams.find((w) => w.id === pending.streamId)?.name}
          </p>
          <Text value={pending.instruction} />
          <p className="hint">
            Waiting for the agent to acknowledge this direction.
          </p>
        </section>
      ) : null}
      <section>
        <h3 className="label">Capabilities</h3>
        <Text value={a.capabilities || "Not specified."} />
      </section>
      <section>
        <h3 className="label">Presence</h3>
        <Badge
          tone={
            a.status === "error" ? "danger" : a.online ? "success" : "muted"
          }
        >
          {a.status === "error" ? "error" : a.online ? a.status : "offline"}
        </Badge>
        {a.lastSeen ? (
          <p className="secondary">
            Last seen <Time at={a.lastSeen} />
          </p>
        ) : null}
      </section>
      <AgentRecovery
        agent={a}
        context={context}
        refresh={refresh}
        setup={() => edit({ kind: "recovery" })}
      />
      {!a.recovery || a.recovery.provider.id === "local-process" ? (
        <AgentExecution agent={a} />
      ) : null}
      <section hidden={!!context.mission.archived}>
        <h3 className="label">Human controls</h3>
        {a.control === "pause" ? (
          <p className="hint">
            {a.status === "paused"
              ? "The runtime acknowledged the pause."
              : "Pause requested. Waiting for the runtime to stop."}
          </p>
        ) : null}
        <div className="button-row">
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              action("agent_control", {
                agent_id: a.id,
                control: a.control === "pause" ? "resume" : "pause",
                reason: "Human changed this agent’s execution state.",
              })
            }
          >
            {a.control === "pause" ? "Resume agent" : "Pause agent"}
          </button>
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              action("coordinator_set", {
                version: context.mission.version,
                agent_id: a.role === "coordinator" ? null : a.id,
                reason: "Human changed the mission coordinator.",
              })
            }
          >
            {a.role === "coordinator"
              ? "Remove coordination"
              : "Make coordinator"}
          </button>
          {a.humanDirected ? (
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                action("agent_control", {
                  agent_id: a.id,
                  control: "release",
                  reason:
                    "Human released this direct assignment to coordinator management.",
                })
              }
            >
              Release direct assignment
            </button>
          ) : null}
        </div>
      </section>
    </>
  );
}
function StreamDetail({
  stream: s,
  context,
  edit,
}: {
  stream: Stream;
  context: Context;
  edit: (m: Modal) => void;
}) {
  return (
    <>
      <span className="label">Workstream goal</span>
      <h2>{s.name}</h2>
      <Text value={s.goal} />
      {!s.isDefault && !context.mission.archived ? (
        <button
          className="button"
          onClick={() => edit({ kind: "edit-stream", stream: s })}
        >
          Edit goal
        </button>
      ) : null}
      <section>
        <h3 className="label">Participating agents</h3>
        {context.agents
          .filter((a) => a.streamId === s.id)
          .map((a) => (
            <div className="inset" key={a.id}>
              <Runtime runtime={a.runtime} />
              <span>{a.name}</span>
              <span className="secondary">
                {a.role === "coordinator" ? "Coordinator" : "Agent"}
              </span>
            </div>
          ))}
        {!context.agents.some((a) => a.streamId === s.id) ? (
          <p className="secondary">No agents assigned yet.</p>
        ) : null}
      </section>
    </>
  );
}
function RequestCard({
  request: r,
  busy,
  readOnly,
  respond,
}: {
  request: AgentRequest;
  busy: boolean;
  readOnly: boolean;
  respond: (response: string, status: string) => Promise<boolean>;
}) {
  const [reply, setReply] = useState("");
  return (
    <section className="panel-block">
      <div className="section-heading">
        <h3>
          {r.count} additional {r.count === 1 ? "agent" : "agents"}
        </h3>
        <Badge tone={r.status === "open" ? "warning" : "success"}>
          {r.status}
        </Badge>
      </div>
      <span className="label">{r.capabilities}</span>
      <Text value={r.reason} />
      {r.response ? <Text value={r.response} /> : null}
      <div hidden={readOnly}>
        <Field label="Your response">
          <textarea
            rows={3}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
          />
        </Field>
        <div className="button-row">
          <button
            className="button"
            disabled={busy || !reply.trim()}
            onClick={() =>
              respond(reply, "open").then((ok) => {
                if (ok) setReply("");
              })
            }
          >
            Reply
          </button>
          <button
            className="button primary"
            disabled={busy || !reply.trim()}
            onClick={() =>
              respond(reply, "resolved").then((ok) => {
                if (ok) setReply("");
              })
            }
          >
            Respond & resolve
          </button>
        </div>
      </div>
    </section>
  );
}
function TaskDetail({
  task: t,
  context,
  busy,
  action,
  inspect,
}: {
  task: Task;
  context: Context;
  busy: boolean;
  action: (op: string, p: object) => Promise<boolean>;
  inspect: (id: string) => void;
}) {
  const [status, setStatus] = useState(t.status),
    [summary, setSummary] = useState(t.summary),
    [agentIds, setAgentIds] = useState(t.agentIds),
    [ref, setRef] = useState(""),
    [overrideVersion, setOverrideVersion] = useState(t.version);
  async function save(e: FormEvent) {
    e.preventDefault();
    const disclosure = e.currentTarget.closest("details");
    const saved = await action("task_update", {
      task_id: t.id,
      version: overrideVersion,
      status,
      summary,
      agent_ids: agentIds,
      refs: ref ? [ref] : t.refs,
    });
    if (saved && disclosure) disclosure.open = false;
  }
  return (
    <>
      <div className="section-heading">
        <TaskStatus task={t} />
        <span className="secondary">
          {t.mode === "parallel" ? "Parallel work" : "Individual work"}
        </span>
      </div>
      <h2>{t.title}</h2>
      <Text value={t.description || "No context reported yet."} />
      <div className="task-detail-meta">
        <span>
          {context.workstreams.find((w) => w.id === t.streamId)?.name ||
            "Workstream"}
        </span>
        {t.createdBy ? (
          <span>
            Created by{" "}
            {t.createdBy === "human"
              ? "you"
              : context.agents.find((a) => a.id === t.createdBy)?.name ||
                "agent"}
          </span>
        ) : null}
      </div>
      <section>
        <h3 className="label">Completion criteria</h3>
        <Text value={t.criteria || "Not specified."} />
      </section>
      <section>
        <h3 className="label">Owners</h3>
        {t.agentIds.map((id) => (
          <button className="text-button" key={id} onClick={() => inspect(id)}>
            {context.agents.find((a) => a.id === id)?.name || id}
          </button>
        ))}
        {!t.agentIds.length ? (
          <p className="secondary">No agents assigned.</p>
        ) : null}
      </section>
      <section>
        <h3 className="label">
          {t.status === "done" ? "Result" : "Latest progress report"}
        </h3>
        <Text
          value={
            t.summary ||
            (t.status === "open"
              ? "Planned. No work has been reported yet."
              : "No progress report yet.")
          }
        />
        {t.updatedBy ? (
          <p className="task-update-meta">
            <span>
              Updated by{" "}
              {t.updatedBy === "human"
                ? "you"
                : context.agents.find((a) => a.id === t.updatedBy)?.name ||
                  "agent"}
            </span>
            <Time at={t.updatedAt || t.createdAt} />
          </p>
        ) : null}
        {t.refs.length ? (
          <div className="task-evidence">
            {t.refs.map((id) => (
              <button
                key={id}
                className="text-button"
                onClick={() => inspect(id)}
              >
                Open evidence · {id}
              </button>
            ))}
          </div>
        ) : null}
      </section>
      <details
        className="task-override"
        hidden={!!context.mission.archived}
        onToggle={(event) => {
          if (!event.currentTarget.open) return;
          setStatus(t.status);
          setSummary(t.summary);
          setAgentIds(t.agentIds);
          setRef("");
          setOverrideVersion(t.version);
        }}
      >
        <summary>Human override</summary>
        <p className="hint">
          Use your authority to change ownership or status when intervention is
          needed.
        </p>
        <form className="stack" onSubmit={save}>
          <Field
            label="Change assignment"
            hint={
              t.mode === "parallel"
                ? "Select any participating agents."
                : "Assign one agent, or leave unassigned."
            }
          >
            {t.mode === "parallel" ? (
              <select
                multiple
                value={agentIds}
                onChange={(e) =>
                  setAgentIds(
                    Array.from(e.target.selectedOptions, (x) => x.value),
                  )
                }
                size={Math.min(5, Math.max(2, context.agents.length))}
              >
                {context.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            ) : (
              <select
                value={agentIds[0] || ""}
                onChange={(e) =>
                  setAgentIds(e.target.value ? [e.target.value] : [])
                }
              >
                <option value="">Unassigned</option>
                {context.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {Object.entries(taskLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Evidence and update">
            <textarea
              rows={4}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          </Field>
          <Field label="Reference">
            <select value={ref} onChange={(e) => setRef(e.target.value)}>
              <option value="">Keep current references</option>
              {context.messages
                .filter((m) => m.kind !== "system")
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.body.slice(0, 70)}
                  </option>
                ))}
            </select>
          </Field>
          {overrideVersion !== t.version ? (
            <p className="warning" role="status">
              An agent updated this task. Close and reopen the override to use
              the latest version.
            </p>
          ) : null}
          <button
            className="button primary"
            disabled={busy || overrideVersion !== t.version}
          >
            Apply human override
          </button>
        </form>
      </details>
    </>
  );
}
