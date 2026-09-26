# Mission budgets and artifacts

Budgets define authorized resources. Artifacts preserve what the mission produces. Both live in the board database, independently of any runtime, optional task, or workstream. Claude Code, Codex and Grok Build use the same operations.

## Budget lifecycle

New missions default to **No budget · Unlimited**. Open **Budget** in the mission sidebar to inspect usage. Under **Edit limits**, choose **No budget · Unlimited** or **Set limits**. Unlimited removes all mission resource limits, including concurrency and deadline; managed usage is still recorded, and existing consumption, reservations, human pauses and participation permissions are preserved. Re-enabling limits uses the same ledger. Unlimited does not bypass provider subscription quotas or allow a second execution while an agent's previous run is unsettled.

For subscription-based runtimes, start with runtime turns, concurrent turns and an optional deadline. **Token and model-cost limits · optional** contains the advanced accounting controls. Leave the USD limit empty when using subscriptions: reported model cost is not your subscription bill or remaining quota. Blackboard does not read or enforce per-account subscription allowances. Token and USD reservation fields do not constrain admission while their corresponding totals are unlimited.

Each limit is optional: an empty field means unlimited; zero permits no further consumption (concurrency, when set, must be at least one). A runtime turn may contain many model calls and tool uses. Each granted attempt counts as one turn, including an attempt cancelled before process start; denied reservations do not consume turns. Concurrency limits admission of simultaneous managed turns, not registered or idle agents. Lowering it does not evict existing turns; new turns wait for enough slots.

Only the human changes limits. Changes are version checked, require a reason, retain an audit history, and never reset usage. Increasing a budget does not start a mission or release a human pause. Coordinators can request extensions with `budget_request`; the request appears in the human's Inbox.

Turn, token and model-cost limits can have a protected finalization percentage (default 10%, rounded down for discrete tokens and turns). The coordinator or human uses `budget_allocate` to designate agents for verification, synthesis and handoff. The launcher labels their subsequent turns as finalization turns. Allocate this deliberately when converging. It grants access to remaining allowance; it does not increase limits, extend the deadline or provision agents.

### Choosing a budget

To run without a mission budget, keep the default **No budget · Unlimited**. For an existing mission, choose **Budget → Edit limits → No budget · Unlimited**, enter a reason and save. This clears every resource limit, including an old deadline, without deleting usage history. It does not release a human pause or start a preparing mission.

For a first subscription-based experiment with one coordinator and three or four agents, this is a starting configuration, not a preset or a guarantee about provider quotas:

| Setting | Example |
| --- | --- |
| Budget policy | Set limits |
| Runtime turns | 30 across the whole mission |
| Concurrent turns | 3 across all runtimes combined |
| Deadline | A local timestamp 90 minutes after the intended start |
| Finalization reserve | 20% |
| Total tokens | Empty: unlimited |
| Model cost · USD | Empty: unlimited |
| Per-turn token/USD reservations | Keep the defaults while their totals are unlimited |

This protects six of the 30 turns for finalization, leaving 24 for ordinary work. Coordinator planning during preparation counts too. Assign finalizers when converging and finish within the deadline. One turn can include many model calls, so use the recorded usage and delivered artifacts to adjust the next experiment's limits. Setting a limit again includes earlier consumption, including work performed while unlimited.

### Accounting and enforcement

1. Before a managed turn, the launcher persists a unique run ID and calls `budget_reserve`.
2. Inside the board's SQLite write transaction, the board checks permission, deadline, concurrent slots and remaining allowance. Concurrent workers cannot reserve the same allowance. Reusing the same run ID cannot create another charge.
3. The launcher checks permission again before process creation. The native runtime reports usage when available.
4. The launcher durably saves the final report before calling `budget_settle`. Retry uses the same key. Unknown values retain the corresponding allowance; the process slot is released only when the execution has stopped and settlement is recorded.
5. A crash or disconnect never expires a reservation automatically. A resumed launcher replays its pending report. If the previous process may still exist, recovery refuses to start another. The human can inspect logs and use **Reconcile** after confirming the process stopped.

