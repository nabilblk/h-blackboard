// Generated from Rust. Run npm run node:types; do not edit.
export type Coordination = "coordinated" | "peer";
export type Participation = "private" | "approval";
export type MissionBudget =
  | { mode: "unlimited" }
  | {
      mode: "limited";
      turns: number | null;
      concurrency: number | null;
      deadline_ms: number | null;
      tokens: number | null;
      model_cost_microusd: number | null;
    };
export type MissionPolicy = {
  coordination: Coordination;
  participation: Participation;
  budget: MissionBudget;
};
export type MissionDefinition = {
  name: string;
  objective: string;
  scope: string;
  criteria: Array<string>;
  /**
   * Absent only in G0 fixtures. Missing policy never grants execution.
   */
  policy?: MissionPolicy;
};
export type CoordinatorIdentity = {
  author: string;
  label: string;
  runtime: string;
};
export type CoordinatorView = {
  identity: CoordinatorIdentity;
  appointment: string;
};
export type PlanView = {
  artifact: string | null;
  id: string;
  author: string;
  text: string;
};
export type ReadinessView = {
  id: string;
  author: string;
  control: string;
  plan: string;
};
export type LifecycleView = {
  archived_from: MissionPhase | null;
  revision: string;
  terms_revision: string;
  phase: MissionPhase;
  coordinator: CoordinatorView | null;
  plan: PlanView | null;
  readiness: ReadinessView | null;
  pause_reason: string | null;
  start_blockers: Array<string>;
};
export type MissionPhase =
  "preparing" | "active" | "paused" | "closed" | "archived";
export type ControlAction =
  | { type: "update_instructions"; definition: MissionDefinition }
  | {
      type: "set_coordination";
      mode: Coordination;
      coordinator: CoordinatorIdentity | null;
    }
  | { type: "set_plan"; text: string }
  | {
      type: "handover";
      registration: string;
      coordinator: CoordinatorIdentity;
      settlements: Array<string>;
    }
  | { type: "set_plan_artifact"; revision: string }
  | { type: "close"; reason: string }
  | { type: "archive"; reason: string }
  | { type: "restore" }
  | {
      type: "start";
      readiness: string | null;
      /**
       * Exact contributions observed by the human at Start. Late arrivals
       * cannot infer inclusion from clocks or network arrival order.
       */
      participants?: Array<string>;
    }
  | { type: "pause"; reason: string };
export type AgentRole = "agent" | "coordinator";
export type AgentIdentity = {
  author: string;
  label: string;
  runtime: string;
  role: AgentRole;
  contributor_name: string;
};
export type AgentStatus =
  | "waiting_for_start"
  | "waiting_for_direction"
  | "waiting_for_appointment"
  | "direction_assigned"
  | "paused"
  | "review_required"
  | "withdrawn"
  | "revoked"
  | "conflict";
