import type { Limits, Runtime } from "./bridge";
export type ContributionApproval = {
  id: string;
  mission: string;
  terms: string;
  coordinator: string | null;
  plan: string | null;
  registration: string;
  contributionId: string | null;
  ownerPermission: boolean;
  minutes: number;
  turns: number;
  followDirections: boolean;
};
export type ContributionAgreement = {
  id: string;
  request: ContributionApproval;
  status: "active" | "stopped" | "expired" | "review" | "interrupted";
  message: string;
  expiresAt: number;
  createdAt: number;
};
export type ReviewedStart = {
  id: string;
  mission: string;
  revision: string;
  readiness: string | null;
  approvals: ContributionApproval[];
};
export type StartJob = {
  id: string;
  request: ReviewedStart;
  phase: "reviewed" | "started" | "complete" | "cancelled";
  createdAt: number;
};
export type CompletionRequest = {
  id: string;
  mission: string;
  control: string;
  revisions: string[];
  reason: string;
};
export type CompletionJob = {
  id: string;
  request: CompletionRequest;
  status: string;
  accepted: string[];
  message: string;
};
export type SetupRequest = {
  id: string;
  mission: string;
  terms: string;
  role: "agent" | "coordinator";
  runtime: Runtime;
  label: string;
  count: number;
  limits: Limits;
  workspaceChoiceId: string | null;
};
export type PermissionRequest = {
  id: string;
  contributionId: string;
  control: string;
  direction: string;
  turns: number;
  minutes: number;
};
type JobBase = {
  id: string;
  mission: string;
  status: string;
  message: string;
  contributions: string[];
  step: number;
  updatedAt: number;
};
export type SetupJob = JobBase &
  (
    | { kind: "setup"; request: SetupRequest }
    | { kind: "permission"; request: PermissionRequest }
  );
export type AgentSetupJob = Extract<SetupJob, { kind: "setup" }>;
export type Preflight = {
  supported: boolean;
  available: boolean;
  capacity: number;
  capacityCeiling: number;
  freeDiskBytes: number;
  minimumDiskBytes: number;
  installer: {
    active: boolean;
    stage: string;
    bytes: number;
    total: number | null;
    error: string | null;
  };
};
declare global {
  interface Window {
    blackboardSetup: {
      completeMission(input: CompletionRequest): Promise<CompletionJob>;
      completionState(mission: string): Promise<CompletionJob[]>;
      discardCompletion(id: string): Promise<void>;
      appPreferences(): Promise<{
        background: boolean;
        notifications: boolean;
        notificationsSupported: boolean;
      }>;
      setBackground(enabled: boolean): Promise<{ background: boolean }>;
      setNotifications(enabled: boolean): Promise<{ notifications: boolean }>;
      takeNotification(): Promise<{ mission: string } | null>;
      setCapacity(maximum: number): Promise<{ maximum: number }>;
      journeyDiagnostics(): Promise<{ enabled: boolean; events: number }>;
      setJourneyDiagnostics(enabled: boolean): Promise<{ enabled: boolean }>;
      clearJourneyDiagnostics(): Promise<void>;
      agreements(mission: string): Promise<ContributionAgreement[]>;
      approveContribution(
        input: ContributionApproval,
      ): Promise<ContributionAgreement>;
      cancelAgreement(id: string): Promise<void>;
      continueAgreement(id: string): Promise<void>;
      reviewedStart(input: ReviewedStart): Promise<unknown>;
      startState(mission: string): Promise<StartJob[]>;
      cancelStart(id: string): Promise<StartJob>;
      state(mission: string): Promise<SetupJob[]>;
      setup(request: SetupRequest): Promise<SetupJob>;
      permission(request: PermissionRequest): Promise<SetupJob>;
      cancel(id: string): Promise<void>;
      preflight(): Promise<Preflight>;
      installProvider(): Promise<void>;
      cancelInstall(): Promise<void>;
      takeInvitation(): Promise<string | null>;
    };
  }
}
