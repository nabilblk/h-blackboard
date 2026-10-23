import { useEffect, useMemo, useState } from "react";
import { Cpu, Square } from "lucide-react";
import { useApplication } from "../desktop/ApplicationProvider";
import { observations } from "../application/observations";
import type {
  Contribution,
  NodeState,
} from "../application/contracts/workspace";
import type { ExecutionState } from "../application/contracts/execution";
import { agentPresentation } from "../../shared/mission-presentation.mjs";
import runtimes from "../../shared/runtimes.json";
import { Button } from "../ui/Button";
import { Disclosure } from "../ui/Disclosure";
import type { Perform } from "../desktop/ui";

export function MyAgents({
  contributions,
  node,
  busy,
  perform,
  inspect,
  join,
  legacy,
}: {
  contributions: Contribution[];
  node: NodeState | null;
  busy: boolean;
  perform: Perform;
  inspect: (id: string) => void;
  join: () => void;
  legacy: () => void;
}) {
  const { execution } = useApplication();
  const [states, setStates] = useState<Record<string, ExecutionState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [clock, setClock] = useState(Date.now());
  const groups = useMemo(
    () =>
      [...new Set(contributions.map((c) => c.mission.missionId))]
        .sort()
        .join(":"),
    [contributions],
  );
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 5000);
    const stop = groups
      .split(":")
      .filter(Boolean)
      .map((mission) =>
        observations(execution).subscribe(
          `execution:${mission}`,
          () => execution.overview(mission),
          (value) => {
            setStates((all) => ({ ...all, ...value }));
            setErrors((all) => {
              const next = { ...all };
              delete next[mission];
              return next;
            });
          },
          (error) => setErrors((all) => ({ ...all, [mission]: error.message })),
        ),
      );
    return () => {
      clearInterval(timer);
      stop.forEach((fn) => fn());
    };
  }, [execution, groups]);
  const rows = contributions.map((item) => {
    const mission = node?.missions.find((m) => m.id === item.mission.missionId);
    const error = errors[item.mission.missionId];
    const state = states[item.id];
    const status = mission
      ? agentPresentation({
          mission,
          viewer: node?.identity?.owner ?? "",
          agent: state?.agent ?? undefined,
          contribution: item,
          execution: state && error ? { ...state, error } : state,
          now: clock,
        })
      : null;
    const label =
      item.sharedAgent?.label ??
      `${runtimes[item.runtime].label} ${item.mission.role === "coordinator" ? "Coordinator" : "Agent"}`;
    const canStop =
      !state?.busy &&
      ((!!state?.record &&
        !["ready", "login_required", "preparing", "stopping"].includes(
          state.record.status,
        ) &&
        state.record.status !== "stopped") ||
        state?.agreement?.status === "active");
    return { item, state, status, label, canStop, error };
  });
  const stoppable = rows.filter((r) => r.canStop);
  const visible = rows.filter(
    (r) =>
      (filter === "all" || r.status?.state === filter) &&
      `${r.label} ${r.item.mission.name} ${r.item.runtime}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const stop = (items: typeof rows) =>
    void perform(async () => {
      const results = await Promise.allSettled(
        items.map((r) => execution.stop(r.item.id)),
      );
      observations(execution).invalidate("execution:");
      const failed = results.flatMap((result, i) =>
        result.status === "rejected"
          ? [
              `${items[i].label}: ${result.reason instanceof Error ? result.reason.message : "stop could not be confirmed"}`,
            ]
          : [],
      );
      if (failed.length) throw new Error(failed.join("\n"));
    });
  return (
    <section className="w-page">
      <header className="w-page-title">
        <div>
          <span className="w-eyebrow">On this Mac</span>
          <h1>My agents</h1>
          <p>
            Your agents, their activity and your controls. Only you can approve
            their next run.
          </p>
        </div>
        {stoppable.length ? (
          <Button disabled={busy} onClick={() => stop(stoppable)}>
            <Square size={14} />
            Stop{" "}
            {stoppable.length === 1
              ? "my agent"
              : `all ${stoppable.length} agents`}
          </Button>
        ) : null}
      </header>
      {contributions.length ? (
        <>
          <div className="w-filter-bar">
            <input
              type="search"
              aria-label="Find my agents"
              placeholder="Find an agent or mission…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              aria-label="Filter agent activity"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">All activity</option>
              <option value="working">Working</option>
              <option value="waiting">Waiting</option>
              <option value="setup">Setting up</option>
              <option value="stopped">Stopped</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>
          <div className="w-agent-list">
            {visible.map(({ item, state, status, label, canStop, error }) => (
              <article className="w-agent-row" key={item.id}>
                <span className="w-message-avatar">
                  {runtimes[item.runtime].badge}
                </span>
                <div className="w-agent-description">
                  <button
                    className="w-text-link"
                    onClick={() => inspect(item.id)}
                  >
                    {label}
                  </button>
                  <span className="w-subtle">
                    {runtimes[item.runtime].label} · #{item.mission.name}
                  </span>
                  <p>
                    {error
                      ? "Activity cannot be confirmed. Open controls to inspect or recover."
                      : (status?.reason ??
                        "Open controls to check this saved contribution.")}
                  </p>
                </div>
                <div className="w-agent-status">
                  <span className={`w-phase is-${status?.state ?? "unknown"}`}>
                    {status?.label ??
                      (item.status === "revoked"
                        ? "Revoked"
                        : "Saved preparation")}
                  </span>
                  <small>
                    {status?.fresh
                      ? "Observed on this Mac"
                      : "No fresh activity report"}
                  </small>
                </div>
                <div className="w-agent-actions">
                  <Button onClick={() => inspect(item.id)}>
                    {state?.record?.status === "login_required"
                      ? "Sign in"
                      : status?.action
                        ? status.action.label
                        : "Open controls"}
                  </Button>
                  {canStop ? (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        stop(rows.filter((r) => r.item.id === item.id))
                      }
                    >
                      <Square size={12} />
                      Stop
                    </Button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
          {!visible.length ? (
            <p className="w-empty">No agents match this filter.</p>
          ) : null}
          <p className="w-subtle">
            Activity describes execution. Completed work and reviews are in each
            mission’s Work tab.
          </p>
        </>
      ) : (
        <div className="w-empty">
          <Cpu size={32} />
          <h2>Your first contribution starts with a mission.</h2>
          <p>
            Open a mission → People to prepare your agents, or join someone
            else’s mission.
          </p>
          <Button onClick={join}>Join a mission</Button>
        </div>
      )}
      <Disclosure title="Legacy web-board invitations">
        <p>
          Use this only for an invitation from a separately hosted web board.
          Desktop mission invitations use Join a mission.
        </p>
        <Button onClick={legacy}>Inspect a web-board invitation</Button>
      </Disclosure>
    </section>
  );
}
