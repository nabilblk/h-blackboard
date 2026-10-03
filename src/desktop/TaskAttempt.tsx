import { useEffect, useState } from "react";
import { node } from "./bridge";
import { Text } from "../Markdown";
import type { Perform } from "./ui";
import type {
  AgentView,
  AttemptStatus,
  AttemptView,
  MissionView,
  TaskView,
  WorkEvidence,
} from "./node-contract";
import { statuses, statusLabel } from "./work-ui";
export function Attempt({
  attempt: a,
  task,
  label,
  agents,
  editable,
  busy,
  mission,
  perform,
  changed,
}: {
  attempt: AttemptView;
  task: TaskView;
  label: string;
  agents: AgentView[];
  editable: boolean;
  busy: boolean;
  mission: MissionView;
  perform: Perform;
  changed: () => Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState<{
    attempt: AttemptView;
    revision: string;
    taskRevision: string;
  } | null>(null);
  return (
    <section className="n-task-attempt">
      <header>
        <strong>{label}</strong>
        <span className={`n-task-status ${a.status}`}>
          {statusLabel(a.status)}
        </span>
      </header>
      <Text value={a.approach} links="text" />
      {a.unavailable ? (
        <p className="d-alert">
          This agent is unavailable. Its attempt and evidence remain here.
        </p>
      ) : null}
      {a.reports.map((r) => (
        <div className="n-task-report" key={r.id}>
          <p className="d-field-help">
            Reported by{" "}
            {r.author === mission.owner
              ? "Mission owner"
              : (agents.find((a) => a.identity.author === r.author)?.identity
                  .label ?? "Agent")}
            {r.stale ? " · Evidence needs review" : ""}
          </p>
          <Text value={r.summary} links="text" />
          {r.evidence.length ? (
            <details>
              <summary>Evidence · {r.evidence.length}</summary>
              {r.evidence.map((id) => (
                <Evidence key={id} mission={mission.id} id={id} />
              ))}
            </details>
          ) : null}
        </div>
      ))}
      {!a.reports.length ? (
        <p className="d-field-help">Assigned · no progress report yet.</p>
      ) : null}
      {a.reports.length > 1 ? (
        <p className="d-alert">
          Conflicting reports are preserved. Review them before recording a
          resolution.
        </p>
      ) : null}
      {editable && task.heads.length === 1 && !snapshot ? (
        <button
          className="d-button"
          onClick={() =>
            setSnapshot({
              attempt: a,
              revision: mission.lifecycle.revision,
              taskRevision: task.heads[0].id,
            })
          }
        >
          Override report
        </button>
      ) : null}
      {snapshot ? (
        <form
          className="n-fields"
          onSubmit={(e) => {
            e.preventDefault();
            const d = new FormData(e.currentTarget);
            void perform(async () => {
              await node.work(mission.id, snapshot.revision, {
                type: "report_attempt",
                task: task.id,
                task_revision: snapshot.taskRevision,
                allocation: snapshot.attempt.allocation,
                registration: snapshot.attempt.registration,
                bases: snapshot.attempt.reports.slice(0, 256).map((r) => r.id),
                status: String(d.get("status")) as AttemptStatus,
                summary: String(d.get("summary")).trim(),
                evidence: String(d.get("evidence"))
                  .split(/\s+/)
                  .filter(Boolean),
              });
              setSnapshot(null);
              await changed();
            });
          }}
        >
          <label className="d-field">
            Status
            <select
              name="status"
              defaultValue={a.status === "conflict" ? "blocked" : a.status}
            >
              {statuses
                .filter((s) => s !== "conflict")
                .map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
            </select>
          </label>
          <label className="d-field">
            Reason and evidence summary
            <textarea name="summary" required rows={3} maxLength={4096} />
          </label>
          <label className="d-field">
            Evidence record IDs · optional
            <textarea name="evidence" rows={2} maxLength={1040} />
          </label>
          <div className="n-action-row">
            <button className="d-button" disabled={busy}>
              Record human override
            </button>
            <button
              type="button"
              className="d-button"
              onClick={() => setSnapshot(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function Evidence({ mission, id }: { mission: string; id: string }) {
  const [evidence, setEvidence] = useState<WorkEvidence | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void node.workEvidence(mission, id).then(
      (value) => {
        if (!cancelled) {
          setEvidence(value);
          setError("");
        }
      },
      (e) => {
        if (!cancelled)
          setError(
            e instanceof Error
              ? e.message
              : "Evidence is unavailable on this node.",
          );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [mission, id, open]);
  return (
    <details
      className="n-task-evidence"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        {evidence?.title ?? `Inspect evidence · ${id.slice(0, 8)}`}
      </summary>
      {error ? (
        <p role="alert">{error}</p>
      ) : evidence ? (
        <>
          <code className="n-key">{id}</code>
          {evidence.text ? <Text value={evidence.text} links="text" /> : null}
          {evidence.files.length ? (
            <>
              <p className="d-field-help">
                Published artifact · {evidence.files.length} files. Publication
                does not verify the result.
              </p>
              <ul>
                {evidence.files.map((f) => (
                  <li key={f.path}>
                    <button
                      className="d-button"
                      disabled={opening}
                      onClick={() => {
                        setOpening(true);
                        void node
                          .artifactOpen(mission, id, f.path)
                          .catch((e) =>
                            setError(
                              e instanceof Error
                                ? e.message
                                : "File unavailable.",
                            ),
                          )
                          .finally(() => setOpening(false));
                      }}
                    >
                      {f.path}
                    </button>{" "}
                    · {f.size.toLocaleString()} bytes
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : (
        <p role="status">Reading saved evidence…</p>
      )}
    </details>
  );
}
