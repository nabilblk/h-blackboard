import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Download,
  FileText,
  Plus,
  Star,
} from "lucide-react";
import { node, type ArtifactInspection } from "./bridge";
import { Text } from "../Markdown";
import { ArtifactPublish } from "./ArtifactPublish";
import { ReviewChecks, checksFromForm, reviewMethods } from "./ReviewChecks";
import type {
  ArtifactAction,
  ArtifactDetail,
  ArtifactSummary,
  ReviewVerdict,
  AgentView,
  WorkstreamView,
  MissionView,
} from "./node-contract";
import type { Perform } from "./ui";
const status = (value: string) =>
  ({
    needs_review: "Inputs changed",
    reviewed: "Reviewed by another author",
    self_reviewed: "Self-reviewed",
    changes_requested: "Changes requested",
    conflict: "Conflicting revisions",
    unreviewed: "Not reviewed",
  })[value] ?? value;
const when = (ms: number | null) =>
  ms
    ? new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(ms)
    : "Time not recorded";
export function ArtifactPanel({
  mission,
  owner,
  agents,
  streams,
  initial,
  conversation,
  busy,
  blocked,
  perform,
  changed,
  openConversation,
}: {
  mission: MissionView;
  owner: string;
  agents: AgentView[];
  streams: WorkstreamView[];
  initial: string | null;
  conversation: string;
  busy: boolean;
  blocked: boolean;
  perform: Perform;
  changed: () => Promise<void>;
  openConversation: (channel: string) => void;
}) {
  const [selected, setSelected] = useState(initial);
  const [items, setItems] = useState<ArtifactSummary[]>([]);
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState("");
  const [limit, setLimit] = useState(32);
  const [more, setMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{
    detail: ArtifactDetail | null;
  } | null>(null);
  const [reviewing, setReviewing] = useState<{
    detail: ArtifactDetail;
    control: string;
  } | null>(null);
  const [accepting, setAccepting] = useState<{
    detail: ArtifactDetail;
    control: string;
  } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [copied, setCopied] = useState(false);
  const [inspection, setInspection] = useState<ArtifactInspection | null>(null);
  const label = (author: string) =>
    author === owner
      ? "You"
      : (agents.find((a) => a.identity.author === author)?.identity.label ??
        (author === mission.owner
          ? "Mission owner"
          : `Participant ${author.slice(0, 8)}`));
  const channelName = (id: string) =>
    id === "main"
      ? "Main"
      : id.startsWith("private:")
        ? "Private conversation"
        : (streams.find((s) => `workstream:${s.id}` === id)?.name ??
          "Workstream");
  useEffect(() => {
    let gone = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        if (selected) {
          const value = await node.artifactDetail(mission.id, selected);
          if (!gone) setDetail(value);
        } else {
          let after: string | null = null;
          const rows: ArtifactSummary[] = [];
          let count = 0;
          do {
            const page = await node.artifacts(mission.id, {
              after,
              conversation: channel || null,
              search: search || null,
            });
            rows.push(...page.items);
            after = page.after;
            count = page.total;
          } while (after && rows.length < limit);
          if (!gone) {
            setItems(rows);
            setMore(!!after);
            setTotal(count);
          }
        }
        if (!gone) setError("");
      } catch (e) {
        if (!gone)
          setError(
            e instanceof Error ? e.message : "Artifacts could not be loaded.",
          );
      } finally {
        if (!gone) {
          setLoading(false);
          timer = setTimeout(load, 3000);
        }
      }
    };
    setLoading(true);
    timer = setTimeout(load, search ? 200 : 0);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [mission.id, selected, search, channel, limit, refresh]);
  const choose = (id: string | null) => {
    setDetail(null);
    setSelected(id);
    setReviewing(null);
    setAccepting(null);
    setCopied(false);
    setInspection(null);
  };
  const saved = async (id?: string) => {
    setEditing(null);
    setReviewing(null);
    setAccepting(null);
    if (id) choose(id);
    setRefresh((n) => n + 1);
    await changed();
  };
  const action = (control: string, d: ArtifactDetail, a: ArtifactAction) =>
    void perform(async () => {
      await node.artifactAction(
        mission.id,
        control,
        d.artifact.conversation,
        a,
      );
      await saved();
    });
  if (editing)
    return (
      <ArtifactPublish
        key={editing.detail?.revision ?? "new"}
        mission={mission}
        detail={editing.detail}
        conversation={conversation}
        streams={streams}
        busy={busy}
        perform={perform}
        done={async (id) => saved(id)}
        cancel={() => setEditing(null)}
      />
    );
  return (
    <div className="n-artifacts">
      {error ? (
        <p className="d-alert" role="alert">
          {error}
        </p>
      ) : null}
      {selected ? (
        <>
          <button className="d-button n-back" onClick={() => choose(null)}>
            <ArrowLeft size={15} /> All artifacts
          </button>
          {detail ? (
            <>
              <div className="n-artifact-eyebrow">
                <span className="d-label">
                  {detail.document.kind} · {detail.document.stage}
                </span>
                {detail.highlighted ? <Star size={16} /> : null}
              </div>
              <h2>{detail.document.title}</h2>
              <Text value={detail.document.summary} links="text" />
              <p className="d-field-help">
                {label(detail.author)} · Revision {detail.revision.slice(0, 10)}
              </p>
              <div className="n-action-row">
                <button
                  className="d-button primary"
                  disabled={busy}
                  onClick={() =>
                    void perform(() =>
                      node.artifactOpen(
                        mission.id,
                        detail.revision,
                        detail.document.entrypoint ??
                          detail.document.files[0].path,
                      ),
                    )
                  }
                >
                  <ArrowUpRight size={16} /> Open artifact
                </button>
                {/\.html?$/i.test(detail.document.entrypoint ?? "") ? (
                  <button
                    className="d-button"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const result = await node.artifactInspect(
                          mission.id,
                          detail.revision,
                          detail.document.entrypoint!,
                        );
                        setInspection(result);
                      })
                    }
                  >
                    Check layout
                  </button>
                ) : null}
                <button
                  className="d-button"
                  onClick={() => openConversation(detail.artifact.conversation)}
                >
                  {channelName(detail.artifact.conversation)}
                </button>
              </div>
              {inspection?.revision === detail.revision ? (
                <section className="d-panel">
                  <h3>Layout check</h3>
                  <p className="d-field-help">
                    {inspection.engine} · {inspection.limitations}
                  </p>
                  <ul>
                    {inspection.checks.map((check) => (
                      <li key={check.viewport}>
                        <strong>
                          {check.viewport}px viewport ·{" "}
                          {check.documentWidth <= check.viewport
                            ? "Fits"
                            : `Overflows to ${check.documentWidth}px`}
                        </strong>
                        {check.errors.length ? (
                          <p>{check.errors.length} browser error(s).</p>
                        ) : null}
                        {check.overflow.length ? (
                          <details>
                            <summary>Overflowing content</summary>
                            {check.overflow.map((item, index) => (
                              <p key={index}>
                                {item.tag}
                                {item.id ? ` #${item.id}` : ""}: {item.text}
                              </p>
                            ))}
                          </details>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {detail.may_review && !blocked ? (
                    <button
                      className="d-button"
                      disabled={busy}
                      onClick={() =>
                        action(mission.lifecycle.revision, detail, {
                          type: "review",
                          revision: detail.revision,
                          verdict: inspection.checks.some(
                            (c) =>
                              c.documentWidth > c.viewport ||
                              c.errors.length ||
                              c.nodeAccess,
                          )
                            ? "changes_requested"
                            : "inconclusive",
                          summary: `Automated layout check: ${inspection.checks.map((c) => `${c.viewport}px viewport, ${c.documentWidth}px document, ${c.errors.length} browser errors`).join("; ")}. Full review remains separate.`,
                          conditions: `${inspection.engine}. ${inspection.limitations}`,
                          checks: inspection.checks.map((c) => ({
                            method: "browser_check",
                            result:
                              c.documentWidth > c.viewport ||
                              c.errors.length ||
                              c.nodeAccess
                                ? "failed"
                                : "passed",
                            details: `${c.viewport}px viewport, ${c.documentWidth}px document. ${c.errors.length} browser errors. Layout measurement only; interactions and visual quality were not tested.`,
                          })),
                          evidence: [],
                        })
                      }
                    >
                      Share layout findings
                    </button>
                  ) : null}
                </section>
              ) : null}
              {detail.stale ? (
                <p className="d-alert">
                  Inputs, mission instructions or author availability changed.
                  Review this revision again.
                </p>
              ) : null}
              {detail.artifact.heads.length > 1 ? (
                <div className="d-alert">
                  <strong>Conflicting revisions are preserved.</strong>
                  <p>
                    Inspect each version before publishing a revision that
                    reconciles them.
                  </p>
                  {detail.artifact.heads.map((id) => (
                    <button
                      className="d-button"
                      key={id}
                      onClick={() => choose(id)}
                    >
                      {id.slice(0, 10)}
                    </button>
                  ))}
                </div>
              ) : !detail.artifact.heads.includes(detail.revision) ? (
                <p className="d-field-help">
                  You are viewing an older revision.{" "}
                  <button
                    className="d-button"
                    onClick={() => choose(detail.artifact.revision)}
                  >
                    View latest
                  </button>
                </p>
              ) : null}
              <section>
                <h3>Files · {detail.document.files.length}</h3>
                <div className="n-artifact-files">
                  {detail.document.files.map((f) => (
                    <div key={f.path}>
                      <button
                        className="n-artifact-file"
                        disabled={busy}
                        onClick={() =>
                          void perform(() =>
                            node.artifactOpen(
                              mission.id,
                              detail.revision,
                              f.path,
                            ),
                          )
                        }
                      >
                        <FileText size={16} />
                        <span>
                          {f.path}
                          <small>
                            {Math.ceil(f.size / 1024)} KB ·{" "}
                            {detail.available_files.includes(f.path)
                              ? "Saved on this device"
                              : "Retrieve from peers"}
                          </small>
                        </span>
                        <ArrowUpRight size={16} />
                      </button>
                      <button
                        className="d-button icon"
                        aria-label={`Save ${f.path}`}
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            await node.artifactSave(
                              mission.id,
                              detail.revision,
                              f.path,
                            );
                          })
                        }
                      >
                        <Download size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              </section>
              {detail.document.limitations ? (
                <section>
                  <h3>Limitations</h3>
                  <Text value={detail.document.limitations} links="text" />
                </section>
              ) : null}
              {detail.document.inputs.length ? (
                <section>
                  <h3>Input revisions</h3>
                  {detail.document.inputs.map((id) => (
                    <button
                      className="d-button"
                      key={id}
                      onClick={() => choose(id)}
                    >
                      {id.slice(0, 12)} <ArrowUpRight size={14} />
                    </button>
                  ))}
                </section>
              ) : null}
              <section className="n-artifact-reviews">
                <div className="n-artifact-section-title">
                  <h3>Reviews</h3>
                  {detail.may_review && !blocked ? (
                    <button
                      className="d-button"
                      onClick={() =>
                        setReviewing({
                          detail,
                          control: mission.lifecycle.revision,
                        })
                      }
                    >
                      Add review
                    </button>
                  ) : null}
                </div>
                {!detail.reviews.length ? (
                  <p className="d-field-help">
                    No review for this exact revision.
                  </p>
                ) : null}
                {detail.reviews.map((r) => (
                  <article key={r.id}>
                    <strong>
                      {label(r.author)} · {r.verdict.replaceAll("_", " ")}
                    </strong>
                    <p className="d-field-help">
                      {r.self_review ? "Self-review" : "Different author"}
                      {r.stale ? " · Evidence needs review" : ""}
                    </p>
                    <Text value={r.summary} links="text" />
                    <p className="d-label">Reported checks</p>
                    {r.checks.length ? (
                      <ul>
                        {r.checks.map((check, index) => (
                          <li key={index}>
                            <strong>
                              {reviewMethods[check.method]} ·{" "}
                              {check.result === "not_run"
                                ? "Not checked"
                                : check.result}
                            </strong>
                            <Text value={check.details} links="text" />
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="d-field-help">
                        Check methods were not recorded. This review does not
                        establish that tests or a browser were run.
                      </p>
                    )}
                    <details>
                      <summary>Checks and conditions</summary>
                      <Text value={r.conditions} links="text" />
                      {r.evidence.length ? (
                        <p className="d-field-help">
                          Evidence:{" "}
                          {r.evidence.map((id) => id.slice(0, 10)).join(", ")}
                        </p>
                      ) : null}
                    </details>
                  </article>
                ))}
                {reviewing ? (
                  <form
                    className="n-fields"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const d = new FormData(e.currentTarget);
                      action(reviewing.control, reviewing.detail, {
                        type: "review",
                        revision: reviewing.detail.revision,
                        verdict: String(d.get("verdict")) as ReviewVerdict,
                        summary: String(d.get("summary")).trim(),
                        conditions: String(d.get("conditions")).trim(),
                        checks: checksFromForm(d),
                        evidence: String(d.get("evidence"))
                          .split(/\s+/)
                          .filter(Boolean),
                      });
                    }}
                  >
                    <p className="d-field-help">
                      Reviewing revision{" "}
                      {reviewing.detail.revision.slice(0, 10)}. A review records
                      your checks; it does not accept the mission.
                    </p>
                    <label className="d-field">
                      Verdict
                      <select name="verdict" defaultValue="inconclusive">
                        <option value="verified">
                          Verified within the reported scope
                        </option>
                        <option value="changes_requested">
                          Changes requested
                        </option>
                        <option value="inconclusive">Inconclusive</option>
                      </select>
                    </label>
                    <label className="d-field">
                      Review
                      <textarea
                        name="summary"
                        required
                        rows={3}
                        maxLength={4096}
                      />
                    </label>
                    <ReviewChecks />
                    <label className="d-field">
                      Overall conditions and limitations
                      <textarea
                        name="conditions"
                        required
                        rows={3}
                        maxLength={4096}
                        placeholder="Checks, environment and any limitations."
                      />
                    </label>
                    <label className="d-field">
                      Evidence references · optional
                      <textarea
                        name="evidence"
                        rows={2}
                        placeholder="Exact message or artifact revision references."
                      />
                    </label>
                    <div className="n-action-row">
                      <button className="d-button primary" disabled={busy}>
                        Save review
                      </button>
                      <button
                        className="d-button"
                        type="button"
                        onClick={() => setReviewing(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}
              </section>
              <section>
                <h3>Human acceptance</h3>
                {detail.acceptance ? (
                  <>
                    <p>
                      {detail.acceptance.accepted
                        ? "Accepted"
                        : "Acceptance withdrawn"}{" "}
                      by {label(detail.acceptance.author)}
                      {detail.acceptance.stale ? " · Needs review" : ""}
                    </p>
                    <Text value={detail.acceptance.reason} links="text" />
                  </>
                ) : (
                  <p className="d-field-help">
                    This revision has not been accepted.
                  </p>
                )}
                {detail.may_accept && !blocked && !accepting ? (
                  <button
                    className="d-button"
                    disabled={busy}
                    onClick={() =>
                      setAccepting({
                        detail,
                        control: mission.lifecycle.revision,
                      })
                    }
                  >
                    {detail.acceptance?.accepted
                      ? "Change acceptance"
                      : "Record acceptance"}
                  </button>
                ) : null}
                {accepting ? (
                  <form
                    className="n-fields"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const d = new FormData(e.currentTarget);
                      action(accepting.control, accepting.detail, {
                        type: "accept",
                        revision: accepting.detail.revision,
                        accepted: String(d.get("accepted")) === "yes",
                        reason: String(d.get("reason")).trim(),
                      });
                    }}
                  >
                    <label className="d-field">
                      Decision
                      <select name="accepted">
                        <option value="yes">Accept this exact revision</option>
                        <option value="no">Withdraw acceptance</option>
                      </select>
                    </label>
                    <label className="d-field">
                      Reason
                      <textarea
                        name="reason"
                        required
                        rows={2}
                        maxLength={2048}
                      />
                    </label>
                    <div className="n-action-row">
                      <button className="d-button" disabled={busy}>
                        Save decision
                      </button>
                      <button
                        type="button"
                        className="d-button"
                        onClick={() => setAccepting(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}
              </section>
              <details>
                <summary>Revision history · {detail.history.length}</summary>
                <div className="n-artifact-history">
                  {detail.history.map((r) => (
                    <button
                      key={r.id}
                      aria-current={
                        r.id === detail.revision ? "true" : undefined
                      }
                      onClick={() => choose(r.id)}
                    >
                      <span>
                        {r.id.slice(0, 10)} · {label(r.author)}
                      </span>
                      <small>{when(r.created_at_ms)}</small>
                    </button>
                  ))}
                </div>
              </details>
              <div className="n-action-row">
                {detail.may_publish && !blocked ? (
                  <button
                    className="d-button"
                    onClick={() => setEditing({ detail })}
                  >
                    Publish revision
                  </button>
                ) : null}
                {detail.may_highlight && !blocked ? (
                  <button
                    className="d-button"
                    disabled={busy}
                    onClick={() =>
                      action(mission.lifecycle.revision, detail, {
                        type: "highlight",
                        revision: detail.revision,
                        highlighted: !detail.highlighted,
                      })
                    }
                  >
                    <Star size={14} />
                    {detail.highlighted ? "Remove highlight" : "Highlight"}
                  </button>
                ) : null}
                <button
                  className="d-button"
                  onClick={() => {
                    void node
                      .copyArtifactReference(mission.id, detail.revision)
                      .then(() => setCopied(true))
                      .catch(() =>
                        setError("Could not copy the revision reference."),
                      );
                  }}
                >
                  {copied ? "Copied" : "Copy revision reference"}
                </button>
              </div>
            </>
          ) : loading ? (
            <p role="status">Loading artifact…</p>
          ) : null}
        </>
      ) : (
        <>
          <div className="n-artifact-section-title">
            <div>
              <h2>Shared outputs</h2>
              <p className="d-field-help">
                {total} {total === 1 ? "artifact" : "artifacts"} · files,
                reviews and revision history
              </p>
            </div>
            <button
              className="d-button"
              disabled={busy || blocked}
              onClick={() => setEditing({ detail: null })}
            >
              <Plus size={16} /> Publish
            </button>
          </div>
          <label className="d-field">
            <span className="sr-only">Search artifacts</span>
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setLimit(32);
              }}
              placeholder="Search all accessible artifacts"
            />
          </label>
          <label className="d-field">
            Conversation
            <select
              value={channel}
              onChange={(e) => {
                setChannel(e.target.value);
                setLimit(32);
              }}
            >
              <option value="">All accessible conversations</option>
              <option value="main">Main</option>
              {streams.map((s) => (
                <option key={s.id} value={`workstream:${s.id}`}>
                  # {s.name}
                </option>
              ))}
              {conversation.startsWith("private:") ? (
                <option value={conversation}>This private conversation</option>
              ) : null}
            </select>
          </label>
          {loading ? <p role="status">Loading artifacts…</p> : null}
          <div className="n-artifact-list">
            {items.map((a) => (
              <article className="n-artifact-row" key={a.id}>
                <div className="n-artifact-row-title">
                  <FileText size={19} />
                  <button
                    onClick={() =>
                      a.entrypoint && a.heads.length === 1
                        ? void perform(() =>
                            node.artifactOpen(
                              mission.id,
                              a.revision,
                              a.entrypoint!,
                            ),
                          )
                        : choose(a.revision)
                    }
                    disabled={busy}
                  >
                    {a.title}
                  </button>
                  {a.highlighted ? (
                    <Star size={15} aria-label="Highlighted" />
                  ) : null}
                </div>
                <p>{a.summary}</p>
                <div className="n-artifact-meta">
                  <span>{label(a.author)}</span>
                  <span>
                    {a.kind} · {a.file_count}{" "}
                    {a.file_count === 1 ? "file" : "files"}
                  </span>
                  <span>{when(a.updated_at_ms)}</span>
                  <span>
                    {channelName(a.conversation)} ·{" "}
                    {a.stage === "draft" ? "Draft" : "Complete"} ·{" "}
                    {a.revision_count}{" "}
                    {a.revision_count === 1 ? "revision" : "revisions"}
                  </span>
                </div>
                <div className="n-artifact-row-footer">
                  <span className={`n-artifact-status ${a.review_status}`}>
                    {status(a.review_status)}
                    {a.accepted ? " · Accepted" : ""}
                  </span>
                  <button
                    className="d-button"
                    onClick={() => choose(a.revision)}
                  >
                    Details
                  </button>
                </div>
              </article>
            ))}
          </div>
          {!loading && !items.length ? (
            <p className="n-work-empty">
              {search || channel
                ? "No artifacts match these filters."
                : "No artifacts yet. Publish a plan, report or working application when there is something to share."}
            </p>
          ) : null}
          {more ? (
            <button
              className="d-button"
              onClick={() => setLimit((n) => n + 32)}
            >
              Load more
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
