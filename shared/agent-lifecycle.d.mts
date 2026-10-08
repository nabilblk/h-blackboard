import type { AgentView, MissionView } from "../src/application/contracts/node";
import type { Contribution } from "../src/application/contracts/workspace";
import type { ExecutionState } from "../src/application/contracts/execution";
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
  observation?: import("../src/application/contracts/execution").RemoteObservation;
  mission: MissionView;
  now?: number;
}): AgentLifecycle;
export function lifecycleSummary(states: AgentLifecycle[]): string;
