import type { ReactNode } from "react";
import { AgentState } from "./ExecutionStatus";
import type { Contribution } from "./bridge";
import { PrivateRecovery } from "./PrivateRecovery";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Hash,
  Inbox,
  LockKeyhole,
  Plus,
  Send,
  ListChecks,
  Files,
} from "lucide-react";
import { node } from "./bridge";
import type { Perform } from "./ui";
import { Message, Composer } from "./ConversationMessage";
import { Thread } from "./Thread";
import type {
  AgentView,
  AudienceView,
  MemberView,
  MessageFeed,
  MessageQuery,
  MessageView,
  MissionView,
  WorkstreamView,
} from "./node-contract";

export type MissionSession = {
  audience: string;
  drafts: Record<string, string>;
  feed?: MessageFeed;
  recipients?: Record<string, string>;
};
type Props = {
  decisions?: ReactNode;
  contributions: Contribution[];
  streams: WorkstreamView[];
  taskCount: number;
  artifactCount: number;
  artifacts: (id?: string) => void;
  tasks: (id?: string) => void;
  editStream: (id: string | null) => void;
  mission: MissionView;
  owner: string;
  name: string;
  busy: boolean;
  blocked: boolean;
  session: MissionSession;
  updateSession: (change: (s: MissionSession) => MissionSession) => void;
  readScroll: (key: string) => number | undefined;
  rememberScroll: (key: string, top: number) => void;
  perform: Perform;
  members: () => void;
  profile: (registration: string) => void;
  detailsOpen: boolean;
  closeDetails: () => void;
};