export type DirectionView = {
  id: string;
  author: string;
  text: string;
  /**
   * Assignment is never an acknowledgment or evidence of execution.
   */
  source: string;
};
export type AgentView = {
  /**
   * The immutable registration record, scoped to one mission.
   */
  id: string;
  identity: AgentIdentity;
  contributor: string;
  terms_revision: string;
  status: AgentStatus;
  direction: DirectionView | null;
  /**
   * Receipt of the exact current direction; never evidence of execution.
   */
  acknowledgment: string | null;
  assignment: WorkstreamAssignmentView | null;
};
export type AgentPage = {
  items: Array<AgentView>;
  after: string | null;
  total: number;
};
export type MissionView = {
  id: string;
  owner: string;
  definition: MissionDefinition;
  state: string;
  conflicted: boolean;
  event_count: number;
  coordinator_node: string | null;
  lifecycle: LifecycleView;
};
export type MessageView = {
  work: WorkLink | null;
  audience: string;
  to: string | null;
  thread: string | null;
  replies: number;
  unread: boolean;
  author_label: string | null;
  author_agent: string | null;
  kind: string;
  agent_registration: string | null;
  provisional: boolean;
  id: string;
  author: string;
  text: string;
  created_at_ms: number | null;
};
export type MessagePage = { items: Array<MessageView>; before: string | null };
export type MissionPage = { items: Array<MissionView>; before: string | null };
export type NetworkMode = "offline" | "direct" | "public_relays" | "custom";
export type NetworkConfig = {
  mode: NetworkMode;
  relays: Array<string>;
  allow_lan: boolean;
};
export type NetworkView = {
  config: NetworkConfig;
  running: boolean;
  error: string | null;
};
export type InvitationReview = {
  mission: string;
  owner: string;
  endpoint: string;
  expires_ms: number;
  definition: MissionDefinition;
  reviewed_revision: string;
};
export type JoinView = {
  mission: string;
  author: string;
  endpoint: string;
  status: string;
};
export type LocalJoinView = { mission: string; name: string; status: string };
export type MemberView = {
  author: string;
  endpoint: string;
  revoked: boolean;
  withdrawn: boolean;
};
export type DeliveryView = {
  endpoint: string;
  pending: boolean;
  last_success_ms: number | null;
  last_error: string | null;
};
export type AudienceView = {
  id: string;
  readers: Array<string>;
  conflicted: boolean;
  agent_registration: string | null;
  label: string | null;
  unread: number;
  writable: boolean;
};
export type DiscoveryConfig = {
  enabled: boolean;
  lan: boolean;
  bootstrap: Array<string>;
  blocked: Array<string>;
};
export type Contact = {
  endpoint: string;
  addresses: Array<string>;
  relays: Array<string>;
  expires_ms: number;
};
export type Advertisement = {
  version: number;
  mission: string;
  title: string;
  summary: string;
  capabilities: Array<string>;
  contact: Contact;
  revision: number;
  active: boolean;
  issued_ms: number;
  expires_ms: number;
};
export type ListingView = {
  publisher: string;
  advertisement: Advertisement;
  reference: string;
  status: string;
};
export type WithdrawalView = { mission: string; pending_notifications: number };
export type MessageFeed = "conversation" | "inbox" | "sent";
export type MessageQuery = {
  view: MessageFeed;
  audience: string | null;
  thread: string | null;
  before: string | null;
  anchor: string | null;
  search: string | null;
};
export type AgentOperation =
  | { type: "governance" }
  | {
      type: "criterion";
      control: string;
      index: number;
      wording: string;
      met: boolean;
      summary: string;
      evidence: Array<string>;
    }
  | { type: "plan_artifact"; control: string; revision: string }
  | { type: "artifacts"; query: ArtifactQuery }
  | { type: "artifact_detail"; revision: string }
  | {
      type: "artifact_action";
      control: string;
      conversation: string;
      action: ArtifactAction;
    }
  | { type: "artifact_transfer"; transfer: ArtifactTransfer }
  | { type: "context" }
  | { type: "workstreams" }
  | { type: "tasks"; query: TaskQuery }
  | { type: "work"; control: string; action: WorkAction }
  | { type: "messages"; query: MessageQuery }
  | {
      type: "post";
      audience: string;
      text: string;
      to: string | null;
      thread: string | null;
    }
  | { type: "acknowledge"; control: string; direction: string }
  | { type: "plan"; control: string; text: string }
  | { type: "ready"; control: string; plan: string }
  | { type: "direct"; control: string; registration: string; text: string };
export type AgentContext = {
  definition: MissionDefinition;
  lifecycle: LifecycleView;
  agent: AgentView;
  conversations: Array<AudienceView>;
  execution: string;
};
export type ArtifactFile = {
  path: string;
  hash: string;
  size: number;
  media_type: string;
};
export type WorkEvidence = {
  id: string;
  title: string;
  conversation: string;
  text: string | null;
  files: Array<ArtifactFile>;
};
export type WorkLink = { kind: string; id: string };
export type TaskDefinition = {
  title: string;
  description: string;
  criteria: Array<string>;
  workstream: string | null;
};
export type AttemptStatus =
  | "planned"
  | "in_progress"
  | "blocked"
  | "paused"
  | "submitted"
  | "complete"
  | "cancelled";
