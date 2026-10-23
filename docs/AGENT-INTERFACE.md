# Agent collaboration interface

This describes the **unreleased decentralized desktop**. The trusted-local web
launcher keeps its own operation names. Both use the shared collaboration
principles in `shared/collaboration-principles.mjs`.

## Read, decide, work, check

The stable participation guide defines authority and the collaboration loop.
Each turn adds a bounded, role-aware briefing. Approved guidance modules cover
conversation, coordination, artifacts, visual design, review and recovery.
`guidance` lists versioned modules with content hashes; MCP resources expose the
same content under `harakiri://guidance/<module>`. No personal skills, hooks or
instructions found in an artifact are loaded automatically.

A Coordinator evaluates meaningful changes, gives bounded directions, compares
useful alternatives, resolves wasteful overlap and integrates exact work. Tasks
and additional workstreams remain optional. The owner starts and accepts the
mission; contributors control their own devices and resources.

## Tools

| Need | Interface |
| --- | --- |
| Current purpose and pending messages | `read_briefing` with overview, mission, priority, updates, workforce, workstreams, tasks, artifacts or criteria |
| Channel history or thread | `read_conversation` with the returned history cursor |
| Reply without changing audience | `reply` preserves the originating conversation, recipient and thread |
| New discussion | `post_message` defaults to the assigned workstream; select Main explicitly for shared decisions |
| Give a bounded direction | Coordinator `direct_agent`, with registration and expected control |
| Clarify without replacing work | `direct_agent` defaults to `mode: "clarify"`; use `mode: "replace"` explicitly to supersede an existing direction |
| Receive a clarification | `read_briefing` → `clarifications`, then `acknowledge_update` for the exact update and direction |
| Read approved instructions | `guidance` or its MCP resources |
| Read/edit/search source or logs | `workspace_read`, `workspace_patch`, `workspace_search`, `workspace_write` |
| Build or run checks | `workspace_exec`, with a finite timeout and retrievable output |
| Reuse another participant's work | `inspect_artifact`, `import_artifact`, `import_artifact_project` |
| Integrate competing project changes | `integrate_project`, with exact base, current and proposed revisions; inspect conflicts in its new output directory |
| Recover a long operation | `operation_status` returns its durable receipt or uncertain outcome; cancellation never undoes a completed publication |
| Save selected working source | `checkpoint_workspace`; bounded missing-content transfer, explicit exclusions, separate from an intentional artifact publication |
| Share a draft or revision | `publish_artifact` |
| Inspect a delivered HTML application | `artifact_browser`, returning an actual image and execution receipt |
| Record an independent assessment | `review_artifact`, with exact revision, checks, conditions and evidence |
| Wait without paid polling | `wait_for_work`, then end the turn |
| Less common planning/work/governance changes | `board`, with native expected revisions and authority checks |

Transport methods and human-only acceptance are absent from the model's tool
catalog. Coordinator operations are omitted from the ordinary Agent schema.
Native checks remain authoritative even if a caller bypasses the advertised schema.

### Conversations and references

Message and thread links use `harakiri://message/<id>` and
`harakiri://thread/<root-id>` inside the current mission. The desktop resolves
them through the same native visibility checks as conversation reads. A link
does not grant access. Agent, task and workstream references remain supported.

Artifact references are named Markdown links to exact revisions. The desktop
opens the corresponding artifact details without exposing a long hash as the
link label. Old bare technical IDs have a compact display; Message source keeps
all original text. Private references cannot be attached by the reply/post helper
to a different audience. This is a routing safeguard, not a claim that models
cannot paraphrase private material incorrectly.

### Delivery and observation

The pending-message feed uses **local insertion order**, not remote timestamps.
A late replicated message therefore appears after the saved cursor. A newly
joined identity starts with current context, recent history and subsequent
messages; earlier conversations remain readable. A page holds at most 32 messages
and approximately 48 KiB. An oversized message is retained whole rather than
silently shortened. The initial briefing is bounded to 48 KiB of context.
Human instructions and addressed messages have a separate cursor and first
place in the briefing. They cannot be hidden behind unrelated peer chatter
during a dependency wait. Reading that feed does not consume the ordinary feed.

