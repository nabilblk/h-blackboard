import { observations } from "../application/observations";
import { readRoster } from "../application/mission-queries";
import { Disclosure } from "../ui/Disclosure";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/Button";
import { useApplication } from "./ApplicationProvider";
import { agentContributorLabel } from "../../shared/agent-lifecycle.mjs";
import type { ReactNode } from "react";
import { AgentState } from "./ExecutionStatus";
import type { Contribution } from "../application/contracts/workspace";
import { PrivateRecovery } from "./PrivateRecovery";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
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
} from "../application/contracts/node";

export type MissionSession = {
  audience: string;
  drafts: Record<string, string>;
  feed?: MessageFeed;
  recipients?: Record<string, string>;
  anchor?: string | null;
  thread?: { id: string; audience: string } | null;
};
type Props = {
  decisions?: ReactNode;
  compactNavigation?: boolean;
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
  compactNavigation = false,
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
  const { missions: node } = useApplication();
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
  const agentsByAuthor = useMemo(
    () => new Map(agents.map((agent) => [agent.identity.author, agent])),
    [agents],
  );
  const [people, setPeople] = useState<MemberView[]>([]);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [windowEnd, setWindowEnd] = useState<number | null>(null);
  const windowEndRef = useRef(windowEnd);
  windowEndRef.current = windowEnd;
  const visibleEnd = windowEnd ?? messages.length;
  const visibleStart = Math.max(0, visibleEnd - 200);
  const visibleMessages = messages.slice(visibleStart, visibleEnd);
  const [readingSize, setReadingSize] = useState(() => {
    try {
      return localStorage.getItem("harakiri.reading-size") === "large"
        ? "large"
        : "standard";
    } catch {
      return "standard";
    }
  });
  const [older, setOlder] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const anchor = session.anchor ?? null;
  const setAnchor = (anchor: string | null) =>
    updateSession((s) => ({ ...s, anchor }));
  const thread = session.thread ?? null;
  const setThread = (thread: MissionSession["thread"]) =>
    updateSession((s) => ({ ...s, thread }));
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
        agentContributorLabel(
          agents.find((a) => a.contributor === author) ?? {
            contributor: author,
          },
          mission,
        ));
  const select = (audience: string, feed: MessageFeed = "conversation") => {
    setAnchor(null);
    setThread(null);
    setSearch("");
    setAppliedSearch("");
    updateSession((s) => ({ ...s, audience, feed }));
  };
  const closeThread = () => setThread(null);
  useEffect(() => {
    const t = setTimeout(() => setAppliedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    const fail = (error: Error) => setError(error.message);
    const roster = observations(node).subscribe(
      `roster:${mission.id}`,
      () => readRoster(node, mission.id),
      setAgents,
      fail,
    );
    const peers = observations(node).subscribe(
      `peers:${mission.id}`,
      () => node.peers(mission.id),
      (value) => setPeople(value.members),
      fail,
    );
    return () => {
      roster();
      peers();
    };
  }, [mission.id, node]);
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
    const seen = new Set<string>();
    const saved = readScroll(key);
    setMessages([]);
    setWindowEnd(null);
    setOlder(null);
    setLoading(true);
    setError("");
    setNewMessages(0);
    const stop = observations(node).subscribe(
      `conversation:${mission.id}:${key}`,
      async () => {
        const [page, audiences] = await Promise.all([
          node.queryMessages(mission.id, queryRef.current),
          node.audiences(mission.id),
        ]);
        return { page, audiences };
      },
      ({ page, audiences }) => {
        if (cancelled) return;
        const nearBottom =
          windowEndRef.current === null &&
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
            windowEndRef.current === null &&
            list.current.scrollHeight -
              list.current.clientHeight -
              list.current.scrollTop <
              48
          )
            void markReadRef.current(page.items);
        });
      },
      (error) => {
        if (!cancelled) {
          setError(error.message);
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
      stop();
    };
  }, [mission.id, key, node]);
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
      role={agentsByAuthor.get(m.author)?.identity.role}
      runtime={agentsByAuthor.get(m.author)?.identity.runtime}
      copyLink={() =>
        perform(async () => {
          await node.copyMessageReference(mission.id, m.id);
        })
      }
      openWork={(kind, id) => {
        if (kind === "artifact") artifacts(id);
        else if (kind === "task") tasks(id);
        else if (kind === "message" || kind === "thread")
          void perform(async () => {
            const message = await node.readMessage(mission.id, id);
            if (kind === "thread") openThread(message);
            else openMessage(message);
          });
        else editStream(id);
      }}
      profile={(id) => {
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
              {!compactNavigation ? (
                <>
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
                </>
              ) : null}
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
                <IconButton
                  aria-label="Find an agent to message"
                  onClick={() => {
                    setThread(null);
                    members();
                  }}
                >
                  <Plus size={16} />
                </IconButton>
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
                <p>
                  Open {compactNavigation ? "People" : "Members"} to start a
                  private conversation.
                </p>
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
          <label className="n-reading-control">
            <span className="sr-only">Message text size</span>
            <select
              aria-label="Message text size"
              value={readingSize}
              onChange={(e) => {
                setReadingSize(e.target.value);
                try {
                  localStorage.setItem("harakiri.reading-size", e.target.value);
                } catch {
                  /* Session preference remains usable. */
                }
              }}
            >
              <option value="standard">Text size</option>
              <option value="large">Larger text</option>
            </select>
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
                  <Button onClick={() => profile(a.id)}>Agent details</Button>
                </div>
              ))
          : null}
        {currentStream && feed === "conversation" ? (
          <div className="n-workstream-goal">
            <p>{currentStream.goal}</p>
            <Button
              onClick={() => {
                setThread(null);
                editStream(currentStream.id);
              }}
            >
              Goal &amp; agents
            </Button>
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
            <Button onClick={() => setAnchor(null)}>Back to latest</Button>
          </div>
        ) : null}
        <div
          className={`n-messages n-reading-${readingSize}`}
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
                void markRead(visibleMessages);
            } else if (windowEnd === null && messages.length > 200) {
              // Hold the current window while reading/selecting older text.
              // New messages remain available through the latest button.
              setWindowEnd(messages.length);
            }
          }}
        >
          {newMessages ? (
            <Button
              className="n-new-messages"
              onClick={() => {
                setNewMessages(0);
                setWindowEnd(null);
                requestAnimationFrame(() => {
                  list.current?.scrollTo({ top: list.current.scrollHeight });
                });
              }}
            >
              {newMessages} new {newMessages === 1 ? "message" : "messages"} ↓
            </Button>
          ) : null}
          {error ? (
            <p role="alert">{error}</p>
          ) : loading ? (
            <p role="status">Loading conversation…</p>
          ) : null}
          {older || visibleStart > 0 ? (
            <Button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  if (visibleStart > 0) {
                    setWindowEnd(Math.min(messages.length, visibleStart + 40));
                    requestAnimationFrame(() =>
                      list.current?.scrollTo({ top: 0 }),
                    );
                    return;
                  }
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
                  setWindowEnd(
                    Math.min(200, page.items.length + messages.length),
                  );
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
            </Button>
          ) : null}
          {windowEnd !== null ? (
            <div className="n-context-banner">
              <span>
                Showing {visibleStart + 1}–
                {Math.min(visibleEnd, messages.length)} of {messages.length}{" "}
                loaded messages. Search covers saved history.
              </span>
              <Button
                onClick={() => {
                  setWindowEnd(null);
                  setNewMessages(0);
                  requestAnimationFrame(() =>
                    list.current?.scrollTo({ top: list.current.scrollHeight }),
                  );
                }}
              >
                Back to latest
              </Button>
            </div>
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
              return visibleMessages.map((m) => render(m));
            const grouped: ReactNode[] = [];
            let routine: MessageView[] = [];
            const flush = () => {
              if (!routine.length) return;
              const items = routine;
              routine = [];
              grouped.push(
                <Disclosure
                  className="n-routine-activity"
                  key={`routine-${items[0].id}`}
                  title={
                    <>
                      {items.length} resource{" "}
                      {items.length === 1 ? "update" : "updates"} · signed
                      history
                    </>
                  }
                >
                  {items.map((m) => render(m))}
                </Disclosure>,
              );
            };
            for (const m of visibleMessages) {
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
      {thread && !detailsOpen ? (
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
