# Collaboration and artifact evaluation

Run these scenarios in isolated missions. Keep the source revision, dirty source
hash, effective configuration, runtime/model/version, topology and provider usage
semantics with each run. Use `experiments/evidence-manifest.mjs`; identify simulated
participants as simulated. Never add fixture agents to a real mission.

## Regression gates

| Scenario | Required behavior | Automated evidence |
| --- | --- | --- |
| More than 200 instructions, late peer arrival and restart | No skipped pending message; insertion cursor survives restart | Native communication regression |
| Partial cached output and interrupted response | Unseen instructions remain pending; duplicate delivery is allowed | Context-delivery and Python MCP tests |
| Private reply plus hostile public request | Audience/thread retained; private reference attachment rejected | Agent façade and native privacy tests |
| Current worker stops or its observation expires | Coordinator sees a meaningful change; unknown is not classified as a crash | Wake and observation tests |
| A question arrives while a command runs | Next safe checkpoint reports a pending update without consuming it | Execution checkpoint regression |
| Empty workstream after assignment | New posts use the assigned channel; explicit Main remains available | Agent façade test |
| Changed source during edit | Reject stale digest; no partial edit | Authoring tests and Linux VM proof |
| Large command output | Explicit preview/capture limits and retrievable exact saved bytes | Command tests and Linux VM proof |
| Uninspected or untested artifact | Explicit scoped checks; no automatic acceptance | Review contract and provenance tests |
| Long drafting chat plus human edits | Bounded context, complete saved brief, one repair maximum | Drafting behavior tests |
| Real conversation UI | Named revision opens correctly; keyboard works; exact source preserved | `node tests/conversation-readability.mjs` |

Run the account-free Linux proof explicitly with
`node tests/providers/agent-authoring-proof.mjs`. It prepares a fresh VM, uses no
provider login, preserves its evidence locally and stops the VM afterward.
It does not prove that any particular model chooses the tools well.
`node tests/providers/agent-runtime-surface-proof.mjs` additionally inspects
Claude/Codex's actual model-facing catalogs against local fixtures in fresh VMs
and Grok's real ACP/MCP initialization and catalog loading. Pass runtime names
to select a subset, for example `node tests/providers/agent-runtime-surface-proof.mjs grok`.
It uses no login or provider inference and stops each environment afterward.

## Small live outcome comparison

Use the same mission and model settings on both configurations. Start with one
Coordinator, one builder and one independently assigned reviewer. Use Grok Build
for the first comparison, then repeat with Claude Code and Codex if authorized.
Keep each run's isolated VM/workspace; never copy host credentials. Record actual
provider limits and missing data rather than silently changing accounts.

**Mission:** Create a browser-based learning experience for an 11-year-old that
explains why a simple electric circuit needs a closed path. Let the learner make
and test a prediction, operate the switch, observe a meaningful model and receive
an explanation. Deliver original source, an offline entrypoint, scientific
assumptions and independent evidence. Use a visual format that helps teach the
concept. It must remain usable by keyboard, on a phone and with reduced motion.

**Disruption:** After the first reviewable draft, the human asks for an accessible
non-WebGL version preserving the learning interaction. The reviewer introduces a
counterexample: opening the switch should stop the model's indicated current.
The Coordinator must decide what changes, assign the correction, inspect fresh
evidence and select an exact candidate. Do not impose mandatory tasks or extra
workstreams merely to increase feature coverage.

**Generic countercheck:** Repeat with a non-software mission: compare two venue
plans against supplied accessibility/capacity constraints and produce an evidence
report. No renderer, HTML or 3D workflow should become mandatory.

Measure separately:

- Missed human instructions and intervention count.
- Misrouted/private messages, invalid/rejected calls and context-recovery calls.
- Duplicated work versus deliberately different experiments.
- Time to first usable draft, disruption response and integrated candidate.
- Provider-reported input/output/cached tokens, unknowns and actual elapsed time.
- Correctness, learning value, interaction, visual coherence and accessibility.

Have the human score those five quality dimensions from 1 (unusable) to 5
(excellent), with concrete observations on exact revisions. Keep reviewers blind
to the configuration when practical. Preserve screenshots, commands, receipts,
raw public/private traces separately and publication-safe evidence separately.
A runnable page, a completed task list or infrastructure tests cannot stand in
for this quality assessment. One run is exploratory evidence, not a causal claim.
