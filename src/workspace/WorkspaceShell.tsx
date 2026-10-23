import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Compass,
  Cpu,
  Home,
  Inbox,
  Link2,
  Menu,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
  X,
} from "lucide-react";
import type { LocalState, NodeState } from "../application/contracts/workspace";
import type { MissionView } from "../application/contracts/node";
import { Brand } from "../desktop/ui";
import { IconButton } from "../ui/Button";
import { Disclosure } from "../ui/Disclosure";
import type { WorkspaceView } from "./Workspace";

/** Navigation and appearance only. Authority and execution remain in application ports. */
export function WorkspaceShell({
  state,
  nodeState,
  mission,
  view,
  busy,
  navigate,
  children,
}: {
  state: LocalState;
  nodeState: NodeState | null;
  mission?: MissionView;
  view: WorkspaceView;
  busy: boolean;
  navigate: (view: WorkspaceView) => void;
  children: ReactNode;
}) {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("harakiri.appearance.v2") === "dark"
        ? "dark"
        : "light";
    } catch {
      return "light";
    }
  });
  const [menu, setMenu] = useState(false);
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!menu) return;
    const media = window.matchMedia("(max-width: 760px)");
    if (!media.matches) {
      setMenu(false);
      return;
    }
    const content = document.getElementById("main");
    const wasInert = content?.inert ?? false;
    if (content) content.inert = true;
    const targets = () =>
      [
        menuTrigger.current,
        ...Array.from(
          sidebar.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), summary, a[href], input, select",
          ) ?? [],
        ),
      ].filter(
        (element): element is HTMLElement =>
          !!element && element.checkVisibility(),
      );
    targets()[1]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setMenu(false);
      } else if (event.key === "Tab") {
        const elements = targets();
        const index = elements.indexOf(document.activeElement as HTMLElement);
        event.preventDefault();
        elements[
          (index + (event.shiftKey ? -1 : 1) + elements.length) %
            elements.length
        ]?.focus();
      }
    };
    const resize = () => {
      if (!media.matches) setMenu(false);
    };
    document.addEventListener("keydown", key, true);
    media.addEventListener("change", resize);
    return () => {
      document.removeEventListener("keydown", key, true);
      media.removeEventListener("change", resize);
      if (content) content.inert = wasInert;
      menuTrigger.current?.focus();
    };
  }, [menu]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      localStorage.setItem("harakiri.appearance.v2", theme);
    } catch {
      /* Session preference still works. */
    }
  }, [theme]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setMenu(false);
        setSearch((open) => !open);
      }
      if (event.key === "Escape") setMenu(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (search) dialog.current?.showModal();
    else if (dialog.current?.open) {
      dialog.current.close();
      searchTrigger.current?.focus();
    }
  }, [search]);
  const go = (next: WorkspaceView) => {
    setMenu(false);
    setSearch(false);
    navigate(next);
  };
  const nav = (id: WorkspaceView, label: string, icon: ReactNode) => (
    <button
      type="button"
      onClick={() => go(id)}
      aria-current={
        view === id ||
        (id === "device" && ["connections", "activity"].includes(String(view)))
          ? "page"
          : undefined
      }
    >
      {icon}
      <span>{label}</span>
    </button>
  );
  const channel = (m: MissionView) => (
    <div key={m.id}>
      <button
        type="button"
        className="w-mission-link"
        aria-current={mission?.id === m.id ? "page" : undefined}
        onClick={() => go({ missionId: m.id })}
        title={m.definition.name}
      >
        <span aria-hidden="true">#</span>
        <span>{m.definition.name}</span>
      </button>
      {mission?.id === m.id ? <div id="mission-conversations" /> : null}
    </div>
  );
  const missions = nodeState?.missions ?? [];
  const filtered = missions.filter((m) =>
    `${m.definition.name} ${m.definition.objective}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div className={`w-shell ${menu ? "w-nav-open" : ""}`}>
      <a className="w-skip" href="#main">
        Skip to content
      </a>
      <header className="w-topbar">
        <IconButton
          ref={menuTrigger}
          className="w-menu"
          aria-label="Toggle navigation"
          aria-expanded={menu}
          onClick={() => setMenu((v) => !v)}
        >
          <Menu size={20} />
        </IconButton>
        <Brand />
        <button
          ref={searchTrigger}
          className="w-search-trigger"
          aria-label="Find a mission or action"
          onClick={() => {
            setMenu(false);
            setQuery("");
            setSearch(true);
          }}
        >
          <Search size={16} />
          <span>Find a mission or action</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="w-device" title={state.device.name}>
          <span
            className={`w-connection ${nodeState?.network === "enabled" ? "is-online" : ""}`}
          />
          {nodeState?.network === "enabled" ? "Peers enabled" : "Local"}
        </div>
        <IconButton
          aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}
          onClick={() => setTheme((v) => (v === "light" ? "dark" : "light"))}
        >
          {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
        </IconButton>
        <button
          className="w-avatar"
          onClick={() => go("device")}
          aria-label={`Settings for ${state.contributor.name}`}
        >
          {state.contributor.name.slice(0, 2).toUpperCase()}
        </button>
      </header>
      {menu ? (
        <button
          className="w-nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setMenu(false)}
        />
      ) : null}
      <aside
        ref={sidebar}
        className="w-sidebar"
        aria-label="Workspace navigation"
      >
        <nav aria-label="Your workspace">
          {nav("missions", "Home", <Home size={17} />)}
          {nav("inbox", "Inbox", <Inbox size={17} />)}
          {nav("contributions", "My agents", <Cpu size={17} />)}
          {nav("discover", "Discover", <Compass size={17} />)}
        </nav>
        <div className="w-sidebar-heading">
          <span>Missions</span>
          <IconButton
            aria-label="Create mission"
            disabled={busy || !nodeState}
            onClick={() => go("new-mission")}
          >
            <Plus size={16} />
          </IconButton>
        </div>
        <nav className="w-mission-list" aria-label="Mission channels">
          {missions
            .filter((m) => m.lifecycle.phase !== "archived")
            .map(channel)}
          {!missions.length ? (
            <p className="w-nav-hint">Your shared work starts here.</p>
          ) : null}
          {missions.some((m) => m.lifecycle.phase === "archived") ? (
            <Disclosure
              title="Archived"
              count={
                missions.filter((m) => m.lifecycle.phase === "archived").length
              }
              variant="sidebar"
              open={mission?.lifecycle.phase === "archived" || undefined}
            >
              {missions
                .filter((m) => m.lifecycle.phase === "archived")
                .map(channel)}
            </Disclosure>
          ) : null}
        </nav>
        <nav className="w-sidebar-bottom" aria-label="Device and invitations">
          {nav("join", "Join with an invitation", <Link2 size={17} />)}
          {nav("device", "Settings", <Settings size={17} />)}
        </nav>
        <div className="w-local-note">Your computer. Your control.</div>
      </aside>
      {children}
      <dialog
        className="w-command"
        ref={dialog}
        onCancel={() => setSearch(false)}
        onClose={() => setSearch(false)}
        aria-label="Find a mission or action"
      >
        <header>
          <Search size={18} />
          <input
            aria-label="Find a mission or action"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Mission name…"
            autoFocus
          />
          <IconButton
            aria-label="Close search"
            onClick={() => setSearch(false)}
          >
            <X size={18} />
          </IconButton>
        </header>
        <div className="w-command-results">
          {filtered.map((m) => (
            <button key={m.id} onClick={() => go({ missionId: m.id })}>
              <span># {m.definition.name}</span>
              <small>{m.lifecycle.phase}</small>
            </button>
          ))}
          {query && !filtered.length ? (
            <p>No mission matches “{query}”.</p>
          ) : null}
          {!query ? (
            <>
              <button disabled={busy} onClick={() => go("new-mission")}>
                <Plus size={17} />
                Create a mission
              </button>
              <button onClick={() => go("join")}>
                <Link2 size={17} />
                Join with an invitation
              </button>
            </>
          ) : null}
        </div>
        <footer>Search messages inside a mission’s conversation.</footer>
      </dialog>
    </div>
  );
}
