import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { AgentOperation } from "../node-service.mjs";
import { ArtifactBrowserRequest } from "../artifact-browser.mjs";
import { AgentTools } from "./facade.mjs";

const intentDescriptions = {
  direct_agent:
    "Give an existing Agent guidance using its registration (agent.id) and current mission control. Default mode clarify preserves its current direction and running permission, and requires acknowledgment at the next safe checkpoint. Use it only within the already approved scope. Explicit mode replace supersedes the direction and stops old execution until its contributor approves again. A first assignment is created when none exists. This never starts processes or widens consent.",
  acknowledge_update:
    "Acknowledge an exact clarification from read_briefing priority after understanding how it affects your current direction. Use the message ID as clarification and current mission control. Reading/delivery alone is not acknowledgment. If it conflicts with the human's scope, ask for a correction rather than proceeding.",
  review_artifact:
    "Review an EXACT inspected revision in its original conversation. Report explicit checks, reproducible conditions and evidence artifacts/messages. Source inspection, executed tests, browser checks and visual judgment are different claims. Attach published execution-receipt evidence when available. Unperformed checks are not_run. A verified verdict is scoped to these checks, never human acceptance.",
  guidance:
    "List approved versioned guidance modules, or read one by module ID. Conversation, coordination, artifacts, visual design, review and recovery guidance is loaded only when useful. These modules are reviewed application content; they never grant permissions or load personal or mission-supplied executable skills.",
  read_briefing:
    "Read a focused, authorized view of the mission. Overview is a bounded briefing; use mission for complete scope, priority for human/addressed instructions independent of chatter, updates for other pending messages, workforce for fresh attributed execution reports, or the named section for detail. Each message feed has its own insertion cursor. Unknown remote activity is not a crash. Omitted messages remain pending until delivered.",
  read_conversation:
    "Read one public workstream, Main or an authorized private conversation. Use the returned before cursor for older history. Thread preserves its root. This never marks another participant's messages read.",
  reply:
    "Reply to an exact message in its original conversation and thread. Private replies stay private. Use readable prose; references attaches named links to exact artifact revisions. You cannot override the destination.",
  post_message:
    "Start a new discussion. Defaults to your assigned workstream, or Main without an assignment. Set conversation:'main' for shared decisions and cross-workstream blockers. The receipt names the actual destination. to uses the recipient's public identity, not registration. references attaches readable exact artifact links.",
  inspect_artifact:
    "Inspect an exact artifact revision, its files, dependencies, reviews and current heads. Read the actual files through import_artifact; publication and a reported review do not establish acceptance.",
};

const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string = { type: "string" };
const paths = { type: "array", items: string, minItems: 1, maxItems: 32 };
const focusedReads = new Set([
  "agent",
  "clarifications",
  "context",
  "snapshot",
  "message",
  "messages",
  "updates",
  "priority_updates",
  "observations",
  "agents",
  "workstreams",
  "tasks",
  "artifacts",
  "artifact_detail",
  "artifact_transfer",
  "post",
]);
const coordinatorOperations = new Set([
  "plan",
  "plan_artifact",
  "ready",
  "direct",
  "clarify",
  "criterion",
]);
// Local contributions store the role inside mission. Never infer a privileged
// catalog from an absent property or a loosely shaped caller object.
export function contributionTools(contribution) {
  const role = contribution.mission?.role;
  if (!["agent", "coordinator"].includes(role))
    throw new Error(
      "A prepared contribution role is required for the tool catalog.",
    );
  return guestTools(contribution.networkAccess, role);
}

