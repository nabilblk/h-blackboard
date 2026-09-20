import { useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { Badge, Empty, Text, Time } from "./ui";
import type { Context, Task } from "./model";

export const taskLabels: Record<string, string> = {
  open: "Planned",
  working: "In progress",
  paused: "Paused",
  done: "Done",
};
export function TaskStatus({ task }: { task: Task }) {
  return (
    <Badge
      tone={
        task.status === "done"
          ? "success"
          : task.status === "working"
            ? "progress"
            : task.status === "paused"
              ? "warning"
              : ""
      }
    >
      {taskLabels[task.status] || task.status}
    </Badge>
  );
}

export function TaskList({
  context,
  inspect,
}: {
  context: Context;
  inspect: (id: string) => void;
}) {
  const [status, setStatus] = useState("");
  const [stream, setStream] = useState("");
  const [query, setQuery] = useState("");
  const agents = new Map(context.agents.map((a) => [a.id, a.name]));
  const streams = new Map(context.workstreams.map((w) => [w.id, w.name]));
  const owners = (task: Task) =>
    task.agentIds.map((id) => agents.get(id) || id).join(", ");
  const tasks = context.tasks
    .filter(
      (task) =>
        (!status || task.status === status) &&
        (!stream || task.streamId === stream) &&
        `${task.title} ${task.description} ${task.summary} ${owners(task)}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort(
      (a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt),
    );
  return (
    <div className="task-visibility">
      <div className="section-heading">
        <h3>
          Tasks <span className="count">{context.tasks.length}</span>
        </h3>
        {status || stream || query ? (
          <button
            className="text-button"
            onClick={() => {
              setStatus("");
              setStream("");
              setQuery("");
            }}
          >
            Clear filters
          </button>
        ) : null}
      </div>
      <p className="secondary">
        Coordinators and agents manage tasks to carry out the plan. Follow their
        ownership, progress, and results here.
      </p>
      {context.mission.plan ? (
        <details className="task-plan">
          <summary>Shared plan</summary>
          <Text value={context.mission.plan} />
        </details>
      ) : null}
      {context.tasks.length ? (
        <>
          <div className="task-counts" aria-label="Task status filters">
            {Object.entries(taskLabels).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={status === value}
                className={status === value ? "selected" : ""}
                onClick={() => setStatus(status === value ? "" : value)}
              >
                <strong>
                  {context.tasks.filter((task) => task.status === value).length}
                </strong>
                <span>{label}</span>
              </button>
            ))}
          </div>
          <div className="task-filters">
            <label className="task-search">
              <Search size={14} />
              <input
                aria-label="Search tasks or owners"
                placeholder="Search tasks or owners"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            {context.workstreams.length > 1 ? (
              <select
                aria-label="Filter tasks by workstream"
                value={stream}
                onChange={(e) => setStream(e.target.value)}
              >
                <option value="">All workstreams</option>
                {context.workstreams.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          <div className="task-records">
            {tasks.map((task) => (
              <article className="task-record" key={task.id}>
                <button className="task-open" onClick={() => inspect(task.id)}>
                  <span className="task-open-title">
                    <strong>{task.title}</strong>
                    <TaskStatus task={task} />
                  </span>
                  <span className="task-owner-names">
                    {owners(task) || "No owner assigned"}
                  </span>
                  <span className="task-stream-name">
                    {streams.get(task.streamId) || "Workstream"} ·{" "}
                    {task.mode === "parallel"
                      ? "Parallel work"
                      : "Individual work"}
                    <ChevronRight size={13} />
                  </span>
                </button>
                {task.summary ? (
                  <div className="task-update-preview">
                    <Text value={task.summary} />
                  </div>
                ) : (
                  <p className="task-no-report">
                    {task.status === "open"
                      ? "Planned · no work reported yet"
                      : "No progress report yet"}
                  </p>
                )}
                <div className="task-update-meta">
                  <span>
                    {task.updatedAt ? "Updated" : "Created"}
                    {task.updatedBy
                      ? ` by ${task.updatedBy === "human" ? "you" : agents.get(task.updatedBy) || "agent"}`
                      : ""}
                  </span>
                  <Time at={task.updatedAt || task.createdAt} />
                </div>
              </article>
            ))}
            {!tasks.length ? (
              <Empty title="No matching tasks">
                Change the status, workstream, or search to see more work.
              </Empty>
            ) : null}
          </div>
        </>
      ) : (
        <Empty
          title={
            context.mission.archived ? "No recorded tasks" : "No tasks yet"
          }
        >
          {context.mission.archived
            ? "This mission was archived without task records."
            : "The coordinator and agents will create tasks when work benefits from explicit ownership and progress tracking. Their updates will appear here automatically."}
        </Empty>
      )}
    </div>
  );
}
