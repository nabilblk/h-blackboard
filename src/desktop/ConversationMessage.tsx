import { IconButton } from "../ui/Button";
import { Button } from "../ui/Button";
import { useState, type RefObject } from "react";
import { ArrowUp, MessageSquare, X } from "lucide-react";
import { Text } from "../Markdown";
import { date } from "./ui";
import type { MessageView } from "../application/contracts/node";
import { Disclosure } from "../ui/Disclosure";

export function Message({
  message: m,
  label,
  owner,
  profile,
  reply,
  context,
  location,
  openWork,
  role,
  runtime,
  copyLink,
}: {
  message: MessageView;
  label: (id: string) => string;
  owner: string;
  profile: (id: string) => void;
  reply?: () => void;
  context?: () => void;
  location?: string;
  openWork: (kind: string, id: string) => void;
  role?: "coordinator" | "agent";
  runtime?: string;
  copyLink?: () => Promise<boolean>;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <article
      className={`n-message${m.unread ? " n-unread" : ""}`}
      id={`message-${m.id}`}
    >
      <span className="n-avatar">
        {m.author_agent
          ? runtime === "claude"
            ? "CC"
            : runtime === "codex"
              ? "CX"
              : runtime === "grok"
                ? "GR"
                : "A"
          : "H"}
      </span>
      <div>
        <header>
          <strong>{m.author_label ?? label(m.author)}</strong>
          {role === "coordinator" ? (
            <span className="n-message-role">Coordinator</span>
          ) : null}
          {m.author === owner ? (
            <span className="n-activity-kind">Mission owner</span>
          ) : null}
          {m.kind !== "message" ? (
            <span className="n-activity-kind">{m.kind}</span>
          ) : null}
          {m.to ? <span className="n-addressed">to {label(m.to)}</span> : null}
          {m.created_at_ms && copyLink ? (
            <button
              className="n-message-link"
              title="Copy message link"
              aria-label={
                copied
                  ? "Message link copied"
                  : `Copy link to message at ${date(new Date(m.created_at_ms).toISOString())}`
              }
              onClick={() => {
                void copyLink().then(setCopied);
              }}
            >
              <time dateTime={new Date(m.created_at_ms).toISOString()}>
                {copied
                  ? "Link copied"
                  : date(new Date(m.created_at_ms).toISOString())}
              </time>
            </button>
          ) : m.created_at_ms ? (
            <time dateTime={new Date(m.created_at_ms).toISOString()}>
              {date(new Date(m.created_at_ms).toISOString())}
            </time>
          ) : null}
          {m.provisional ? (
            <span className="d-mono">
              Outside accepted history · review required
            </span>
          ) : null}
        </header>
        {context ? (
          <span className="n-message-location">
            {m.audience.startsWith("private:")
              ? "Private conversation"
              : `# ${location ?? (m.audience === "main" ? "Main" : "Workstream")}`}
            {m.thread ? " · thread" : ""}
          </span>
        ) : null}
        <div className="n-message-text">
          <Text
            value={m.text}
            links="text"
            onReference={(kind, id) =>
              kind === "agent" ? profile(id) : openWork(kind, id)
            }
          />
        </div>
        {/[a-f0-9]{64}/.test(m.text) ? (
          <Disclosure variant="inline" title="Message source">
            <pre className="n-message-source">{m.text}</pre>
          </Disclosure>
        ) : null}
        <div className="n-message-actions">
          {context ? (
            <Button size="compact" onClick={context}>
              Open conversation
            </Button>
          ) : null}
          {reply ? (
            <Button size="compact" onClick={reply}>
              <MessageSquare size={14} />
              {m.replies
                ? `${m.replies} ${m.replies === 1 ? "reply" : "replies"}`
                : "Reply in thread"}
            </Button>
          ) : null}
          {m.work ? (
            <Button
              size="compact"
              onClick={() => openWork(m.work!.kind, m.work!.id)}
            >
              View {m.work.kind}
            </Button>
          ) : null}
          {m.agent_registration || m.author_agent ? (
            <Button
              size="compact"
              className="n-message-agent"
              onClick={() => profile((m.agent_registration ?? m.author_agent)!)}
            >
              View agent
            </Button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function Composer({
  draft,
  change,
  title,
  hint,
  busy,
  blocked,
  send,
  recipient,
  refElement,
  thread = false,
}: {
  draft: string;
  change: (s: string) => void;
  title: string;
  hint: string;
  busy: boolean;
  blocked: boolean;
  send: () => void;
  recipient?: {
    value: string;
    change: (s: string) => void;
    options: { id: string; label: string }[];
  };
  refElement?: RefObject<HTMLTextAreaElement | null>;
  thread?: boolean;
}) {
  const id = thread ? "thread-message" : "main-message";
  return (
    <form
      className="n-composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && !blocked && draft.trim()) send();
      }}
    >
      <div className="n-composer-heading">
        <label className="d-label" htmlFor={id}>
          {thread ? "Reply in thread" : `Message in ${title}`}
        </label>
        {recipient ? (
          <label className="n-recipient">
            <span>To</span>
            <select
              aria-label="Address message to"
              value={recipient.value}
              onChange={(e) => recipient.change(e.target.value)}
            >
              <option value="">Everyone</option>
              {recipient.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            {recipient.value ? (
              <IconButton
                type="button"
                aria-label="Remove recipient"
                onClick={() => recipient.change("")}
              >
                <X size={14} />
              </IconButton>
            ) : null}
          </label>
        ) : null}
      </div>
      <textarea
        id={id}
        ref={refElement}
        placeholder={
          thread
            ? "Reply in this conversation…"
            : "Share a note or instruction…"
        }
        value={draft}
        maxLength={16384}
        disabled={busy || blocked}
        onChange={(e) => change(e.target.value)}
        rows={2}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <footer>
        <span>{hint}</span>
        <Button
          variant="primary"
          type="submit"
          disabled={busy || blocked || !draft.trim()}
        >
          <ArrowUp size={16} />
          Send
        </Button>
      </footer>
    </form>
  );
}
