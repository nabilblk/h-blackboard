import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, Download, Lock, Plus, X } from "lucide-react";
import { rpc } from "./client";
import { usePanelEscape } from "./usePanelEscape";
import { Badge, Empty, Field, ModalFrame, Text, Time } from "./ui";
import type { Context } from "./model";
import type {
  Artifact,
  ArtifactDetail,
  ArtifactFile,
  ArtifactRevision,
} from "./resources";

export function ArtifactsPanel({
  context,
  artifactId,
  revisionId,
  directAgentId,
  close,
  inspect,
  refresh,
}: {
  context: Context;
  artifactId?: string;
  revisionId?: string;
  directAgentId?: string;
  close: () => void;
  inspect: (id: string) => void;
  refresh: () => Promise<void>;
}) {
  usePanelEscape(close);
  const [items, setItems] = useState<Artifact[]>([]),
    [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [selected, setSelected] = useState(artifactId || ""),
    [revision, setRevision] = useState(revisionId || "");
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [nextOffset, setNextOffset] = useState<number | null>(null),
    [query, setQuery] = useState("");
  const [publishing, setPublishing] = useState(false),
    [reviewing, setReviewing] = useState(false),
    [generation, setGeneration] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    const load = selected
      ? rpc<ArtifactDetail>("artifact_read", {
          channel_id: context.mission.id,
          artifact_id: selected,
          revision_id: revision || undefined,
        })
      : rpc<{ items: Artifact[]; nextOffset: number | null }>(
          "artifacts_read",
          { channel_id: context.mission.id, direct_agent_id: directAgentId },
        );
    load
      .then((result) => {
        if (!active) return;
        if ("artifact" in result) setDetail(result);
        else {
          setItems(result.items);
          setNextOffset(result.nextOffset);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    selected,
    context.mission.id,
    context.cursor,
    directAgentId,
    generation,
    revision,
  ]);
  const loadHistory = async (kind: "revisions" | "reviews") => {
    if (!detail) return;
    setLoading(true);
    setError("");
    try {
      const result = await rpc<ArtifactDetail>("artifact_read", {
        channel_id: context.mission.id,
        artifact_id: selected,
        revision_id: revision || undefined,
        ...(kind === "revisions"
          ? { revision_offset: detail.nextRevisionOffset }
          : { review_offset: detail.nextReviewOffset }),
      });
      setDetail((old) =>
        old
          ? {
              ...old,
              ...(kind === "revisions"
                ? {
                    revisions: [
                      ...new Map(
                        [...old.revisions, ...result.revisions].map((r) => [
                          r.id,
                          r,
                        ]),
                      ).values(),
                    ].sort((a, b) => a.number - b.number),
                    nextRevisionOffset: result.nextRevisionOffset,
                  }
                : {
                    reviews: [
                      ...new Map(
                        [...old.reviews, ...result.reviews].map((r) => [
                          r.id,
                          r,
                        ]),
                      ).values(),
                    ],
                    nextReviewOffset: result.nextReviewOffset,
                  }),
            }
          : result,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const current = detail?.revisions.find(
    (r) => r.id === (revision || detail.artifact.headId),
  );
  const latest = current?.id === detail?.artifact.headId;
  const author = (id: string) =>
    id === "human"
      ? "You"
      : context.agents.find((a) => a.id === id)?.name || id;
  const saved = async (result?: {
    artifact: Artifact;
    revision: ArtifactRevision;
  }) => {
    await refresh();
    setGeneration((v) => v + 1);
    if (result) {
      setSelected(result.artifact.id);
      setRevision(result.revision.id);
    }
    setPublishing(false);
    setReviewing(false);
  };
  return (
    <aside
      className="details resource-panel artifacts-panel"
      aria-label="Mission artifacts"
    >
      <header className="details-heading">
        {selected ? (
          <button
            className="icon"
            aria-label="All artifacts"
            onClick={() => {
              setSelected("");
              setDetail(null);
              setRevision("");
            }}
          >
            <ArrowLeft size={17} />
          </button>
        ) : null}
        <h2 className="label">
          {directAgentId || detail?.artifact.directAgentId ? (
            <Lock size={13} />
          ) : null}{" "}
          Artifacts{directAgentId ? " · private conversation" : ""}
        </h2>
        <button className="icon" aria-label="Close artifacts" onClick={close}>
          <X size={17} />
        </button>
      </header>
      <div className="details-body">
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        {!selected ? (
          <>
            <div className="section-heading">
              <h2>Shared work, saved</h2>
              <button
                className="button"
                disabled={context.mission.archived}
                onClick={() => setPublishing(true)}
              >
                <Plus size={14} />
                Publish
              </button>
            </div>
            <p className="secondary">
              Plans, evidence and deliverables with revision history.
              Publication, verification and acceptance stay distinct.
            </p>
            <input
              type="search"
              aria-label="Filter loaded artifacts"
              placeholder="Filter loaded artifacts"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {!loading && !items.length ? (
              <Empty title="No artifacts yet">
                Agents publish useful work here as they progress. Tasks are
                optional.
              </Empty>
            ) : null}
            {items
              .filter((a) =>
                `${a.title} ${a.kind} ${a.revision.summary}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .map((a) => (
                <button
                  className="artifact-card"
                  key={a.id}
                  onClick={() => {
                    setSelected(a.id);
                    setRevision("");
                  }}
                >
                  <span className="section-heading">
                    <strong>{a.title}</strong>
                    <span className="mono secondary">v{a.revision.number}</span>
                  </span>
                  <span className="secondary">{a.revision.summary}</span>
                  <span className="button-row">
                    <Badge tone={a.stale ? "warning" : ""}>
                      {a.stale ? "Inputs changed" : a.revision.outcome}
                    </Badge>
                    <span className="mono secondary">
                      {a.kind} · {a.revision.files.length} files
                    </span>
                  </span>
                </button>
              ))}
            {nextOffset !== null ? (
              <button
                className="button"
                disabled={loading}
                onClick={async () => {
                  setLoading(true);
                  try {
                    const next = await rpc<{
                      items: Artifact[];
                      nextOffset: number | null;
                    }>("artifacts_read", {
                      channel_id: context.mission.id,
                      direct_agent_id: directAgentId,
                      offset: nextOffset,
                    });
                    setItems((old) => [...old, ...next.items]);
                    setNextOffset(next.nextOffset);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setLoading(false);
                  }
                }}
              >
                Load more artifacts
              </button>
            ) : null}
          </>
        ) : detail && current ? (
          <>
            <section>
              <div className="section-heading">
                <h2>{current.title}</h2>
                <Badge tone={current.outcome === "draft" ? "" : "progress"}>
                  {current.outcome}
                </Badge>
              </div>
              <p className="secondary">
                {author(current.authorId)} · <Time at={current.createdAt} /> ·{" "}
                {current.kind}
              </p>
              {detail.artifact.directAgentId ? (
                <p className="privacy-note">
                  <Lock size={13} />
                  Private to the human and{" "}
                  {author(detail.artifact.directAgentId)}
                </p>
              ) : null}
              <Text value={current.summary} />
              <Field label="Revision">
                <select
                  value={current.id}
                  onChange={(e) => setRevision(e.target.value)}
                >
                  {[...detail.revisions].reverse().map((r) => (
                    <option key={r.id} value={r.id}>
                      Revision {r.number}
                      {r.id === detail.artifact.headId
                        ? " · latest"
                        : ""} · {author(r.authorId)}
                    </option>
                  ))}
                </select>
              </Field>
              {detail.nextRevisionOffset !== null ? (
                <button
                  className="text-button"
                  disabled={loading}
                  onClick={() => loadHistory("revisions")}
                >
                  Load earlier revisions
                </button>
              ) : null}
              {!latest ? (
                <Badge tone="warning">Superseded revision</Badge>
              ) : null}
              {current.stale ? (
                <div className="state-banner warning">
                  Mission instructions or an input revision changed. Revalidate
                  this result before relying on it.
                </div>
              ) : null}
              <div className="button-row">
                <button
                  className="button"
                  disabled={
                    context.mission.archived ||
                    context.mission.planArtifactId === detail.artifact.id
                  }
                  title={
                    context.mission.planArtifactId === detail.artifact.id
                      ? "Edit the shared plan from mission details"
                      : undefined
                  }
                  onClick={() => setPublishing(true)}
                >
                  Publish revision
                </button>
                <button
                  className="button"
                  disabled={context.mission.archived}
                  onClick={() => setReviewing(true)}
                >
                  Review this revision
                </button>
                <button
                  className="text-button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        `${location.origin}/#${context.mission.id}?message=${current.id}`,
                      );
                    } catch {
                      setError("Could not copy the revision link.");
                    }
                  }}
                >
                  Copy revision link
                </button>
              </div>
            </section>
            <FilePreview
              key={current.id}
              revision={current}
              channelId={context.mission.id}
            />
            <section>
              <h3 className="label">Limitations</h3>
              <Text
                value={
                  current.limitations ||
                  "No limitations reported by the author."
                }
              />
            </section>
            {current.refs.length ? (
              <section>
                <h3 className="label">Inputs and evidence</h3>
                <div className="stack">
                  {current.refs.map((id) => (
                    <button
                      className="text-button"
                      key={id}
                      onClick={() => inspect(id)}
                    >
                      Open reference · {id}
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
            <section>
              <h3 className="label">Reviews · revision {current.number}</h3>
              {detail.nextReviewOffset !== null ? (
                <button
                  className="text-button"
                  disabled={loading}
                  onClick={() => loadHistory("reviews")}
                >
                  Load earlier reviews
                </button>
              ) : null}
              {detail.reviews
                .filter((r) => r.revisionId === current.id)
                .map((r) => (
                  <article className="resource-row" key={r.id}>
                    <div className="button-row">
                      <Badge
                        tone={
                          r.stale
                            ? "warning"
                            : r.verdict === "verified" ||
                                r.verdict === "accepted"
                              ? "success"
                              : ""
                        }
                      >
                        {r.verdict}
                        {r.stale ? " · stale" : ""}
                      </Badge>
                      <span className="secondary">
                        {author(r.authorId)}
                        {r.selfReview ? " · self-review" : ""}
                      </span>
                    </div>
                    <Text value={r.summary} />
                    <p className="secondary">Conditions: {r.conditions}</p>
                    {r.refs.map((id) => (
                      <button
                        className="text-button"
                        key={id}
                        onClick={() => inspect(id)}
                      >
                        {id}
                      </button>
                    ))}
                  </article>
                ))}
              {!detail.reviews.some((r) => r.revisionId === current.id) ? (
                <p className="secondary">
                  {detail.nextReviewOffset !== null
                    ? "No review for this revision in the loaded history. Load earlier reviews to inspect more."
                    : "No verification or human acceptance recorded for this revision."}
                </p>
              ) : null}
            </section>
            <section>
              <h3 className="label">Provenance</h3>
              <p className="mono secondary">{current.id}</p>
              {current.runId ? (
                <p className="mono secondary">Run: {current.runId}</p>
              ) : null}
              <p className="secondary">
                A published result is the author's report. Reviews record their
                evidence and conditions; the human retains final authority.
              </p>
            </section>
          </>
        ) : null}
        {loading ? (
          <p className="secondary" role="status">
            Loading artifacts…
          </p>
        ) : null}
      </div>
      {publishing ? (
        <PublishArtifact
          context={context}
          artifact={selected ? detail?.artifact : undefined}
          directAgentId={directAgentId}
          close={() => setPublishing(false)}
          saved={saved}
        />
      ) : null}
      {reviewing && current ? (
        <ReviewArtifact
          channelId={context.mission.id}
          revision={current}
          close={() => setReviewing(false)}
          saved={saved}
        />
      ) : null}
    </aside>
  );
}
const bytesFromBase64 = (value: string) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
function FilePreview({
  revision,
  channelId,
}: {
  revision: ArtifactRevision;
  channelId: string;
}) {
  const [fileName, setFileName] = useState(revision.files[0].name),
    [data, setData] = useState<{
      file: ArtifactFile;
      bytes: Uint8Array<ArrayBuffer>;
    } | null>(null);
  const [error, setError] = useState(""),
    [preview, setPreview] = useState(false);
  useEffect(() => {
    let active = true;
    setData(null);
    setError("");
    setPreview(false);
    rpc<ArtifactFile & { content: string }>("artifact_file", {
      channel_id: channelId,
      revision_id: revision.id,
      name: fileName,
    })
      .then((result) => {
        if (active)
          setData({ file: result, bytes: bytesFromBase64(result.content) });
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [channelId, revision.id, fileName]);
  const isText =
    data &&
    (data.file.mediaType.startsWith("text/") ||
      /json|javascript|xml|yaml/.test(data.file.mediaType));
  const source = isText && data ? new TextDecoder().decode(data.bytes) : "";
  return (
    <section>
      <div className="section-heading">
        <h3 className="label">Files</h3>
        {data ? (
          <button
            className="text-button"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([data.bytes], { type: "application/octet-stream" }),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = data.file.name.split("/").at(-1)!;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 10000);
            }}
          >
            <Download size={14} />
            Download file
          </button>
        ) : null}
      </div>
      <select
        aria-label="Artifact file"
        value={fileName}
        onChange={(e) => setFileName(e.target.value)}
      >
        {revision.files.map((f) => (
          <option key={f.name} value={f.name}>
            {f.name} · {(f.size / 1024).toFixed(1)} KiB
          </option>
        ))}
      </select>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {data ? (
        <>
          <p className="mono secondary artifact-checksum">
            SHA-256 · {data.file.sha256}
          </p>
          {data.file.mediaType === "text/html" ? (
            <div className="button-row">
              <button className="button" onClick={() => setPreview((v) => !v)}>
                {preview ? "Stop preview" : "Run isolated preview"}
              </button>
              <small className="secondary">No network or board access.</small>
            </div>
          ) : null}
          {preview ? (
            <iframe
              title={`Isolated preview: ${fileName}`}
              className="artifact-preview"
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">${source}`}
            />
          ) : data.file.mediaType === "text/markdown" &&
            data.bytes.length < 150000 ? (
            <div className="artifact-content">
              <Text value={source} />
            </div>
          ) : isText ? (
            <pre className="artifact-source">
              {source.slice(0, 150000)}
              {source.length > 150000
                ? "\n… Preview truncated. Download the complete file."
                : ""}
            </pre>
          ) : (
            <p className="secondary">Binary file · download to inspect.</p>
          )}
        </>
      ) : (
        <p className="secondary" role="status">
          Loading file…
        </p>
      )}
    </section>
  );
}
function PublishArtifact({
  context,
  artifact,
  directAgentId,
  close,
  saved,
}: {
  context: Context;
  artifact?: Artifact;
  directAgentId?: string;
  close: () => void;
  saved: (value?: {
    artifact: Artifact;
    revision: ArtifactRevision;
  }) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [version] = useState(artifact?.version);
  const publish = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const uploads = form
        .getAll("files")
        .filter((file): file is File => file instanceof File && !!file.name);
      if (
        uploads.length > 32 ||
        uploads.some((f) => f.size > 2 * 1024 * 1024) ||
        uploads.reduce((n, f) => n + f.size, 0) > 8 * 1024 * 1024
      )
        throw new Error(
          "Use up to 32 files, at most 2 MiB each and 8 MiB total.",
        );
      const files = await Promise.all(
        uploads.map(async (file) => {
          const bytes = new Uint8Array(await file.arrayBuffer());
          let binary = "";
          for (let i = 0; i < bytes.length; i += 8192)
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          return {
            name: file.name,
            media_type: file.type || "application/octet-stream",
            encoding: "base64",
            content: btoa(binary),
          };
        }),
      );
      if (form.get("content"))
        files.push({
          name: "report.md",
          media_type: "text/markdown",
          encoding: "utf8",
          content: String(form.get("content")),
        });
      if (!files.length)
        throw new Error("Write a report or attach the files being delivered.");
      const result = await rpc<{
        artifact: Artifact;
        revision: ArtifactRevision;
      }>("artifact_publish", {
        channel_id: context.mission.id,
        artifact_id: artifact?.id,
        version,
        direct_agent_id: artifact?.directAgentId || directAgentId,
        title: form.get("title"),
        kind: form.get("kind"),
        summary: form.get("summary"),
        limitations: form.get("limitations"),
        outcome: form.get("outcome"),
        files,
        refs: String(form.get("refs") || "")
          .split(/[\s,]+/)
          .filter(Boolean),
      });
      await saved(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalFrame
      title={artifact ? "Publish a new revision" : "Publish an artifact"}
      label="Artifacts"
      close={close}
    >
      <form onSubmit={publish}>
        <div className="dialog-body stack">
          <p className="secondary">
            {artifact?.directAgentId || directAgentId
              ? "Private to this human-agent conversation."
              : "Visible to everyone in this mission."}{" "}
            Each revision stores a complete set of files.
          </p>
          <Field label="Title">
            <input
              name="title"
              required
              maxLength={180}
              defaultValue={artifact?.title}
            />
          </Field>
          <div className="resource-fields">
            <Field label="Kind">
              <select name="kind" defaultValue={artifact?.kind || "report"}>
                {[
                  "report",
                  "plan",
                  "code",
                  "data",
                  "application",
                  "validation",
                  "other",
                ].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </Field>
            <Field label="Author's outcome">
              <select name="outcome" defaultValue="draft">
                <option value="draft">Draft</option>
                <option value="complete">Complete contribution</option>
                <option value="inconclusive">Inconclusive result</option>
              </select>
            </Field>
          </div>
          <Field label="Summary">
            <textarea name="summary" required rows={2} maxLength={16000} />
          </Field>
          <Field
            label="Report · Markdown"
            hint="Optional if you attach files. Saved as report.md."
          >
            <textarea name="content" rows={6} />
          </Field>
          <Field label="Files · 2 MiB each / 8 MiB total">
            <input name="files" type="file" multiple />
          </Field>
          <Field label="Limitations and remaining gaps">
            <textarea name="limitations" rows={2} maxLength={16000} />
          </Field>
          <Field
            label="Input revision or evidence IDs"
            hint="Separate IDs with spaces or commas; reference exact revisions."
          >
            <input name="refs" />
          </Field>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <footer className="dialog-footer">
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Publishing…" : "Publish revision"}
          </button>
        </footer>
      </form>
    </ModalFrame>
  );
}
function ReviewArtifact({
  channelId,
  revision,
  close,
  saved,
}: {
  channelId: string;
  revision: ArtifactRevision;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <ModalFrame
      title={`Review revision ${revision.number}`}
      label="Artifact review"
      close={close}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          setBusy(true);
          setError("");
          try {
            await rpc("artifact_review", {
              channel_id: channelId,
              revision_id: revision.id,
              verdict: data.get("verdict"),
              summary: data.get("summary"),
              conditions: data.get("conditions"),
              refs: String(data.get("refs") || "")
                .split(/[\s,]+/)
                .filter(Boolean),
            });
            await saved();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-body stack">
          <Field label="Assessment">
            <select name="verdict">
              <option value="verified">
                Verified against stated conditions
              </option>
              <option value="inconclusive">Inconclusive</option>
              <option value="rejected">Rejected</option>
              <option value="accepted">Accepted by the human</option>
            </select>
          </Field>
          <Field label="Evidence and result">
            <textarea name="summary" required maxLength={16000} />
          </Field>
          <Field label="Conditions · inputs, configuration, checks run">
            <textarea name="conditions" required maxLength={16000} />
          </Field>
          <Field label="Evidence IDs">
            <input name="refs" />
          </Field>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <footer className="dialog-footer">
          <button className="button" type="button" onClick={close}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            Record review
          </button>
        </footer>
      </form>
    </ModalFrame>
  );
}
