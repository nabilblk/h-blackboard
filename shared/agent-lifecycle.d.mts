import type { AgentView, MissionView } from "../src/desktop/node-contract";
import type { Contribution } from "../src/desktop/bridge";
import type { ExecutionState } from "../src/desktop/execution-types";
export type AgentLifecycle = {
  state: string;
  label: string;
  reason: string;
  action: string | null;
  attention: boolean;
  local: boolean;
  observedAt: number | null;
};
export function agentContributorLabel(
  agent: AgentView | undefined,
  mission: MissionView,
  local?: boolean,
): string;
export function agentLifecycle(input: {
  agent?: AgentView;
  contribution?: Contribution;
  execution?: ExecutionState;
  observation?: import("../src/desktop/execution-types").RemoteObservation;
  mission: MissionView;
  now?: number;
}): AgentLifecycle;
export function lifecycleSummary(states: AgentLifecycle[]): string;
