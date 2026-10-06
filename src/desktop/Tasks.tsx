import { useEffect, useState } from "react";
import { ArrowLeft, Hash, Plus } from "lucide-react";
import { node } from "./bridge";
import { Text } from "../Markdown";
import type {
  AgentView,
  TaskDefinition,
  TaskView,
  WorkstreamView,
} from "./node-contract";
import { active, statuses, statusLabel, type Props } from "./work-ui";
import { Attempt } from "./TaskAttempt";
export function TaskPanel({
  initialTask,
  mission,
  localKey,
  busy,
  blocked,
  perform,
  changed,
  streams,
  agents,
  open,
}: Props & {
  initialTask: string | null;
  streams: WorkstreamView[];
  agents: AgentView[];
  open: (audience: string) => void;
}) {
  const [items, setItems] = useState<TaskView[]>([]);
  const [limit, setLimit] = useState(32);
  const [total, setTotal] = useState(0);
  const [after, setAfter] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [owner, setOwner] = useState("");
  const [status, setStatus] = useState("");
  const [workstream, setWorkstream] = useState("");
  const [selected, setSelected] = useState<string | null>(initialTask);
  useEffect(() => {
    setSelected(initialTask);
    setEditing(null);
  }, [initialTask]);
  const [detail, setDetail] = useState<TaskView | null>(null);
  const [editing, setEditing] = useState<{
    task: TaskView | null;
    revision: string;
  } | null>(null);
  const [generation, setGeneration] = useState(0);
  const query = {
    search: search.trim(),
    owner: owner.trim(),
    status: status || null,
    workstream: workstream || null,
  };
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    const poll = async () => {
      try {
        const [page, one] = await Promise.all([
          node.tasks(mission.id, query),
          selected
            ? node.tasks(mission.id, { task: selected })
            : Promise.resolve(null),
        ]);
        while (page.after && page.items.length < limit && !cancelled) {
          const more = await node.tasks(mission.id, {
            ...query,
            after: page.after,
          });
          page.items.push(...more.items);
          page.after = more.after;
        }
        if (!cancelled) {
          setItems(page.items);
          setTotal(page.total);
          setAfter(page.after);
          setDetail(one?.items[0] ?? null);
          setError("");
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Unable to read tasks.");
          setLoading(false);
        }
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 3000);
    };
    timer = setTimeout(() => void poll(), 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    mission.id,
    search,
    owner,
    status,
    workstream,
    selected,
    generation,
    limit,
  ]);
  const editable = localKey === mission.owner && !blocked;
  const label = (id: string) =>
    agents.find((a) => a.id === id)?.identity.label ?? "Unavailable agent";
  const refresh = async () => {
    setGeneration((n) => n + 1);
    await changed();
  };
  return (
    <div className="n-work-detail">
      {mission.lifecycle.phase === "paused" ? (
        <p className="d-alert">
          Mission paused. These are the latest saved reports.
        </p>
      ) : null}
      {selected ? (
        <button
          className="d-back"
          onClick={() => {
            setSelected(null);
            setEditing(null);
          }}
        >
          <ArrowLeft size={15} />
          All tasks
        </button>
      ) : (
        <>
          <p>
            Ownership, approaches and reported progress. Agents create tasks
            when a concrete outcome needs tracking.
          </p>
          <div className="n-task-filters">
            <label className="d-field">
              Search tasks
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                maxLength={512}
              />
            </label>
            <label className="d-field">
              Owner
              <input
                type="search"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                maxLength={120}
                placeholder="Agent or contributor"
              />
            </label>
            <label className="d-field">
              Status
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">All statuses</option>
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </select>
            </label>
            <label className="d-field">
              Workstream
              <select
                value={workstream}
                onChange={(e) => setWorkstream(e.target.value)}
              >
                <option value="">All workstreams</option>
                <option value="main">Main</option>
                {streams.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="d-label">
            {total} {total === 1 ? "task" : "tasks"}
          </p>
        </>
      )}
      {error ? (
        <p className="d-alert" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? <p role="status">Loading tasks…</p> : null}
      {!selected ? (
        <>
          <div className="n-task-list">
            {items.map((t) => (
              <button
                className="n-task-row"
                key={t.id}
                onClick={() => setSelected(t.id)}
              >
                <span className={`n-task-status ${t.status}`}>
                  {statusLabel(t.status)}
                </span>
                <strong>{t.definition.title}</strong>
                <span className="d-field-help">
                  {t.attempts.length
                    ? [...new Set(t.attempts.map((a) => a.registration))]
                        .map(label)
                        .join(" · ")
                    : "Unassigned"}
                  {t.attempts.length > 1
                    ? ` · ${t.attempts.length} attempts`
                    : ""}
                </span>
                <span className="d-field-help">
                  #{" "}
                  {streams.find((s) => s.id === t.definition.workstream)
                    ?.name ?? "Main"}
                  {t.stale ? " · Needs review" : ""}
                  {t.attempts.some((a) => a.unavailable)
                    ? " · Owner unavailable"
                    : ""}
                </span>
              </button>
            ))}
          </div>
          {!loading && !items.length ? (
            <p className="n-work-empty">
              {search || owner || status || workstream
                ? "No tasks match these filters."
                : "No tasks yet. Work can continue through Main and workstream goals."}
            </p>
          ) : null}
          {after ? (
            <button
              className="d-button"
              disabled={busy}
              onClick={() => setLimit((n) => n + 32)}
            >
              Load more tasks
            </button>
          ) : null}
        </>
      ) : detail ? (
        <>
          <p className={`n-task-status ${detail.status}`}>
            {statusLabel(detail.status)}
          </p>
          <h2>{detail.definition.title}</h2>
          <Text value={detail.definition.description} links="text" />
          <button
            className="d-button"
            onClick={() =>
              open(
                detail.definition.workstream
                  ? `workstream:${detail.definition.workstream}`
                  : "main",
              )
            }
          >
            <Hash size={15} />
            {streams.find((s) => s.id === detail.definition.workstream)?.name ??
              "Main"}
          </button>
          <h3>Completion criteria</h3>
          <ul>
            {detail.definition.criteria.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
          {!detail.definition.criteria.length ? (
            <p className="d-field-help">
              Use the task description to assess the result.
            </p>
          ) : null}
          {detail.stale ? (
            <p className="d-alert">
              Task instructions or evidence changed. Review the saved reports.
            </p>
          ) : null}
          {detail.heads.length > 1 ? (
            <div className="d-alert">
              <strong>Concurrent definitions need a decision.</strong>
              {detail.heads.map((h) => (
                <div key={h.id}>
                  <p>{h.definition.title}</p>
                  <Text value={h.definition.description} links="text" />
                </div>
              ))}
            </div>
          ) : null}
          <h3>Attempts · {detail.attempts.length}</h3>
          {!detail.attempts.length ? (
            <p className="d-field-help">No agent owns an attempt yet.</p>
          ) : null}
          {detail.attempts.map((a) => (
            <Attempt
              key={`${a.allocation}:${a.registration}`}
              attempt={a}
              task={detail}
              label={label(a.registration)}
              agents={agents}
              editable={editable}
              busy={busy}
              mission={mission}
              perform={perform}
              changed={refresh}
            />
          ))}
          <p className="d-field-help">
            Statuses are attributed reports. They do not prove a process is
            running, verify a result or close the mission.
          </p>
        </>
      ) : null}
      {editable ? (
        <details className="n-work-overrides">
          <summary>
            {detail ? "Manage this task" : "Create a task yourself"}
          </summary>
          <p className="d-field-help">
            Normally, the Coordinator and agents maintain tasks. Your changes
            are attributed to you.
          </p>
          <button
            className="d-button"
            disabled={busy}
            onClick={() =>
              setEditing({ task: detail, revision: mission.lifecycle.revision })
            }
          >
            <Plus size={15} />
            {detail ? "Edit definition / resolve" : "Create a task"}
          </button>
          {detail ? (
            <form
              className="n-fields"
              onSubmit={(e) => {
                e.preventDefault();
                const d = new FormData(e.currentTarget);
                void perform(async () => {
                  await node.work(mission.id, mission.lifecycle.revision, {
                    type: "assign_task",
                    task: detail.id,
                    registration: String(d.get("agent")),
                    approach: String(d.get("approach")).trim(),
                  });
                  await refresh();
                });
              }}
            >
              <label className="d-field">
                Agent
                <select name="agent" required defaultValue="">
                  <option value="" disabled>
                    Select an agent
                  </option>
                  {agents.filter(active).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.identity.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="d-field">
                Approach
                <textarea name="approach" required maxLength={2048} rows={2} />
              </label>
              <button className="d-button" disabled={busy}>
                Add an attempt
              </button>
            </form>
          ) : null}
        </details>
      ) : null}
      {editing ? (
        <TaskEditor
          key={`${editing.task?.id ?? "new"}:${editing.revision}`}
          task={editing.task}
          streams={streams}
          busy={busy}
          cancel={() => setEditing(null)}
          save={(definition) =>
            void perform(async () => {
              const task = editing.task;
              await node.work(
                mission.id,
                editing.revision,
                task
                  ? {
                      type: "revise_task",
                      task: task.id,
                      bases: task.heads.slice(0, 256).map((h) => h.id),
                      definition,
                    }
                  : { type: "create_task", definition, assignees: [] },
              );
              setEditing(null);
              await refresh();
            })
          }
        />
      ) : null}
    </div>
  );
}

function TaskEditor({
  task,
  streams,
  busy,
  save,
  cancel,
}: {
  task: TaskView | null;
  streams: WorkstreamView[];
  busy: boolean;
  save: (d: TaskDefinition) => void;
  cancel: () => void;
}) {
  return (
    <form
      className="n-fields n-work-editor"
      onSubmit={(e) => {
        e.preventDefault();
        const d = new FormData(e.currentTarget);
        save({
          title: String(d.get("title")).trim(),
          description: String(d.get("description")).trim(),
          criteria: String(d.get("criteria"))
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
          workstream: String(d.get("workstream")) || null,
        });
      }}
    >
      <label className="d-field">
        Task title
        <input
          name="title"
          defaultValue={task?.definition.title}
          required
          maxLength={240}
        />
      </label>
      <label className="d-field">
        Expected outcome
        <textarea
          name="description"
          defaultValue={task?.definition.description}
          required
          rows={3}
          maxLength={4096}
        />
      </label>
      <label className="d-field">
        Completion criteria · one per line
        <textarea
          name="criteria"
          defaultValue={task?.definition.criteria.join("\n")}
          rows={3}
          maxLength={16384}
        />
      </label>
      <label className="d-field">
        Workstream
        <select
          name="workstream"
          defaultValue={task?.definition.workstream ?? ""}
        >
          <option value="">Main</option>
          {streams.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <div className="n-action-row">
        <button className="d-button primary" disabled={busy}>
          Save task
        </button>
        <button className="d-button" type="button" onClick={cancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
