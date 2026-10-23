import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Compass,
  Cpu,
  FileText,
  Hash,
  Home,
  Inbox,
  Link2,
  Menu,
  Moon,
  Plus,
  Search,
  ShieldCheck,
  Square,
  Sun,
  Users,
} from "lucide-react";
import { CreateMission, CoordinatorSetup } from "./CreateMission";
import { JoinMission } from "./JoinMission";
import { ArtifactPreview, ArtifactReview, Mission } from "./Mission";
import {
  initialAgents,
  agentChannel,
  initialMessages,
  festival,
  timeNow,
  type Agent,
  type Brief,
  type Message,
  type Phase,
  type Runtime,
} from "./model";
import {
  Avatar,
  Button,
  Details,
  IconButton,
  Modal,
  PageTitle,
  Tag,
} from "./ui";

function useRoute() {
  const [route, setRoute] = useState(
    () => location.hash.slice(1) || "mission/main",
  );
  useEffect(() => {
    const change = () => setRoute(location.hash.slice(1) || "mission/main");
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  return [
    route,
    (value: string) => {
      location.hash = value;
    },
  ] as const;
}
function readDrafts(): Record<string, string> {
  try {
    const data = JSON.parse(
      sessionStorage.getItem("harakiri.experience-preview.drafts.v1") || "{}",
    );
    return Object.fromEntries(
      Object.entries(data).filter(
        ([, v]) => typeof v === "string" && v.length <= 16000,
      ),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}
export function App() {
  const [route, go] = useRoute(),
    [brief, setBrief] = useState<Brief>(festival),
    [phase, setPhase] = useState<Phase>("active");
  const [created, setCreated] = useState(false),
    [empty, setEmpty] = useState(false),
    [owner, setOwner] = useState(true);
  const [agents, setAgents] = useState<Agent[]>(initialAgents),
    [messages, setMessages] = useState<Message[]>(initialMessages);
  const [drafts, setDrafts] = useState(readDrafts),
    [accepted, setAccepted] = useState(false),
    [delayed, setDelayed] = useState(false);
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("harakiri.experience-preview.theme") ===
        "dark"
        ? "dark"
        : "light";
    } catch {
      return "light";
    }
  });
  const [navOpen, setNavOpen] = useState(false),
    [searchOpen, setSearchOpen] = useState(false),
    [query, setQuery] = useState("");
  const [review, setReview] = useState(false),
    [invite, setInvite] = useState(false),
    [recovery, setRecovery] = useState<Agent | null>(null),
    [finish, setFinish] = useState(false);
  const [toast, setToast] = useState(""),
    [storageError, setStorageError] = useState("");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const scrollPositions = useRef<Record<string, number>>({});
  const [journeyVersion, setJourneyVersion] = useState(0);
  const [openedJourneys, setOpenedJourneys] = useState<string[]>([]);
  useEffect(() => {
    if (["create", "join", "setup"].includes(route)) {
      setOpenedJourneys((paths) =>
        paths.includes(route) ? paths : [...paths, route],
      );
    }
  }, [route]);
  const localAgents = empty ? [] : agents.filter((a) => a.owner === "You");
  const running = localAgents.filter((a) => a.state === "working").length;
  const dmAnswered = messages.some(
    (m) => m.author === "You" && m.channel === "dm-robin",
  );
  const needs =
    created || empty ? 0 : (accepted ? 0 : 1) + (dmAnswered ? 0 : 1);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem(
        "harakiri.experience-preview.drafts.v1",
        JSON.stringify(drafts),
      );
      setStorageError("");
    } catch {
      setStorageError(
        "This browser could not save your draft. Keep this page open.",
      );
    }
  }, [drafts]);
  useEffect(() => {
    try {
      localStorage.setItem("harakiri.experience-preview.theme", theme);
    } catch {
      /* The selected theme still applies for this session. */
    }
  }, [theme]);
  function navigate(path: string) {
    setNavOpen(false);
    go(path);
  }
  function notify(text: string) {
    setToast(text);
    timers.current.push(setTimeout(() => setToast(""), 4000));
  }
  function send(text: string, channel: string) {
    setMessages((ms) => [
      ...ms,
      {
        id: crypto.randomUUID(),
        author: "You",
        role: "Human",
        time: timeNow(),
        text: text.trim(),
        channel,
      },
    ]);
  }
  function reset(scenario: string) {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setToast("");
    scrollPositions.current = {};
    setJourneyVersion((v) => v + 1);
    setOpenedJourneys([scenario]);
    setReview(false);
    setInvite(false);
    setRecovery(null);
    setFinish(false);
    setCreated(false);
    setBrief(festival);
    setMessages(initialMessages);
    setAgents(initialAgents);
    setPhase("active");
    setAccepted(false);
    setDelayed(scenario === "delayed");
    setEmpty(scenario === "fresh" || scenario === "join");
    setOwner(scenario !== "join");
    if (scenario === "recover")
      setAgents(
        initialAgents.map((a) =>
          a.id === "builder"
            ? {
                ...a,
                state: "stopped",
                activity: "Stopped unexpectedly. Source and session saved.",
              }
            : a,
        ),
      );
    navigate(
      (
        {
          create: "create",
          join: "join",
          recover: "agents",
          fresh: "home",
          home: "home",
        } as Record<string, string>
      )[scenario] || "mission/main",
    );
  }
  function create(value: Brief) {
    setOpenedJourneys([]);
    setJourneyVersion((v) => v + 1);
    setDrafts({});
    scrollPositions.current = {};
    setBrief(value);
    setPhase("preparing");
    setCreated(true);
    setEmpty(false);
    setOwner(true);
    setAgents([]);
    setMessages([
      {
        id: crypto.randomUUID(),
        author: "You",
        role: "Human",
        time: timeNow(),
        channel: "main",
        text: value.goal,
      },
    ]);
    navigate("mission/main");
    notify("Mission created in this preview. Set up your Coordinator next.");
  }
  function start(runtime: Runtime) {
    setAgents([
      {
        ...initialAgents[0],
        runtime,
        activity: "Preparing the first useful draft",
      },
    ]);
    setMessages((ms) => [
      ...ms,
      {
        id: crypto.randomUUID(),
        author: "Robin",
        role: "Coordinator",
        time: timeNow(),
        channel: "main",
        text: "The plan is approved. I’ll share the first version here, check it against the brief, and ask when a decision needs your input.",
      },
    ]);
    setPhase("active");
    navigate("mission/main");
  }
  function stop(agent: Agent) {
    setAgents((xs) =>
      xs.map((a) =>
        a.id === agent.id
          ? {
              ...a,
              state: "stopping",
              activity: "Waiting for this Mac to confirm the stop",
            }
          : a,
      ),
    );
    timers.current.push(
      setTimeout(() => {
        setAgents((xs) =>
          xs.map((a) =>
            a.id === agent.id
              ? {
                  ...a,
                  state: "stopped",
                  activity: "Stopped by you. Saved work is available.",
                }
              : a,
          ),
        );
      }, 700),
    );
  }
  function joined(
    runtime: Runtime,
    count: number,
    minutes: number,
    internet: boolean,
  ) {
    setOwner(false);
    setEmpty(false);
    setCreated(false);
    setBrief(festival);
    setMessages(
      initialMessages.map((message) =>
        message.author === "You" ? { ...message, author: "Sam" } : message,
      ),
    );
    setAgents([
      ...initialAgents.map((agent) => ({ ...agent, owner: "Sam" })),
      ...Array.from({ length: count }, (_, i): Agent => ({
        id: `your-${i}`,
        name: `Your agent ${i + 1}`,
        role: "Agent",
        owner: "You",
        runtime,
        permission: { minutes, turns: 12, internet },
        state: "working",
        activity: "Reviewing the family timetable",
      })),
    ]);
    navigate("mission/main");
    notify("Contribution started in the preview. Control it from My agents.");
  }
  const searchItems = [
    ...(!empty
      ? [
          {
            title: brief.name,
            meta: "Mission · Main",
            action: () => navigate("mission/main"),
          },
        ]
      : []),
    ...(!empty && !created
      ? [
          {
            title: "Family timetable",
            meta: "Artifact · version 3",
            action: () => setReview(true),
          },
        ]
      : []),
    ...(!empty
      ? agents.map((a) => ({
          title: a.name,
          meta: `${a.role} · private message`,
          action: () => navigate(`mission/${agentChannel(a)}`),
        }))
      : []),
    {
      title: "My agents",
      meta: "Control contributions on this Mac",
      action: () => navigate("agents"),
    },
    {
      title: "Create a mission",
      meta: "Start with an idea",
      action: () => navigate("create"),
    },
  ].filter((item) =>
    `${item.title} ${item.meta}`.toLowerCase().includes(query.toLowerCase()),
  );
  if (route === "preview") return <ArtifactPreview />;
  const isMission = route.startsWith("mission/") || route === "setup";
  const nav = (
    path: string,
    label: string,
    icon: ReactNode,
    badge?: number,
  ) => (
    <button
      className={`v-nav-item ${route === path ? "selected" : ""}`}
      onClick={() => navigate(path)}
      aria-current={route === path ? "page" : undefined}
    >
      {icon}
      <span>{label}</span>
      {badge ? <b>{badge}</b> : null}
    </button>
  );
  return (
    <div className="v-app" data-theme={theme}>
      <div className="v-prototype-bar">
        <span>
          <b>EXPERIENCE PREVIEW</b>
          <span>Sample data · no agents run</span>
        </span>
        <label>
          Try a journey
          <select
            aria-label="Preview journey"
            defaultValue="collaboration"
            onChange={(e) => reset(e.target.value)}
          >
            <option value="collaboration">Collaborate</option>
            <option value="create">Create a mission</option>
            <option value="join">Join & contribute</option>
            <option value="recover">Recover an agent</option>
            <option value="fresh">First launch</option>
            <option value="delayed">Delayed connection</option>
          </select>
        </label>
      </div>
      <div className="v-shell">
        {navOpen ? (
          <button
            className="v-nav-scrim"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
          />
        ) : null}
        <aside
          className={`v-sidebar ${navOpen ? "open" : ""}`}
          aria-label="Workspace navigation"
        >
          <a className="v-brand" href="#home">
            <span className="v-brand-symbol" aria-hidden="true">
              <i />
            </span>
            <span>
              HARA<span className="v-slash">/</span>KIRI
            </span>
          </a>
          <div className="v-workspace-name">
            <span>Your workspace</span>
            <span className="v-avatar small">Y</span>
          </div>
          <nav aria-label="Main navigation">
            {nav("home", "Home", <Home size={18} />)}
            {nav("inbox", "Inbox", <Inbox size={18} />, needs)}
            {nav("agents", "My agents", <Cpu size={18} />)}
            {nav("browse", "Discover", <Compass size={18} />)}
          </nav>
          <div className="v-nav-section">
            <div className="v-nav-label">
              <span>MISSIONS</span>
              <IconButton
                label="Create a mission"
                onClick={() => navigate("create")}
              >
                <Plus size={16} />
              </IconButton>
            </div>
            {!empty ? (
              <>
                <button
                  className={`v-mission-nav ${isMission ? "selected" : ""}`}
                  onClick={() => navigate("mission/main")}
                >
                  <span className="v-mission-mark">
                    {brief.name.slice(0, 1)}
                  </span>
                  <span>{brief.name}</span>
                  <ChevronDown size={15} />
                </button>
                {isMission ? (
                  <div className="v-channel-nav">
                    {nav("mission/main", "Main", <Hash size={17} />)}
                    {!created ? (
                      <>
                        {nav(
                          "mission/programme",
                          "Programme",
                          <Hash size={17} />,
                        )}
                        {nav(
                          "mission/experience",
                          "Family experience",
                          <Hash size={17} />,
                        )}
                      </>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="v-sidebar-help">
                Your first mission will appear here.
              </p>
            )}
          </div>
          {isMission && !empty && agents.length ? (
            <div className="v-nav-section">
              <div className="v-nav-label">
                <span>DIRECT MESSAGES</span>
              </div>
              {agents.map((agent) => (
                <div key={agent.id}>
                  {nav(
                    `mission/${agentChannel(agent)}`,
                    agent.name,
                    <Avatar
                      name={agent.name}
                      coordinator={agent.role === "Coordinator"}
                      small
                    />,
                  )}
                </div>
              ))}
            </div>
          ) : null}
          <div className="v-sidebar-bottom">
            <button
              className="v-local-status"
              onClick={() => navigate("agents")}
            >
              <span className={running ? "v-dot green" : "v-dot"} />
              <span>
                {running
                  ? `${running} ${running === 1 ? "agent" : "agents"} working here`
                  : "Your Mac is available"}
              </span>
              <ArrowRight size={14} />
            </button>
            <div>
              <Button quiet onClick={() => navigate("join")}>
                <Link2 size={16} />
                Join a mission
              </Button>
              <IconButton
                label={
                  theme === "light"
                    ? "Use dark appearance"
                    : "Use light appearance"
                }
                onClick={() =>
                  setTheme((t) => (t === "light" ? "dark" : "light"))
                }
              >
                {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
              </IconButton>
            </div>
          </div>
        </aside>
        <div className="v-body">
          <header className="v-topbar">
            <IconButton
              label="Toggle navigation"
              className="v-menu-trigger"
              onClick={() => setNavOpen(!navOpen)}
            >
              <Menu size={19} />
            </IconButton>
            <div className="v-history">
              <IconButton label="Go back" onClick={() => history.back()}>
                <ArrowLeft size={17} />
              </IconButton>
              <IconButton label="Go forward" onClick={() => history.forward()}>
                <ArrowRight size={17} />
              </IconButton>
            </div>
            <button
              className="v-search-trigger"
              onClick={() => setSearchOpen(true)}
            >
              <Search size={16} />
              <span>Search your workspace</span>
              <kbd>⌘ K</kbd>
            </button>
            <span className="v-desktop-label">BLACKBOARD</span>
          </header>
          <main id="v-main">
            {isMission && route !== "setup" ? (
              <Mission
                route={route}
                navigate={navigate}
                brief={brief}
                phase={phase}
                agents={agents}
                messages={messages}
                scrollPositions={scrollPositions.current}
                send={send}
                drafts={drafts}
                draft={(key, value) =>
                  setDrafts((d) => ({ ...d, [key]: value }))
                }
                pause={() => {
                  setPhase((p) => (p === "paused" ? "active" : "paused"));
                  notify(
                    phase === "paused"
                      ? "Mission resumed in the preview."
                      : "Mission paused in the preview.",
                  );
                }}
                review={() => setReview(true)}
                invite={() => setInvite(true)}
                accepted={accepted}
                created={created}
                delayed={delayed}
                owner={owner}
                changeBrief={(value) => {
                  setBrief(value);
                  setPhase("paused");
                  notify("Brief updated. Contributions need renewed approval.");
                }}
              />
            ) : null}
            {route === "setup" || openedJourneys.includes("setup") ? (
              <div
                className="v-retained-journey"
                hidden={route !== "setup"}
                key={`setup-${journeyVersion}`}
              >
                <CoordinatorSetup brief={brief} start={start} />
              </div>
            ) : null}
            {route === "create" || openedJourneys.includes("create") ? (
              <div
                className="v-retained-journey"
                hidden={route !== "create"}
                key={`create-${journeyVersion}`}
              >
                <CreateMission
                  create={create}
                  cancel={() => navigate("home")}
                />
              </div>
            ) : null}
            {route === "join" || openedJourneys.includes("join") ? (
              <div
                className="v-retained-journey"
                hidden={route !== "join"}
                key={`join-${journeyVersion}`}
              >
                <JoinMission joined={joined} />
              </div>
            ) : null}
            {route === "home" ? (
              <HomeScreen
                empty={empty}
                created={created}
                owner={owner}
                brief={brief}
                phase={phase}
                needs={needs}
                accepted={accepted}
                navigate={navigate}
                review={() => setReview(true)}
              />
            ) : null}
            {route === "inbox" ? (
              <InboxScreen
                empty={empty || created}
                accepted={accepted}
                answered={dmAnswered}
                review={() => setReview(true)}
                navigate={navigate}
              />
            ) : null}
            {route === "agents" ? (
              <AgentsScreen
                agents={empty ? [] : localAgents}
                brief={brief}
                stop={stop}
                recover={setRecovery}
                navigate={navigate}
              />
            ) : null}
            {route === "browse" ? <Discover navigate={navigate} /> : null}
          </main>
          {storageError ? (
            <p className="v-storage-error" role="alert">
              {storageError}
            </p>
          ) : null}
        </div>
      </div>
      {toast ? (
        <div className="v-toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      ) : null}
      {review ? (
        <Modal title="Review the result" close={() => setReview(false)}>
          <ArtifactReview
            accepted={accepted}
            owner={owner}
            accept={() => {
              setAccepted(true);
              setReview(false);
              send(
                "I reviewed and accepted Family timetable, version 3. The real-family usability check remains a known limitation.",
                "main",
              );
              notify(
                "Version 3 accepted. You decide when the mission is finished.",
              );
            }}
            request={(text) => {
              send(text, "dm-robin");
              setReview(false);
              navigate("mission/dm-robin");
            }}
          />
          {accepted && owner && phase !== "closed" ? (
            <Button
              onClick={() => {
                setReview(false);
                setFinish(true);
              }}
            >
              Finish this mission
              <ArrowRight size={16} />
            </Button>
          ) : null}
        </Modal>
      ) : null}
      {finish ? (
        <Modal title="Finish the mission" close={() => setFinish(false)}>
          <p>
            The accepted work and conversations will stay available.
            Contributors will see that the mission is closed.
          </p>
          <p>
            Closing the mission is your decision; a completed review does not
            close it automatically.
          </p>
          <Button
            primary
            onClick={() => {
              setPhase("closed");
              setFinish(false);
              navigate("mission/main");
              notify("Mission closed in the preview.");
            }}
          >
            Close mission
          </Button>
        </Modal>
      ) : null}
      {invite ? (
        <Modal
          title="Bring someone into the mission"
          close={() => setInvite(false)}
        >
          <p>
            Share the invitation. They’ll inspect the brief and choose what to
            contribute from their own computer.
          </p>
          <label className="v-field">
            Sample invitation
            <input readOnly value="harakiri://preview/little-explorers" />
          </label>
          <Button
            primary
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(
                  "harakiri://preview/little-explorers",
                );
                notify(
                  "Sample invitation copied. It cannot join a real mission.",
                );
              } catch {
                notify(
                  "Copy is unavailable. Select and copy the sample invitation above.",
                );
              }
            }}
          >
            Copy sample invitation
            <Link2 size={16} />
          </Button>
          <p className="v-help">
            Owner approval is required. Joining never starts an agent.
          </p>
        </Modal>
      ) : null}
      {recovery ? (
        <Modal
          title={`Resume ${recovery.name}`}
          close={() => setRecovery(null)}
        >
          <Recovery
            agent={recovery}
            resume={() => {
              setAgents((as) =>
                as.map((a) =>
                  a.id === recovery.id
                    ? {
                        ...a,
                        state: "working",
                        activity: "Resuming saved work",
                      }
                    : a,
                ),
              );
              setRecovery(null);
              notify("Agent resumed in the preview.");
            }}
          />
        </Modal>
      ) : null}
      {searchOpen ? (
        <Modal title="Jump to something" close={() => setSearchOpen(false)}>
          <input
            data-autofocus
            className="v-command-input"
            aria-label="Search workspace"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Mission, message, person, or artifact…"
          />
          <div className="v-command-results">
            {!searchItems.length ? (
              <p className="v-help">No matching items in this workspace.</p>
            ) : null}
            {searchItems.map((r) => (
              <button
                key={r.title}
                onClick={() => {
                  setSearchOpen(false);
                  r.action();
                }}
              >
                <span>
                  <strong>{r.title}</strong>
                  <small>{r.meta}</small>
                </span>
                <ArrowRight size={17} />
              </button>
            ))}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function HomeScreen({
  empty,
  created,
  owner,
  brief,
  phase,
  needs,
  accepted,
  navigate,
  review,
}: {
  empty: boolean;
  created: boolean;
  owner: boolean;
  brief: Brief;
  phase: Phase;
  needs: number;
  accepted: boolean;
  navigate: (s: string) => void;
  review: () => void;
}) {
  return (
    <div className="v-page v-home">
      <PageTitle
        eyebrow="YOUR WORKSPACE"
        title={
          empty
            ? "What will you work on together?"
            : "Pick up where you left off."
        }
        description={
          empty
            ? "Start a mission, or bring an agent to someone else’s."
            : "Your missions, the latest work, and the decisions that need you."
        }
        action={
          !empty ? (
            <Button primary onClick={() => navigate("create")}>
              <Plus size={16} />
              New mission
            </Button>
          ) : undefined
        }
      />
      {empty ? (
        <div className="v-start-choices">
          <button onClick={() => navigate("create")}>
            <Plus size={24} />
            <h2>Start a mission</h2>
            <p>Turn an idea into a clear brief. Build your team around it.</p>
            <span>
              Create a mission
              <ArrowRight size={18} />
            </span>
          </button>
          <button onClick={() => navigate("join")}>
            <Users size={24} />
            <h2>Join a mission</h2>
            <p>Bring your agent, your judgment, and the time you choose.</p>
            <span>
              Open an invitation
              <ArrowRight size={18} />
            </span>
          </button>
        </div>
      ) : (
        <>
          <div className="v-home-section">
            <div className="v-section-title">
              <h2>Continue working</h2>
              <Button quiet onClick={() => navigate("inbox")}>
                Inbox {needs ? <span className="v-count">{needs}</span> : null}
                <ArrowRight size={16} />
              </Button>
            </div>
            <button
              className="v-mission-card"
              onClick={() => navigate("mission/main")}
            >
              <div className="v-home-mission-mark">
                {brief.name.slice(0, 1)}
              </div>
              <div>
                <Tag tone={phase === "active" ? "progress" : "neutral"}>
                  {phase === "active"
                    ? "In progress"
                    : phase === "closed"
                      ? "Complete"
                      : phase === "paused"
                        ? "Paused"
                        : "Preparing"}
                </Tag>
                <h2>{brief.name}</h2>
                <p>{brief.goal}</p>
                <span>
                  {created && phase === "preparing"
                    ? "Set up a Coordinator to plan with you"
                    : `Coordinator: Robin · ${owner ? "Your mission" : "Hosted by Sam"}`}
                </span>
              </div>
              <ArrowRight size={22} />
            </button>
          </div>
          {!created ? (
            <div className="v-home-section">
              <div className="v-section-title">
                <h2>
                  {accepted ? "Latest result" : "Ready for your attention"}
                </h2>
              </div>
              <button className="v-attention-row" onClick={review}>
                <FileText size={24} />
                <div>
                  <strong>Family timetable, version 3</strong>
                  <p>
                    {accepted
                      ? "Accepted by you. Open the work and its review."
                      : "Robin has checked the revised programme. Your review is the next step."}
                  </p>
                </div>
                <span>
                  {accepted ? "Open" : "Review"}
                  <ArrowRight size={16} />
                </span>
              </button>
            </div>
          ) : (
            <div className="v-home-section">
              <h2>
                {phase === "preparing"
                  ? "Work out the approach together."
                  : "The first version is on its way."}
              </h2>
              <p className="v-help">
                {phase === "preparing"
                  ? "Connect a Coordinator, then review the plan before any implementation starts."
                  : "Follow the conversation for progress and questions."}
              </p>
              <Button
                primary
                onClick={() =>
                  navigate(phase === "preparing" ? "setup" : "mission/main")
                }
              >
                {phase === "preparing" ? "Set up Coordinator" : "Open Main"}
                <ArrowRight size={16} />
              </Button>
            </div>
          )}
          <div className="v-home-footer">
            <span>Have another idea?</span>
            <Button quiet onClick={() => navigate("create")}>
              Create a mission
              <Plus size={16} />
            </Button>
            <Button quiet onClick={() => navigate("join")}>
              Join an invitation
              <Link2 size={16} />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
function InboxScreen({
  empty,
  accepted,
  answered,
  review,
  navigate,
}: {
  empty: boolean;
  accepted: boolean;
  answered: boolean;
  review: () => void;
  navigate: (s: string) => void;
}) {
  const [filter, setFilter] = useState("All");
  const entries = empty
    ? []
    : [
        ...(!accepted
          ? [
              {
                title: "The family timetable is ready for your review",
                meta: "Robin · Little Explorers · Main",
                type: "Decisions",
                action: review,
              },
            ]
          : []),
        ...(!answered
          ? [
              {
                title: "Include a quieter session for smaller groups?",
                meta: "Robin · Private message to you",
                type: "Messages",
                action: () => navigate("mission/dm-robin"),
              },
            ]
          : []),
      ];
  return (
    <div className="v-page v-inbox">
      <PageTitle
        eyebrow="INBOX"
        title="Needs your attention"
        description="Decisions and conversations that need your input."
      />
      <div className="v-segment">
        {["All", "Decisions", "Messages"].map((f) => (
          <button
            key={f}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>
      {entries
        .filter((e) => filter === "All" || e.type === filter)
        .map((e) => (
          <button className="v-inbox-row" key={e.title} onClick={e.action}>
            <Avatar name="Robin" coordinator />
            <span>
              <small>{e.meta}</small>
              <strong>{e.title}</strong>
              <span>
                {e.type === "Decisions"
                  ? "Review the exact work and its evidence"
                  : "Private conversation with Robin · visible to its contributor"}
              </span>
            </span>
            <ArrowRight size={18} />
          </button>
        ))}
      {!entries.filter((e) => filter === "All" || e.type === filter).length ? (
        <div className="v-calm-empty">
          <Check size={28} />
          <h2>You’re clear for now.</h2>
          <p>The team’s next question or review will appear here.</p>
          <Button onClick={() => navigate("mission/main")}>
            Back to the conversation
          </Button>
        </div>
      ) : null}
    </div>
  );
}
function AgentsScreen({
  agents,
  brief,
  stop,
  recover,
  navigate,
}: {
  agents: Agent[];
  brief: Brief;
  stop: (a: Agent) => void;
  recover: (a: Agent) => void;
  navigate: (s: string) => void;
}) {
  return (
    <div className="v-page v-agents">
      <PageTitle
        eyebrow="THIS MAC"
        title="My agents"
        description="Know what you’re contributing, what’s saved, and how to stop."
      />
      {!agents.length ? (
        <div className="v-calm-empty">
          <Cpu size={28} />
          <h2>No agents on a mission yet.</h2>
          <p>
            Choose a mission first. We’ll help you connect an agent when it’s
            needed.
          </p>
          <Button primary onClick={() => navigate("home")}>
            Choose a mission
            <ArrowRight size={16} />
          </Button>
        </div>
      ) : (
        <>
          <div className="v-section-title">
            <h2>{brief.name}</h2>
            <Button quiet onClick={() => navigate("mission/main")}>
              Open mission
              <ArrowRight size={16} />
            </Button>
          </div>
          {agents.map((a) => (
            <article className="v-local-agent" key={a.id}>
              <div className="v-agent-topline">
                <Avatar name={a.name} coordinator={a.role === "Coordinator"} />
                <div>
                  <h3>
                    {a.name}
                    <span className="v-role">{a.role}</span>
                  </h3>
                  <span>{a.runtime} · protected workspace</span>
                </div>
                <Tag
                  tone={
                    a.state === "working"
                      ? "progress"
                      : a.state === "stopped"
                        ? "warning"
                        : "neutral"
                  }
                >
                  {a.state === "working"
                    ? "Working"
                    : a.state === "waiting"
                      ? "Waiting for work"
                      : a.state === "stopping"
                        ? "Stopping…"
                        : "Stopped"}
                </Tag>
              </div>
              <p className="v-agent-purpose">{a.activity}</p>
              <div className="v-agent-limits">
                <span>{a.permission?.minutes ?? 30}-minute permission</span>
                <span>
                  Public internet {a.permission?.internet ? "allowed" : "off"}
                </span>
                <span>Source saved</span>
              </div>
              <footer>
                {a.state === "stopped" ? (
                  <Button primary onClick={() => recover(a)}>
                    Review and resume
                    <ArrowRight size={16} />
                  </Button>
                ) : (
                  <Button
                    disabled={a.state === "stopping"}
                    onClick={() => stop(a)}
                  >
                    <Square size={13} />
                    Stop this agent
                  </Button>
                )}
                <Details title="Workspace and technical details">
                  <dl className="v-facts">
                    <div>
                      <dt>Host</dt>
                      <dd>This Mac</dd>
                    </div>
                    <div>
                      <dt>Environment</dt>
                      <dd>Dedicated Lima VM</dd>
                    </div>
                    <div>
                      <dt>Saved source</dt>
                      <dd>24 files · last checkpoint 10:42</dd>
                    </div>
                    <div>
                      <dt>Permissions</dt>
                      <dd>
                        {a.permission?.minutes ?? 30} minutes ·{" "}
                        {a.permission?.turns ?? 6} turns · reviewed mission
                        scope
                      </dd>
                    </div>
                  </dl>
                  <p>
                    Sample observations. The connected version shows actual
                    paths, timestamps, logs and operation receipts here.
                  </p>
                </Details>
              </footer>
            </article>
          ))}
        </>
      )}
    </div>
  );
}
function Recovery({ agent, resume }: { agent: Agent; resume: () => void }) {
  const [checked, setChecked] = useState(false);
  return (
    <div className="v-recovery-flow">
      <div className="v-success-line">
        <ShieldCheck size={23} />
        <div>
          <strong>Your work is saved.</strong>
          <p>The original workspace and runtime session are available.</p>
        </div>
      </div>
      <dl className="v-facts">
        <div>
          <dt>What survived</dt>
          <dd>24 source files and the saved session</dd>
        </div>
        <div>
          <dt>What happens next</dt>
          <dd>Resume {agent.name} with current mission context</dd>
        </div>
      </dl>
      <h3>Renew this Mac’s contribution</h3>
      <div className="v-permission-summary">
        <strong>
          Up to {agent.permission?.minutes ?? 30} minutes ·{" "}
          {agent.permission?.turns ?? 6} turns
        </strong>
        <span>
          Public internet {agent.permission?.internet ? "allowed" : "off"} ·
          existing protected workspace
        </span>
      </div>
      <label className="v-check">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
        />
        <span>I approve this renewed contribution.</span>
      </label>
      <Button primary disabled={!checked} onClick={resume}>
        Resume saved work
        <ArrowRight size={16} />
      </Button>
      <Details title="If the original workspace is missing">
        <p>
          Restore the available source checkpoint into a new workspace. That
          starts a new runtime session; unavailable files, credentials and
          conversation cannot be recovered from the checkpoint.
        </p>
      </Details>
    </div>
  );
}
function Discover({ navigate }: { navigate: (s: string) => void }) {
  const [search, setSearch] = useState("");
  return (
    <div className="v-page v-discover">
      <PageTitle
        eyebrow="DISCOVER"
        title="Find a mission"
        description="Mission briefs received through your discovery network."
      />
      <input
        className="v-discover-search"
        aria-label="Search received missions"
        placeholder="Search received missions…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="v-section-title">
        <span className="v-muted">Sample community · updated just now</span>
        <Button quiet onClick={() => navigate("join")}>
          Have an invitation?
          <Link2 size={16} />
        </Button>
      </div>
      {"Little Explorers science festival"
        .toLowerCase()
        .includes(search.toLowerCase()) ? (
        <article className="v-listing">
          <span className="v-label">EDUCATION · PLANNING · REVIEW</span>
          <h2>Little Explorers</h2>
          <p>
            Help make a two-day science festival that families can actually use.
            Bring an agent to challenge the schedule and improve the public
            guide.
          </p>
          <footer>
            <span>Hosted by Sam · approval required</span>
            <Button primary onClick={() => navigate("join")}>
              Inspect mission
              <ArrowRight size={16} />
            </Button>
          </footer>
        </article>
      ) : (
        <div className="v-calm-empty">
          <Search size={24} />
          <h2>No matching briefs received.</h2>
          <p>Try another search or join from an invitation.</p>
        </div>
      )}
      <Details title="Where these missions come from">
        <p>
          Discovery searches the signed listings your node has received. It is
          not a global index. The real app shows the community peers, listing
          freshness and reachability here.
        </p>
      </Details>
    </div>
  );
}
