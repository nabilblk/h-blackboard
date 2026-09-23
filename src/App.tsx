import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Plus,
  Hash,
  ChevronRight,
  ChevronDown,
  X,
  MessageSquare,
  ArrowUp,
  Menu,
  Link2,
  Users,
  PanelRight,
  Search,
  Copy,
  Check,
  Eye,
  Pencil,
  Lock,
  Inbox,
  Send,
  ListChecks,
  Archive,
} from "lucide-react";
import { get, rpc } from "./client";
import { Badge, Empty, Runtime, Text, Time } from "./ui";
import { Dialogs } from "./dialogs";
import { SidePanel } from "./panels";
import { StartupBanner } from "./Startup";
import { Presence, ResumeAgent, connectionLabel } from "./Recovery";
import {
  DirectDirectory,
  Mailbox,
  messageLink,
  readLocation,
} from "./Messaging";
import type {
  Context,
  Mission,
  MissionList,
  Modal,
  Panel,
  Session,
  SharedRecord,
  Message,
  MessageView,
} from "./model";
export default function App() {
  const [session, setSession] = useState<Session | null>(null),
    [missions, setMissions] = useState<Mission[]>([]),
    [archivedMissions, setArchivedMissions] = useState<Mission[]>([]),
    [archivedOpen, setArchivedOpen] = useState(false),
    [archiving, setArchiving] = useState(false),
    [selected, setSelected] = useState(readLocation().mission),
    [context, setContext] = useState<Context | null>(null),
    [stream, setStream] = useState(readLocation().stream),
    [view, setView] = useState<MessageView>(readLocation().view),
    [directId, setDirectId] = useState(readLocation().agent),
    [linkedMessage, setLinkedMessage] = useState(readLocation().message),
    [modal, setModal] = useState<Modal | null>(null),
    [panel, setPanel] = useState<Panel | null>(null),
    [error, setError] = useState(""),
    [online, setOnline] = useState(false),
    [ready, setReady] = useState(false),
    [query, setQuery] = useState(""),
    [mobileNav, setMobileNav] = useState(false),
    [recipient, setRecipient] = useState("everyone");
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const reload = useCallback(async () => {
    const id = selectedRef.current;
    const [list, state] = await Promise.all([
      get<MissionList>("channels"),
      id
        ? rpc<Context>("context_read", { channel_id: id })
        : Promise.resolve(null),
    ]);
    setMissions(list.missions);
    setArchivedMissions(list.archivedMissions);
    if (selectedRef.current === id) setContext(state);
    setOnline(true);
  }, []);
  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout>;
    async function start() {
      try {
        const info = await get<Session>("session");
        const list = await get<MissionList>("channels");
        if (cancelled) return;
        setSession(info);
        setMissions(list.missions);
        setArchivedMissions(list.archivedMissions);
        setArchivedOpen(
          list.archivedMissions.some((m) => m.id === selectedRef.current),
        );
        setSelected((current) =>
          [...list.missions, ...list.archivedMissions].some(
            (m) => m.id === current,
          )
            ? current
            : list.missions[0]?.id || "",
        );
        setReady(true);
        setOnline(true);
        setError("");
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          retry = setTimeout(start, 2500);
        }
      }
    }
    void start();
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, []);
  useEffect(() => {
    if (!session) return;
    setContext(null);
    void reload().catch((e) => setError(e.message));
  }, [selected, session, reload]);
  useEffect(() => {
    if (!session) return;
    const source = new EventSource(
      `/api/events${selected ? `?channel=${selected}` : ""}`,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          void reload().catch(() => setOnline(false));
        }, 100);
    };
    source.addEventListener("ready", () => {
      setOnline(true);
      refresh();
    });
    source.addEventListener("changed", refresh);
    source.onerror = () => setOnline(false);
    const interval = setInterval(refresh, 15000);
    return () => {
      source.close();
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [session, selected, reload]);
  useEffect(() => {
    const navigate = () => {
      const route = readLocation();
      setSelected(route.mission);
      setStream(route.stream);
      setView(route.view);
      setDirectId(route.agent);
      setLinkedMessage(route.message);
      setQuery("");
      setPanel(null);
    };
    addEventListener("hashchange", navigate);
    return () => removeEventListener("hashchange", navigate);
  }, []);
  useEffect(
    () =>
      setRecipient((current) =>
        context?.agents.some((a) => a.id === current) || current === "human"
          ? current
          : context?.mission.coordinatorId
            ? "coordinator"
            : "everyone",
      ),
    [context?.mission.coordinatorId, selected],
  );
  useEffect(() => {
    if (panel) setMobileNav(false);
  }, [panel]);
  useEffect(() => {
    if (!context?.mission.archived) return;
    setArchivedOpen(true);
    setModal((current) => (current?.kind === "mission" ? current : null));
  }, [context?.mission.id, context?.mission.archived]);
  const choose = (id: string, workstream = "") => {
    setSelected(id);
    setStream(workstream);
    setPanel(null);
    setQuery("");
    setView("channel");
    setDirectId("");
    setLinkedMessage("");
    setMobileNav(false);
    history.pushState(
      null,
      "",
      `#${id}${workstream ? `?stream=${workstream}` : ""}`,
    );
  };
  const inspect = async (id: string) => {
    try {
      setPanel({
        kind: "record",
        record: await rpc<SharedRecord>("record_read", {
          channel_id: selected,
          id,
        }),
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    if (context?.mission.id === selected && linkedMessage) {
      void inspect(linkedMessage);
      setLinkedMessage("");
    }
  }, [context?.mission.id, selected, linkedMessage]);
  const saved = async (created?: Mission) => {
    if (created) {
      choose(created.id);
      const list = await get<MissionList>("channels");
      setMissions(list.missions);
      setArchivedMissions(list.archivedMissions);
    } else await reload();
  };
  const archiveChannel = async (archived: boolean) => {
    if (!context || archiving) return;
    const mission = context.mission;
    setArchiving(true);
    setError("");
    try {
      await rpc("mission_archive", {
        channel_id: mission.id,
        version: mission.version,
        archived,
      });
      await reload();
      setArchivedOpen(true);
      if (selectedRef.current === mission.id) {
        setPanel(null);
        setModal(null);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setArchiving(false);
    }
  };
  const navigateMessages = (next: MessageView, agent = "") => {
    setView(next);
    setDirectId(agent);
    setQuery("");
    setPanel(null);
    setMobileNav(false);
    const params = new URLSearchParams({
      view: next,
      ...(agent ? { agent } : {}),
    });
    history.pushState(null, "", `#${selected}?${params}`);
  };
  const direct = (id: string) => {
    const agent = id === "coordinator" ? context?.mission.coordinatorId : id;
    if (agent) navigateMessages("dm", agent);
  };
  const address = (id: string) => {
    choose(selected, stream);
    setRecipient(id);
    requestAnimationFrame(() =>
      document.getElementById("channel-composer")?.focus(),
    );
  };
  const openMessage = (m: Message) => {
    if (m.directAgentId) direct(m.directAgentId);
    else choose(selected, m.streamId || "");
    history.replaceState(null, "", messageLink(m));
    void inspect(m.id);
  };
  const currentStream = context?.workstreams.find(
    (w) => w.id === (stream || context.mission.defaultStreamId),
  );
  const coordinator = context?.agents.find(
    (a) => a.id === context.mission.coordinatorId,
  );
  const directAgent = context?.agents.find((a) => a.id === directId);
  const privateUnread =
    context?.directMessages.reduce((sum, d) => sum + d.unread, 0) || 0;
  const renderMission = (m: Mission) => (
    <div key={m.id}>
      <button
        className={`channel-item ${selected === m.id && view === "channel" ? "selected" : ""}`}
        onClick={() => choose(m.id)}
      >
        {m.archived ? <Archive size={15} /> : <Hash size={15} />}
        <span>{m.name}</span>
        {m.coordinatorId ? <i className="square accent" /> : null}
      </button>
      {selected === m.id && context?.mission.id === m.id ? (
        <div className="streams-nav">
          {context.workstreams
            .filter((w) => !w.archived || m.archived)
            .map((w) => (
              <button
                key={w.id}
                className={
                  view === "channel" && currentStream?.id === w.id
                    ? "active"
                    : ""
                }
                onClick={() => choose(m.id, w.id)}
              >
                <span className="stream-glyph">{w.isDefault ? "#" : "↳"}</span>
                <span>{w.name}</span>
              </button>
            ))}
          <button
            className={
              panel?.kind === "tasks"
                ? "active mission-tasks-link"
                : "mission-tasks-link"
            }
            onClick={() => setPanel({ kind: "tasks" })}
            aria-label={`View mission tasks, ${context.tasks.length} total`}
          >
            <ListChecks size={14} />
            <span>Tasks</span>
            <b className="count">{context.tasks.length}</b>
          </button>
          <button
            className="add-stream"
            hidden={!!m.archived}
            onClick={() => setModal({ kind: "stream" })}
          >
            <Plus size={12} />
            New workstream
          </button>
        </div>
      ) : null}
    </div>
  );
  const requests =
    context?.requests.filter((r) => r.status === "open").length || 0;
  return (
    <div className="workspace">
      <header className="topbar">
        <button
          className="icon mobile-menu"
          aria-label="Toggle channels"
          onClick={() => setMobileNav(!mobileNav)}
        >
          <Menu size={18} />
        </button>
        <a
          className="wordmark"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            if (missions[0]) choose(missions[0].id);
          }}
        >
          <img src="/favicon.svg" alt="" />
          HARA<span>/</span>KIRI
        </a>
        <span className="top-divider" />
        <span className="workspace-title">Blackboard</span>
        <label className="search">
          <Search size={14} />
          <input
            placeholder={
              view === "sent"
                ? "Search your sent messages"
                : view === "inbox"
                  ? "Search your inbox"
                  : "Search this conversation"
            }
            aria-label="Search messages"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={!context || view === "directs"}
          />
          {query ? (
            <button
              className="icon"
              onClick={() => setQuery("")}
              aria-label="Clear search"
            >
              <X size={12} />
            </button>
          ) : null}
        </label>
        <span className={`connection ${online ? "success" : "warning"}`}>
          <i />
          {online ? "Live" : "Reconnecting"}
        </span>
        {context && !context.mission.archived ? (
          <>
            <button
              className="button attention"
              onClick={() => setPanel({ kind: "requests" })}
            >
              <i className={`square ${requests ? "warning" : "muted"}`} />
              {requests}
              <span> need attention</span>
            </button>
            <button
              className="button primary"
              onClick={() => setModal({ kind: "invite" })}
            >
              Invite agents
            </button>
          </>
        ) : null}
        <span className="human-badge">YOU</span>
      </header>
      <aside className={`channel-sidebar ${mobileNav ? "visible" : ""}`}>
        {context ? (
          <nav
            className="message-navigation"
            aria-label="Messages in this mission"
          >
            <button
              className={`channel-item ${view === "inbox" ? "selected" : ""}`}
              onClick={() => navigateMessages("inbox")}
            >
              <Inbox size={16} />
              <span>Inbox</span>
              {context.inboxUnread ? (
                <b className="unread-count">{context.inboxUnread}</b>
              ) : null}
            </button>
            <button
              className={`channel-item ${view === "sent" ? "selected" : ""}`}
              onClick={() => navigateMessages("sent")}
            >
              <Send size={15} />
              <span>Sent</span>
            </button>
            <button
              className={`channel-item ${view === "directs" ? "selected" : ""}`}
              onClick={() => navigateMessages("directs")}
            >
              <MessageSquare size={16} />
              <span>Direct messages</span>
              {privateUnread ? (
                <b className="unread-count">{privateUnread}</b>
              ) : null}
            </button>
          </nav>
        ) : null}
        <div className="sidebar-heading">
          <h2 className="label">Channels</h2>
          <button
            className="icon"
            aria-label="Create mission channel"
            onClick={() => setModal({ kind: "mission" })}
          >
            <Plus size={15} />
          </button>
        </div>
        <nav aria-label="Mission channels">{missions.map(renderMission)}</nav>
        {archivedMissions.length ? (
          <details
            className="archived-channels"
            open={archivedOpen}
            onToggle={(e) => setArchivedOpen(e.currentTarget.open)}
          >
            <summary>
              <Archive size={14} />
              <span>Archived channels</span>
              <b className="count">{archivedMissions.length}</b>
            </summary>
            <nav aria-label="Archived channels">
              {archivedMissions.map(renderMission)}
            </nav>
          </details>
        ) : null}
        {!missions.length ? (
          <p className="sidebar-empty">
            {archivedMissions.length
              ? "No active channels. Browse the archive or create a mission."
              : "Create a mission to open its channel."}
          </p>
        ) : null}
        <button
          className="button create-channel"
          onClick={() => setModal({ kind: "mission" })}
        >
          New channel
        </button>
        {context ? (
          <section className="sidebar-directs">
            <div className="sidebar-heading">
              <h2 className="label">Direct messages</h2>
              <button
                className="icon"
                aria-label={
                  context.mission.archived
                    ? "Browse private conversations"
                    : "New private message"
                }
                onClick={() => navigateMessages("directs")}
              >
                <Plus size={15} />
              </button>
            </div>
            {context.directMessages.slice(0, 6).map((d) => {
              const agent = context.agents.find((a) => a.id === d.agentId);
              return (
                <button
                  key={d.agentId}
                  className={`channel-item ${view === "dm" && directId === d.agentId ? "selected" : ""} ${d.unread ? "unread" : ""}`}
                  onClick={() => direct(d.agentId)}
                >
                  <Lock size={12} />
                  <span>{agent?.name || "Agent"}</span>
                  {agent ? <Presence agent={agent} /> : null}
                  {d.unread ? <b className="unread-count">{d.unread}</b> : null}
                </button>
              );
            })}
            {!context.directMessages.length && !context.mission.archived ? (
              <button
                className="text-button sidebar-empty"
                onClick={() =>
                  context.agents.length
                    ? direct(coordinator?.id || context.agents[0].id)
                    : setModal({ kind: "invite" })
                }
              >
                {" "}
                {coordinator
                  ? "Message coordinator privately"
                  : context.agents.length
                    ? "Start a private conversation"
                    : "Invite agents to start"}
              </button>
            ) : null}
            {context.directMessages.length > 6 ? (
              <button
                className="text-button sidebar-empty"
                onClick={() => navigateMessages("directs")}
              >
                View all conversations
              </button>
            ) : null}
          </section>
        ) : null}
        {context ? (
          <div className="sidebar-agents">
            <div className="sidebar-heading">
              <h2 className="label">Agents</h2>
              <button
                className="text-button count"
                onClick={() => setPanel({ kind: "agents" })}
              >
                {context.agents.length}
              </button>
            </div>
            {context.agents.slice(0, 7).map((a) => (
              <button
                className="sidebar-agent"
                key={a.id}
                onClick={() => setPanel({ kind: "record", record: a })}
              >
                <Runtime runtime={a.runtime} />
                <span>{a.name}</span>
                <i
                  className={`square ${a.status === "error" ? "danger" : a.online ? "success" : "muted hollow"}`}
                />
              </button>
            ))}
            {context.agents.length > 7 ? (
              <button
                className="text-button"
                onClick={() => setPanel({ kind: "agents" })}
              >
                View all {context.agents.length} agents
              </button>
            ) : null}
            {!context.agents.length && !context.mission.archived ? (
              <button
                className="text-button"
                onClick={() => setModal({ kind: "invite" })}
              >
                Invite your first agents
              </button>
            ) : null}
          </div>
        ) : null}
        <footer className="sidebar-footer">
          <Runtime />
          <div>
            You<small>Mission owner</small>
          </div>
        </footer>
      </aside>
      {mobileNav ? (
        <button
          className="nav-scrim"
          aria-label="Close channels"
          onClick={() => setMobileNav(false)}
        />
      ) : null}
      <main className="conversation-main">
        {error ? (
          <div className="error error-banner" role="alert">
            {error}
            <button
              className="icon"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={14} />
            </button>
          </div>
        ) : null}
        {!ready ? (
          <Empty title="Opening Blackboard…" />
        ) : !selected ? (
          <div className="start-screen">
            <span className="label">Harakiri Blackboard</span>
            <h1>
              {archivedMissions.length
                ? "No active channels."
                : "A shared place for your agents."}
            </h1>
            <p>
              {archivedMissions.length
                ? "Your archived missions are still available. Browse their history or start a new mission."
                : "Create a mission channel, invite agents, and start the conversation."}
            </p>
            <div className="button-row">
              {archivedMissions.length ? (
                <button
                  className="button"
                  onClick={() => {
                    setArchivedOpen(true);
                    setMobileNav(true);
                  }}
                >
                  Browse archive
                </button>
              ) : null}
              <button
                className="button primary"
                onClick={() => setModal({ kind: "mission" })}
              >
                Define a mission
              </button>
            </div>
          </div>
        ) : !context ? (
          <Empty title="Loading the channel…" />
        ) : (
          <>
            <header
              className={`channel-heading ${view === "dm" ? "direct-heading" : ""}`}
            >
              <div className="channel-identity">
                {view === "channel" ? (
                  <Hash size={22} />
                ) : view === "dm" ? (
                  <Lock size={22} />
                ) : view === "inbox" ? (
                  <Inbox size={22} />
                ) : view === "sent" ? (
                  <Send size={22} />
                ) : (
                  <MessageSquare size={22} />
                )}
                <div>
                  <h1>
                    {view === "channel"
                      ? context.mission.name
                      : view === "dm"
                        ? directAgent?.name || "Private conversation"
                        : view === "inbox"
                          ? "Inbox"
                          : view === "sent"
                            ? "Sent"
                            : "Direct messages"}
                  </h1>
                  <span>
                    {view === "dm"
                      ? `${directAgent?.role === "coordinator" ? "Coordinator" : "Agent"} · ${directAgent ? connectionLabel(directAgent) : "Offline"} · ${context.mission.name}`
                      : view !== "channel"
                        ? context.mission.name
                        : currentStream?.isDefault
                          ? "Main conversation"
                          : currentStream?.name}
                  </span>
                </div>
              </div>
              <div className="channel-actions">
                {view === "channel" ? (
                  <button
                    className="button compact tasks-button"
                    onClick={() => setPanel({ kind: "tasks" })}
                  >
                    <ListChecks size={14} />
                    Tasks <span className="count">{context.tasks.length}</span>
                  </button>
                ) : null}
                {view === "dm" && directAgent ? (
                  <ResumeAgent
                    agent={directAgent}
                    context={context}
                    refresh={reload}
                    setup={() => setModal({ kind: "recovery" })}
                  />
                ) : null}
                {view === "dm" && directAgent ? (
                  <button
                    className="button compact"
                    onClick={() =>
                      setPanel({ kind: "record", record: directAgent })
                    }
                  >
                    Agent details
                  </button>
                ) : null}
                <button
                  className="button compact agent-count"
                  onClick={() => setPanel({ kind: "agents" })}
                >
                  <Users size={14} />
                  {context.agents.length} agents
                </button>
                <button
                  className="icon"
                  aria-label="Open mission details"
                  onClick={() => setPanel({ kind: "mission" })}
                >
                  <PanelRight size={17} />
                </button>
              </div>
            </header>
            {view !== "directs" ? (
              <label className="mobile-message-search">
                <Search size={14} />
                <input
                  aria-label="Search conversation history"
                  placeholder={
                    view === "sent"
                      ? "Search your sent messages"
                      : view === "inbox"
                        ? "Search your inbox"
                        : "Search this conversation"
                  }
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {query ? (
                  <button
                    className="icon"
                    aria-label="Clear mobile search"
                    onClick={() => setQuery("")}
                  >
                    <X size={13} />
                  </button>
                ) : null}
              </label>
            ) : null}
            {view === "channel" ? (
              <div className="goal-strip">
                <button
                  onClick={() =>
                    currentStream?.isDefault
                      ? setPanel({ kind: "mission" })
                      : setPanel({ kind: "record", record: currentStream! })
                  }
                >
                  <span className="label">
                    {currentStream?.isDefault ? "Mission" : "Workstream goal"}
                  </span>
                  <span>{currentStream?.goal}</span>
                  <ChevronRight size={14} />
                </button>
                <button
                  className="coord-link"
                  onClick={() => setPanel({ kind: "mission" })}
                >
                  <i
                    className={`square ${coordinator ? "accent" : "muted hollow"}`}
                  />
                  {coordinator
                    ? coordinator.name
                    : context.mission.coordinationMode === "peer"
                      ? "Peer collaboration"
                      : "Awaiting coordinator"}
                  <ChevronDown size={12} />
                </button>
              </div>
            ) : view === "dm" ? (
              <div className="private-notice">
                <Lock size={13} />
                <span>
                  Private · Only you and {directAgent?.name || "this agent"} can
                  read this conversation on the board.
                </span>
              </div>
            ) : null}
            {context.mission.archived ? (
              <div className="state-banner archive-banner" role="status">
                <Archive size={16} />
                <div>
                  <strong>Archived channel</strong>
                  <span>
                    History is read-only. Restore the channel to make changes.
                  </span>
                </div>
                <button
                  className="button"
                  disabled={archiving}
                  onClick={() => archiveChannel(false)}
                >
                  Restore channel
                </button>
              </div>
            ) : context.mission.state === "preparing" ? (
              <StartupBanner
                key={context.mission.id}
                context={context}
                refresh={reload}
                details={() => setPanel({ kind: "mission" })}
              />
            ) : context.mission.state !== "active" ? (
              <div className="state-banner">
                Mission {context.mission.state}. Human messages and controls
                remain available.
              </div>
            ) : null}
            {view === "sent" || view === "inbox" ? (
              <Mailbox
                key={`${selected}:${view}`}
                context={context}
                view={view}
                query={query}
                open={openMessage}
                inspect={inspect}
                refresh={reload}
              />
            ) : view === "directs" ? (
              <DirectDirectory context={context} direct={direct} />
            ) : view === "dm" && !directAgent ? (
              <Empty title="Agent not found in this mission" />
            ) : (
              <Conversation
                key={`${selected}:${view}:${view === "dm" ? directId : currentStream?.id}`}
                context={context}
                streamId={currentStream?.id || context.mission.defaultStreamId}
                query={query}
                inspect={inspect}
                refresh={reload}
                recipient={recipient}
                setRecipient={setRecipient}
                directAgentId={view === "dm" ? directId : undefined}
              />
            )}
          </>
        )}
      </main>
      {panel && context ? (
        <SidePanel
          key={panel.kind + panel.record?.id}
          panel={panel}
          context={context}
          close={() => setPanel(null)}
          edit={setModal}
          inspect={inspect}
          refresh={reload}
          direct={direct}
          address={address}
          showTasks={() => setPanel({ kind: "tasks" })}
          archive={archiveChannel}
          archiving={archiving}
        />
      ) : null}
      {modal &&
      session &&
      (!context?.mission.archived || modal.kind === "mission") ? (
        <Dialogs
          key={
            modal.kind +
            (modal.agent?.id || "") +
            (modal.stream?.id || "") +
            (modal.criterion?.id || "")
          }
          modal={modal}
          context={context}
          session={session}
          close={() => setModal(null)}
          saved={saved}
        />
      ) : null}
    </div>
  );
}
export function Conversation({
  context,
  streamId,
  query = "",
  inspect,
  refresh,
  recipient,
  setRecipient,
  thread,
  directAgentId,
}: {
  context: Context;
  streamId: string;
  query?: string;
  inspect: (id: string) => void;
  refresh: () => Promise<void>;
  recipient?: string;
  setRecipient?: (id: string) => void;
  thread?: Message;
  directAgentId?: string;
}) {
  const privateId = thread?.directAgentId || directAgentId;
  const [messages, setMessages] = useState<Message[]>([]),
    [more, setMore] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [newCount, setNewCount] = useState(0);
  const scroll = useRef<HTMLDivElement>(null),
    atBottom = useRef(true),
    oldCount = useRef(0);
  const ch = context.mission.id;
  const target = privateId
    ? { direct_agent_id: privateId }
    : { stream_id: streamId };
  const marked = useRef(new Set<string>());
  const markVisible = useCallback(() => {
    if (
      !atBottom.current ||
      document.visibilityState !== "visible" ||
      !document.hasFocus()
    )
      return;
    const ids = [...(thread ? [thread] : []), ...messages]
      .filter(
        (m) =>
          m.authorId !== "human" &&
          m.kind !== "system" &&
          (m.directAgentId ||
            m.audience === "human" ||
            thread?.authorId === "human") &&
          !marked.current.has(m.id),
      )
      .slice(-100)
      .map((m) => m.id);
    if (!ids.length) return;
    ids.forEach((id) => marked.current.add(id));
    void rpc("messages_seen", { channel_id: ch, message_ids: ids })
      .then(refresh)
      .catch(() => ids.forEach((id) => marked.current.delete(id)));
  }, [messages, thread, ch, refresh]);
  useEffect(() => {
    markVisible();
    addEventListener("focus", markVisible);
    document.addEventListener("visibilitychange", markVisible);
    return () => {
      removeEventListener("focus", markVisible);
      document.removeEventListener("visibilitychange", markVisible);
    };
  }, [markVisible]);
  useEffect(() => {
    setMessages([]);
    setNewCount(0);
    oldCount.current = 0;
    atBottom.current = true;
  }, [query]);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(
      () => {
        void rpc<{ messages: Message[]; more: boolean }>(
          query ? "messages_search" : "messages_read",
          {
            channel_id: ch,
            ...target,
            ...(query ? { query } : {}),
            ...(thread ? { thread_id: thread.id } : {}),
          },
        )
          .then((data) => {
            if (alive) {
              setMessages((old) =>
                [
                  ...new Map(
                    [...old, ...data.messages].map((m) => [m.id, m]),
                  ).values(),
                ].sort((a, b) => a.sequence - b.sequence),
              );
              setMore(data.more);
            }
          })
          .catch((e) => alive && setError(e.message));
      },
      query ? 180 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [ch, streamId, privateId, thread?.id, context.cursor, query]);
  useEffect(() => {
    if (messages.length > oldCount.current) {
      if (atBottom.current)
        requestAnimationFrame(() => {
          if (scroll.current)
            scroll.current.scrollTop = scroll.current.scrollHeight;
        });
      else setNewCount((n) => n + messages.length - oldCount.current);
    }
    oldCount.current = messages.length;
  }, [messages.length]);
  async function earlier() {
    setLoading(true);
    try {
      const oldHeight = scroll.current?.scrollHeight || 0;
      const data = await rpc<{ messages: Message[]; more: boolean }>(
        query ? "messages_search" : "messages_read",
        {
          channel_id: ch,
          ...target,
          ...(query ? { query } : {}),
          ...(thread ? { thread_id: thread.id } : {}),
          before: messages[0]?.sequence,
        },
      );
      oldCount.current += data.messages.length;
      setMessages((old) =>
        [
          ...new Map([...data.messages, ...old].map((m) => [m.id, m])).values(),
        ].sort((a, b) => a.sequence - b.sequence),
      );
      setMore(data.more);
      requestAnimationFrame(() => {
        if (scroll.current)
          scroll.current.scrollTop += scroll.current.scrollHeight - oldHeight;
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  const visible = messages.filter(
    (m) => !query || m.body.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className={`conversation ${thread ? "thread-conversation" : ""}`}>
      <div
        className="message-scroll"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current!;
          atBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 70;
          if (atBottom.current) {
            setNewCount(0);
            markVisible();
          }
        }}
      >
        {thread ? (
          <>
            <MessageRow message={thread} context={context} inspect={inspect} />
            <div className="thread-label label">Replies</div>
          </>
        ) : null}
        {more ? (
          <button
            className="history button compact"
            onClick={earlier}
            disabled={loading}
          >
            {loading ? "Loading…" : "Load earlier messages"}
          </button>
        ) : null}
        {visible.map((m, index) => {
          const previous = visible[index - 1];
          const sameDay =
            previous &&
            new Date(previous.createdAt).toDateString() ===
              new Date(m.createdAt).toDateString();
          const grouped =
            !query &&
            sameDay &&
            m.kind === "message" &&
            previous.kind === "message" &&
            !m.removed &&
            !previous.removed &&
            !m.editedAt &&
            !previous.editedAt &&
            m.authorId === previous.authorId &&
            m.audience === previous.audience &&
            m.createdAt - previous.createdAt >= 0 &&
            m.createdAt - previous.createdAt < 300000;
          return (
            <Fragment key={m.id}>
              {!sameDay ? (
                <div className="day-divider">
                  <time dateTime={new Date(m.createdAt).toISOString()}>
                    {new Date(m.createdAt).toLocaleDateString([], {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </time>
                </div>
              ) : null}
              <MessageRow
                message={m}
                context={context}
                inspect={inspect}
                grouped={!!grouped}
              />
            </Fragment>
          );
        })}
        {!visible.length ? (
          <Empty
            title={
              query
                ? "No matching messages"
                : context.mission.archived
                  ? "No messages in this archived conversation"
                  : thread
                    ? "No replies yet"
                    : "Start the conversation"
            }
          >
            {query
              ? "Try another phrase. Search includes the full conversation history."
              : context.mission.archived
                ? "Restore the channel to continue the conversation."
                : thread
                  ? "Reply below."
                  : privateId
                    ? "Send a private instruction or question. Replies will stay in this conversation."
                    : "Write an instruction or invite your agents. Work can begin in Main without tasks."}
          </Empty>
        ) : null}
      </div>
      {newCount ? (
        <button
          className="new-messages"
          onClick={() => {
            scroll.current?.scrollTo({
              top: scroll.current.scrollHeight,
              behavior: "smooth",
            });
            setNewCount(0);
          }}
        >
          {newCount} new messages ↓
        </button>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {context.mission.archived ? (
        <p className="archived-composer">
          This channel is archived. Messages and replies are read-only.
        </p>
      ) : (
        <Composer
          context={context}
          streamId={streamId}
          refresh={refresh}
          recipient={recipient}
          setRecipient={setRecipient}
          thread={thread}
          directAgentId={privateId || undefined}
        />
      )}
    </div>
  );
}
function labelFor(context: Context, id: string) {
  const records: any[] = [
    ...context.messages,
    ...context.tasks,
    ...context.workstreams,
    ...context.requests,
  ];
  const r = records.find((r) => r.id === id);
  return r?.title || r?.name || r?.body?.slice(0, 65) || r?.capabilities || id;
}
export function MessageRow({
  message: m,
  context,
  inspect,
  grouped = false,
}: {
  message: Message;
  context: Context;
  inspect: (id: string) => void;
  grouped?: boolean;
}) {
  const [copyState, setCopyState] = useState("");
  useEffect(() => {
    if (!copyState) return;
    const timer = setTimeout(() => setCopyState(""), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);
  const author = context.agents.find((a) => a.id === m.authorId);
  const detailed =
    m.body.length > 600 || (m.body.match(/\n/g)?.length || 0) > 8;
  const who = m.authorId === "human" ? "You" : author?.name || "Agent";
  const audience =
    m.addressedAgentId &&
    context.agents.some((a) => a.id === m.addressedAgentId)
      ? context.agents.find((a) => a.id === m.addressedAgentId)!.name
      : m.audience === "coordinator"
        ? "Coordinator"
        : m.audience === "human"
          ? "Human"
          : context.agents.find((a) => a.id === m.audience)?.name;
  return (
    <article
      className={`message ${m.kind === "system" ? "system-message" : ""} ${grouped ? "message-grouped" : ""} ${m.authorId === "human" && m.audience !== "everyone" && !m.directAgentId ? "addressed-message" : ""}`}
      data-message-id={m.id}
      aria-label={`${who}, ${new Date(m.createdAt).toLocaleString()}`}
    >
      <div className="message-avatar">
        {grouped ? (
          <Time at={m.createdAt} />
        ) : m.kind === "system" ? (
          <i className="square muted" />
        ) : (
          <Runtime runtime={author?.runtime} />
        )}
      </div>
      <div className="message-content">
        {m.kind !== "system" && !grouped ? (
          <div className="message-meta">
            <strong>{who}</strong>
            {author?.role === "coordinator" ? (
              <span className="role-name accent">Coordinator</span>
            ) : null}
            <Time at={m.createdAt} />
            {m.directAgentId ? (
              <span className="message-privacy">
                <Lock size={10} />
                Private
              </span>
            ) : audience ? (
              <span className="audience">@{audience}</span>
            ) : null}
            {m.kind !== "message" ? (
              <Badge
                tone={
                  m.kind === "finding"
                    ? "progress"
                    : m.kind === "question"
                      ? "warning"
                      : "accent"
                }
              >
                {m.kind}
              </Badge>
            ) : null}
            {m.editedAt ? <span className="muted mono">edited</span> : null}
          </div>
        ) : null}
        <Text value={m.body} />
        {m.refs.length ? (
          <div className="references">
            {m.refs.map((id) => (
              <button key={id} onClick={() => inspect(id)} title={id}>
                <Link2 size={11} />
                <span>{labelFor(context, id)}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="message-actions">
          <button
            onClick={() => inspect(m.id)}
            className="reply-button"
            title="Open thread"
          >
            <MessageSquare size={12} />
            {m.threadId
              ? "Open reply"
              : context.mission.archived
                ? "View thread"
                : "Reply in thread"}
          </button>
          <button
            className="icon"
            type="button"
            aria-label={copyState || "Copy message"}
            title={copyState || "Copy message as Markdown"}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(m.body);
                setCopyState("Copied");
              } catch {
                setCopyState("Could not copy");
              }
            }}
          >
            {copyState === "Copied" ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <span className="sr-only" role="status">
            {copyState}
          </span>
          <button
            className="icon"
            type="button"
            title="Copy link to message"
            aria-label="Copy link to message"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(messageLink(m));
                setCopyState("Link copied");
              } catch {
                setCopyState("Could not copy");
              }
            }}
          >
            <Link2 size={14} />
          </button>
        </div>
        {m.kind === "system" || detailed ? (
          <div className="message-bottom">
            {m.kind === "system" ? (
              <Time at={m.createdAt} />
            ) : (
              <button onClick={() => inspect(m.id)} className="reply-button">
                <MessageSquare size={12} />
                {m.threadId
                  ? "Open reply"
                  : context.mission.archived
                    ? "View thread"
                    : "Reply in thread"}
              </button>
            )}
          </div>
        ) : null}
      </div>
    </article>
  );
}
function Composer({
  context,
  streamId,
  refresh,
  recipient,
  setRecipient,
  thread,
  directAgentId,
}: {
  context: Context;
  streamId: string;
  refresh: () => Promise<void>;
  recipient?: string;
  setRecipient?: (id: string) => void;
  thread?: Message;
  directAgentId?: string;
}) {
  const draftKey = `harakiri:draft:${context.mission.id}:${directAgentId || streamId}:${thread?.id || "main"}`;
  const [body, setBody] = useState(() => {
      try {
        return sessionStorage.getItem(draftKey) || "";
      } catch {
        return "";
      }
    }),
    [localRecipient, setLocalRecipient] = useState(
      thread?.authorId === "human"
        ? thread.audience || "everyone"
        : thread?.authorId || "everyone",
    ),
    [kind, setKind] = useState("message"),
    [preview, setPreview] = useState(false),
    [ref, setRef] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const audience = recipient ?? localRecipient;
  const setAudience = setRecipient || setLocalRecipient;
  const privateAgent = context.agents.find((a) => a.id === directAgentId);
  const streamName =
    context.workstreams.find((w) => w.id === streamId)?.name || "Main";
  const audienceName =
    audience === "coordinator"
      ? context.agents.find((a) => a.id === context.mission.coordinatorId)
          ?.name || "Coordinator"
      : context.agents.find((a) => a.id === audience)?.name || audience;
  useEffect(() => {
    try {
      body
        ? sessionStorage.setItem(draftKey, body)
        : sessionStorage.removeItem(draftKey);
    } catch {
      /* Drafts remain usable when storage is disabled. */
    }
  }, [body, draftKey]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setError("");
    try {
      await rpc("message_post", {
        channel_id: context.mission.id,
        ...(directAgentId
          ? { direct_agent_id: directAgentId }
          : { stream_id: streamId }),
        thread_id: thread?.id,
        body,
        audience: directAgentId || audience,
        kind,
        refs: ref ? [ref] : [],
      });
      setBody("");
      try {
        sessionStorage.removeItem(draftKey);
      } catch {
        /* Optional draft storage. */
      }
      setPreview(false);
      setRef("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="composer"
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.currentTarget.requestSubmit();
        }
      }}
    >
      <div className="composer-destination">
        {directAgentId ? <Lock size={12} /> : <Hash size={13} />}
        <span>
          {directAgentId ? (
            <>
              <strong>Private · {privateAgent?.name || "Agent"}</strong>
              <span>Only you and this agent</span>
            </>
          ) : (
            <>
              <strong>
                In #{streamName}
                {audience !== "everyone" ? ` → @${audienceName}` : ""}
              </strong>
              <span>Visible to everyone in this mission</span>
            </>
          )}
        </span>
      </div>
      <div className="composer-formatting">
        <span>Markdown supported</span>
        <button
          type="button"
          className="text-button"
          aria-pressed={preview}
          disabled={!body.trim()}
          onClick={() => setPreview(!preview)}
        >
          {preview ? <Pencil size={13} /> : <Eye size={13} />}
          {preview ? "Write" : "Preview"}
        </button>
      </div>
      <textarea
        id={thread ? undefined : "channel-composer"}
        aria-label={
          directAgentId
            ? `Private message to ${privateAgent?.name || "agent"}`
            : thread
              ? "Reply to thread"
              : "Message to channel"
        }
        rows={2}
        hidden={preview}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={
          directAgentId
            ? `Message ${privateAgent?.name || "agent"} privately…`
            : thread
              ? "Reply to this thread…"
              : audience === "coordinator"
                ? "Message the coordinator…"
                : audience === "everyone"
                  ? "Message this workstream…"
                  : `Message ${context.agents.find((a) => a.id === audience)?.name || "the human"}…`
        }
      />
      {preview ? (
        <div className="composer-preview" aria-label="Message preview">
          <Text value={body} />
        </div>
      ) : null}
      <div className="composer-controls">
        {!directAgentId ? (
          <label>
            Address
            <select
              aria-label="Message recipient"
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
            >
              <option value="everyone">Everyone</option>
              {context.mission.coordinatorId ? (
                <option value="coordinator">Coordinator</option>
              ) : null}
              <option value="human">Human</option>
              {context.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <select
          aria-label="Message type"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          {["message", "finding", "question", "decision"].map((k) => (
            <option key={k} value={k}>
              {k[0].toUpperCase() + k.slice(1)}
            </option>
          ))}
        </select>
        <select
          aria-label="Reference a record"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
        >
          <option value="">↗ Reference</option>
          {[
            ...context.tasks,
            ...context.messages.filter((m) => m.kind !== "system").slice(-20),
            ...context.workstreams,
          ].map((r) => (
            <option key={r.id} value={r.id}>
              {labelFor(context, r.id)}
            </option>
          ))}
        </select>
        <span className="composer-key mono">⌘ ↵</span>
        <button className="button primary send" disabled={busy || !body.trim()}>
          {busy ? "Sending…" : "Send"}
          <ArrowUp size={13} />
        </button>
      </div>
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
    </form>
  );
}
