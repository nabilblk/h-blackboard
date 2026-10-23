import { ScreenBoundary } from "../ui/ScreenBoundary";
import { MyAgents } from "./MyAgents";
import { Settings } from "./Settings";
import { WorkspaceShell } from "./WorkspaceShell";
import { Home } from "./Home";
import { Inbox } from "./Inbox";
import { observations } from "../application/observations";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/Button";
import { useApplication } from "../desktop/ApplicationProvider";
import { readDrafts, writeDrafts } from "../../shared/desktop-drafts.mjs";
import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import {
  type LocalState,
  type NodeState,
} from "../application/contracts/workspace";
import { Brand, type Perform } from "../desktop/ui";
import Prepare from "../desktop/Prepare";
import ContributionDetail from "../desktop/ContributionDetail";
import {
  CreateMission,
  MissionRoom,
  type MissionSession,
} from "../desktop/Missions";
import { JoinMission } from "../desktop/Peers";
import { Discover } from "../desktop/Discovery";
import type { ContributionReview } from "../application/contracts/workspace";
import type { InvitationReview } from "../application/contracts/node";

export type WorkspaceView =
  | "discover"
  | "node-contribution"
  | "missions"
  | "new-mission"
  | "join"
  | "contributions"
  | "prepare"
  | "device"
  | "connections"
  | "activity"
  | "inbox"
  | { id: string }
  | { missionId: string; startSetup?: boolean };

