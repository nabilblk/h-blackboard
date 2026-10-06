import type {
  AgentView,
  MissionView,
  ArtifactSummary,
  JoinView,
} from "../src/desktop/node-contract";
import type { Contribution } from "../src/desktop/bridge";
import type {
  ExecutionState,
  RemoteObservation,
} from "../src/desktop/execution-types";
export type PresentationAction = {
  label: string;
  destination:
    | "agent"
    | "setup"
    | "controls"
    | "people"
    | "results"
    | "technical"
    | "artifact";
  agent?: string | null;
  contribution?: string | null;
  role?: "coordinator" | "agent";
  review?: boolean;
  revision?: string;
};
export type AgentPresentation = {
  state: "setup" | "working" | "waiting" | "stopping" | "stopped" | "unknown";
  label: string;
  cause: string;
  reason: string;
  responsible: string;
  action: PresentationAction | null;
  attention: boolean;
  urgent: boolean;
  local: boolean;
  fresh: boolean;
  technicalState: string;
  observedAt: number | null;
  source: string;
  reference: string | null;
  stopConfirmed: boolean;
};
export type Decision = {
  id: string;
  kind: string;
  priority: number;
  title: string;
  reason: string;
  responsible: string;
  action: PresentationAction;
  urgent?: boolean;
};
export type MissionPresentationInput = {
  mission: MissionView;
  viewer: string;
  agents?: AgentView[];
  contributions?: Contribution[];
  states?: Record<string, ExecutionState>;
  observations?: Record<string, RemoteObservation>;
  requests?: JoinView[];
  startJobs?: import("../src/desktop/onboarding-types").StartJob[];
  criteria?: { met: boolean; stale: boolean }[];
  acceptedResult?: ArtifactSummary | null;
  loaded?: boolean;
  blocked?: boolean;
  access?: "revoked" | "withdrawn" | null;
  now?: number;
};
export type MissionPresentation = {
  phase: MissionView["lifecycle"]["phase"];
  phaseLabel: string;
  summary: string;
  activity: string;
  rows: { agent: AgentView; status: AgentPresentation }[];
  counts: Record<AgentPresentation["state"], number>;
  decisions: Decision[];
  waiting: Decision[];
  next: Decision | null;
  urgent: boolean;
  acceptedResult: ArtifactSummary | null;
};
export function agentPresentation(input: {
  agent?: AgentView;
  contribution?: Contribution;
  execution?: ExecutionState;
  observation?: RemoteObservation;
  mission: MissionView;
  viewer?: string;
  now?: number;
}): AgentPresentation;
export function missionPresentation(
  input: MissionPresentationInput,
): MissionPresentation;
export function missionDecisions(
  input: Pick<
    MissionPresentationInput,
    "mission" | "viewer" | "requests" | "criteria" | "startJobs"
  >,
): Decision[];
