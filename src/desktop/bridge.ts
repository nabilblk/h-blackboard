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
  nodeBinding?: { owner: string; revision: string };
  runtime: Runtime;
  sharedAgent?: {
    registration: string;
    author: string;
    label: string;
    withdrawn: boolean;
  };
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

import type {
  Coordination,
  MissionDefinition,
  MissionView,
  MessagePage,
  MessageQuery,
  NetworkConfig,
  NetworkView,
  InvitationReview,
  JoinView,
  LocalJoinView,
  MemberView,
  DeliveryView,
  AudienceView,
  DiscoveryConfig,
  ListingView,
  WithdrawalView,
} from "./node-contract";
export type NodeState = {
  status: "not_enrolled" | "ready";
  identity: { owner: string; endpoint: string; version: number } | null;
  missions: MissionView[];
  network: "disabled" | "enabled";
  connection: NetworkView | null;
  joins: LocalJoinView[];
  withdrawals: WithdrawalView[];
  execution: "unavailable";
};
export type PeerState = {
  members: MemberView[];
  delivery: DeliveryView[];
  requests: JoinView[];
};
export type DiscoveryState = {
  config: DiscoveryConfig;
  listings: ListingView[];
  peer_ticket: string | null;
};
export type ContributionReview = {
  reviewId: string;
  mission: Mission;
  definition: MissionDefinition;
  nodeBinding: { owner: string; revision: string };
};
export type NodeAPI = {
  artifacts(
    mission: string,
    query?: Partial<import("./node-contract").ArtifactQuery>,
  ): Promise<import("./node-contract").ArtifactPage>;
  copyArtifactReference(mission: string, revision: string): Promise<void>;
  artifactDetail(
    mission: string,
    revision: string,
  ): Promise<import("./node-contract").ArtifactDetail>;
  artifactAction(
    mission: string,
    control: string,
    conversation: string,
    action: import("./node-contract").ArtifactAction,
  ): Promise<{ event: string }>;
  artifactTransfer(
    mission: string,
    transfer: import("./node-contract").ArtifactTransfer,
  ): Promise<{
    upload?: string;
    event?: string;
    hex?: string;
    offset?: number;
    complete?: boolean;
    size?: number;
  }>;
  artifactOpen(mission: string, revision: string, path: string): Promise<void>;
  artifactSave(
    mission: string,
    revision: string,
    path: string,
  ): Promise<{ saved: boolean }>;
  state(): Promise<NodeState>;
  enroll(): Promise<NodeState>;
  createMission(definition: MissionDefinition): Promise<{ mission: string }>;
  updateInstructions(
    mission: string,
    revision: string,
    definition: MissionDefinition,
  ): Promise<{ event: string }>;
  setCoordination(
    mission: string,
    revision: string,
    mode: Coordination,
  ): Promise<{ event: string }>;
  consentGrant(
    mission: string,
    grant: string,
    contributionId: string,
  ): Promise<{ event: string }>;
  governance(
    mission: string,
  ): Promise<import("./node-contract").GovernanceView>;
  govern(
    mission: string,
    control: string,
    action: import("./node-contract").GovernanceAction,
  ): Promise<{ event: string }>;
  missionAction(
    mission: string,
    revision: string,
    action: import("./node-contract").ControlAction,
  ): Promise<{ event: string }>;
  privateRecovery(
    mission: string,
    audience: string,
  ): Promise<{ member: string; revocation: string }[]>;
  reconcilePrivate(
    mission: string,
    audience: string,
    member: string,
    revocation: string,
    accepted: string | null,
  ): Promise<{ event: string }>;
  setPlan(
    mission: string,
    revision: string,
    text: string,
  ): Promise<{ event: string }>;
  startMission(
    mission: string,
    revision: string,
    readiness: string | null,
  ): Promise<{ event: string }>;
  pauseMission(
    mission: string,
    revision: string,
    reason: string,
  ): Promise<{ event: string }>;
  appointCoordinator(
    mission: string,
    revision: string,
    contributionId: string,
  ): Promise<{ event: string }>;
  workEvidence(
    mission: string,
    event: string,
  ): Promise<import("./node-contract").WorkEvidence>;
  workstreams(
    mission: string,
  ): Promise<import("./node-contract").WorkstreamView[]>;
  tasks(
    mission: string,
    query?: Partial<import("./node-contract").TaskQuery>,
  ): Promise<import("./node-contract").TaskPage>;
  work(
    mission: string,
    revision: string,
    action: import("./node-contract").WorkAction,
  ): Promise<{ event: string }>;
  agents(
    mission: string,
    after?: string | null,
  ): Promise<import("./node-contract").AgentPage>;
  shareAgent(
    mission: string,
    contributionId: string,
    label: string,
  ): Promise<{ registration: string; author: string }>;
  withdrawAgent(mission: string, contributionId: string): Promise<null>;
  directAgent(
    mission: string,
    revision: string,
    registration: string,
    text: string,
  ): Promise<{ event: string }>;
  networkState(): Promise<NetworkView>;
  configureNetwork(config: NetworkConfig): Promise<NetworkView>;
  discoveryState(): Promise<DiscoveryState>;
  configureDiscovery(config: DiscoveryConfig): Promise<null>;
  publishListing(input: {
    mission: string;
    summary: string;
    capabilities: string[];
    active: boolean;
  }): Promise<{ reference: string }>;
  copyPeerTicket(): Promise<null>;
  withdrawMission(mission: string): Promise<null>;
  reviewContribution(
    mission: string,
    role: "agent" | "coordinator",
  ): Promise<ContributionReview>;
  prepareContribution(input: PrepareInput): Promise<LocalState>;
  issueInvitation(mission: string): Promise<{ ticket: string }>;
  copyInvitation(mission: string): Promise<null>;
  inspectInvitation(ticket: string): Promise<InvitationReview>;
  requestJoin(
    ticket: string,
    reviewed_mission: string,
    reviewed_revision: string,
  ): Promise<{ mission: string }>;
  localJoins(): Promise<LocalJoinView[]>;
  peers(mission: string): Promise<PeerState>;
  decideJoin(mission: string, author: string, admit: boolean): Promise<null>;
  revokeInvitations(mission: string): Promise<null>;
  revokeMember(mission: string, author: string): Promise<{ event: string }>;
  createAudience(
    mission: string,
    readers: string[],
  ): Promise<{ audience: string }>;
  audiences(mission: string): Promise<AudienceView[]>;
  openAgentConversation(
    mission: string,
    registration: string,
  ): Promise<{ audience: string }>;
  queryMessages(mission: string, query: MessageQuery): Promise<MessagePage>;
  markMessagesRead(mission: string, ids: string[]): Promise<null>;
  postMessage(
    mission: string,
    text: string,
    audience?: string,
    to?: string | null,
    thread?: string | null,
  ): Promise<{ event: string }>;
  messages(
    mission: string,
    before?: string | null,
    audience?: string,
  ): Promise<MessagePage>;
};
declare global {
  interface Window {
    blackboardNode: NodeAPI;
  }
}
export const node = window.blackboardNode;