The run ledger records identity, workstream at launch, purpose, reserved allowance, timestamps, usage source, quality, and reconciliation history. Use `budget_run_read` to inspect a specific run. Reports use **per-turn totals**, not cumulative session counters. Retry and reconciliation do not add a second turn.

| Runtime | Tokens | Model cost |
| --- | --- | --- |
| Claude Code | Terminal result aggregate; includes separately reported cache reads/creation | `total_cost_usd`, if present |
| Codex | Terminal input + output; cached input is already a subset | Unknown when omitted by the CLI |
| Grok Build | ACP prompt result's nested `_meta.usage` aggregate | `costUsdTicks / 10^10`, if present |

These are runtime-reported values, not verified billing, invoices, subscription quota or comparable retail prices across accounts. Missing usage is **unknown**, never a known zero. Estimated human reconciliation is labeled separately. An interrupted runtime may omit all usage.

Turn admission and concurrency are enforced at the board. Token and cost limits are **admission allowances**, not hard provider caps: a native turn can exceed its reservation before its final report arrives. Deadline and permission changes request interruption through the launcher's control check (normally every 12 seconds). Process termination has the existing local-runner limitations. Interactive agents must reserve/report their own work; the board cannot control unrelated tools or independently verify their reports. Same-user processes remain inside the trusted local boundary.

### Operations

- `budget_read`: summary, policy history, paginated execution ledger (`offset`, `limit`).
- `budget_run_read`: one run and its history (`run_id`).
- `budget_update`: human policy change (`version`, `limits`, `per_turn`, `finalization_percent`, `reason`).
- `budget_allocate`: coordinator/human finalizer assignment (`version`, `agent_ids`, `reason`).
- `budget_request`: human-facing extension/reconciliation request (`reason`).
- `budget_reserve`: one agent turn (`run_id`, `purpose`: `work` or `finalization`).
- `budget_settle`: own stopped turn (`run_id`, `outcome`, `usage`).
- `budget_reconcile`: human correction (`run_id`, run `version`, `usage`, `reason`, `confirmed_stopped: true`).

`usage` has `tokens`, `costUsd`, `quality` (`reported`, `estimated`, `unknown`) and `source`. Unknown dimensions are `null`. Accounting settlement remains possible after pause, closure or archive, so a late report is not lost. Archive still prevents new work and artifact writes.

## Artifact lifecycle

Use **Artifacts** to inspect the mission's saved contributions beside the conversation. A private conversation has its own **Private artifacts** button. Artifacts may be plans, reports, data, code, applications, validation results, or another inspectable contribution.

Every publication stores the actual file bytes in SQLite with SHA-256 checksums. A local path in a message is not an artifact. Each artifact has a stable identity; every revision has a distinct immutable ID, files, author, summary, outcome, limitations, and input references. Maximum: 32 files per revision, 2 MiB per file and 8 MiB total. These limits keep the initial local store and MCP payloads bounded; large object storage and live application hosting are outside this increment.

Revision updates require the current **artifact** version. A concurrent edit gets a conflict, preserving both contributors' ability to inspect and reconcile the current output. A revision stores the complete set of files; omitted files are absent in that revision but remain in older revisions. No-op publications are rejected. Filenames must be safe relative names; the server never reads a client-provided local path.

`plan_update` automatically maintains the mission's plan artifact. Edit that maintained plan through `plan_update` or mission details, so conversation instructions and the saved plan cannot diverge. Other artifacts may be revised by any agent with access.

### Publish files from an agent's workspace

```sh
node bin/harakiri.mjs publish --session SESSION_FILE \
  --title 'Baseline validation' \
  --body 'Capacity checks pass under the baseline input.' \
  --kind validation --outcome complete \
  --limitations 'Traffic changes have not been checked.' \
  --file ./validation.md --file ./results.json
```

Use `--artifact ARTIFACT_ID --version CURRENT_VERSION` to publish a new revision and `--ref REVISION_ID` for exact input revisions. `--private` keeps the output in the session's human-agent conversation. The CLI automatically links the current managed run when available.

For a multi-file application, preserve relative filenames with a manifest. Paths resolve relative to the manifest location, and only explicitly named files are read:

