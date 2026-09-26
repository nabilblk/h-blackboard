import { z } from "zod";
import { artifactOperations } from "./artifacts.mjs";
import { budgetOperations } from "./budget.mjs";
const id = z.string().min(1).max(100),
  text = z.string().trim().min(1).max(16000),
  short = z.string().trim().min(1).max(180),
  optional = z.string().max(16000).default("");
const channel = { channel_id: id },
  version = { version: z.number().int().positive() },
  refs = z.array(id).max(30).default([]);
export const operations = {
  ...artifactOperations,
  ...budgetOperations,
  runner_pair: {
    description:
      "Human: create a single-use, mission-scoped link to connect an execution runner. This does not start agents.",
    schema: z.object({ ...channel }),
  },
  agents_resume: {
    description:
      "Human: ask the paired runners to resume existing agent sessions. The runner resolves saved execution references; no shell command or path is accepted. Mission start and pause rules still apply.",
    schema: z
      .object({ ...channel, agent_ids: z.array(id).min(1).max(1000) })
      .strict(),
  },
  context_read: {
    description:
      "Read the mission, startup readiness, and your participation permission before acting. Joining is not permission to execute. Includes plan, workstreams, pending assignments, tasks, human requests and conversation. Use records_read for full lists and messages_read for more history.",
    read: true,
    schema: z.object({ ...channel }),
  },
  messages_read: {
    description:
      "Read a channel, private conversation (direct_agent_id), or thread. Agents can read only their own private conversation with the human. before loads earlier history.",
    read: true,
    schema: z.object({
      ...channel,
      stream_id: id.optional(),
      thread_id: id.optional(),
      direct_agent_id: id.optional(),
      before: z.number().int().optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
  },
  messages_search: {
    description:
      "Search message history across this mission. Private messages are visible only to their participants. Human inbox and sent views support visibility and recipient filters.",
    read: true,
    schema: z.object({
      ...channel,
      view: z.enum(["all", "inbox", "sent"]).default("all"),
      query: z.string().trim().max(200).default(""),
      visibility: z.enum(["all", "public", "private"]).default("all"),
      agent_id: id.optional(),
      audience: z.enum(["everyone", "coordinator", "human"]).optional(),
      stream_id: id.optional(),
      direct_agent_id: id.optional(),
      unread: z.boolean().default(false),
      before: z.number().int().optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
  },
  messages_seen: {
    description:
      "Human: mark received messages as read in the workspace inbox.",
    schema: z.object({ ...channel, message_ids: z.array(id).min(1).max(100) }),
  },
  updates_read: {
    description:
      "Read relevant updates after a cursor. Read the full context on joining and after a change of role or mission. Acknowledge only a page you have received.",
    read: true,
    schema: z.object({
      ...channel,
      after: z.number().int().min(0).default(0),
      acknowledge: z.number().int().min(0).optional(),
    }),
  },
  record_read: {
    description: "Read an explicitly referenced record in this mission.",
    read: true,
    schema: z.object({ ...channel, id }),
  },
  records_read: {
    description:
      "Page through the mission roster, workstreams, assignments, requests or optional tasks. Read totals and nextOffset; use record_read for a specific ID.",
    read: true,
    schema: z.object({
      ...channel,
      type: z.enum(["agent", "workstream", "assignment", "request", "task"]),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(50),
    }),
  },
  mission_create: {
    description:
      "Human: create a preparing mission with its default Main workstream. Joining does not authorize execution.",
    schema: z.object({
      name: short,
      objective: text,
      scope: optional,
      criteria: z.array(short).max(50).default([]),
      coordination_mode: z.enum(["coordinated", "peer"]).default("coordinated"),
    }),
  },
  mission_update: {
    description:
      "Human: update mission instructions and criterion definitions. Unchanged criteria retain their progress; changed wording resets progress. Use criterion_update to report status. Use the current mission version.",
    schema: z.object({
      ...channel,
      ...version,
      name: short,
      objective: text,
      scope: optional,
      criteria: z
        .array(
          z.object({
            id: id.optional(),
            text: short,
            met: z.boolean().optional(),
          }),
        )
        .max(50),
    }),
  },
  criterion_update: {
    description:
      "Current coordinator or human: report one mission completion criterion as met or not yet met. Read context_read for its criterion ID and current mission version. Always explain the evidence or remaining gap in summary. A coordinator marking met must reference at least one supporting public board record in refs; publish evidence with message_post first if needed. This records a report, not automatic verification. It cannot change the criterion wording or close the mission. Agents may report progress only during active execution.",
    schema: z
      .object({
        ...channel,
        ...version,
        criterion_id: id,
        met: z.boolean(),
        summary: text,
        refs,
      })
      .strict(),
  },
  mission_state: {
    description:
      "Human: prepare, start, pause, or close the mission. Starting requires the current version and coordinator readiness in coordinated mode.",
    schema: z.object({
      ...channel,
      version: z.number().int().positive().optional(),
      state: z.enum(["preparing", "active", "paused", "closed"]),
      reason: text,
    }),
  },
  coordination_set: {
    description:
      "Human: explicitly choose coordinated or peer collaboration. Changing mode returns the mission to preparation.",
    schema: z.object({
      ...channel,
      ...version,
      mode: z.enum(["coordinated", "peer"]),
    }),
  },
  coordinator_ready: {
    description:
      "Coordinator: after reading the current mission and publishing an initial shared plan, acknowledge readiness for this startup revision. Only the human starts execution. Read context_read for startupRevision; stale acknowledgments are rejected.",
    schema: z.object({ ...channel, revision: z.number().int().positive() }),
  },
  agent_admit: {
    description:
      "Coordinator or human: give joined agents permission to work under a shared direction after the mission starts. Use for arrivals in an active coordinated mission; no task or extra workstream is needed. Assignment creation also supplies admission. This does not start a preparing mission or override a human pause.",
    schema: z.object({
      ...channel,
      agent_ids: z.array(id).min(1).max(1000),
      instruction: text,
    }),
  },
  mission_archive: {
    description:
      "Human: archive a channel to hide it from active channels and make its history read-only, or restore it. Archiving pauses active work; restoring does not resume agents. Use the current mission version.",
    schema: z.object({ ...channel, ...version, archived: z.boolean() }),
  },
  coordinator_set: {
    description:
      "Human: appoint, replace, or remove the coordinator. Only Coordinator and Agent roles exist.",
    schema: z.object({
      ...channel,
      ...version,
      agent_id: id.nullable(),
      reason: text,
    }),
  },
  plan_update: {
    description:
      "Coordinator or human: publish the shared plan and rationale. Tasks are optional. During preparation this invalidates readiness; read the current startupRevision before coordinator_ready.",
    schema: z.object({ ...channel, ...version, plan: text, refs }),
  },
  stream_create: {
    description:
      "Create an optional workstream with a goal. Coordinator or human; any agent in peer mode.",
    schema: z.object({ ...channel, name: short, goal: text }),
  },
  stream_update: {
    description:
      "Change a workstream goal or archive an additional workstream. Existing messages remain available.",
    schema: z.object({
      ...channel,
      ...version,
      stream_id: id,
      name: short,
      goal: text,
      archived: z.boolean().default(false),
    }),
  },
  stream_join: {
    description:
      "Join a workstream yourself in peer mode. In coordinated mode request assignment from the coordinator. No task is required.",
    schema: z.object({ ...channel, stream_id: id, direction: text }),
  },
  assignment_create: {
    description:
      "Coordinator or human: give an existing agent a workstream direction, including Main. This admits a late arrival to an active mission but cannot start a preparing mission. Assignment remains pending until acknowledged. Human-directed assignments cannot be replaced by a coordinator until released by the human.",
    schema: z.object({
      ...channel,
      agent_id: id,
      stream_id: id,
      instruction: text,
    }),
  },
  assignment_ack: {
    description:
      "Acknowledge your current pending workstream assignment and declare your approach. This joins the workstream, without creating a task.",
    schema: z.object({ ...channel, assignment_id: id, direction: text }),
  },
  agent_control: {
    description:
      "Human: pause/resume an agent or release a direct human assignment back to coordinator management.",
    schema: z.object({
      ...channel,
      agent_id: id,
      control: z.enum(["pause", "resume", "release"]),
      reason: text,
    }),
  },
  direction_set: {
    description:
      "Declare the direction you are exploring in your workstream. Works without a task.",
    schema: z.object({ ...channel, direction: text }),
  },
  message_post: {
    description:
      "Post publicly by default: audience addresses everyone, coordinator, human, or an agent ID but does NOT make a message private. For a private human-agent conversation set direct_agent_id to that agent's ID (your own ID when replying to the human). Replying with thread_id inherits its privacy. Never copy private content into public messages without the human's instruction. Human instructions have priority.",
    schema: z.object({
      ...channel,
      stream_id: id.optional(),
      thread_id: id.optional(),
      direct_agent_id: id.optional(),
      body: text,
      kind: z
        .enum(["message", "finding", "question", "decision"])
        .default("message"),
      audience: z.string().max(100).default("everyone"),
      refs,
    }),
  },
  message_edit: {
    description:
      "Human: edit or remove a message while retaining an audit event.",
    schema: z.object({
      ...channel,
      message_id: id,
      body: text.optional(),
      remove: z.boolean().default(false),
    }),
  },
  agents_request: {
    description:
      "Coordinator: ask the human for additional agents. Specify the number, capabilities and why more agents are needed. Does not launch instances.",
    schema: z.object({
      ...channel,
      count: z.number().int().min(1).max(1000),
      capabilities: short,
      reason: text,
      stream_id: id.optional(),
    }),
  },
  request_respond: {
    description:
      "Human: answer a request for additional agents, keeping the coordinator informed.",
    schema: z.object({
      ...channel,
      request_id: id,
      response: text,
      status: z.enum(["open", "resolved"]).default("resolved"),
    }),
  },
  task_create: {
    description:
      "Create an execution task that advances the shared plan when ownership, a deliverable or progress tracking is useful. Agents manage tasks; do not ask the human to write them. Ordinary agents may create their own tasks in coordinated mode; the coordinator allocates work across agents. Omitted agent_ids default to yourself; omitted stream_id defaults to your current workstream. Tasks remain optional.",
    schema: z.object({
      ...channel,
      stream_id: id.optional(),
      title: short,
      description: optional,
      criteria: optional,
      mode: z.enum(["individual", "parallel"]).default("parallel"),
      agent_ids: z.array(id).max(1000).default([]),
    }),
  },
  task_update: {
    description:
      "Keep an owned task's status, progress summary and result evidence current so the human can follow the plan's execution. Assigned agents report their work; the coordinator manages ownership across agents. Use the current version. To mark done, publish a complete or inconclusive artifact revision and include its revision ID in refs. A done task does not automatically complete the mission. Human overrides remain available.",
    schema: z.object({
      ...channel,
      ...version,
      task_id: id,
      status: z.enum(["open", "working", "done", "paused"]),
      summary: optional,
      refs,
      agent_ids: z.array(id).max(1000).optional(),
    }),
  },
  invitation_create: {
    description:
      "Human: create an invitation for agents, or one coordinator, with optional initial workstream placement.",
    schema: z.object({
      ...channel,
      role: z.enum(["agent", "coordinator"]).default("agent"),
      stream_id: id.optional(),
    }),
  },
  invitation_revoke: {
    description:
      "Human: revoke an invitation. Existing registered identities remain valid.",
    schema: z.object({ ...channel, invitation_id: id }),
  },
};
export function validate(operation, input) {
  const def = operations[operation];
  if (!def) throw new Error("Unknown operation");
  return def.schema.parse(input);
}
