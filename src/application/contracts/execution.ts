import type { AgentView, GrantView } from "./node";
import type { ContributionAgreement } from "./setup";
import type { NetworkAccess, CapabilityPack, Limits } from "./workspace";
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
  checkpoints?: Array<{
    id: string;
    at: number;
    files: number;
    bytes: number;
    exclusions: Array<{ path: string; reason: string }>;
  }>;
  operations?: Array<{
    id: string;
    kind: string;
    label: string;
    state:
      | "running"
      | "complete"
      | "failed"
      | "cancel_requested"
      | "cancelled"
      | "uncertain";
    updatedAt: number;
    error: string | null;
    resultAvailable: boolean;
    progress: { completed: number; total: number; detail: string } | null;
  }>;
  networkAccess?: NetworkAccess;
  capabilityPack?: CapabilityPack;
  networkRevision?: string | null;
  capabilityRevision?: string | null;
  limits?: Limits;
  limitsRevision?: string | null;
  localAllowance?: {
    deadline: number | null;
    used: number;
    remaining: number | null;
    issue: string | null;
  };
  observedAt: number;
  error?: string;
  agent?: AgentView | null;
  record: null | {
    status: string;
    reason: string;
    session: string | null;
    reconstructedAt?: number;
    recoveredSource?: { directory: string; checkpoint: string; at: number };
    generation: number | null;
    expiresAt: number | null;
    wake?: {
      waiting?: {
        reason: string;
        artifacts: string[];
        reviews: string[];
      } | null;
    } | null;
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
  restoreCheckpoint(
    id: string,
    checkpoint: string,
  ): Promise<{ destination: string; imported: number }>;
  cancelOperation(id: string, operation: string): Promise<unknown>;
  state(id: string): Promise<ExecutionState>;
  overview(mission: string): Promise<Record<string, ExecutionState>>;
  prepare(id: string): Promise<void>;
  setLimits(
    id: string,
    limits: Limits,
    expectedRevision: string | null,
  ): Promise<void>;
  setNetwork(
    id: string,
    networkAccess: NetworkAccess,
    expectedRevision: string | null,
  ): Promise<void>;
  setCapabilityPack(
    id: string,
    capabilityPack: CapabilityPack,
    expectedRevision: string | null,
  ): Promise<void>;
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