export default function Workspace() {
  const { workspace: desktop, setup, missions: node } = useApplication();
  const [state, setState] = useState<LocalState | null>(null);
  const [view, setView] = useState<WorkspaceView>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("harakiri.last-view.v1") ?? "null",
      );
      if (
        saved &&
        typeof saved.missionId === "string" &&
        /^[a-f0-9]{64}$/.test(saved.missionId)
      )
        return { missionId: saved.missionId };
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
    const failure = (error: Error) => setError(error.message);
    const stopNode = observations(node).subscribe(
      "state",
      () => node.state(),
      setNodeState,
      failure,
    );
    const stopWorkspace = observations(desktop).subscribe(
      "state",
      () => desktop.state(),
      setState,
      failure,
    );
    const stopSignals = observations(setup).subscribe(
      "desktop-signals",
      async () => {
        const invitation = await setup.takeInvitation();
        const target = await setup.takeNotification();
        return {
          invitation,
          target,
          delivery: invitation || target ? crypto.randomUUID() : null,
        };
      },
      ({ invitation, target }) => {
        if (invitation && !cancelled) {
          setIncomingInvitation(invitation);
          setView("join");
          setNotice("Invitation received. Review it before joining.");
        }
        if (target && !cancelled)
          void node
            .state()
            .then((value) => {
              if (
                cancelled ||
                !value.identity ||
                !value.missions.some((m) => m.id === target.mission)
              )
                return;
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
            })
            .catch(failure);
      },
      failure,
    );
    const reconcile = () => {
      observations(node).invalidate();
      observations(desktop).invalidate();
      observations(setup).invalidate();
    };
    window.addEventListener("focus", reconcile);
    window.addEventListener("online", reconcile);
    return () => {
      cancelled = true;
      stopNode();
      stopWorkspace();
      stopSignals();
      window.removeEventListener("focus", reconcile);
      window.removeEventListener("online", reconcile);
    };
  }, [desktop, setup, node]);
  const perform: Perform = async (operation) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      observations(node).invalidate();
      observations(desktop).invalidate();
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
  const navigate = (next: WorkspaceView) => {
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
  return (
    <WorkspaceShell
      state={state}
      nodeState={nodeState}
      view={view}
      mission={selectedMission}
      navigate={navigate}
      busy={busy}
    >
      <main
        className={`d-main${selectedMission ? " d-main-mission" : ""}`}
        id="main"
        tabIndex={-1}
        ref={main}
      >
        {error ? (
          <div className="d-alert" role="alert">
            <span>{error}</span>
            <IconButton aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={16} />
            </IconButton>
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
          <ScreenBoundary
            key={
              typeof view === "object"
                ? "missionId" in view
                  ? view.missionId
                  : view.id
                : view
            }
            home={() => navigate("missions")}
          >
            {view === "missions" ? (
              <Home
                state={nodeState}
                busy={busy}
                create={() => navigate("new-mission")}
                join={() => {
                  setJoinReview(null);
                  navigate("join");
                }}
                open={(missionId) => navigate({ missionId })}
                withdraw={(mission) =>
                  void perform(async () => {
                    await node.withdrawMission(mission);
                    await refreshNode();
                  })
                }
              />
            ) : null}
            {view === "inbox" ? (
              <Inbox
                missions={nodeState?.missions ?? []}
                open={(missionId, message) => {
                  if (!nodeState?.identity) return;
                  const owner = nodeState.identity.owner;
                  const key = `${owner}:${missionId}`;
                  const saved =
                    latestSessions.current[key] ??
                    missionSessions[key] ??
                    readDrafts(localStorage, owner, missionId);
                  const next = {
                    ...saved,
                    feed: "conversation" as const,
                    audience: message.audience,
                    anchor: message.thread ?? message.id,
                    thread: message.thread
                      ? { id: message.thread, audience: message.audience }
                      : null,
                  };
                  latestSessions.current[key] = next;
                  setMissionSessions((all) => ({ ...all, [key]: next }));
                  navigate({ missionId });
                }}
              />
            ) : null}
            {view === "discover" ? (
              <section className="w-page">
                <Discover
                  state={nodeState}
                  busy={busy}
                  perform={perform}
                  updated={refreshNode}
                  network={() => navigate("connections")}
                  review={(reference, review) => {
                    setJoinReview({ reference, review });
                    navigate("join");
                  }}
                />
              </section>
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
              <section className="w-page w-join-page">
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
              </section>
            ) : null}
            {view === "new-mission" ? (
              <CreateMission
                busy={busy}
                enrolled={nodeState?.status === "ready"}
                perform={perform}
                cancel={() => navigate("missions")}
                complete={async (id) => {
                  await refreshNode();
                  navigate({ missionId: id, startSetup: true });
                  setNotice(
                    "Mission created. Choose your team when you’re ready.",
                  );
                }}
              />
            ) : null}
            {typeof view === "object" &&
            "missionId" in view &&
            !selectedMission ? (
              <section className="w-page">
                <h1>
                  {nodeState
                    ? "Mission unavailable on this Mac"
                    : "Opening mission…"}
                </h1>
                <p>
                  {nodeState
                    ? "Your saved navigation points to a mission that is no longer in this local workspace."
                    : "Loading the protected mission history."}
                </p>
                {nodeState ? (
                  <Button onClick={() => navigate("missions")}>
                    Back to Home
                  </Button>
                ) : null}
              </section>
            ) : null}
            {selectedMission && nodeState?.identity ? (
              <MissionRoom
                fullPage
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
                network={() => navigate("connections")}
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
              <MyAgents
                contributions={state.contributions}
                node={nodeState}
                busy={busy}
                perform={perform}
                inspect={(id) => navigate({ id })}
                join={() => navigate("join")}
                legacy={() => navigate("prepare")}
              />
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
              <section className="w-page w-contribution-detail">
                <ContributionDetail
                  item={selected}
                  openMission={
                    nodeState?.missions.some(
                      (m) => m.id === selected.mission.missionId,
                    )
                      ? () =>
                          navigate({ missionId: selected.mission.missionId })
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
              </section>
            ) : null}
            {["device", "connections", "activity"].includes(
              typeof view === "string" ? view : "",
            ) ? (
              <Settings
                key={typeof view === "string" ? view : "settings"}
                initialTab={
                  view === "activity"
                    ? "activity"
                    : view === "connections"
                      ? "connection"
                      : "profile"
                }
                state={state}
                node={nodeState}
                busy={busy}
                perform={perform}
                updated={refreshNode}
                renamed={setState}
                inspect={(id) => navigate({ id })}
              />
            ) : null}
          </ScreenBoundary>
        </div>
      </main>
    </WorkspaceShell>
  );
}