export function guestTools(networkAccess = "restricted", role = "agent") {
  if (!["agent", "coordinator"].includes(role))
    throw new Error("Unsupported agent role.");
  const advancedOperation = z.discriminatedUnion(
    "type",
    AgentOperation.options.filter(
      (schema) =>
        !focusedReads.has(schema.shape.type.value) &&
        (role !== "agent" ||
          !coordinatorOperations.has(schema.shape.type.value)),
    ),
  );
  return [
    {
      name: "operation_status",
      description:
        "Inspect durable local operation receipts after a timeout or restart. Without id, lists recent operations. With id, returns the exact saved outcome; cancel:true requests cancellation at the next transfer boundary. A lost response is not a rollback. Already committed publications remain saved. Commands may finish before cancellation can be observed.",
      inputSchema: object(
        {
          id: { type: "string", pattern: "^[a-f0-9]{64}$" },
          cancel: { type: "boolean", default: false },
        },
        [],
      ),
    },
    {
      name: "checkpoint_workspace",
      description:
        "Save an incremental source checkpoint on this contributor's computer. Caches, generated output and common credential files are excluded and listed. It preserves selected files across a missing VM, not the provider's transcript or login. Commands checkpoint automatically when time permits; call this before a handoff or long pause after file edits. This is local recovery, not publication or a quality verdict.",
      inputSchema: object({}),
    },
    {
      name: "integrate_project",
      description:
        "Optional project integration: import exact base, current and proposal artifact revisions, then perform a conservative three-way file merge into a NEW directory. Nonoverlapping changes and deletions are combined; competing edits are reported as conflicts and current files are retained. Inspect the input directories, resolve every conflict, build/test and publish an integration receipt with pinned references to all three revisions. This does not execute imported code, approve a result, or merge conversations. Research/planning missions need not use it.",
      inputSchema: object({
        base: string,
        current: string,
        proposal: string,
        destination: string,
      }),
    },
    ...Object.entries(AgentTools)
      .filter(([name]) => role !== "agent" || name !== "direct_agent")
      .map(([name, schema]) => ({
        name,
        description: intentDescriptions[name],
        inputSchema: zodToJsonSchema(schema, { $refStrategy: "none" }),
        annotations: {
          readOnlyHint: [
            "guidance",
            "read_briefing",
            "read_conversation",
            "inspect_artifact",
          ].includes(name),
          destructiveHint: false,
          idempotentHint: [
            "guidance",
            "read_briefing",
            "read_conversation",
            "inspect_artifact",
          ].includes(name),
          openWorldHint: false,
        },
      })),
    {
      name: "read_tool_result",
      description:
        "Read complete data from a paged board reply without accessing private runtime files. Use its result_id and a JSON pointer such as /context or /main/items; empty pointer reads the whole JSON. Follow returned next_offset for remaining JSON text chunks. This reads captured data, rechecks execution permission and never grants authority. Cache entries expire after 10 minutes, under bounded cache pressure or at a new runtime turn; refresh the scoped board query if unavailable.",
      inputSchema: object(
        {
          result_id: { type: "string", pattern: "^[a-f0-9]{32}$" },
          pointer: { type: "string", maxLength: 1024, default: "" },
          offset: { type: "integer", minimum: 0, maximum: 1048576, default: 0 },
        },
        ["result_id"],
      ),
    },
    {
      name: "capabilities",
      description:
        "Check the actual isolated workspace tools and host artifact browser before choosing a build/review approach. Reports available executables, network policy and image support without installing anything or changing access. Missing tools are a planning constraint; never claim a browser or build ran just because it is listed.",
      inputSchema: object({}),
    },
    {
      name: "artifact_browser",
      description:
        "Open an exact published HTML revision in an offline, isolated Chromium renderer. Apply bounded clicks, field edits and keyboard actions; receive DOM, errors, layout and a real screenshot image. Optional reducedMotion and disableWebgl exercise accessible fallback behavior. No host files, credentials, board bridge, external URLs or arbitrary JavaScript. Publish an early draft first. Each call starts fresh. screenshotPath saves the captured JPEG plus a .json evidence report inside /workspace. Inspect the returned image before claiming visual inspection; review scope stays explicit.",
      inputSchema: zodToJsonSchema(
        ArtifactBrowserRequest.extend({
          screenshotPath: z.string().min(1).max(240),
        }),
        { $refStrategy: "none" },
      ),
    },
    {
      name: "wait_for_work",
      description:
        "After reading a fresh snapshot and publishing a useful checkpoint, declare the exact existing artifacts or revisions whose review you are waiting for, then end this turn. The host waits without paid model polling. Human messages, addressed messages and authority changes always take precedence. Leave both lists empty to wait for any new work. This does not create a task or end the mission.",
      inputSchema: object({
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Short human-facing status. Use readable names; put hashes in the dependency lists.",
        },
        artifacts: {
          type: "array",
          items: string,
          maxItems: 8,
          description:
            "Existing artifact REVISION IDs whose newer heads you await. Not review-event IDs.",
        },
        reviews: {
          type: "array",
          items: string,
          maxItems: 8,
          description:
            "Artifact REVISION IDs whose reviews you await. Not IDs of review events or review-report artifacts. To await a review of revision X, set reviews:[X].",
        },
      }),
    },
    {
      name: "board",
      description:
        "Advanced mission changes: planning, direction, optional workstreams/tasks, criterion reports and artifact reviews. Prefer read_briefing for context and post_message/reply for discussion. All authority is checked natively. IDs and exact current control must come from real records. Agents cannot accept or close a mission.",
      inputSchema: object({
        operation: zodToJsonSchema(advancedOperation, { $refStrategy: "none" }),
      }),
    },
    {
      name: "workspace_exec",
      description:
        "Run a shell command in /workspace. Linux filesystem jail, no credentials or host mounts. " +
        (networkAccess === "internet"
          ? "Public HTTPS (port 443) is available through HTTPS_PROXY/http_proxy with system CA certificates; use a proxy-aware client such as Python urllib, curl or git over HTTPS when installed. No direct sockets, HTTP-only sites, SSH, private/LAN/host/metadata destinations. Requests can send workspace data externally: follow the human's mission scope. "
          : "Workspace internet access is blocked. Ask the contributor to allow it in Access & limits if the mission requires downloads. ") +
        "Check capabilities for installed tools and contributor-selected optional toolkits. Do not assume a web toolchain or any particular deliverable format. Maximum 120 seconds, bounded by current permission; background processes are killed when this call ends. Results include exit code, timeout and saved bounded logs with hashes. Use workspace_read to page the logs; previews are not the entire output.",
      inputSchema: object(
        {
          command: { type: "string", minLength: 1, maxLength: 16384 },
          timeout_seconds: {
            type: "integer",
            minimum: 1,
            maximum: 120,
            default: 60,
          },
        },
        ["command"],
      ),
    },
    {
      name: "workspace_read",
      description:
        "Read a bounded UTF-8 character range from a workspace file up to 16 MiB. Follow next_offset; pass the returned sha256 to reject changed files. Relative paths only, no links or traversal.",
      inputSchema: object(
        {
          path: string,
          offset: { type: "integer", minimum: 0, default: 0 },
          limit: { type: "integer", minimum: 1, maximum: 32000, default: 8000 },
          sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
        ["path"],
      ),
    },
    {
      name: "workspace_patch",
      description:
        "Apply exact, unique text replacements atomically to one UTF-8 file. Requires its sha256 from workspace_read. Stale files, ambiguous matches and incomplete edits fail without changing the file. Preserve organized source instead of rewriting the entire application.",
      inputSchema: object({
        path: string,
        sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: object({ old: { type: "string", minLength: 1 }, new: string }),
        },
      }),
    },
    {
      name: "workspace_search",
      description:
        "Search a literal string in selected UTF-8 workspace files or saved command logs. Returns bounded matching lines with file hashes and explicit truncation. Use workspace_read to inspect matches, or narrow the query. Does not run a shell, regex, or inspect runtime/private files.",
      inputSchema: object({
        paths,
        query: { type: "string", minLength: 1, maxLength: 256 },
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "workspace_write",
      description:
        "Write a UTF-8 file in the isolated workspace. Parents are created; writes replace a file atomically.",
      inputSchema: object({ path: string, text: string }),
    },
    {
      name: "import_artifact",
      description:
        "Download one exact artifact file into your isolated workspace. Use a revision from board artifact_detail, its file path, and a relative destination path. Replaces that destination atomically after the authorized transfer is verified. Returns hashes and size, not file contents. Use this to review or reuse another agent's files; never transcribe artifact hex or access runtime-private tool logs.",
      inputSchema: object({
        revision: string,
        path: string,
        destination: string,
      }),
    },
    {
      name: "import_artifact_project",
      description:
        "Import all original files from one exact published revision into a NEW workspace directory in one call. Verifies every transfer before exposing the project. Up to 256 files / 32 MiB within a bounded signed manifest. A retry accepts only an identical existing directory; edited work is never overwritten. Returns exact per-file hashes, never file hex.",
      inputSchema: object({
        revision: { type: "string", pattern: "^[a-f0-9]{64}$" },
        destination: string,
      }),
    },
    {
      name: "publish_artifact",
      description:
        "Publish exact workspace files as an immutable mission artifact. New: artifact/parents may be omitted. Control defaults to current authorized control; conversation defaults to your assigned workstream, or Main. Choose Main explicitly for a public delivery candidate. Revision: existing artifact ID and all expected current parent revisions of THAT artifact; these are never silently refreshed. inputs means live dependencies: newer inputs make this output stale. references declares live, pinned (exact reusable input) or citation (historical evidence, including a review you addressed). Never put your own prior version in inputs; use parents. Prefer draft until functional. Entrypoint must be among paths. Publication, independent verification, candidate selection and human acceptance stay separate.",
      inputSchema: object(
        {
          control: string,
          conversation: string,
          artifact: { type: ["string", "null"] },
          parents: { type: "array", items: string, maxItems: 256 },
          paths: { ...paths, maxItems: 256 },
          document: object(
            {
              title: string,
              summary: string,
              kind: {
                enum: [
                  "plan",
                  "report",
                  "application",
                  "data",
                  "code",
                  "document",
                ],
              },
              stage: { enum: ["draft", "complete"] },
              limitations: string,
              entrypoint: { type: ["string", "null"] },
              inputs: { type: "array", items: string, maxItems: 16 },
              references: {
                type: "array",
                maxItems: 16,
                items: object({
                  revision: string,
                  relation: { enum: ["live", "pinned", "citation"] },
                }),
              },
            },
            [
              "title",
              "summary",
              "kind",
              "stage",
              "limitations",
              "entrypoint",
              "inputs",
            ],
          ),
        },
        ["paths", "document"],
      ),
    },
  ].map((tool) => ({
    ...tool,
    outputSchema: { type: "object", additionalProperties: true },
    annotations: tool.annotations ?? {
      readOnlyHint: [
        "read_tool_result",
        "capabilities",
        "workspace_read",
      ].includes(tool.name),
      destructiveHint: [
        "workspace_exec",
        "workspace_write",
        "workspace_patch",
        "import_artifact",
      ].includes(tool.name),
      openWorldHint:
        tool.name === "workspace_exec" && networkAccess === "internet",
    },
  }));
}