export type WorkAction =
  | { type: "create_workstream"; name: string; goal: string }
  | {
      type: "revise_workstream";
      workstream: string;
      bases: Array<string>;
      name: string;
      goal: string;
    }
  | {
      type: "assign_workstream";
      registration: string;
      workstream: string | null;
      goal_revision: string | null;
      direction: string;
    }
  | {
      type: "create_task";
      definition: TaskDefinition;
      assignees: Array<string>;
    }
  | {
      type: "revise_task";
      task: string;
      bases: Array<string>;
      definition: TaskDefinition;
    }
  | {
      type: "assign_task";
      task: string;
      registration: string;
      approach: string;
    }
  | {
      type: "report_attempt";
      task: string;
      task_revision: string;
      allocation: string;
      registration: string;
      bases: Array<string>;
      status: AttemptStatus;
      summary: string;
      evidence: Array<string>;
    };
export type WorkstreamRevision = {
  id: string;
  author: string;
  name: string;
  goal: string;
};
export type WorkstreamView = {
  id: string;
  name: string;
  goal: string;
  heads: Array<WorkstreamRevision>;
  stale: boolean;
  unread: number;
};
export type WorkstreamAssignmentView = {
  id: string;
  author: string;
  workstream: string | null;
  goal_revision: string | null;
  name: string;
  direction: string;
  stale: boolean;
};
export type TaskRevision = {
  id: string;
  author: string;
  definition: TaskDefinition;
};
export type AttemptReport = {
  id: string;
  author: string;
  status: AttemptStatus;
  summary: string;
  evidence: Array<string>;
  stale: boolean;
};
export type AttemptView = {
  allocation: string;
  registration: string;
  assigned_by: string;
  approach: string;
  reports: Array<AttemptReport>;
  status: string;
  unavailable: boolean;
};
export type TaskView = {
  id: string;
  creator: string;
  definition: TaskDefinition;
  heads: Array<TaskRevision>;
  attempts: Array<AttemptView>;
  status: string;
  stale: boolean;
};
export type TaskQuery = {
  after: string | null;
  task: string | null;
  workstream: string | null;
  status: string | null;
  search: string | null;
  owner: string | null;
};
export type TaskPage = {
  items: Array<TaskView>;
  after: string | null;
  total: number;
};
export type ArtifactKind =
  "plan" | "report" | "application" | "data" | "code" | "document";
export type ArtifactStage = "draft" | "complete";
export type ReviewVerdict = "verified" | "changes_requested" | "inconclusive";
export type ArtifactDocument = {
  title: string;
  summary: string;
  kind: ArtifactKind;
  stage: ArtifactStage;
  limitations: string;
  entrypoint: string | null;
  inputs: Array<string>;
  files: Array<ArtifactFile>;
};
export type ArtifactAction =
  | {
      type: "publish";
      artifact: string | null;
      parents: Array<string>;
      document: ArtifactDocument;
    }
  | {
      type: "review";
      revision: string;
      verdict: ReviewVerdict;
      summary: string;
      conditions: string;
      evidence: Array<string>;
    }
  | { type: "accept"; revision: string; accepted: boolean; reason: string }
  | { type: "highlight"; revision: string; highlighted: boolean };
