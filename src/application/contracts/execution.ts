import type { AgentView, GrantView } from "./node";
import type { ContributionAgreement } from "./setup";
export type RemoteObservation = {
  contributor: string;
  remaining_ms: number;
  expiresAt?: number;
  report: {
    registration: string;
    mission: string;
    control: string;
    grant: string | null;
    state: string;
    issued_ms: number;
  };
};
export type AuthenticationState = {
  status: "starting" | "waiting" | "complete" | "failed" | "cancelled";
  text: string;
  urls: string[];
  error?: string;
  code?: string | null;
  url?: string | null;
  expiresAt?: number | null;
  localDeadline?: number;
  failure?: "expired" | "denied" | "connection" | null;
};
export type ExecutionState = {
  observedAt: number;
  error?: string;
  agent?: AgentView | null;
  record: null | {
    status: string;
    reason: string;
    session: string | null;
    generation: number | null;
    expiresAt: number | null;
    interruption?: {
      code: "direction_changed";
      previous: string;
      current: string;
    } | null;
    transitions?: { at: number; from: string; to: string; reason: string }[];
  };
  permissions: GrantView[];
  direction: { id: string; text: string } | null;
  permissionProblem: string | null;
  capacity: number;
  busy: boolean;
  authentication?: AuthenticationState | null;
  agreement?: ContributionAgreement | null;
  events: { at: number; type: string; message: string }[];
};
export type ExecutionAPI = {
  state(id: string): Promise<ExecutionState>;
  overview(mission: string): Promise<Record<string, ExecutionState>>;
  prepare(id: string): Promise<void>;
  cancelSetup(id: string): Promise<void>;
  login(id: string): Promise<{ command: string }>;
  signIn(id: string): Promise<void>;
  loginInput(id: string, text: string): Promise<void>;
  cancelLogin(id: string): Promise<void>;
  openLogin(id: string, url: string): Promise<void>;
  start(id: string, grant: string): Promise<ExecutionState>;
  stop(id: string): Promise<void>;
  exportFiles(id: string): Promise<{ exported: number; directory: string }>;
  exportDiagnostics(id: string): Promise<{ cancelled: boolean }>;
  importFiles(id: string): Promise<{ imported?: number; cancelled?: boolean }>;
};
