import { useEffect, useState } from "react";
import { ArrowRight, Inbox as InboxIcon } from "lucide-react";
import { useApplication } from "../desktop/ApplicationProvider";
import { observations } from "../application/observations";
import type {
  MissionView,
  MessagePage,
  MessageView,
} from "../application/contracts/node";
import { Button } from "../ui/Button";

/** Per-mission subscriptions share the bounded application queue, including partial failures. */
export function Inbox({
  missions,
  open,
}: {
  missions: MissionView[];
  open: (id: string, message: MessageView) => void;
}) {
  const { missions: node } = useApplication();
  const [pages, setPages] = useState<Record<string, MessagePage>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const key = missions
    .map((m) => m.id)
    .sort()
    .join(":");
  useEffect(() => {
    const stop = key
      .split(":")
      .filter(Boolean)
      .map((id) =>
        observations(node).subscribe(
          `workspace-inbox:${id}`,
          () =>
            node.queryMessages(id, {
              view: "inbox",
              audience: null,
              thread: null,
              before: null,
              anchor: null,
              search: null,
            }),
          (page) => {
            setPages((all) => ({ ...all, [id]: page }));
            setErrors((all) => {
              const next = { ...all };
              delete next[id];
              return next;
            });
          },
          (error) => setErrors((all) => ({ ...all, [id]: error.message })),
        ),
      );
    return () => stop.forEach((unsubscribe) => unsubscribe());
  }, [node, key]);
  const loaded = missions.every((m) => pages[m.id] || errors[m.id]);
  const items = missions
    .flatMap((mission) =>
      (pages[mission.id]?.items ?? []).map((message) => ({ mission, message })),
    )
    .sort(
      (a, b) => (b.message.created_at_ms ?? 0) - (a.message.created_at_ms ?? 0),
    );
  return (
    <section className="w-page w-inbox">
      <header className="w-page-title">
        <div>
          <span className="w-eyebrow">Across your missions</span>
          <h1>Inbox</h1>
          <p>Messages addressed to you, private conversations and replies.</p>
        </div>
      </header>
      {!loaded ? <p role="status">Checking your conversations…</p> : null}
      {missions
        .filter((m) => errors[m.id])
        .map((m) => (
          <div className="d-alert" role="alert" key={m.id}>
            <span>
              {m.definition.name}: {errors[m.id]}
            </span>
            <Button
              onClick={() =>
                observations(node).invalidate(`workspace-inbox:${m.id}`)
              }
            >
              Retry
            </Button>
          </div>
        ))}
      <div className="w-inbox-list">
        {items.map(({ mission, message }) => (
          <button
            className={`w-inbox-item ${message.unread ? "is-unread" : ""}`}
            key={`${mission.id}:${message.id}`}
            onClick={() => open(mission.id, message)}
          >
            <span className="w-message-avatar">
              {(message.author_label ?? "?").slice(0, 2).toUpperCase()}
            </span>
            <span>
              <span className="w-inbox-context">
                <strong>{message.author_label ?? "Mission participant"}</strong>
                <span>#{mission.definition.name}</span>
                {message.unread ? (
                  <span className="w-unread">Unread</span>
                ) : null}
              </span>
              <span className="w-row-description">{message.text}</span>
            </span>
            <ArrowRight size={17} />
          </button>
        ))}
      </div>
      {loaded && !items.length && !Object.keys(errors).length ? (
        <div className="w-empty">
          <InboxIcon size={30} />
          <h2>You’re all caught up.</h2>
          <p>When someone needs you, their message will appear here.</p>
        </div>
      ) : null}
      {missions.some((m) => pages[m.id]?.before) ? (
        <p className="w-subtle">
          Showing recent messages. Open a mission’s Inbox for its full history.
        </p>
      ) : null}
    </section>
  );
}