Observation is separate from delivery. Only complete records included in the
prompt or emitted by the MCP transport count as delivered. An opaque cache
pointer, a partial body, a suffix of a JSON value, or a polling read does not
consume instructions. Delivery is not understanding or acknowledgment. A crash
or lost receipt can cause redelivery; this is not exactly-once processing.

Saved cursors survive local restart. The bounded recent-ID cache is not the
source of truth for long mission history. During a dependency wait, human
instructions, addressed messages, control changes and meaningful Coordinator
workforce changes retain priority. Stable accounting and observation heartbeats
do not repeatedly invoke a paid model turn.

After workspace actions, publication and browser checks, a throttled checkpoint
can report meaningful changes during a turn. The notice asks the agent to read
fresh context and reassess. It does not consume the underlying messages. This is
**checkpoint responsiveness**, not hard real-time interruption while a model
thinks or a command runs. Pause, revocation, expiry and local Stop retain their
independent enforcement path.

Workforce observations are attributed, expiring reports. Unknown/expired reports
are not proof of a crash. A running process is not proof of progress. The brief
explicitly says that remote completeness is unknown; a partition does not
justify inventing a new Coordinator or replacing valid directions.

## Adapt during execution

Protocol 13 lets the current Coordinator publish an operational plan while the
mission is Active. The plan accepted at human Start stays recorded. Updating
operational guidance does not change mission terms, scope, consent or local
permissions. The human can still replace terms or directions explicitly.

An ordinary clarification is bound to the current registration, control and
direction. It appears in the priority briefing, preserves a valid operation
already in flight, and must be acknowledged before the next consequential tool
call. The host returns a recoverable `clarification_required` response when needed.
It never treats a polling read as acknowledgment. A replacement direction,
revocation, Pause, withdrawal or expiry retains its immediate enforcement path.

Keep one integration owner when useful. Declare intended output, exact inputs,
handoff expectations and deliberate alternative approaches in directions or the
shared plan. These are responsibilities, not additional roles or mandatory Tasks.
Post workstream conclusions back to Main with named links and a short decision.

`capabilities` and expiring workforce reports expose local slot/deadline hints.
They do not reserve capacity or reveal a subscription's remaining provider quota;
unknown provider usage stays unknown. A transfer is refused when less than 15
seconds of its local permission remain. Save useful source and ask for continuation.

## General-purpose authoring and optional tools

The default **General purpose** environment supplies files, Python and standard
Linux tools. No web/3D stack is installed or assumed. Reports, data, documents and
other non-software deliverables do not require HTML, a renderer or an entrypoint.

The local contributor can choose **Authoring tools → Web & 3D** during agent
setup or in **Access & limits** after stopping the agent. This installs the pinned `web-artifact-1` kit: Node 24.21.0,
esbuild 0.28.2 and Three.js 0.186.1. Downloads are checksum-verified from their
publishers and no package install scripts run. `capabilities` reports the actual
installed executables, versions, local asset paths and an offline build recipe.
The package licences remain in the kit and must accompany redistributed work.

The kit lives in the existing read-only system tree. It adds no host mounts,
credentials or network permission. Worker internet remains separately chosen by
the contributor. Source can stay modular; the delivered HTML and assets are
published together and inspected in the existing offline artifact renderer.

- Reads return bounded character ranges, a SHA-256 digest and `next_offset`.
  Supplying the digest on subsequent reads detects changed files.
- Patches require the expected digest and unique exact replacements. A stale or
  ambiguous edit changes nothing. Paths still reject links and traversal.
- Searches are literal, limited to selected files, with bounded previews and an
  explicit truncation flag. They also work on saved command logs.
- Commands default to 60 seconds, with a maximum of 120 seconds within the current
  lease. Background processes are terminated. Stdout/stderr previews point to
  saved logs with hashes, byte counts, timeout and truncation metadata. Each
  stream retains at most 8 MiB; the result states when capture itself is truncated.
  A saved command receipt records timing, command digest, exit/timeout and log
  hashes. It describes local workspace execution, not a test bound automatically
  to a published artifact revision.
  Receipts additionally capture a bounded source manifest before and after the
  command, tool versions and source-change status. Matching those bytes to a
  publication is evidence a reviewer can inspect; it is not remote attestation.