export type ArtifactQuery = {
  after: string | null;
  conversation: string | null;
  search: string | null;
};
export type ArtifactSummary = {
  id: string;
  revision: string;
  heads: Array<string>;
  conversation: string;
  title: string;
  summary: string;
  kind: ArtifactKind;
  stage: ArtifactStage;
  author: string;
  updated_at_ms: number | null;
  revision_count: number;
  file_count: number;
  entrypoint: string | null;
  stale: boolean;
  review_status: string;
  accepted: boolean;
  highlighted: boolean;
};
export type ArtifactPage = {
  items: Array<ArtifactSummary>;
  after: string | null;
  total: number;
};
export type ArtifactRevisionSummary = {
  id: string;
  author: string;
  created_at_ms: number | null;
  title: string;
  parents: Array<string>;
};
export type ArtifactReviewView = {
  id: string;
  author: string;
  verdict: ReviewVerdict;
  summary: string;
  conditions: string;
  evidence: Array<string>;
  self_review: boolean;
  stale: boolean;
};
export type ArtifactDecision = {
  id: string;
  author: string;
  accepted: boolean;
  reason: string;
  stale: boolean;
};
export type ArtifactDetail = {
  artifact: ArtifactSummary;
  revision: string;
  author: string;
  document: ArtifactDocument;
  parents: Array<string>;
  stale: boolean;
  history: Array<ArtifactRevisionSummary>;
  reviews: Array<ArtifactReviewView>;
  acceptance: ArtifactDecision | null;
  highlighted: boolean;
  available_files: Array<string>;
  may_publish: boolean;
  may_review: boolean;
  may_accept: boolean;
  may_highlight: boolean;
};
export type ArtifactFileRef = { revision: string; path: string };
export type ArtifactTransfer =
  | {
      type: "begin";
      control: string;
      conversation: string;
      path: string;
      media_type: string;
      size: number;
    }
  | { type: "chunk"; upload: string; offset: number; hex: string }
  | { type: "cancel"; upload: string }
  | {
      type: "publish";
      control: string;
      conversation: string;
      artifact: string | null;
      parents: Array<string>;
      document: ArtifactDocument;
      uploads: Array<string>;
      retain: Array<ArtifactFileRef>;
    }
  | { type: "read"; revision: string; path: string; offset: number };
export type GovernanceAction =
  | { type: "allocate"; node: string; turns: number | null; slots: number }
  | { type: "reclaim"; seal: string }
  | {
      type: "grant";
      purpose?: GrantPurpose;
      previous: string | null;
      allocation: string;
      registration: string;
      direction: string;
      execution: string;
      generation: number;
      turns: number;
      expires_ms: number;
      offline_ms: number;
    }
  | { type: "consent"; grant: string; binding: string }
  | { type: "reserve"; grant: string; consent: string; nonce: string }
  | {
      type: "receipt";
      reservation: string;
      used: number | null;
      stopped: boolean;
      summary: string;
    }
  | { type: "resolve"; reservation: string; reason: string }
  | { type: "retire_grant"; grant: string; reason: string }
  | { type: "seal_grant"; grant: string; settlements: Array<string> }
  | { type: "seal_allocation"; allocation: string; grants: Array<string> }
  | {
      type: "criterion";
      index: number;
      wording: string;
      met: boolean;
      summary: string;
      evidence: Array<string>;
    };
export type GrantPurpose = "work" | "planning";
export type GovernanceView = {
  allocations: Array<AllocationView>;
  grants: Array<GrantView>;
  reservations: Array<ReservationView>;
  criteria: Array<CriterionView>;
  handover_blockers: Array<string>;
  execution_available: boolean;
};
export type AllocationView = {
  id: string;
  node: string;
  turns: number | null;
  slots: number;
  charged: number;
  reserved: number;
  active: number;
  sealed: string | null;
  reclaimed: boolean;
};
export type GrantView = {
  id: string;
  purpose: GrantPurpose;
  issued_ms: number;
  allocation: string;
  registration: string;
  node: string;
  execution: string;
  generation: number;
  turns: number;
  expires_ms: number;
  offline_ms: number;
  control: string;
  direction: string;
  consent: string | null;
  consent_binding: string | null;
  risk_accepted: string | null;
  sealed: boolean;
  seal: string | null;
  charged: number;
  reserved: number;
};
export type ReservationView = {
  id: string;
  grant: string;
  node: string;
  nonce: string;
  receipt: string | null;
  used: number | null;
  stopped: boolean;
  resolution: string | null;
  summary: string | null;
};
export type CriterionView = {
  index: number;
  wording: string;
  met: boolean;
  report: string | null;
  author: string | null;
  summary: string | null;
  evidence: Array<string>;
  stale: boolean;
};
export type LocalAllowance =
  | { mode: "bounded"; turns: number; concurrency: number; minutes: number }
  | { mode: "unlimited"; concurrency: number };
