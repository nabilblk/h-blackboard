export type Role = "agent" | "coordinator";
export interface Base {
  id: string;
  type: string;
  channelId: string;
  version: number;
  createdAt: number;
}
export interface Criterion {
  id: string;
  text: string;
  met: boolean;
}
export interface Mission extends Base {
  name: string;
  objective: string;
  scope: string;
  criteria: Criterion[];
  coordinatorId: string | null;
  defaultStreamId: string;
  plan: string;
  state: "active" | "paused" | "closed";
  archived?: boolean;
  archivedAt?: number | null;
}
export interface MissionList {
  missions: Mission[];
  archivedMissions: Mission[];
}
export interface Stream extends Base {
  name: string;
  goal: string;
  isDefault: boolean;
  archived: boolean;
}
export interface Agent extends Base {
  name: string;
  runtime: "claude" | "codex";
  role: Role;
  capabilities: string;
  streamId: string;
  lastSeen: number;
  status: string;
  control: "pause" | "resume";
  direction: string;
  online: boolean;
  humanDirected: boolean;
  execution?: ExecutionInfo | null;
}
export interface ExecutionInfo {
  environment: "local";
  host: string;
  workspace: string;
  workspaceRoot: string;
  shared: string | null;
  layout: "per-agent" | "shared" | "legacy";
  permissions: "default" | "full" | "board-only";
  runtimeVersion: string;
  stdoutPath: string;
  stderrPath: string;
  pid: number;
  startedAt: number;
  reportedAt: number;
  lastError: string | null;
}
export interface Message extends Base {
  authorId: string;
  streamId: string | null;
  directAgentId?: string | null;
  addressedAgentId?: string | null;
  visibility?: "public" | "private";
  seen?: boolean;
  body: string;
  kind: string;
  audience: string;
  refs: string[];
  threadId: string | null;
  sequence: number;
  removed: boolean;
  editedAt?: number;
}
export interface DirectConversation {
  agentId: string;
  lastMessage: Pick<Message, "id" | "authorId" | "createdAt" | "sequence"> & {
    preview: string;
  };
  unread: number;
}
export type MessageView = "channel" | "dm" | "directs" | "inbox" | "sent";
export interface Assignment extends Base {
  agentId: string;
  streamId: string;
  instruction: string;
  issuedBy: string;
  status: string;
}
export interface AgentRequest extends Base {
  count: number;
  capabilities: string;
  reason: string;
  streamId: string;
  requestedBy: string;
  status: string;
  response: string;
}
export interface Task extends Base {
  title: string;
  description: string;
  criteria: string;
  mode: "individual" | "parallel";
  agentIds: string[];
  streamId: string;
  status: string;
  summary: string;
  refs: string[];
  createdBy?: string;
  updatedBy?: string;
  updatedAt?: number;
}
export interface Context {
  mission: Mission;
  workstreams: Stream[];
  agents: Agent[];
  assignments: Assignment[];
  requests: AgentRequest[];
  tasks: Task[];
  messages: Message[];
  cursor: number;
  serverTime: number;
  selfId: string;
  directMessages: DirectConversation[];
  inboxUnread: number;
}
export interface Session {
  selfId: string;
  url: string;
  cli: string;
  node: string;
}
export type SharedRecord =
  Message | Stream | Agent | Task | Assignment | AgentRequest;
export type Modal = {
  kind:
    | "mission"
    | "edit-mission"
    | "invite"
    | "stream"
    | "edit-stream"
    | "assignment"
    | "task"
    | "plan";
  agent?: Agent;
  stream?: Stream;
};
export type Panel = {
  kind: "mission" | "agents" | "requests" | "tasks" | "record";
  record?: SharedRecord;
};
