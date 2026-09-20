import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Hash, Lock, Search } from "lucide-react";
import { rpc } from "./client";
import { Empty, Runtime, Time } from "./ui";
import { MessageRow } from "./App";
import type { Context, Message, MessageView } from "./model";

export function readLocation() {
  const [mission, parameters = ""] = location.hash.slice(1).split("?");
  const params = new URLSearchParams(parameters);
  const candidate = params.get("view");
  const view: MessageView =
    candidate && ["dm", "directs", "inbox", "sent"].includes(candidate)
      ? (candidate as MessageView)
      : "channel";
  return {
    mission,
    view,
    agent: params.get("agent") || "",
    stream: params.get("stream") || "",
    message: params.get("message") || "",
  };
}

export function messageLink(message: Message) {
  const params = new URLSearchParams({
    ...(message.directAgentId
      ? { view: "dm", agent: message.directAgentId }
      : { stream: message.streamId || "" }),
    message: message.id,
  });
  return `${location.origin}${location.pathname}#${message.channelId}?${params}`;
}

export function messagePlace(context: Context, m: Message) {
  return m.directAgentId
    ? `Private · ${context.agents.find((a) => a.id === m.directAgentId)?.name || "Agent"}`
    : `# ${context.workstreams.find((w) => w.id === m.streamId)?.name || "Main"}${m.threadId ? " · Thread" : ""}`;
}