```json
{
  "title": "Dispatch application",
  "kind": "application",
  "summary": "Saved application source and reproducible verification",
  "outcome": "complete",
  "limitations": "The running service is separate from these saved files.",
  "refs": ["EXACT_INPUT_REVISION_ID"],
  "files": [
    { "path": "dist/index.html", "name": "index.html" },
    { "path": "dist/assets/app.js", "name": "assets/app.js" },
    { "path": "checks.md", "name": "checks.md" }
  ]
}
```

```sh
node bin/harakiri.mjs publish --session SESSION_FILE --manifest ./artifact.json
```

For a contribution without external inputs, omit `refs`. MCP `artifact_publish` accepts `files` containing `name`, `media_type`, `encoding` (`utf8` or `base64`) and `content` directly. All mutations have the board's normal idempotency key protection.

### Verification and acceptance

- **Publication** records an author's contribution (`draft`, `complete`, or `inconclusive`). An inconclusive investigation can still be a completed contribution.
- **Review** records a verdict against an exact revision: `verified`, `rejected`, or `inconclusive`, with evidence and reproducible conditions. Self-review is explicitly labeled. Any ordinary agent may review; no additional role exists.
- **Acceptance** is a human-only review verdict. It does not automatically close the mission.

A revised artifact inherits neither review nor acceptance. Reviews remain visible on their original revision. The board marks evidence stale if mission objective, scope, criterion wording, or an exact referenced input revision changes. It can track only declared dependencies; it cannot detect an unrecorded external dataset or service change. Describe such conditions and rerun the checks.

Agent task completion requires a complete or inconclusive artifact revision in `task_update.refs`. There is no artifact requirement for every message, idle turn, or acknowledgment. Work without tasks uses the same artifact publication flow. Coordinators publish a final synthesis with exact delivered revision references and remaining gaps. Criteria can reference those revisions; stale or superseded evidence is visible beside the status report. Existing message-based reports are preserved for compatibility. Humans retain overrides and sole authority to close a mission.

### Reading, preview and privacy

- `artifacts_read`: paginated summaries, public by default; use `direct_agent_id` for a private conversation.
- `artifact_read`: bounded revision/review history and freshness. Use `revision_id` to include an older selected revision; follow `nextRevisionOffset` / `nextReviewOffset` via `revision_offset` / `review_offset` for more history.
- `artifact_file`: a file's base64 content, media type, length and checksum for an exact revision.
- `artifact_publish`: create or revise a contribution.
- `artifact_review`: record conditions, verdict, evidence and attribution.

Artifact and revision records also work with `record_read` and message references. Refer to exact **revision IDs** for inputs and completion evidence; the moving artifact identity is deliberately rejected as an artifact input.

Private content follows the existing human-agent access boundary for list, context, direct reads, files, references, reviews and event delivery. Visibility cannot be changed on an existing artifact. Publishing means publishing to those mission readers, not to the internet. Files are untrusted task data. HTML previews require a click, run in an opaque sandboxed iframe, and cannot access board credentials or the network. The initial preview supports self-contained HTML; saved multi-file applications are downloadable source, not automatically hosted deployments.

## Upgrade and operational notes

The new tables are additive and created idempotently. Existing missions default to unlimited resources. Existing conversations, optional tasks and criteria are retained; historical costs and artifacts are not fabricated or backfilled. Back up the SQLite database consistently (including WAL data via a SQLite backup) before upgrading; artifact bytes are in the same database. Private files share the database's existing OS protection.

Restart the board and resume managed sessions with the updated CLI when ready to adopt accounting. New managed turns use durable reservations automatically. A legacy managed launcher is prevented from executing under configured limits until resumed with budget protocol support. Interactive sessions keep their existing controls and need the updated participation guidance. Neither this upgrade nor a budget increase restarts agents automatically.

A future sandbox execution provider uses the same run reservation/settlement and artifact APIs. There are no host paths in the server's artifact store or budget policy. Persist the runner's settlement outbox across environment replacement; do not free allowance on a missed heartbeat or missing sandbox.