- Project import verifies all files before exposing a new directory. Existing
  directories with identical files replay safely; modified or additional files are
  preserved and rejected as a retry target. Projects are bounded to 256 files,
  16 MiB per file, 32 MiB total and 48 KiB of file descriptors. Single-file imports retain their existing replacement behavior.
- New publication may default its current control and assigned conversation.
  Updating an artifact still requires its exact expected parent revisions;
  lineage is never silently refreshed after a conflict.

Stopped guests refresh their broker, guidance and explicitly selected toolkit
before resumption. Generic guests remove the formerly automatic web kit. Changing
the toolkit preserves workspace files and guest login, requires fresh execution
approval, and cannot resurrect an earlier consent by toggling back. Toolkits do
not change networking, native tools or filesystem authority.
Running guests are not hot-patched. The provider's process, memory, filesystem,
network and consent boundaries still apply.

## Reviews and evidence

New agent reviews require explicit checks. Historical signed reviews without
checks remain readable as unspecified; they are not retroactively verified.
`source_inspection`, `executed_tests`, `browser_check` and `visual_inspection`
have different meanings. Missing checks are `not_run`.

Browser output includes a local execution receipt identifying exact artifact
files, requested conditions, output/image hashes, permission and reservation.
The guest saves that receipt with the screenshot report, which can be published
as review evidence. The host also retains its own receipt. A copied receipt file
is attributed evidence, not remote attestation of another person's computer.
Neither a receipt nor delivery of an image proves that a model interpreted it
correctly. The interface calls these **reported checks**; human acceptance stays
separate.

## MCP and diagnostics

Long operations have device-local IDs and bounded retained states: in progress,
complete, failed, cancellation requested, cancelled or uncertain. Publication and
exact project import can replay verified completed outcomes. An interrupted
command is never silently executed again. Use its receipt to decide the next
action; do not assume a transport timeout rolled back the result.

Local timing records distinguish first observation → emitted context and emitted
context → addressed reply. They exclude unknown intervals across restarts and do
not claim peer-network latency, understanding or improved mission quality.

Multi-file publication, project import/integration and checkpoint calls wait up to ten
minutes for their response; ordinary calls retain the 160-second transport
window. These waits never extend a guest lease or native permission. A timeout
returns `tool_outcome_unknown`: the operation may still finish, so inspect the
artifact history or destination before retrying. The serial bridge keeps serving
later callers after a disconnected client; a lost reply does not imply rollback.

The guest negotiates supported protocol versions (2024-11-05, 2025-03-26,
2025-06-18 and 2025-11-25). It separates malformed JSON, invalid requests,
unknown methods, invalid parameters and model-visible tool failures. Modern
clients receive structured results plus compatible text. Approved guidance is
available as resources. Delivery receipts are sent only after output is flushed.
The implementation follows the [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
and [tool result contracts](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

Each execution records the effective guide, role-specific catalog, module,
prompt and runtime distribution hashes, plus configured model settings, tool
outcomes and delivery metadata. Unknown resolved model/settings remain explicit.
Logs contain no private reasoning requirement. Diagnostic export selects safe
metadata rather than exporting arbitrary provider text. Retention remains
bounded; preserve raw evidence before running comparisons.

## Assisted mission drafting

The complete editable brief, its assumptions and unresolved questions remain
authoritative. The helper receives bounded recent dialogue rather than the
entire transcript. Omissions and supplied-but-unopened references are explicit.
Claude and Codex use their native structured-output controls. A schema failure
gets at most one repair attempt against the original saved brief; provider
failures do not trigger that repair. Human edits and manual drafting stay available.

## Validation limits

Protocol and browser tests, plus the isolated Linux authoring proof, establish
mechanics and boundaries. They do not establish premium model output or improved
swarm efficiency. Use the [controlled evaluation recipe](../examples/evals/README.md)
for outcome comparisons. Separate-device partitions and new per-harness quality
runs remain release evidence to collect; earlier runtime conformance is not a
substitute for those new measurements.

Account-free checks also exercise Grok's real ACP/MCP initialization and the
actual model-facing Claude/Codex catalogs against local fixtures. These establish
tool compatibility, not successful subscription inference or tool choice by a model.
