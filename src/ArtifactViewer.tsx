import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  Lock,
  MessageSquare,
  PanelRight,
  Copy,
  Check,
} from "lucide-react";
import { get, rpc } from "./client";
import { ArtifactFiles } from "./ArtifactFiles";
import { ArtifactStatus } from "./ArtifactStatus";
import { ArtifactFeedback } from "./ArtifactFeedback";
import { artifactHref } from "./artifact-links";
import type { Context } from "./model";
import type { ArtifactDetail } from "./resources";
const ArtifactsPanel = lazy(() =>
  import("./Artifacts").then((m) => ({ default: m.ArtifactsPanel })),
);

export default function ArtifactViewer({
  channelId,
  artifactId,
}: {
  channelId: string;
  artifactId: string;
}) {
  const revisionId = useRef(
    new URLSearchParams(location.search).get("revision") || "",
  );
  const [detail, setDetail] = useState<ArtifactDetail | null>(null),
    [context, setContext] = useState<Context | null>(null);
  const [error, setError] = useState(""),
    [details, setDetails] = useState(false),
    [feedback, setFeedback] = useState(false),
    [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const alive = useRef(false);
  const reload = useCallback(async () => {
    const [result, state] = await Promise.all([
      rpc<ArtifactDetail>("artifact_read", {
        channel_id: channelId,
        artifact_id: artifactId,
        revision_id: revisionId.current || undefined,
      }),
      rpc<Context>("context_read", { channel_id: channelId }),
    ]);
    if (!alive.current) return;
    if (!revisionId.current) {
      revisionId.current = result.artifact.headId;
      history.replaceState(
        null,
        "",
        artifactHref(channelId, artifactId, revisionId.current),
      );
    }
    setDetail(result);
    setContext(state);
    setError("");
  }, [channelId, artifactId]);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          void reload().catch((e) => {
            if (alive.current) setError(e.message);
          }),
        150,
      );
    };
    void get("session")
      .then(async () => {
        if (cancelled) return;
        await reload();
        if (cancelled) return;
        source = new EventSource(
          `/api/events?channel=${encodeURIComponent(channelId)}`,
        );
        source.addEventListener("changed", update);
      })
      .catch((e) => {
        if (alive.current) setError(e.message);
      });
    const interval = setInterval(update, 15000);
    return () => {
      cancelled = true;
      alive.current = false;
      clearTimeout(timer);
      clearInterval(interval);
      source?.close();
    };
  }, [channelId, reload]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const current = detail?.revisions.find((r) => r.id === revisionId.current);
  useEffect(() => {
    if (current)
      document.title = `${current.title} · v${current.number} · Harakiri`;
  }, [current?.title, current?.number]);
  const inspect = (id: string) => {
    location.href = `/#${encodeURIComponent(channelId)}?message=${encodeURIComponent(id)}`;
  };
  return (
    <main
      className={`artifact-viewer ${details ? "artifact-viewer-with-details" : ""}`}
    >
      <header className="artifact-viewer-toolbar">
        <a
          className="icon"
          href={`/#${encodeURIComponent(channelId)}`}
          aria-label="Back to mission"
          title="Back to mission"
        >
          <ArrowLeft size={18} />
        </a>
        <div className="artifact-viewer-title">
          <h1>{current?.title || "Artifact"}</h1>
          {current ? (
            <span className="secondary">
              {detail?.artifact.directAgentId ? (
                <>
                  <Lock size={12} aria-hidden="true" />
                  Private ·
                </>
              ) : null}
              v{current.number} · {context?.mission.name}
            </span>
          ) : null}
        </div>
        {current ? <ArtifactStatus revision={current} /> : null}
        <div className="artifact-viewer-actions">
          <button
            className="button"
            disabled={!current || context?.mission.archived}
            onClick={() => setFeedback(true)}
          >
            <MessageSquare size={14} />
            Feedback
          </button>
          <button
            className="icon"
            aria-label={copied ? "Link copied" : "Copy artifact link"}
            title="Copy artifact link"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(location.href);
                setCopied(true);
              } catch {
                setError(
                  "Could not copy the link. Copy the address from your browser.",
                );
              }
            }}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
          <button
            className="button"
            aria-expanded={details}
            onClick={() => setDetails((v) => !v)}
          >
            <PanelRight size={14} />
            Details
          </button>
        </div>
      </header>
      <div className="artifact-viewer-main">
        {error ? (
          <div className="error" role="alert">
            {error}{" "}
            <button
              className="text-button"
              onClick={() => void reload().catch((e) => setError(e.message))}
            >
              Retry
            </button>
          </div>
        ) : null}
        {notice ? (
          <p className="artifact-viewer-notice" role="status">
            {notice}
          </p>
        ) : null}
        {current && detail ? (
          <>
            {current.id !== detail.artifact.headId ? (
              <div className="artifact-viewer-notice">
                You are viewing revision {current.number}.{" "}
                <a
                  href={artifactHref(
                    channelId,
                    artifactId,
                    detail.artifact.headId,
                  )}
                >
                  Open the latest revision
                </a>
              </div>
            ) : null}
            {current.stale ? (
              <div className="artifact-viewer-notice warning">
                Inputs changed. This version needs to be checked again.
              </div>
            ) : null}
            <ArtifactFiles
              key={current.id}
              channelId={channelId}
              revision={current}
              fullPage
            />
          </>
        ) : !error ? (
          <p className="secondary" role="status">
            Opening artifact…
          </p>
        ) : null}
      </div>
      {details && context && current ? (
        <Suspense fallback={<p role="status">Loading details…</p>}>
          <ArtifactsPanel
            key={artifactId + current.id}
            context={context}
            artifactId={artifactId}
            revisionId={current.id}
            showFiles={false}
            close={() => setDetails(false)}
            inspect={inspect}
            refresh={reload}
          />
        </Suspense>
      ) : null}
      {feedback && context && detail && current ? (
        <ArtifactFeedback
          context={context}
          artifact={detail.artifact}
          revision={current}
          close={() => setFeedback(false)}
          sent={() => {
            setFeedback(false);
            setNotice(
              `Feedback sent on revision ${current.number}${detail.artifact.directAgentId ? " in the private conversation" : " in the workstream"}.`,
            );
          }}
        />
      ) : null}
    </main>
  );
}
