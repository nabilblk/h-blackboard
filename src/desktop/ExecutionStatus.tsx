import { useApplication } from "./ApplicationProvider";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { agentPresentation } from "../../shared/mission-presentation.mjs";
import type { ExecutionState } from "../application/contracts/execution";
import type { RemoteObservation } from "../application/contracts/execution";

import type { Contribution } from "../application/contracts/workspace";
import type { AgentView, MissionView } from "../application/contracts/node";

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
  const { execution, missions: node } = useApplication();
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
          execution.overview(mission),
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
  }, [mission, execution, node]);
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
export function useExecutionClock() {
  return useContext(Context)?.clock ?? Date.now();
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
  const status = agentPresentation({
    viewer: contribution
      ? (agent?.contributor ?? states?.[contribution.id]?.agent?.contributor)
      : undefined,
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
      <strong>
        {status.label}
        {!status.local && status.fresh ? " · reported" : ""}
      </strong>
      <span>{status.reason}</span>
    </span>
  );
}
