import { BackgroundSetting } from "./BackgroundSetting";
import { readDrafts, writeDrafts } from "../../shared/desktop-drafts.mjs";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Compass,
  Check,
  ChevronRight,
  CircleHelp,
  History,
  Laptop,
  Layers,
  Link,
  LockKeyhole,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react";
import runtimes from "../../shared/runtimes.json";
import { desktop, node, type LocalState, type NodeState } from "./bridge";
import { Brand, Heading, Status, date, type Perform } from "./ui";
import Prepare from "./Prepare";
import ContributionDetail from "./ContributionDetail";
import {
  MyMissions,
  CreateMission,
  MissionRoom,
  type MissionSession,
} from "./Missions";
import { NetworkSettings, JoinMission } from "./Peers";
import { Discover, DeviceDiscovery } from "./Discovery";
import type { ContributionReview } from "./bridge";
import type { InvitationReview } from "./node-contract";

type View =
  | "discover"
  | "node-contribution"
  | "missions"
  | "new-mission"
  | "join"
  | "contributions"
  | "prepare"
  | "device"
  | "activity"
  | { id: string }
  | { missionId: string; startSetup?: boolean };

export default function Desktop() {
  const [state, setState] = useState<LocalState | null>(null);
  const [view, setView] = useState<View>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("harakiri.last-view.v1") ?? "null",
      );
      if (
        saved &&
        typeof saved.missionId === "string" &&
        /^[a-f0-9]{64}$/.test(saved.missionId)
      )
        return saved;
      if (saved === "new-mission") return saved;
    } catch {
      /* Use mission list if unavailable. */
    }
    return "missions";
  });
  const [nodeState, setNodeState] = useState<NodeState | null>(null);
  const [error, setError] = useState("");
  const [openingNode, setOpeningNode] = useState(false);
  useEffect(() => {
    if (nodeState || error) {
      setOpeningNode(false);
      return;
    }
    const timer = setTimeout(() => setOpeningNode(true), 2000);
    return () => clearTimeout(timer);
  }, [nodeState, error]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [joinReview, setJoinReview] = useState<{
    reference: string;
    review: InvitationReview;
  } | null>(null);
  const [incomingInvitation, setIncomingInvitation] = useState<string | null>(
    null,
  );
  const [contributionReview, setContributionReview] =
    useState<ContributionReview | null>(null);
  const main = useRef<HTMLElement>(null);
  const currentView = useRef(view);
  currentView.current = view;
  const missionScroll = useRef<Record<string, number>>({});
  const latestSessions = useRef<Record<string, MissionSession>>({});
  const [missionSessions, setMissionSessions] = useState<
    Record<string, MissionSession>
  >({});
  useEffect(() => {
    main.current?.scrollTo({
      top:
        typeof view === "object" && "missionId" in view
          ? (missionScroll.current[view.missionId] ?? 0)
          : 0,
    });
  }, [view]);
  useEffect(() => {
    let cancelled = false;
    if (!desktop) {
      setError("Open this page in the Harakiri desktop application.");
      return;
    }
    desktop
      .state()
      .then((value) => {
        if (!cancelled) setState(value);
      })
      .catch((failure: Error) => {
        if (!cancelled) setError(failure.message);
      });
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const invitation = await window.blackboardSetup.takeInvitation();
        if (invitation && !cancelled) {
          setIncomingInvitation(invitation);
          setView("join");
          setNotice("Invitation received. Review it before joining.");
        }
        const value = await node.state();
        const local = await desktop.state();
        const target = await window.blackboardSetup.takeNotification();
        if (!cancelled) {
          setNodeState(value);
          setState(local);
          if (
            target &&
            value.identity &&
            value.missions.some((m) => m.id === target.mission)
          ) {
            const prior = currentView.current;
            if (
              typeof prior === "object" &&
              "missionId" in prior &&
              main.current
            )
              missionScroll.current[prior.missionId] = main.current.scrollTop;
            const key = `${value.identity.owner}:${target.mission}`;
            const saved =
              latestSessions.current[key] ??
              readDrafts(localStorage, value.identity.owner, target.mission);
            const next = { ...saved, feed: "inbox" as const };
            latestSessions.current[key] = next;
            setMissionSessions((all) => ({ ...all, [key]: next }));
            setView({ missionId: target.mission });
          }
        }
      } catch (failure) {
        if (!cancelled)
          setError(
            failure instanceof Error
              ? failure.message
              : "The local node is unavailable.",
          );
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
  const perform: Perform = async (operation) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      return true;
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The operation failed. Please try again.",
      );
      main.current?.scrollTo({ top: 0 });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const navigate = (next: View) => {
    if (typeof view === "object" && "missionId" in view && main.current)
      missionScroll.current[view.missionId] = main.current.scrollTop;
    setView(next);
    try {
      localStorage.setItem("harakiri.last-view.v1", JSON.stringify(next));
    } catch {
      /* Navigation remains available. */
    }
    setError("");
    setNotice("");
  };

  if (!state)
    return (
      <div className="d-starting">
        <Brand />
        <h1>{error ? "Desktop unavailable" : "Opening your desktop…"}</h1>
        <p role={error ? "alert" : "status"}>
          {error || "Loading your local contribution records."}
        </p>
      </div>
    );
  const selected =
    typeof view === "object" && "id" in view
      ? state.contributions.find((item) => item.id === view.id)
      : undefined;
  const selectedMission =
    typeof view === "object" && "missionId" in view
      ? nodeState?.missions.find((item) => item.id === view.missionId)
      : undefined;
  const refreshNode = async () => {
    setNodeState(await node.state());
    setState(await desktop.state());
  };
  const prepared = state.contributions.filter(
    (item) => item.status === "prepared",
  );
  return (
    <div className="d-app">
      <header className="d-topbar">
        <Brand />
        <span className="d-topbar-divider" />
        <span>Blackboard</span>
        <span className="d-preview">Preview</span>
        <div className="d-topbar-right">
          <Laptop size={15} />
          <span>{state.device.name}</span>
          <span className="d-user">{state.contributor.name}</span>
        </div>
      </header>
      <aside className="d-sidebar" aria-label="Desktop navigation">
        <div className="d-sidebar-title">
          <span className="d-label">Your space</span>
          <LockKeyhole size={13} aria-label="Local to this device" />
        </div>
        <nav aria-label="Contributor controls">
          <button
            disabled={busy}
            className={view === "discover" ? "active" : ""}
            onClick={() => navigate("discover")}
          >
            <Compass size={16} />
            Discover
          </button>
          <button
            disabled={busy}
            className={view === "missions" ? "active" : ""}
            onClick={() => navigate("missions")}
          >
            <Layers size={16} />
            My missions
            <span className="d-count">{nodeState?.missions.length ?? 0}</span>
          </button>
          <button
            disabled={busy}
            className={view === "join" ? "active" : ""}
            onClick={() => {
              setJoinReview(null);
              navigate("join");
            }}
          >
            <Link size={16} />
            Join a mission
          </button>
        </nav>
        <div className="d-sidebar-title d-mission-heading">
          <span className="d-label">Mission channels</span>
          <button
            className="d-icon"
            aria-label="Create mission"
            disabled={busy || !nodeState}
            onClick={() => navigate("new-mission")}
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="d-mission-nav">
          {nodeState?.missions
            .filter((m) => m.lifecycle.phase !== "archived")
            .map((mission) => (
              <div key={mission.id}>
                <button
                  className={`n-channel-nav ${selectedMission?.id === mission.id ? "active" : ""}`}
                  disabled={busy}
                  onClick={() => navigate({ missionId: mission.id })}
                >
                  <span className="d-hash">#</span>
                  <span>{mission.definition.name}</span>
                </button>
                {selectedMission?.id === mission.id ? (
                  <div id="mission-conversations" />
                ) : null}
              </div>
            ))}
          {nodeState?.missions.some((m) => m.lifecycle.phase === "archived") ? (
            <details
              className="n-archived"
              open={
                selectedMission?.lifecycle.phase === "archived" || undefined
              }
            >
              <summary>Archived channels</summary>
              {nodeState.missions
                .filter((m) => m.lifecycle.phase === "archived")
                .map((m) => (
                  <div key={m.id}>
                    <button
                      className={`n-channel-nav ${selectedMission?.id === m.id ? "active" : ""}`}
                      onClick={() => navigate({ missionId: m.id })}
                    >
                      <span className="d-hash">#</span>
                      <span>{m.definition.name}</span>
                    </button>
                    {selectedMission?.id === m.id ? (
                      <div id="mission-conversations" />
                    ) : null}
                  </div>
                ))}
            </details>
          ) : null}
          {!nodeState?.missions.length ? <p>No local missions yet.</p> : null}
        </div>
        <nav aria-label="Local settings" className="d-local-nav">
          <button
            disabled={busy}
            className={view === "contributions" ? "active" : ""}
            onClick={() => navigate("contributions")}
          >
            <Layers size={16} />
            Contributions<span className="d-count">{prepared.length}</span>
          </button>
          <button
            disabled={busy}
            className={view === "device" ? "active" : ""}
            onClick={() => navigate("device")}
          >
            <Laptop size={16} />
            This device
          </button>
          <button
            disabled={busy}
            className={view === "activity" ? "active" : ""}
            onClick={() => navigate("activity")}
          >
            <History size={16} />
            Local activity
          </button>
        </nav>
        <div className="d-sidebar-foot">
          <ShieldCheck size={17} />
          <div>
            <strong>Local control</strong>
            <span>You decide what to contribute.</span>
          </div>
        </div>
      </aside>
      <main
        className={`d-main${selectedMission ? " d-main-mission" : ""}`}
        id="main"
        ref={main}
      >
        {!selectedMission ? (
          <div className="d-stage-note">
            <LockKeyhole size={14} />
            <span>
              {nodeState?.network === "enabled"
                ? "Peer networking enabled"
                : "Offline · local workspace"}{" "}
              · Claude Code, Codex and Grok Build run in isolated Lima VMs on
              Apple Silicon.
            </span>
          </div>
        ) : null}
        {error ? (
          <div className="d-alert" role="alert">
            <span>{error}</span>
            <button
              className="d-icon"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
        ) : null}
        {notice ? (
          <div className="d-notice" role="status">
            <Check size={15} />
            {notice}
          </div>
        ) : null}
        {openingNode ? (
          <div className="d-notice" role="status">
            Opening your protected node. If macOS shows a Keychain prompt for
            “Harakiri Desktop”, approve it there to continue. Your saved
            missions remain on this Mac.
          </div>
        ) : null}
        <div className="d-content">
          {view === "missions" ? (
            <MyMissions
              state={nodeState}
              busy={busy}
              create={() => navigate("new-mission")}
              join={() => {
                setJoinReview(null);
                navigate("join");
              }}
              withdraw={(mission) =>
                void perform(async () => {
                  await node.withdrawMission(mission);
                  await refreshNode();
                })
              }
              open={(id) => navigate({ missionId: id })}
            />
          ) : null}
          {view === "discover" ? (
            <Discover
              state={nodeState}
              busy={busy}
              perform={perform}
              updated={refreshNode}
              network={() => navigate("device")}
              review={(reference, review) => {
                setJoinReview({ reference, review });
                navigate("join");
              }}
            />
          ) : null}
          {view === "node-contribution" && contributionReview ? (
            <Prepare
              key={contributionReview.reviewId}
              nodeReview={contributionReview}
              busy={busy}
              perform={perform}
              cancel={() =>
                navigate({ missionId: contributionReview.mission.missionId })
              }
              complete={(value) => {
                setState(value);
                navigate({ missionId: contributionReview.mission.missionId });
                setNotice(
                  "Contribution prepared. Open Members to share your agent with the mission.",
                );
              }}
            />
          ) : null}
          {view === "join" ? (
            <JoinMission
              key={incomingInvitation ?? joinReview?.reference ?? "private"}
              initialTicket={incomingInvitation ?? joinReview?.reference}
              initialReview={joinReview?.review}
              state={nodeState}
              busy={busy}
              perform={perform}
              updated={refreshNode}
              back={() => navigate("missions")}
              open={(missionId, startSetup) =>
                navigate({ missionId, startSetup })
              }
            />
          ) : null}
          {view === "new-mission" ? (
            <CreateMission
              busy={busy}
              enrolled={nodeState?.status === "ready"}
              perform={perform}
              cancel={() => navigate("missions")}
              complete={async (id) => {
                await refreshNode();
                navigate({ missionId: id });
                setNotice("Mission created.");
              }}
            />
          ) : null}
          {selectedMission && nodeState?.identity ? (
            <MissionRoom
              initialSetup={
                typeof view === "object" &&
                "missionId" in view &&
                view.startSetup === true
              }
              error={error}
              readScroll={(audience) =>
                missionScroll.current[`${selectedMission.id}:${audience}`]
              }
              rememberScroll={(audience, top) => {
                missionScroll.current[`${selectedMission.id}:${audience}`] =
                  top;
              }}
              key={selectedMission.id}
              session={
                missionSessions[
                  `${nodeState.identity.owner}:${selectedMission.id}`
                ] ??
                readDrafts(
                  localStorage,
                  nodeState.identity.owner,
                  selectedMission.id,
                )
              }
              updateSession={(change) => {
                const owner = nodeState.identity!.owner;
                const key = `${owner}:${selectedMission.id}`;
                const next = change(
                  latestSessions.current[key] ??
                    missionSessions[key] ??
                    readDrafts(localStorage, owner, selectedMission.id),
                );
                try {
                  writeDrafts(localStorage, owner, selectedMission.id, next);
                } catch (e) {
                  setError(
                    e instanceof Error
                      ? e.message
                      : "Draft could not be saved on this device.",
                  );
                }
                latestSessions.current[key] = next;
                setMissionSessions((all) => ({ ...all, [key]: next }));
              }}
              mission={selectedMission}
              contributions={state.contributions}
              owner={nodeState.identity.owner}
              name={state.contributor.name}
              busy={busy}
              perform={perform}
              updated={refreshNode}
              enabled={nodeState.network === "enabled"}
              network={() => navigate("device")}
              withdrawal={nodeState.withdrawals.find(
                (w) => w.mission === selectedMission.id,
              )}
              prepare={(role) =>
                void perform(async () => {
                  setContributionReview(
                    await node.reviewContribution(selectedMission.id, role),
                  );
                  navigate("node-contribution");
                })
              }
            />
          ) : null}
          {view === "contributions" ? (
            <>
              <Heading
                section="Renting the Rent / Your contributions"
                title="Your contributions"
                action={
                  <button
                    className="d-button primary"
                    disabled={busy}
                    onClick={() => navigate("prepare")}
                  >
                    <Plus size={16} />
                    Prepare contribution
                  </button>
                }
              >
                Bring your agent to a shared mission. Keep control of your
                machine, your account and your time.
              </Heading>
              <section className="d-contributions">
                <header className="d-section-heading">
                  <h2>Contributions</h2>
                  <span className="d-label">
                    {state.contributions.length} saved on this device
                  </span>
                </header>
                {state.contributions.length ? (
                  <div className="d-table">
                    <div className="d-table-head">
                      <span>Mission / board</span>
                      <span>Runtime</span>
                      <span>Local allowance</span>
                      <span>Local consent</span>
                    </div>
                    {state.contributions.map((item) => (
                      <button
                        key={item.id}
                        className="d-contribution-row"
                        onClick={() => navigate({ id: item.id })}
                      >
                        <span className="d-row-name">
                          <strong>{item.mission.name}</strong>
                          <small>{item.mission.origin}</small>
                        </span>
                        <span>{runtimes[item.runtime].label}</span>
                        <span className="d-mono">
                          {item.limits.mode === "unlimited"
                            ? "No turn / time cap"
                            : `${item.limits.turns} turns · ${item.limits.minutes} min`}
                        </span>
                        <span className="d-row-status">
                          <Status muted={item.status === "revoked"}>
                            {item.status === "revoked"
                              ? "Revoked"
                              : "Terms saved"}
                          </Status>
                          <ChevronRight size={15} />
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="d-empty">
                    <div className="d-empty-icon">
                      <Layers size={25} strokeWidth={1.5} />
                    </div>
                    <h3>No contributions yet</h3>
                    <p>
                      Start with a mission invitation. Inspect the board, choose
                      your local terms, and save a contribution.
                    </p>
                    <button
                      className="d-button"
                      onClick={() => navigate("prepare")}
                    >
                      <Link size={15} />
                      Inspect an invitation
                      <ArrowRight size={15} />
                    </button>
                  </div>
                )}
              </section>
              <p className="d-field-help">
                Local consent records your approved terms. Open a contribution
                for live agent activity and controls.
              </p>
            </>
          ) : null}
          {view === "prepare" ? (
            <Prepare
              busy={busy}
              perform={perform}
              cancel={() => navigate("contributions")}
              complete={(next) => {
                setState(next);
                setView({ id: next.contributions[0].id });
                setNotice(
                  "Contribution prepared locally. No agent has been started.",
                );
              }}
            />
          ) : null}
          {selected ? (
            <ContributionDetail
              item={selected}
              openMission={
                nodeState?.missions.some(
                  (m) => m.id === selected.mission.missionId,
                )
                  ? () => navigate({ missionId: selected.mission.missionId })
                  : undefined
              }
              busy={busy}
              perform={perform}
              back={() => navigate("contributions")}
              revoke={async () => {
                setState(await desktop.revoke(selected.id));
                setNotice(
                  "Local consent revoked. The workspace and its files are preserved.",
                );
              }}
            />
          ) : null}
          {view === "device" ? (
            <>
              <Heading
                section="Local ownership / This device"
                title="Your machine. Your authority."
              >
                Your profile and node identity belong to this computer. No
                central account is required.
              </Heading>
              <div className="d-two-columns">
                <section className="d-panel">
                  <header>
                    <h2>Contributor</h2>
                    <Status muted>Local identity</Status>
                  </header>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const name = String(
                        new FormData(event.currentTarget).get("name"),
                      );
                      void perform(async () => {
                        setState(await desktop.rename(name));
                        setNotice("Contributor name saved on this device.");
                      });
                    }}
                  >
                    <label className="d-field">
                      Display name
                      <input
                        name="name"
                        key={state.contributor.name}
                        defaultValue={state.contributor.name}
                        required
                        minLength={1}
                        maxLength={100}
                        autoComplete="off"
                      />
                    </label>
                    <dl className="d-facts">
                      <div>
                        <dt>Contributor ID</dt>
                        <dd className="d-mono">{state.contributor.id}</dd>
                      </div>
                      <div>
                        <dt>Device</dt>
                        <dd>{state.device.name}</dd>
                      </div>
                      <div>
                        <dt>Device ID</dt>
                        <dd className="d-mono">{state.device.id}</dd>
                      </div>
                    </dl>
                    <button className="d-button" disabled={busy} type="submit">
                      Save name
                    </button>
                  </form>
                </section>
                <section className="d-panel">
                  <header>
                    <h2>Execution boundary</h2>
                    <Status muted>Isolated local execution</Status>
                  </header>
                  <p>
                    Claude Code, Codex and Grok Build run in separate Lima
                    environments after you approve a current permission.
                  </p>
                  <ul className="d-checklist">
                    <li>
                      <Check size={15} />
                      Native workspace selection
                    </li>
                    <li>
                      <Check size={15} />
                      Local, revocable contribution terms
                    </li>
                    <li>
                      <Check size={15} />
                      Remote content has no desktop tool access
                    </li>
                  </ul>
                  <div className="d-pending">
                    <span className="d-label">
                      Your approval controls execution
                    </span>
                    <p>
                      Each agent uses its own guest login and isolated
                      workspace. Joining or preparing an agent never starts
                      mission work. Open a mission’s Add agents panel to prepare
                      this Mac and sign in; no Terminal setup is required for
                      the normal flow.
                    </p>
                  </div>
                </section>
              </div>
              <NetworkSettings
                state={nodeState}
                busy={busy}
                perform={perform}
                updated={refreshNode}
              />
              <BackgroundSetting />
              <DeviceDiscovery
                state={nodeState}
                busy={busy}
                perform={perform}
                updated={refreshNode}
              />
              <section className="d-panel n-identity-panel">
                <header>
                  <h2>Node identity</h2>
                  <Status muted>
                    {nodeState?.identity ? "OS-protected keys" : "Not enrolled"}
                  </Status>
                </header>
                {nodeState?.identity ? (
                  <>
                    <dl className="d-facts">
                      <div>
                        <dt>Owner public key</dt>
                        <dd className="d-mono">{nodeState.identity.owner}</dd>
                      </div>
                      <div>
                        <dt>Node public key</dt>
                        <dd className="d-mono">
                          {nodeState.identity.endpoint}
                        </dd>
                      </div>
                    </dl>
                    <p>
                      These public keys identify this node and its signed
                      records. Private keys stay in protected local storage.
                    </p>
                    <p className="d-field-help">
                      Back up the complete closed-app profile and retain its
                      original OS keychain. Restore on this device only.
                      Cross-device recovery is not available yet; copying an
                      active identity can create conflicting histories.
                    </p>
                  </>
                ) : (
                  <p>
                    Your first mission creates a protected identity here.
                    Existing contribution preparations remain separate.
                  </p>
                )}
              </section>
              <div className="d-explainer">
                <LockKeyhole size={17} />
                <p>
                  Mission owners direct the goal. Coordinators organize the
                  work. Neither can increase your local allowance or authorize
                  access to your computer.
                </p>
              </div>
            </>
          ) : null}
          {view === "activity" ? (
            <>
              <Heading
                section="This installation / Local activity"
                title="A record of your decisions."
              >
                Saved preparations and consent changes on this device. Mission
                progress will remain in the shared blackboard.
              </Heading>
              <section className="d-activity-list" aria-label="Local activity">
                {state.activity.length ? (
                  state.activity.map((entry) => (
                    <article key={entry.id}>
                      <div className="d-activity-mark">
                        {entry.type === "consent_revoked" ? (
                          <LockKeyhole size={16} />
                        ) : (
                          <Check size={16} />
                        )}
                      </div>
                      <div>
                        <h2>
                          {entry.type === "contribution_prepared"
                            ? "Contribution prepared"
                            : entry.type === "consent_revoked"
                              ? "Local consent revoked"
                              : "Contributor name saved"}
                        </h2>
                        <p>{entry.label}</p>
                      </div>
                      <time dateTime={entry.at}>{date(entry.at)}</time>
                      {entry.contributionId ? (
                        <button
                          className="d-icon"
                          aria-label={`Open ${entry.label}`}
                          onClick={() =>
                            navigate({ id: entry.contributionId! })
                          }
                        >
                          <ChevronRight size={17} />
                        </button>
                      ) : null}
                    </article>
                  ))
                ) : (
                  <div className="d-empty">
                    <History size={25} />
                    <h3>No local activity yet</h3>
                    <p>
                      Your decisions will appear here as you prepare
                      contributions.
                    </p>
                  </div>
                )}
              </section>
              <p className="d-footnote">
                This is a local history, not a signed or tamper-proof network
                audit.
              </p>
            </>
          ) : null}
        </div>
      </main>
    </div>
  );
}
