import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  FileText,
  AppWindow,
  FileCode2,
  Table2,
  Star,
  Plus,
} from "lucide-react";
import { rpc } from "./client";
import { Empty } from "./ui";
import {
  artifactAction,
  artifactHref,
  artifactKinds,
  reviewLabels,
} from "./artifact-links";
import { ArtifactStatus } from "./ArtifactStatus";
import type { Context } from "./model";
import type { Artifact } from "./resources";

type Page = { items: Artifact[]; nextOffset: number | null; total: number };
export function ArtifactList({
  context,
  directAgentId,
  select,
  publish,
  refresh,
}: {
  context: Context;
  directAgentId?: string;
  select: (id: string) => void;
  publish: () => void;
  refresh: () => Promise<void>;
}) {
  const [page, setPage] = useState<Page>({
    items: [],
    nextOffset: null,
    total: 0,
  });
  const [query, setQuery] = useState(""),
    [kind, setKind] = useState(""),
    [status, setStatus] = useState("");
  const [author, setAuthor] = useState(""),
    [stream, setStream] = useState("");
  const [onlyHighlights, setOnlyHighlights] = useState(false);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const request = useRef(0);
  const filters = {
    channel_id: context.mission.id,
    direct_agent_id: directAgentId,
    query,
    kind: kind || undefined,
    review_status: status || undefined,
    author_id: author || undefined,
    stream_id: stream || undefined,
    highlighted: onlyHighlights ? true : undefined,
  };
  useEffect(() => {
    const generation = ++request.current;
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      rpc<Page>("artifacts_read", filters)
        .then((value) => {
          if (request.current === generation) setPage(value);
        })
        .catch((e) => {
          if (request.current === generation) setError(e.message);
        })
        .finally(() => {
          if (request.current === generation) setLoading(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      ++request.current;
    };
  }, [
    context.mission.id,
    context.cursor,
    directAgentId,
    query,
    kind,
    status,
    author,
    stream,
    onlyHighlights,
  ]);
  const more = async () => {
    const generation = request.current;
    setLoading(true);
    try {
      const next = await rpc<Page>("artifacts_read", {
        ...filters,
        offset: page.nextOffset,
      });
      if (generation === request.current)
        setPage((old) => ({
          ...next,
          items: [
            ...new Map(
              [...old.items, ...next.items].map((a) => [a.id, a]),
            ).values(),
          ],
        }));
    } catch (e) {
      if (generation === request.current) setError((e as Error).message);
    } finally {
      if (generation === request.current) setLoading(false);
    }
  };
  const highlight = async (a: Artifact) => {
    setPending(a.id);
    setError("");
    try {
      await rpc("artifact_highlight", {
        channel_id: context.mission.id,
        artifact_id: a.id,
        version: a.version,
        highlighted: !a.highlighted,
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending("");
    }
  };
  const filtered = !!(
    query ||
    kind ||
    status ||
    author ||
    stream ||
    onlyHighlights
  );
  const hasHighlights = page.items.some((a) => a.highlighted);
  return (
    <>
      <div className="section-heading artifact-list-heading">
        <h2>Mission outputs</h2>
        <button
          className="button"
          disabled={context.mission.archived}
          onClick={publish}
        >
          <Plus size={14} />
          Publish
        </button>
      </div>
      <div className="artifact-filters">
        <input
          type="search"
          aria-label="Search artifacts"
          placeholder="Search all artifacts…"
          maxLength={200}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="resource-fields">
          <select
            aria-label="Artifact type"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="">All types</option>
            {Object.entries(artifactKinds).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="Artifact review status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All review statuses</option>
            {Object.entries(reviewLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <details className="artifact-extra-filters">
          <summary>
            More filters{author || stream || onlyHighlights ? " · active" : ""}
          </summary>
          <div className="stack">
            <select
              aria-label="Artifact author"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
            >
              <option value="">All authors</option>
              <option value="human">You</option>
              {context.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            {!directAgentId ? (
              <select
                aria-label="Artifact workstream"
                value={stream}
                onChange={(e) => setStream(e.target.value)}
              >
                <option value="">All workstreams</option>
                {context.workstreams.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            ) : null}
            <label className="artifact-check">
              <input
                type="checkbox"
                checked={onlyHighlights}
                onChange={(e) => setOnlyHighlights(e.target.checked)}
              />
              Highlighted deliverables only
            </label>
          </div>
        </details>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <p className="secondary artifact-results" role="status">
        {loading
          ? "Loading artifacts…"
          : `${page.total} artifact${page.total === 1 ? "" : "s"}${filtered ? " found" : ""}`}
      </p>
      {!loading && !page.items.length ? (
        <Empty title={filtered ? "No matching artifacts" : "No artifacts yet"}>
          {filtered
            ? "Try a different search or clear the filters."
            : "Published applications, reports and other contributions will appear here."}
          {filtered ? (
            <button
              className="text-button"
              onClick={() => {
                setQuery("");
                setKind("");
                setStatus("");
                setAuthor("");
                setStream("");
                setOnlyHighlights(false);
              }}
            >
              Clear filters
            </button>
          ) : null}
        </Empty>
      ) : null}
      <div className="artifact-list" aria-busy={loading}>
        {page.items.map((a, index) => {
          const Icon =
            a.kind === "application"
              ? AppWindow
              : a.kind === "data"
                ? Table2
                : a.kind === "code"
                  ? FileCode2
                  : FileText;
          const href = artifactHref(context.mission.id, a.id, a.revision.id);
          const name =
            a.revision.authorId === "human"
              ? "You"
              : context.agents.find((agent) => agent.id === a.revision.authorId)
                  ?.name || "Agent";
          return (
            <div key={a.id}>
              {hasHighlights &&
              (index === 0 ||
                page.items[index - 1].highlighted !== a.highlighted) ? (
                <h3 className="label artifact-group">
                  {a.highlighted
                    ? "Highlighted deliverables"
                    : "All other artifacts"}
                </h3>
              ) : null}
              <article className="artifact-list-row">
                <Icon
                  size={19}
                  className="artifact-type-icon"
                  aria-hidden="true"
                />
                <div className="artifact-row-content">
                  <div className="artifact-row-title">
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {a.title}
                    </a>
                    <span className="mono secondary">v{a.revision.number}</span>
                  </div>
                  <p className="artifact-description secondary">
                    {a.revision.description || a.revision.summary}
                  </p>
                  <p className="artifact-row-meta secondary">
                    <span>{name}</span>
                    <span>
                      <time
                        dateTime={new Date(a.revision.createdAt).toISOString()}
                        title={new Date(a.revision.createdAt).toLocaleString()}
                      >
                        {new Date(a.revision.createdAt).toDateString() ===
                        new Date().toDateString()
                          ? "Today " +
                            new Date(a.revision.createdAt).toLocaleTimeString(
                              [],
                              { hour: "2-digit", minute: "2-digit" },
                            )
                          : new Date(a.revision.createdAt).toLocaleDateString(
                              [],
                              {
                                month: "short",
                                day: "numeric",
                                year:
                                  new Date(
                                    a.revision.createdAt,
                                  ).getFullYear() !== new Date().getFullYear()
                                    ? "numeric"
                                    : undefined,
                              },
                            )}
                      </time>
                    </span>
                    <span>{artifactKinds[a.kind]}</span>
                    {a.streamId &&
                    a.streamId !== context.mission.defaultStreamId ? (
                      <span>
                        #
                        {context.workstreams.find((s) => s.id === a.streamId)
                          ?.name || "Workstream"}
                      </span>
                    ) : null}
                  </p>
                  <div className="artifact-row-footer">
                    <ArtifactStatus revision={a.revision} />
                    <div className="artifact-row-actions">
                      <a
                        className="button compact"
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {artifactAction(a.revision)}
                        <ArrowUpRight size={13} />
                      </a>
                      <button
                        className="text-button"
                        onClick={() => select(a.id)}
                      >
                        Details
                      </button>
                    </div>
                  </div>
                </div>
                <button
                  className={`icon artifact-highlight ${a.highlighted ? "accent" : ""}`}
                  aria-label={`${a.highlighted ? "Remove highlight from" : "Highlight"} ${a.title}`}
                  aria-pressed={!!a.highlighted}
                  title={
                    a.highlighted ? "Remove highlight" : "Highlight deliverable"
                  }
                  disabled={!!pending || context.mission.archived}
                  onClick={() => void highlight(a)}
                >
                  <Star
                    size={16}
                    fill={a.highlighted ? "currentColor" : "none"}
                  />
                </button>
              </article>
            </div>
          );
        })}
      </div>
      {page.nextOffset !== null ? (
        <button
          className="button"
          disabled={loading}
          onClick={() => void more()}
        >
          Load more artifacts
        </button>
      ) : null}
    </>
  );
}
