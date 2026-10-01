export type Runtime = "claude" | "codex" | "grok";
export type Limits =
  | { mode: "bounded"; concurrency: number; turns: number; minutes: number }
  | { mode: "unlimited"; concurrency: number };
export type Mission = {
  origin: string;
  missionId: string;
  name: string;
  role: "coordinator" | "agent";
  inspectedAt: string;
};
export type Contribution = {
  id: string;
  contributorId: string;
  deviceId: string;
  mission: Mission;
  runtime: Runtime;
  limits: Limits;
  workspace: string;
  status: "prepared" | "revoked";
  createdAt: string;
  revokedAt: string | null;
  execution: { allowed: false; blockers: { code: string; message: string }[] };
};
export type LocalState = {
  schemaVersion: 1;
  contributor: { id: string; name: string };
  device: { id: string; name: string };
  contributions: Contribution[];
  activity: {
    id: string;
    at: string;
    type: "contributor_named" | "contribution_prepared" | "consent_revoked";
    contributionId: string | null;
    label: string;
  }[];
};
export type PrepareInput = {
  reviewId: string;
  workspaceChoiceId: string;
  runtime: Runtime;
  limits: Limits;
};
export type DesktopAPI = {
  state(): Promise<LocalState>;
  inspect(invitation: string): Promise<{ reviewId: string; mission: Mission }>;
  chooseWorkspace(): Promise<{ id: string; path: string } | null>;
  prepare(input: PrepareInput): Promise<LocalState>;
  revoke(contributionId: string): Promise<LocalState>;
  reveal(contributionId: string): Promise<null>;
  rename(name: string): Promise<LocalState>;
};
declare global {
  interface Window {
    contributor: DesktopAPI;
  }
}
export const desktop = window.contributor;
