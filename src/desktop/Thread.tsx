import { useEffect, useRef, useState, type ReactNode } from "react";
import { node } from "./bridge";
import { ContextPanel } from "./ContextPanel";
import { Composer } from "./ConversationMessage";
import type { MessageView, MessageQuery } from "./node-contract";
import type { Perform } from "./ui";

export function Thread({
  mission,
  target,
  close,
  render,
  blocked,
  busy,
  perform,
  draft,
  change,
}: {
  mission: string;
  target: { id: string; audience: string };
  close: () => void;
  render: (m: MessageView) => ReactNode;
  blocked: boolean;
  busy: boolean;
  perform: Perform;
  draft: string;
  change: (s: string) => void;
}) {
  const [root, setRoot] = useState<MessageView | null>(null);
  const history = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<MessageView[]>([]);
  const [older, setOlder] = useState<string | null>(null);
  const [error, setError] = useState("");
  const active = useRef(true);
  const query: MessageQuery = {
    view: "conversation",
    audience: target.audience,
    thread: target.id,
    before: null,
    anchor: null,
    search: null,
  };
  useEffect(() => {
    active.current = true;
    let timer: ReturnType<typeof setTimeout>;
    let first = true;
    const load = async () => {
      try {
        const [page, parent] = await Promise.all([
          node.queryMessages(mission, query),
          first
            ? node.queryMessages(mission, { ...query, anchor: target.id })
            : Promise.resolve(null),
        ]);
        if (active.current) {
          if (parent)
            setRoot(parent.items.find((m) => m.id === target.id) ?? null);
          const follow =
            !!history.current &&
            history.current.scrollHeight -
              history.current.clientHeight -
              history.current.scrollTop <
              48;
          setItems((current) => {
            const updates = new Map(page.items.map((m) => [m.id, m]));
            return [
              ...current.filter((m) => !updates.has(m.id)),
              ...page.items.filter((m) => m.id !== target.id),
            ];
          });
          if (first) {
            setOlder(page.before);
            first = false;
          }
          setError("");
          if (follow)
            requestAnimationFrame(() => {
              if (active.current && history.current)
                history.current.scrollTop = history.current.scrollHeight;
            });
          const unread = page.items.filter((m) => m.unread).map((m) => m.id);
          if (document.hasFocus() && follow && unread.length)
            await node.markMessagesRead(mission, unread);
        }
      } catch (e) {
        if (active.current)
          setError(e instanceof Error ? e.message : "Unable to load thread.");
      }
      if (active.current) timer = setTimeout(() => void load(), 2500);
    };
    void load();
    return () => {
      active.current = false;
      clearTimeout(timer);
    };
  }, [mission, target.id, target.audience]);
  return (
    <ContextPanel title="Thread" close={close} error={error}>
      <div className="n-thread">
        <p className="d-field-help">
          {target.audience === "main"
            ? "Public · Main"
            : !target.audience.startsWith("private:")
              ? "Public · workstream · everyone in this mission"
              : "Private · same participants as the original message"}
        </p>
        <div className="n-thread-messages" ref={history}>
          {root ? <div className="n-thread-root">{render(root)}</div> : null}
          {older ? (
            <button
              className="d-button"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const height = history.current?.scrollHeight ?? 0;
                  const top = history.current?.scrollTop ?? 0;
                  const page = await node.queryMessages(mission, {
                    ...query,
                    before: older,
                  });
                  if (active.current) {
                    setItems((current) => [
                      ...page.items.filter((m) => m.id !== target.id),
                      ...current.filter(
                        (m) => !page.items.some((p) => p.id === m.id),
                      ),
                    ]);
                    setOlder(page.before);
                    requestAnimationFrame(() => {
                      if (active.current && history.current)
                        history.current.scrollTop =
                          top + history.current.scrollHeight - height;
                    });
                  }
                })
              }
            >
              Earlier replies
            </button>
          ) : null}
          {items.map(render)}
        </div>
        <Composer
          thread
          draft={draft}
          change={change}
          title="Thread"
          hint="Replies keep this conversation’s audience."
          busy={busy}
          blocked={blocked || !!error}
          send={() =>
            void perform(async () => {
              await node.postMessage(
                mission,
                draft.trim(),
                target.audience,
                null,
                target.id,
              );
              change("");
              const page = await node.queryMessages(mission, query);
              if (active.current) {
                setItems(page.items.filter((m) => m.id !== target.id));
                setOlder(page.before);
                requestAnimationFrame(() => {
                  if (active.current && history.current)
                    history.current.scrollTop = history.current.scrollHeight;
                });
              }
            })
          }
        />
      </div>
    </ContextPanel>
  );
}
