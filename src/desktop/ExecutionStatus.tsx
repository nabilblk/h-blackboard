import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  agentLifecycle,
  lifecycleSummary,
} from "../../shared/agent-lifecycle.mjs";
import type { ExecutionState } from "./execution-types";
import type { RemoteObservation } from "./execution-types";
import { node } from "./bridge";
import type { Contribution } from "./bridge";
import type { AgentView, MissionView } from "./node-contract";

const Context = createContext<{
  states: Record<string, ExecutionState>;
  observations: Record<string, RemoteObservation>;
  clock: number;
} | null>(null);
export function ExecutionStatusProvider({
  mission,
  children,
}: {
  mission: string;
  children: ReactNode;
}) {
  const [states, setStates] = useState<Record<string, ExecutionState>>({});
  const [clock, setClock] = useState(Date.now);
  const [observations, setObservations] = useState<
    Record<string, RemoteObservation>
  >({});
  useEffect(() => {
    // Expire observations even if an IPC request hangs or networking stalls.
    const timer = setInterval(() => setClock(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [next, reports] = await Promise.all([
          window.blackboardExecution.overview(mission),
          node.observations(mission),
        ]);
        if (!cancelled) setStates(next);
        if (!cancelled)
          setObservations((old) => ({
            ...Object.fromEntries(
              Object.entries(old).map(([id, v]) => [
                id,
                { ...v, expiresAt: 0 },
              ]),
            ),
            ...Object.fromEntries(
              reports.map((v) => [
                v.report.registration,
                { ...v, expiresAt: Date.now() + v.remaining_ms },
              ]),
            ),
          }));
      } catch {
        if (!cancelled)
          setStates((current) =>
            Object.fromEntries(
              Object.entries(current).map(([id, state]) => [
                id,
                {
                  ...state,
                  error:
                    "Execution observation unavailable. Retry or inspect local execution.",
                },
              ]),
            ),
          );
      }
      if (!cancelled) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mission]);
  return (
    <Context.Provider value={{ states, observations, clock }}>
      {children}
    </Context.Provider>
  );
}
export function useExecutionStates() {
  return useContext(Context)?.states ?? null;
}
export function useExecutionObservations() {
  return useContext(Context)?.observations ?? {};
}
export function AgentState({
  agent,
  contribution,
  mission,
}: {
  agent?: AgentView;
  contribution?: Contribution;
  mission: MissionView;
}) {
  const states = useExecutionStates();
  const observations = useExecutionObservations();
  const status = agentLifecycle({
    observation: agent ? observations[agent.id] : undefined,
    agent:
      agent ??
      (contribution
        ? (states?.[contribution.id]?.agent ?? undefined)
        : undefined),
    contribution,
    mission,
    execution: contribution ? states?.[contribution.id] : undefined,
  });
  return (
    <span className={`n-live-status ${status.state}`}>
      <strong>{status.label}</strong>
      <span>{status.reason}</span>
    </span>
  );
}
export function ExecutionSummary({
  agents,
  contributions,
  mission,
  open,
}: {
  agents: AgentView[];
  contributions: Contribution[];
  mission: MissionView;
  open: (id: string) => void;
}) {
  const states = useExecutionStates();
  const observations = useExecutionObservations();
  const rows = agents.map((agent) => ({
    agent,
    status: agentLifecycle({
      observation: observations[agent.id],
      agent,
      contribution: contributions.find(
        (c) => c.sharedAgent?.registration === agent.id,
      ),
      execution:
        states?.[
          contributions.find((c) => c.sharedAgent?.registration === agent.id)
            ?.id ?? ""
        ],
      mission,
    }),
  }));
  if (!rows.length) return null;
  return (
    <section
      className="n-status-overview"
      aria-label="Agent execution overview"
    >
      <p role="status">
        <strong>Agents</strong> · {lifecycleSummary(rows.map((r) => r.status))}
      </p>
      <button
        className="d-button n-status-details"
        onClick={() => open(rows[0].agent.id)}
      >
        View agents
      </button>
      <div className="n-status-agents">
        {rows.slice(0, 6).map(({ agent, status }) => (
          <button
            type="button"
            key={agent.id}
            className={`n-status-chip ${status.state}`}
            onClick={() => open(agent.id)}
            title={status.reason}
          >
            <span>{agent.identity.label}</span>
            <strong>{status.label}</strong>
            {status.attention ? (
              <span className="sr-only"> · Needs attention</span>
            ) : null}
          </button>
        ))}
        {rows.length > 6 ? (
          <button className="d-button" onClick={() => open(rows[6].agent.id)}>
            View all {rows.length} agents
          </button>
        ) : null}
      </div>
    </section>
  );
}