export type Command =
  | {
      type: "reserve_local";
      mission: string;
      control: string;
      registration: string;
      grant: string;
      consent: string;
      nonce: string;
      limits: LocalAllowance;
    }
  | { type: "governance"; mission: string }
  | {
      type: "govern";
      mission: string;
      control: string;
      action: GovernanceAction;
    }
  | {
      type: "mission_action";
      mission: string;
      revision: string;
      action: ControlAction;
    }
  | { type: "private_recovery"; mission: string; audience: string }
  | {
      type: "reconcile_private";
      mission: string;
      audience: string;
      member: string;
      revocation: string;
      accepted: string | null;
    }
  | { type: "artifacts"; mission: string; query: ArtifactQuery }
  | { type: "artifact_detail"; mission: string; revision: string }
  | {
      type: "artifact_action";
      mission: string;
      control: string;
      conversation: string;
      action: ArtifactAction;
    }
  | { type: "artifact_transfer"; mission: string; transfer: ArtifactTransfer }
  | { type: "state" }
  | { type: "missions"; before: string | null }
  | { type: "create_mission"; definition: MissionDefinition }
  | {
      type: "update_instructions";
      mission: string;
      revision: string;
      definition: MissionDefinition;
    }
  | {
      type: "set_coordination";
      mission: string;
      revision: string;
      mode: Coordination;
    }
  | { type: "set_plan"; mission: string; revision: string; text: string }
  | {
      type: "start_mission";
      mission: string;
      revision: string;
      readiness: string | null;
    }
  | { type: "pause_mission"; mission: string; revision: string; reason: string }
  | {
      type: "appoint_coordinator";
      mission: string;
      revision: string;
      contribution: string;
      label: string;
      runtime: string;
    }
  | { type: "work_evidence"; mission: string; event: string }
  | { type: "workstreams"; mission: string }
  | { type: "tasks"; mission: string; query: TaskQuery }
  | { type: "work"; mission: string; revision: string; action: WorkAction }
  | { type: "agents"; mission: string; after: string | null }
  | {
      type: "share_agent";
      mission: string;
      terms: string;
      contribution: string;
      label: string;
      contributor_name: string;
      runtime: string;
      role: AgentRole;
    }
  | { type: "withdraw_agent"; mission: string; registration: string }
  | {
      type: "direct_agent";
      mission: string;
      revision: string;
      registration: string;
      text: string;
    }
  | {
      type: "agent_request";
      mission: string;
      contribution: string;
      registration: string;
      operation: AgentOperation;
    }
  | { type: "open_agent_conversation"; mission: string; registration: string }
  | { type: "query_messages"; mission: string; query: MessageQuery }
  | { type: "mark_messages_read"; mission: string; ids: Array<string> }
  | { type: "network_state" }
  | { type: "configure_network"; config: NetworkConfig }
  | { type: "discovery_state" }
  | { type: "configure_discovery"; config: DiscoveryConfig }
  | {
      type: "publish_listing";
      mission: string;
      summary: string;
      capabilities: Array<string>;
      active: boolean;
    }
  | { type: "withdraw_mission"; mission: string }
  | { type: "withdrawals" }
  | { type: "review_contribution"; mission: string }
  | { type: "issue_invitation"; mission: string }
  | { type: "inspect_invitation"; ticket: string }
  | {
      type: "request_join";
      ticket: string;
      reviewed_mission: string;
      reviewed_revision: string;
    }
  | { type: "local_joins" }
  | { type: "peers"; mission: string }
  | { type: "decide_join"; mission: string; author: string; admit: boolean }
  | { type: "revoke_invitations"; mission: string }
  | { type: "revoke_member"; mission: string; author: string }
  | { type: "create_audience"; mission: string; readers: Array<string> }
  | { type: "audiences"; mission: string }
  | {
      type: "post_message";
      mission: string;
      audience: string | null;
      text: string;
      to: string | null;
      thread: string | null;
    }
  | {
      type: "messages";
      mission: string;
      audience: string | null;
      before: string | null;
    }
  | { type: "shutdown" };