export function Mailbox({
  context,
  view,
  query,
  open,
  inspect,
  refresh,
}: {
  context: Context;
  view: "inbox" | "sent";
  query: string;
  open: (message: Message) => void;
  inspect: (id: string) => void;
  refresh: () => Promise<void>;
}) {
  const [visibility, setVisibility] = useState("all");
  const [agent, setAgent] = useState("");
  const [unread, setUnread] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const input = {
    channel_id: context.mission.id,
    view,
    query,
    visibility,
    agent_id: agent && agent !== "coordinator" ? agent : undefined,
    audience: agent === "coordinator" ? "coordinator" : undefined,
    unread,
  };
  const filterKey = JSON.stringify(input);
  const currentFilter = useRef(filterKey);
  currentFilter.current = filterKey;
  const loadedFilter = useRef("");
  const hasEarlier = useRef(false);
  useEffect(() => {
    let active = true;
    if (loadedFilter.current !== filterKey) {
      setMessages([]);
      hasEarlier.current = false;
    }
    setLoading(true);
    const timer = setTimeout(
      () => {
        rpc<{ messages: Message[]; more: boolean }>("messages_search", input)
          .then((data) => {
            if (active) {
              if (loadedFilter.current !== filterKey || !data.messages.length)
                hasEarlier.current = false;
              loadedFilter.current = filterKey;
              setMessages((old) =>
                hasEarlier.current
                  ? [
                      ...data.messages,
                      ...old.filter(
                        (m) =>
                          m.sequence <
                            (data.messages.at(-1)?.sequence ??
                              Number.MAX_SAFE_INTEGER) &&
                          (!unread || !m.seen),
                      ),
                    ]
                  : data.messages,
              );
              if (!hasEarlier.current) setMore(data.more);
              setError("");
            }
          })
          .catch((e) => active && setError(e.message))
          .finally(() => active && setLoading(false));
      },
      query ? 180 : 0,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    context.mission.id,
    context.cursor,
    context.inboxUnread,
    view,
    query,
    visibility,
    agent,
    unread,
    page,
  ]);
  async function earlier() {
    setLoading(true);
    try {
      const data = await rpc<{ messages: Message[]; more: boolean }>(
        "messages_search",
        { ...input, before: messages.at(-1)?.sequence },
      );
      if (currentFilter.current !== filterKey) return;
      hasEarlier.current = true;
      setMessages((old) =>
        [
          ...new Map([...old, ...data.messages].map((m) => [m.id, m])).values(),
        ].sort((a, b) => b.sequence - a.sequence),
      );
      setMore(data.more);
    } catch (e) {
      if (currentFilter.current === filterKey) setError((e as Error).message);
    } finally {
      if (currentFilter.current === filterKey) setLoading(false);
    }
  }
  async function markRead(ids: string[]) {
    try {
      await rpc("messages_seen", {
        channel_id: context.mission.id,
        message_ids: ids,
      });
      setMessages((old) =>
        old
          .map((m) => (ids.includes(m.id) ? { ...m, seen: true } : m))
          .filter((m) => !unread || !m.seen),
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="mailbox">
      <div className="mailbox-filters">
        <nav className="tabs" aria-label="Message visibility">
          {[
            ["all", "All"],
            ["public", "In channels"],
            ["private", "Private"],
          ].map(([value, label]) => (
            <button
              key={value}
              className={visibility === value ? "selected" : ""}
              onClick={() => setVisibility(value)}
            >
              {label}
            </button>
          ))}
        </nav>
        <select
          aria-label="Filter by agent"
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
        >
          <option value="">All agents</option>
          <option value="coordinator">Addressed to Coordinator</option>
          {context.agents.map((a) => (
            <option value={a.id} key={a.id}>
              {a.name}
              {a.role === "coordinator" ? " · Coordinator" : ""}
            </option>
          ))}
        </select>
        {view === "inbox" ? (
          <label className="check-row">
            <input
              type="checkbox"
              checked={unread}
              onChange={(e) => setUnread(e.target.checked)}
            />
            Unread only
          </label>
        ) : null}
      </div>
      <div className="mailbox-scroll">
        <p className="mailbox-description">
          {view === "sent"
            ? "Your messages across every workstream and private conversation in this mission."
            : "Private messages, messages addressed to you, and replies to your channel messages."}
        </p>
        {view === "inbox" && messages.some((m) => !m.seen) ? (
          <button
            className="text-button mark-read"
            onClick={() =>
              void markRead(
                messages
                  .filter((m) => !m.seen)
                  .slice(0, 100)
                  .map((m) => m.id),
              )
            }
          >
            <Check size={13} />
            Mark listed messages as read
          </button>
        ) : null}
        {error ? (
          <div className="error" role="alert">
            {error}
            <button
              className="text-button"
              onClick={() => setPage((p) => p + 1)}
            >
              Retry
            </button>
          </div>
        ) : null}
        {messages.map((m) => (
          <section
            key={m.id}
            className={`mailbox-message ${view === "inbox" && !m.seen ? "unread" : ""}`}
          >
            <div className="message-location">
              <button
                onClick={() => {
                  if (view === "inbox") void markRead([m.id]);
                  open(m);
                }}
              >
                {m.directAgentId ? <Lock size={13} /> : <Hash size={14} />}
                <span>{messagePlace(context, m)}</span>
                <ArrowUpRight size={14} />
              </button>
              {view === "inbox" && !m.seen ? (
                <span className="unread-label">Unread</span>
              ) : null}
            </div>
            <MessageRow
              message={m}
              context={context}
              inspect={(id) => {
                if (id !== m.id) {
                  inspect(id);
                  return;
                }
                if (view === "inbox") void markRead([m.id]);
                open(m);
              }}
            />
            <button
              className="text-button open-conversation"
              onClick={() => {
                if (view === "inbox") void markRead([m.id]);
                open(m);
              }}
            >
              Open {m.directAgentId ? "private conversation" : "in channel"}
              <ArrowUpRight size={13} />
            </button>
          </section>
        ))}
        {!messages.length && !error ? (
          <Empty
            title={
              loading
                ? "Loading messages…"
                : query || agent || visibility !== "all"
                  ? "No matching messages"
                  : view === "sent"
                    ? "Your sent messages live here"
                    : "You're all caught up"
            }
          >
            {context.mission.archived
              ? "No messages match this view in the archived history."
              : view === "sent"
                ? "Send in a channel or start a private conversation. You can always find it here."
                : "New messages to you will appear here."}
          </Empty>
        ) : null}
        {more ? (
          <button
            className="button history"
            disabled={loading}
            onClick={earlier}
          >
            {loading ? "Loading…" : "Load earlier messages"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function DirectDirectory({
  context,
  direct,
}: {
  context: Context;
  direct: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const conversations = new Map(
    context.directMessages.map((d) => [d.agentId, d]),
  );
  const agents = [...context.agents].sort(
    (a, b) =>
      (conversations.get(b.id)?.lastMessage.sequence || 0) -
        (conversations.get(a.id)?.lastMessage.sequence || 0) ||
      Number(b.role === "coordinator") - Number(a.role === "coordinator"),
  );
  return (
    <div className="direct-directory">
      <label className="directory-search">
        <Search size={16} />
        <input
          autoFocus
          placeholder="Find an agent or coordinator"
          aria-label="Find an agent for a private message"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <p className="secondary">
        Choose an agent to open a private conversation. Only you and that agent
        can read it on this board.
      </p>
      <div className="direct-list">
        {agents
          .filter((a) =>
            `${a.name} ${a.role} ${a.runtime}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .map((a) => {
            const conversation = conversations.get(a.id);
            return (
              <button
                className={`direct-card ${conversation?.unread ? "unread" : ""}`}
                key={a.id}
                onClick={() => direct(a.id)}
              >
                <Runtime runtime={a.runtime} />
                <span className="direct-card-body">
                  <strong>
                    {a.name}
                    <small>
                      {a.role === "coordinator" ? "Coordinator" : "Agent"}
                    </small>
                  </strong>
                  <span>
                    {conversation
                      ? `${conversation.lastMessage.authorId === "human" ? "You: " : ""}${conversation.lastMessage.preview}`
                      : context.mission.archived
                        ? "No recorded conversation"
                        : "Start a private conversation"}
                  </span>
                </span>
                <span className="direct-card-meta">
                  {conversation ? (
                    <Time at={conversation.lastMessage.createdAt} />
                  ) : (
                    <Lock size={14} />
                  )}
                  {conversation?.unread ? (
                    <b className="unread-count">{conversation.unread}</b>
                  ) : null}
                </span>
              </button>
            );
          })}
        {!agents.length ? (
          <Empty
            title={
              context.mission.archived
                ? "No recorded agents"
                : "No agents connected yet"
            }
          >
            {context.mission.archived
              ? "This mission was archived without any agents."
              : "Invite agents to this mission to start a conversation."}
          </Empty>
        ) : null}
        {agents.length &&
        !agents.some((a) =>
          `${a.name} ${a.role} ${a.runtime}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        ) ? (
          <Empty title="No matching agents" />
        ) : null}
      </div>
    </div>
  );
}