export function Conversation({
  decisions,
  contributions,
  streams,
  taskCount,
  artifactCount,
  artifacts,
  tasks,
  editStream,
  mission,
  owner,
  name,
  busy,
  blocked,
  session,
  updateSession,
  readScroll,
  rememberScroll,
  perform,
  members,
  profile,
  detailsOpen,
  closeDetails,
}: Props) {
  const [navTarget, setNavTarget] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    // Archive/restore moves the selected mission between sidebar groups and
    // replaces its portal container. Keep its conversations mounted there.
    setNavTarget(document.getElementById("mission-conversations"));
  }, [mission.id, mission.lifecycle.phase]);
  const audience = session.audience;
  const feed = session.feed ?? "conversation";
  const [scopes, setScopes] = useState<AudienceView[]>([]);
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [people, setPeople] = useState<MemberView[]>([]);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [older, setOlder] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [anchor, setAnchor] = useState<string | null>(null);
  const [thread, setThread] = useState<{ id: string; audience: string } | null>(
    null,
  );
  const [newMessages, setNewMessages] = useState(0);
  const [scopeLimit, setScopeLimit] = useState(20);
  const list = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const currentScope = scopes.find((s) => s.id === audience);
  const isPrivate = audience.startsWith("private:");
  const currentStream = streams.find((s) => `workstream:${s.id}` === audience);
  const title =
    feed === "inbox"
      ? "Inbox"
      : feed === "sent"
        ? "Sent"
        : isPrivate
          ? (currentScope?.label ?? "Private conversation")
          : (currentStream?.name ??
            (audience === "main" ? "Main" : "Workstream"));
  const key = `${feed}:${audience}:${appliedSearch}:${anchor ?? ""}`;
  const query: MessageQuery = {
    view: feed,
    audience,
    thread: null,
    before: null,
    anchor,
    search: appliedSearch,
  };
  const queryRef = useRef(query);
  queryRef.current = query;
  const readIds = useRef(new Set<string>());
  const activeKey = useRef(key);
  activeKey.current = key;
  const label = (author: string) =>
    author === owner
      ? name
      : (agents.find((a) => a.identity.author === author)?.identity.label ??
        (author === mission.owner
          ? "Mission owner"
          : `Participant ${author.slice(0, 8)}`));
  const select = (audience: string, feed: MessageFeed = "conversation") => {
    setAnchor(null);
    setThread(null);
    setSearch("");
    setAppliedSearch("");
    updateSession((s) => ({ ...s, audience, feed }));
  };
  const closeThread = useCallback(() => setThread(null), []);
  useEffect(() => {
    if (detailsOpen) setThread(null);
  }, [detailsOpen]);
  useEffect(() => {
    const t = setTimeout(() => setAppliedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const peers = await node.peers(mission.id);
        const all: AgentView[] = [];
        let after: string | null = null;
        do {
          const page = await node.agents(mission.id, after);
          all.push(...page.items);
          after = page.after;
        } while (after && !cancelled && all.length < 512);
        if (!cancelled) {
          setAgents(all);
          setPeople(peers.members);
        }
      } catch (e) {
        if (!cancelled)
          setError(
            e instanceof Error ? e.message : "Unable to read participants.",
          );
      }
      if (!cancelled) timer = setTimeout(() => void load(), 10000);
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mission.id]);
  const markRead = async (items: MessageView[]) => {
    if (!document.hasFocus()) return;
    const ids = items
      .filter((m) => m.unread && !readIds.current.has(m.id))
      .map((m) => m.id);
    if (!ids.length) return;
    ids.forEach((id) => readIds.current.add(id));
    try {
      await node.markMessagesRead(mission.id, ids);
    } catch {
      ids.forEach((id) => readIds.current.delete(id));
    }
  };
  const markReadRef = useRef(markRead);
  markReadRef.current = markRead;
  useEffect(() => {
    let cancelled = false;
    let first = true;
    let timer: ReturnType<typeof setTimeout>;
    const seen = new Set<string>();
    const saved = readScroll(key);
    setMessages([]);
    setOlder(null);
    setLoading(true);
    setError("");
    setNewMessages(0);
    const poll = async () => {
      try {
        const [page, audiences] = await Promise.all([
          node.queryMessages(mission.id, queryRef.current),
          node.audiences(mission.id),
        ]);
        if (cancelled) return;
        const nearBottom =
          !!list.current &&
          list.current.scrollHeight -
            list.current.clientHeight -
            list.current.scrollTop <
            48;
        const added = page.items.filter((m) => !seen.has(m.id)).length;
        page.items.forEach((m) => seen.add(m.id));
        setScopes(audiences);
        setMessages((current) => {
          const updates = new Map(page.items.map((m) => [m.id, m]));
          const ids = new Set(current.map((m) => m.id));
          return [
            ...current.map((m) => updates.get(m.id) ?? m),
            ...page.items.filter((m) => !ids.has(m.id)),
          ];
        });
        const initial = first;
        if (first) {
          setOlder(page.before);
          first = false;
        } else if (added && !nearBottom) setNewMessages((n) => n + added);
        setLoading(false);
        setError("");
        requestAnimationFrame(() => {
          if (cancelled || !list.current) return;
          if (initial)
            list.current.scrollTop = saved ?? list.current.scrollHeight;
          else if (nearBottom)
            list.current.scrollTop = list.current.scrollHeight;
          if (
            feed === "conversation" &&
            !appliedSearch &&
            list.current.scrollHeight -
              list.current.clientHeight -
              list.current.scrollTop <
              48
          )
            void markReadRef.current(page.items);
        });
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : "Unable to read conversation.",
          );
          setLoading(false);
        }
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mission.id, key]);
  const openMessage = (m: MessageView) => {
    setSearch("");
    setAppliedSearch("");
    setAnchor(m.thread ?? m.id);
    updateSession((s) => ({
      ...s,
      audience: m.audience,
      feed: "conversation",
    }));
    if (m.thread) {
      closeDetails();
      setThread({ id: m.thread, audience: m.audience });
    }
  };
  const openThread = (m: MessageView) => {
    closeDetails();
    setThread({ id: m.thread ?? m.id, audience: m.audience });
  };
  const draft = session.drafts[audience] ?? "";
  const setDraft = (value: string) =>
    updateSession((s) => ({
      ...s,
      drafts: { ...s.drafts, [audience]: value },
    }));
  const recipient = session.recipients?.[audience] ?? "";
  const setRecipient = (to: string) =>
    updateSession((s) => ({
      ...s,
      recipients: { ...s.recipients, [audience]: to },
    }));
  const unavailable =
    blocked || (isPrivate && (!currentScope || !currentScope.writable));
  const render = (m: MessageView, inThread = false) => (
    <Message
      key={m.id}
      message={m}
      label={label}
      location={streams.find((s) => `workstream:${s.id}` === m.audience)?.name}
      owner={owner}
      openWork={(kind, id) => {
        setThread(null);
        if (kind === "artifact") artifacts(id);
        else if (kind === "task") tasks(id);
        else editStream(id);
      }}
      profile={(id) => {
        setThread(null);
        profile(id);
      }}
      reply={inThread ? undefined : () => openThread(m)}
      context={
        (feed !== "conversation" || !!appliedSearch) && !inThread
          ? () => openMessage(m)
          : undefined
      }
    />
  );
  return (
    <div className="n-conversations">
      {navTarget
        ? createPortal(
            <nav
              className="n-conversation-nav"
              aria-label="Mission conversations"
            >
              <button
                aria-current={
                  feed === "conversation" && audience === "main"
                    ? "page"
                    : undefined
                }
                onClick={() => select("main")}
              >
                <Hash size={17} />
                Main
              </button>
              {streams.map((s) => (
                <button
                  key={s.id}
                  data-workstream={s.id}
                  aria-current={
                    feed === "conversation" && audience === `workstream:${s.id}`
                      ? "page"
                      : undefined
                  }
                  onClick={() => select(`workstream:${s.id}`)}
                >
                  <Hash size={17} />
                  <span>{s.name}</span>
                  {s.unread ? (
                    <span className="d-count" aria-label={`${s.unread} unread`}>
                      {s.unread}
                    </span>
                  ) : null}
                </button>
              ))}
              {mission.owner === owner && !blocked ? (
                <button
                  onClick={() => {
                    setThread(null);
                    editStream(null);
                  }}
                >
                  <Plus size={17} />
                  Add workstream
                </button>
              ) : null}
              <button
                onClick={() => {
                  setThread(null);
                  tasks();
                }}
              >
                <ListChecks size={17} />
                Tasks<span className="d-count">{taskCount}</span>
              </button>
              <button
                onClick={() => {
                  setThread(null);
                  artifacts();
                }}
              >
                <Files size={17} />
                Artifacts<span className="d-count">{artifactCount}</span>
              </button>
              <button
                aria-current={feed === "inbox" ? "page" : undefined}
                onClick={() => select(audience, "inbox")}
              >
                <Inbox size={17} />
                Inbox
              </button>
              <button
                aria-current={feed === "sent" ? "page" : undefined}
                onClick={() => select(audience, "sent")}
              >
                <Send size={17} />
                Sent
              </button>
              <div className="n-dm-heading">
                <span className="d-label">Direct messages</span>
                <button
                  className="d-icon"
                  aria-label="Find an agent to message"
                  onClick={() => {
                    setThread(null);
                    members();
                  }}
                >
                  <Plus size={16} />
                </button>
              </div>
              {scopes.slice(0, scopeLimit).map((s) => (
                <button
                  key={s.id}
                  data-audience={s.id}
                  title={
                    s.label ??
                    s.readers
                      .filter((r) => r !== owner)
                      .map(label)
                      .join(", ")
                  }
                  aria-current={
                    feed === "conversation" && s.id === audience
                      ? "page"
                      : undefined
                  }
                  onClick={() => select(s.id)}
                >
                  <LockKeyhole size={15} />
                  <span>
                    {s.label ??
                      s.readers
                        .filter((r) => r !== owner)
                        .map(label)
                        .join(", ")}
                  </span>
                  {s.unread ? (
                    <span className="d-count" aria-label={`${s.unread} unread`}>
                      {s.unread}
                    </span>
                  ) : null}
                </button>
              ))}
              {!scopes.length ? (
                <p>Open Members to start a private conversation.</p>
              ) : null}
              {scopes.length > scopeLimit ? (
                <button onClick={() => setScopeLimit((n) => n + 20)}>
                  More conversations
                </button>
              ) : null}
            </nav>,
            navTarget,
          )
        : null}
      <section className="n-chat" aria-label={title}>
        <header className="n-channel-title">
          {feed === "inbox" ? (
            <Inbox size={17} />
          ) : feed === "sent" ? (
            <Send size={17} />
          ) : isPrivate ? (
            <LockKeyhole size={17} />
          ) : (
            <Hash size={17} />
          )}
          <h2>{title}</h2>
          <label className="n-conversation-picker">
            <span className="sr-only">Conversation</span>
            <select
              aria-label="Conversation"
              value={feed === "conversation" ? audience : feed}
              onChange={(e) =>
                ["inbox", "sent"].includes(e.target.value)
                  ? select(audience, e.target.value as MessageFeed)
                  : select(e.target.value)
              }
            >
              <option value="main">Main · everyone in this mission</option>
              {streams.map((s) => (
                <option key={s.id} value={`workstream:${s.id}`}>
                  {s.name} · everyone in this mission
                </option>
              ))}
              <option value="inbox">Inbox</option>
              <option value="sent">Sent</option>
              {scopes.map((s) => (
                <option key={s.id} value={s.id}>
                  Private ·{" "}
                  {s.label ??
                    s.readers
                      .filter((r) => r !== owner)
                      .map(label)
                      .join(", ")}
                </option>
              ))}
            </select>
          </label>
          <label className="n-message-search">
            <span className="sr-only">Search {title}</span>
            <input
              type="search"
              aria-label={`Search ${title}`}
              value={search}
              maxLength={512}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${title}…`}
            />
          </label>
        </header>
        {isPrivate && feed === "conversation"
          ? agents
              .filter((a) => currentScope?.readers.includes(a.identity.author))
              .map((a) => (
                <div className="n-dm-status" key={a.id}>
                  <AgentState
                    agent={a}
                    contribution={contributions.find(
                      (c) => c.sharedAgent?.registration === a.id,
                    )}
                    mission={mission}
                  />
                  <button className="d-button" onClick={() => profile(a.id)}>
                    Agent details
                  </button>
                </div>
              ))
          : null}
        {currentStream && feed === "conversation" ? (
          <div className="n-workstream-goal">
            <p>{currentStream.goal}</p>
            <button
              className="d-button"
              onClick={() => {
                setThread(null);
                editStream(currentStream.id);
              }}
            >
              Goal &amp; agents
            </button>
            {currentStream.heads.length > 1 || currentStream.stale ? (
              <span className="d-field-help">Goal needs review</span>
            ) : null}
          </div>
        ) : null}
        {feed !== "conversation" ? (
          <p className="n-feed-help">
            {feed === "inbox"
              ? "Private messages, messages addressed to you and replies to your public messages."
              : "Your messages across Main, workstreams, private conversations and threads."}{" "}
            Open a message to return to its conversation.
          </p>
        ) : null}
        {anchor ? (
          <div className="n-context-banner">
            <span>Viewing earlier conversation</span>
            <button className="d-button" onClick={() => setAnchor(null)}>
              Back to latest
            </button>
          </div>
        ) : null}
        <div
          className="n-messages"
          ref={list}
          aria-label={`${title} messages`}
          aria-busy={loading}
          onScroll={(e) => {
            if (!loading) rememberScroll(key, e.currentTarget.scrollTop);
            if (
              e.currentTarget.scrollHeight -
                e.currentTarget.clientHeight -
                e.currentTarget.scrollTop <
              48
            ) {
              setNewMessages(0);
              if (feed === "conversation" && !appliedSearch)
                void markRead(messages.slice(-200));
            }
          }}
        >
          {newMessages ? (
            <button
              className="d-button n-new-messages"
              onClick={() => {
                setNewMessages(0);
                requestAnimationFrame(() => {
                  list.current?.scrollTo({ top: list.current.scrollHeight });
                });
              }}
            >
              {newMessages} new messages ↓
            </button>
          ) : null}
          {error ? (
            <p role="alert">{error}</p>
          ) : loading ? (
            <p role="status">Loading conversation…</p>
          ) : null}
          {older ? (
            <button
              className="d-button"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const selected = key;
                  const height = list.current?.scrollHeight ?? 0;
                  const top = list.current?.scrollTop ?? 0;
                  const page = await node.queryMessages(mission.id, {
                    ...query,
                    before: older,
                  });
                  if (activeKey.current !== selected) return;
                  setMessages((current) => [
                    ...page.items,
                    ...current.filter(
                      (m) => !page.items.some((p) => p.id === m.id),
                    ),
                  ]);
                  setOlder(page.before);
                  requestAnimationFrame(() => {
                    if (list.current)
                      list.current.scrollTop =
                        top + list.current.scrollHeight - height;
                  });
                })
              }
            >
              Load earlier messages
            </button>
          ) : null}
          {!loading && !messages.length && !error ? (
            <div className="n-conversation-start">
              <h2>
                {appliedSearch
                  ? "No matching messages."
                  : feed === "conversation"
                    ? `This is the start of ${title}.`
                    : `Your ${title.toLowerCase()} is empty.`}
              </h2>
              <p>
                {appliedSearch
                  ? "Search covers the full saved history you can access on this node."
                  : isPrivate && feed === "conversation"
                    ? "Only these participants receive this conversation. The agent’s contributor controls the computer that hosts it."
                    : feed === "conversation"
                      ? "Share context, useful constraints or a first direction. Everyone admitted to this mission can read this conversation."
                      : "Messages keep their original conversation and privacy."}
              </p>
            </div>
          ) : null}
          {feed === "inbox" ? decisions : null}
          {(() => {
            if (appliedSearch || feed !== "conversation")
              return messages.map((m) => render(m));
            const grouped: ReactNode[] = [];
            let routine: MessageView[] = [];
            const flush = () => {
              if (!routine.length) return;
              const items = routine;
              routine = [];
              grouped.push(
                <details
                  className="n-routine-activity"
                  key={`routine-${items[0].id}`}
                >
                  <summary>
                    {items.length} resource{" "}
                    {items.length === 1 ? "update" : "updates"} · signed history
                  </summary>
                  {items.map((m) => render(m))}
                </details>,
              );
            };
            for (const m of messages) {
              if (
                m.kind === "governance" &&
                m.text ===
                  "Resource permission or allowance updated. Open Budget & permissions for the signed ledger." &&
                !m.replies
              )
                routine.push(m);
              else {
                flush();
                grouped.push(render(m));
              }
            }
            flush();
            return grouped;
          })()}
        </div>
        {feed === "conversation" ? (
          <>
            {audience.startsWith("private:") ? (
              <PrivateRecovery
                key={`${mission.id}:${audience}`}
                mission={mission.id}
                audience={audience}
                messages={messages}
                perform={perform}
                busy={busy}
              />
            ) : null}
            <Composer
              refElement={composer}
              draft={draft}
              change={setDraft}
              busy={busy}
              blocked={unavailable || !!error}
              title={title}
              hint={
                unavailable
                  ? "This conversation is read-only. Saved history remains available."
                  : isPrivate
                    ? "Private · the agent’s hosting computer receives this conversation"
                    : "Public · everyone in this mission can read this message"
              }
              recipient={
                isPrivate
                  ? undefined
                  : {
                      value: recipient,
                      change: setRecipient,
                      options: [
                        ...people
                          .filter((p) => !p.revoked && p.author !== owner)
                          .map((p) => ({
                            id: p.author,
                            label: label(p.author),
                          })),
                        ...agents
                          .filter(
                            (a) =>
                              ![
                                "withdrawn",
                                "revoked",
                                "conflict",
                                "review_required",
                              ].includes(a.status),
                          )
                          .map((a) => ({
                            id: a.identity.author,
                            label: `${a.identity.label}${a.identity.role === "coordinator" ? " · Coordinator" : ""}`,
                          })),
                      ],
                    }
              }
              send={() =>
                void perform(async () => {
                  if (unavailable || !draft.trim()) return;
                  await node.postMessage(
                    mission.id,
                    draft.trim(),
                    audience,
                    isPrivate ? null : recipient || null,
                  );
                  setDraft("");
                  setAnchor(null);
                  setSearch("");
                  setAppliedSearch("");
                  const page = await node.queryMessages(mission.id, {
                    ...query,
                    anchor: null,
                    search: "",
                    before: null,
                  });
                  if (activeKey.current === key) {
                    setMessages(page.items);
                    setOlder(page.before);
                    requestAnimationFrame(() => {
                      if (list.current)
                        list.current.scrollTop = list.current.scrollHeight;
                      composer.current?.focus();
                    });
                  }
                })
              }
            />
          </>
        ) : null}
      </section>
      {thread ? (
        <Thread
          key={`${thread.audience}:${thread.id}`}
          mission={mission.id}
          target={thread}
          close={closeThread}
          render={(m) => render(m, true)}
          blocked={
            blocked ||
            (thread.audience.startsWith("private:") &&
              !scopes.find((s) => s.id === thread.audience)?.writable)
          }
          busy={busy}
          perform={perform}
          draft={session.drafts[`thread:${thread.id}`] ?? ""}
          change={(value) =>
            updateSession((s) => ({
              ...s,
              drafts: { ...s.drafts, [`thread:${thread.id}`]: value },
            }))
          }
        />
      ) : null}
    </div>
  );
}
