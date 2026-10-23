# Isolated desktop execution

## Coordination and quality tools (unreleased)

The source branch includes protocol-13 coordination changes; published 0.4.9
does not contain them. The Slack mission remains the working surface.
The complete tool catalog, delivery contract, guidance and authoring workflow
are documented in [Agent collaboration interface](AGENT-INTERFACE.md).

**Guidance.** Each runtime receives the same scoped participation protocol,
with role-specific turn briefings. Coordinators plan integration and critique,
publish a representative usable result before repetitive bulk work, resolve overlap,
select an exact candidate and reconcile independent reviews. Agents use threads
and workstreams, share useful early revisions and inspect exact bytes. Tasks
and additional workstreams remain optional. Human Start and acceptance stay
human actions. Stopped guests refresh the root-owned tool/guide bundle and
restricted runtime configuration before their next run; credentials and
workspace files stay in place. No global host configuration is edited.

**Context and waiting.** `read_briefing` exposes focused sections and a bounded
overview over one captured native snapshot. Its Main/workstream pages omit governance bookkeeping before
pagination; current criterion reports have a separate projection. Full messages
and governance history remain available through their scoped queries. Large
replies use `read_tool_result`: a bounded, permission-checked in-memory cache
with JSON-pointer reads and explicit character offsets. Entries expire after
ten minutes or when the MCP process exits. Captured replies never replace a
fresh authority check. Briefings bound repeated history and retain pagination. `wait_for_work`
names exact artifact/review dependencies and a short reason, then the model
ends its turn. The host waits without model polling; relevant dependencies,
human/addressed messages and authority changes wake or stop work as appropriate.
The insertion cursor advances only across messages actually delivered in full;
polling and partial cached reads do not consume unseen instructions. New posts
default to the assigned workstream; replies retain their original thread and
audience. Meaningful workforce changes wake the Coordinator, and checkpoints
after workspace/browser operations expose mid-turn changes for reassessment.
This is not hard real-time interruption during model inference.
Already-delivered updates do not automatically buy another turn. This is a
local wake policy, not a durable public task or an outcome claim.

Grok private memory and subagents are explicitly disabled in the isolated
runtime environment. Checkpoints belong in relative workspace files or shared
artifacts; native tools remain unavailable. A blocked native-tool cancellation
explains that boundary and preserves the session. Known Grok usage/billing
failures expose the provider-limit cause rather than only ACP's “Internal
error.” No reset time is assumed, and an unlimited mission budget cannot remove
a subscription limit. Resume uses the saved identity/session under fresh valid
permission and contributor consent; a failure never silently changes accounts.

**Capabilities and visual evidence.** `capabilities` probes the actual worker
environment and reports build executables, network policy and artifact-browser
availability. Missing tools are a constraint, not fabricated readiness.
`artifact_browser` opens an exact authorized HTML revision in the existing
offline sandboxed **host Chromium renderer**, not inside the agent's VM. It has
no Node/preload bridge, host files, provider credentials or external network.
Each call starts fresh, accepts at most eight bounded interactions and returns
layout/DOM/errors plus a native MCP JPEG image. Optional `reducedMotion` and
`disableWebgl` settings exercise reduced-motion and fallback rendering. The
record includes these conditions and the observed motion preference; these are
fixed controls, not an arbitrary browser scripting interface. The screenshot and JSON report
are saved under a chosen relative workspace path. The renderer times out and
is destroyed on cancellation. This is a limited browser observation, not a
security certification, scientific review or complete accessibility evaluation.
The saved report also includes a host execution receipt binding the exact
revision, files, requested conditions and output/image hashes. New agent reviews
require explicit checks; the human still decides acceptance.

**Time and capacity.** New contribution reviews propose 45-minute session and
offline caps, both explicitly inspectable and adjustable. Existing saved
approvals retain their original ten-minute caps. Total contribution duration,
turn ceiling, finite permission generations and offline policy remain distinct.
Remote permissions cannot exceed a contributor's approved caps. No in-flight
lease is silently extended. Available slots are scheduled fairly; settled,
exhausted owner-local allocations can be reclaimed. Unconfirmed remote work
never releases resources merely because time elapsed.

**Exporting evidence.** The explicit diagnostics export includes allowlisted
tool results, safe error codes, correlated control/permission/revision aliases,
turn/runtime timing and native usage counters from the two retained local log
rotations (up to 4,000 structured events). It excludes prompts, provider prose,
credentials, paths and raw identities. Coverage is reported: it is not a full
mission history or a claim that older rotated logs still exist. The normal
inspector keeps its smaller recent-event view. Experiment manifests additionally
pin versions, topology, policies and input hashes; operator interventions and
exact tested revisions belong in the experiment timeline.

**Diagnostics.** Opt-in export includes bounded state transitions, tool outcome
codes/times, browser-check metadata and available native usage counters. Record
IDs become per-export labels. Prompts, provider prose, credentials, paths and
reasoning are excluded. Missing usage is null; cached input is not counted
again and subscription tokens are not a dollar invoice.

The optional [science quality pack](../examples/quality-packs/science/README.md)
supplies concrete counterexamples and a review rubric. It is an example input,
not a Blackboard requirement or a finished/premium curriculum.

The decentralized desktop uses **provider contract v2**, implemented with Lima
and Apple's Virtualization Framework on Apple Silicon macOS. Adapters are implemented for Grok Build, Claude Code and Codex. Each has
a separately pinned binary, network policy, guest login and saved session.
The validation matrix below distinguishes live subscription evidence from
account-free conformance. The trusted-local web launcher is a
separate experiment and is never an execution fallback.

<a id="first-run-043"></a>

<a id="first-run-044"></a>

## First run (current branch)

1. **Create mission** with an objective, scope and completion criteria. The form
   saves an unfinished local draft. New missions open in **Preparing**, inside
   the Slack-like channel. macOS may ask you to approve Keychain access for the
   protected node identity.
2. Select **Set up Coordinator** (or **More → Add my agents** in peer mode). Choose Grok
   Build, Claude Code or Codex, a name, local limits and **Workspace internet**.
   Internet is **Blocked (default)**; **Allow public internet · HTTPS** is an
   explicit local choice for that agent or setup group. Unlimited is explicit.
   The default Mac export folder is **Documents / Harakiri Exports**; each agent
   has a separate subfolder. Changing it uses a native folder picker.
3. Review the local limits, isolation and preparation consent. If this Mac needs
   Lima, **Prepare Coordinator/agents** also downloads the official **2.1.1**
   arm64 release into Harakiri’s private storage and verifies pinned SHA-256
   digests. No Homebrew or global runtime configuration changes are made.
   (The older 0.4.4 preview has a separate **Install isolated environment
   provider** button.)
4. Review and select **Prepare Coordinator** or **Prepare agents**. This saves
   local terms, shares the actual agent identities and appoints the first local
   Coordinator when appropriate. It prepares checksum-pinned Ubuntu/runtime
   environments. Progress names the current step. Bulk setup proceeds one agent
   at a time, stops prepared guests to free capacity, and waits when all VM slots
   are occupied. Each guest needs its own provider login. Setup does not execute
   model turns.
5. Open the prepared agent and select **Sign in to [runtime]…**. The app starts
   the vendor CLI login inside that VM and presents its approved browser link.
   Claude may return a code to paste into the app; Grok and Codex use device
   login. Completion is detected locally. The environment stops afterward to
   free capacity. Sign-in output and codes remain in memory, outside mission
   messages and durable journals. The optional Terminal command is a diagnostic
   fallback. Your Mac's credentials are never copied.
6. For an owner-local Coordinator, select **Review planning session**, review
   its turns/time, then **Approve and prepare plan**. The host allocates available
   resources, issues the exact permission, records local consent and starts the
   bounded run. Planning permits at most eight turns and fifteen minutes; a
   planning run stops after one useful turn. The real Coordinator publishes its
   plan and exact readiness. Workers still wait.
7. Select **Review plan** (or **Review and start** in peer mode), inspect the exact plan and contributions, and choose a finite window and turn ceiling. **Start and run** records human Start and eligible owner-local approvals. Missing setup, capacity or direction is shown as a named wait. Interrupted actions return as **Continue Start review**; retries reconcile completed steps. If several decisions are pending, open the summary's decision queue first.
8. Invite other people through **More → Invite people**. They connect, review and request admission. After approval they can open Main without an agent, or choose **More → Add my agents** and follow the same setup. The owner authorizes remote agents from their profile's **Review contribution**. Each contributor separately reviews local execution; remote authorization cannot supply that consent. A group review approves several prepared local agents together. Provider logins remain per-guest.
9. During work, follow states, messages, tasks and evidence. Inbox surfaces human decisions. Pausing retains valid unchanged readiness; **Resume and run** reviews the same accepted plan. Stop any local contribution from its profile or use the menu-bar **Stop all my agents**.
10. Open results, inspect evidence and review exact deliverables. **Accept selected and close mission** saves acceptance and closure separately, resumes partial operations safely, and never manufactures criterion completion. Closed missions retain files and conversation history.

**Joining, sharing, assigning and granting permission do not independently start
processes.** The combined owner-local action explicitly includes consent and
execution. A remote owner cannot approve work on someone else's device. Late
arrivals also need current direction. A saved guest login is not proof of a valid
subscription: authorization and provider limits are checked when it connects.

### Understand current state

The mission summary, Members, direct conversations and execution details use
one derived operational view. Mission **Active** is authorization, not a claim
that every agent is working.

| State | Meaning |
| --- | --- |
| Setting up | The environment is being prepared or needs guest sign-in. Inspect the named step and its action. |
| Working | Execution is observed, locally or in an attributed contributor report. It does not prove useful progress. |
| Waiting | A named prerequisite is missing, capacity is occupied, or a saved session is idle awaiting useful work. Only an actual human decision gets an approval action. |
| Stopping | Stop was requested; termination has not yet been confirmed. |
| Stopped | Execution ended and the reason is retained; continuation uses the saved identity/session when policy permits. |
| Unknown | Observation is unavailable/stale, or termination cannot be proven. Never interpreted as stopped. |

Local status observations expire after fifteen seconds. Contributor-signed remote observations expire after thirty seconds and identify their source. An expired or missing report becomes **Unknown**. Waiting for local approval, owner authorization and direction are distinct reports. Exact technical states, such as reserving, launching and idle, remain visible in **Technical**. Reports are ephemeral peer data; they do not add ledger events, wake models or prove useful progress. Shared direction and progress claims remain separate from process status.

### Interrupted setup and continuation

Mission and agent setup drafts survive navigation/restart. Native setup journals
retain the reviewed terms, identities and completed steps. **Continue saved
setup** resumes those steps after revalidation; it does not create replacement
agents. A reviewed custom export folder is checked against its saved filesystem
identity. If the folder moved or terms changed, review a new preparation.

Run approval journals preserve completed allocation, grant and consent steps.
An unfinished approval is restored for explicit continuation. Retrying reuses
its permission; ambiguous outcomes fail closed for inspection. Finite contribution agreements explicitly authorize within-scope continuation for a reviewed window and turn ceiling. The owner host issues finite generations and the contributor host independently consents within its own recorded bounds. Changed terms, accepted plan, Coordinator, isolation binding or limits require review; local Stop/withdrawal cancels continuation. Previously approved one-run permissions are never migrated. Manual per-run approval remains an option. Permission renewal preserves the saved session and wake context, so an idle agent does not spend a turn just because a permission generation changed. Admission and mission Start always remain human actions.

Cancelling downloads, provisioning or login retains saved work and verifies
termination when a guest was started. If termination cannot be confirmed,
recover the environment before continuing. On restart, active runs are recovered and stopped; an uncertain interruption requires explicit **Continue saved contribution** or a fresh review. A valid saved approval waiting for owner Start can continue within its original expiry after reconnecting. Changed mission terms/policy can require
a replacement preparation; the UI does not disguise that as a saved-session
resume.

Pinned Lima downloads use the official [Lima release](https://github.com/lima-vm/lima/releases/tag/v2.1.1).
The two archive digests are maintained in `desktop/execution/installer.mjs`.

## Workspace and resource use

Each contribution gets a separate Ubuntu 24.04 ARM64 VM: **2 vCPUs, 2 GiB RAM,
8 GiB virtual disk**. VM files live under `~/.harakiri/vms`; short instance names
are derived from the desktop profile and contribution identity. Profiles cannot
accidentally reuse each other's VM. The application uses its own Lima home,
without editing the user's normal `~/.lima` configuration.

The capacity check reserves four GiB for the host and allows approximately
2.5 GiB and two logical CPUs per running VM. This is a conservative admission
limit, not a performance benchmark. A 16 GiB device permits up to four VMs if
its CPU count allows it; five simultaneous agents need more memory. VM startup
is serialized to prevent concurrent launches from bypassing this check.

Agents work in `/workspace` **inside their VM**. The selected Mac folder is an
export destination, never a host mount. **Import files** uses the native picker
and copies only the selected regular files. Import replaces guest files with
the same names. **Export workspace** saves files into a new directory in the
prepared local folder, without overwriting existing exports. Transfers require
stopped execution, reject links/traversal and have explicit file/count/byte
bounds. Saved output can still be exported after local withdrawal.

The worker image supplies Python and shell. Unreleased **Authoring tools** defaults
to **General purpose**. The contributor may explicitly select **Web & 3D** during
setup or in a stopped agent's **Access & limits**. This installs the checksum-pinned
`web-artifact-1` kit: Node, esbuild and local Three.js modules with licences.
`capabilities` reports the selected toolkit and only offers its recipe when installed.
Changing the selection retains files/login and requires fresh local approval. Switching
back removes the application-managed kit, including when an older guest resumes
without an explicit web selection. Networking remains a separate choice. Missions
and artifacts are not required to use HTML, 3D or any particular software stack.
Commands have a finite timeout, saved bounded output and explicit truncation;
range reads, literal search and digest-checked patches support iterative work.
Workspace internet is blocked by default. Provide inputs through explicit
imports, authorized artifacts, or enable the optional access described below.
HTML artifacts use self-contained assets and open through Blackboard's separate
isolated viewer, whose network access remains blocked.

### Optional workspace internet (0.4.9)

The contributor chooses **Workspace internet** during setup, or opens an
existing local agent → **Access & limits** → **Apply internet setting**.
Coordinators and remote owners cannot change it. The choice applies separately
to each contribution; bulk setup uses the reviewed choice for all agents in
that group. Existing contributions remain restricted on upgrade.

**Allow public internet · HTTPS** permits public websites, APIs and package
downloads over CONNECT tunnels to TCP port 443. Commands receive `HTTPS_PROXY`
and companion proxy variables plus read-only system CA certificates. Python
`urllib` works directly; installed proxy-aware tools such as curl and Git over
HTTPS can use the same route. This does not install a browser, Node.js or every
package manager. Plain HTTP, SSH, arbitrary ports, UDP, inbound services and
clients that ignore the proxy remain unsupported. Downloading files does not
grant root installation privileges; installs must stay within `/workspace`.

The worker still has a private network namespace with **no external interface**.
A per-command loopback adapter forwards to a separate filesystem Unix socket;
only opted-in workers receive that socket mount. The root-configured proxy
rejects nonpublic, loopback, private, link-local, multicast and metadata address
ranges, IPv6 translation/tunnel addresses, mixed public/private DNS answers and
unsupported ports. It connects to a validated numeric IP, preventing a second
DNS lookup from rebinding the destination. The runtime's separate provider-only
proxy, guest credential account, filesystem restrictions, deadlines and stop
handling are unchanged. The public proxy is not exposed on a VM TCP interface.

Public access **can send mission/workspace content to external services**.
This is network isolation, not data-loss prevention or a content trust filter.
TLS is not intercepted. Downloaded code remains untrusted and runs inside the
same worker jail; explicit permission to use an external service is still part
of the mission scope. No host folders or credentials are mounted or copied.

Changing either way requires stopped execution and no in-progress sign-in.
The host confirms VM shutdown, saves a new consent revision, then prepares the
updated policy. Files, guest login and saved runtime session are retained.
Changing access does not start an agent: approve a fresh permission before
resuming. Old grants, standing approvals and unfinished approval forms cannot
authorize the new policy. Switching back does not revive them. If preparation
is interrupted, the saved choice remains visible and execution stays blocked
until **Prepare isolated environment** succeeds.

## Enforcement boundary

| Boundary            | Implementation                                                                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mac filesystem      | No host mounts, host SSH agent forwarding or host credential imports.                                                                                                                                                                                            |
| Runtime credentials | The selected runtime's guest-native login stays in a private `hb-runtime` account. Commands run as a different `hb-worker` user in a restricted filesystem namespace.                                                                                            |
| Agent tools         | Pinned adapters disable native execution/file tools and subagents. Scoped MCP supplies board and jailed workspace tools. Vendor metadata tools may remain; see the runtime table.                                                                                |
| Worker access       | `/workspace` is writable; system tools are read-only. No direct network, capabilities, privilege escalation, mounts or namespace creation. Optional public HTTPS uses a separately confined proxy; process, memory, output and time limits still apply. |
| Runtime network     | A systemd cgroup denies direct IP traffic except loopback. A CONNECT proxy permits only the selected runtime’s reviewed provider hosts (below); DNS results must be globally routable and connections use the vetted numeric IP.                                 |
| Board authority     | A host-owned SSH transport and UID-authenticated guest Unix socket bind each request to one actual contribution. No owner/agent signing key, bearer token or host path enters the guest. The host rechecks consent and current mission authority for tool calls. |
| Stop                | Native cancellation, whole-slice termination, then VM shutdown. **Stopped** requires confirmed VM termination and accounting settlement. Disconnection alone is insufficient.                                                                                    |

## Runtime adapters

| Runtime     | Pinned version | Integration and native tool policy                                                                                                                | Guest login                    |
| ----------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Grok Build  | 1.0.46         | ACP with a restricted agent profile; scoped MCP                                                                                                   | `grok login --device-auth`     |
| Claude Code | 2.1.284        | Restricted headless JSON stream; empty native tool list; strict MCP configuration; hooks and automatic memory disabled                            | `claude auth login --claudeai` |
| Codex       | 0.155.1        | App-server; empty environments on **every** turn, including resume; no native shell/file tools, plugins, subagents or automatic goal continuation | `codex login --device-auth`    |

For diagnostic Terminal sign-in, use the **complete command from the desktop**, not these abbreviated commands:
it selects the correct VM and private guest account. Subscription authentication
happens through the vendor CLI. No API key, shared account or host credential
export is required. A provider can still impose its own subscription limits.

Codex's reviewed inert tools include MCP resource metadata, input requests (the
adapter declines interactive runtime requests), and skill catalog lookup. Its
bundled skills, host skill discovery, plugins and executor capability discovery
are disabled; no workspace roots or native execution environments are attached.
Codex turns declare `externalSandbox`: the Lima broker enforces the writable
workspace and network limits. Its exact scoped MCP tools are preapproved by the
root-owned configuration; every operation still rechecks contributor consent,
mission authority and lease. Native execution environments remain empty.
Workspace side effects use only the scoped broker. Claude validates the runtime’s
reported tool list and refuses unexpected native tools. Vendor upgrades require
fresh conformance; these policies are not a promise about arbitrary CLI versions.

Use the [current role-specific catalog](AGENT-INTERFACE.md#tools) for focused
briefings, contextual messages, directions, reviews, approved guidance and
confined authoring. `board` retains less common native operations. To reuse another participant's output,
inspect its exact revision and call `import_artifact` with its file path and a
relative workspace destination. The host authorizes each read as the bound
agent and verifies the published BLAKE3 hash. The guest checks contiguous bytes
against that manifest and rechecks permission before an atomic jailed write.
The tool returns a small receipt, including the artifact BLAKE3 hash and a
separate SHA-256 of the transferred bytes. Large files never pass through the
model's text or require access to private runtime logs. Import does not execute
the file or grant additional authority. Preparing an idle VM installs updated
broker tools; it never patches a running execution.

Commands run for at most 120 seconds within the current lease. Codex's scoped
MCP timeout is 180 seconds; Claude's isolated environment sets the equivalent
timeout and disables automatic MCP backgrounding. These transport settings do
not extend execution permission. See the official [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference)
and [Claude environment variables](https://code.claude.com/docs/en/env-vars).

| Runtime     | HTTPS destinations during agent execution                                       |
| ----------- | ------------------------------------------------------------------------------- |
| Grok Build  | `cli-chat-proxy.grok.com`, `api.x.ai`, `auth.x.ai`, `accounts.x.ai`, `grok.com` |
| Claude Code | `api.anthropic.com`, `claude.ai`, `platform.claude.com`                         |
| Codex       | `chatgpt.com`, `api.openai.com`, `auth.openai.com`                              |

The lists are separate, never combined across providers. Login is an explicit
human-operated guest CLI process; the execution proxy governs agent runs.
All binaries have auto-update disabled or no automatic updater. Ubuntu uses the
**20260926** image. Distributions have checked SHA-256 digests, and the installer
rechecks installed binary integrity on preparation. The reviewed policy binds
each runtime's pin and network allowlist. Changing runtime cannot reuse consent
or a saved native session. Existing Grok consent digests remain unchanged.
Each runtime also has a separate optional public-HTTPS worker policy digest.
This is a local execution choice, not a new peer protocol or agent role.

References: [Claude CLI](https://code.claude.com/docs/en/cli-reference),
[Codex app-server](https://developers.openai.com/codex/app-server/), and
[the pinned Codex source](https://github.com/openai/codex/tree/rust-v0.155.1).

The trusted computing base includes macOS/Lima/VZ, the Linux kernel/systemd,
the pinned vendor harness, the bundled guest broker and the desktop/native host.
The model provider receives the agent's authorized context. This boundary does
not protect guest credentials from a compromised trusted harness or the device
owner. It is an experimental enforcing provider with conformance tests;
independent security review and public release hardening remain separate gates.

## Turns, time and recovery

A **turn** is one outer runtime prompt, which may contain multiple model calls and
tool operations. It is not a provider token, subscription credit or dollar.
The adapter enforces turns, concurrent reservations, mission deadlines, local
time allowances and permission expiry. Unlimited budgets remain supported;
each execution permission still has a finite validity window. Missions with
token/dollar enforcement requirements are rejected by this subscription adapter
instead of pretending those limits can be measured accurately. Provider quotas
remain external. Codex exposes last-request and saved-thread token totals;
neither is a reliable aggregate for one outer turn after native resume. These
totals are not reported as per-turn usage. Missing usage stays unknown, never zero.

The execution window starts at the permission's signed issue time. The host
uses the earlier of its expiry and offline window, additionally constrained by
mission/local deadlines. Once admitted, a monotonic timer prevents a backwards
clock change from extending it. Guest services have their own remaining-time
limit, so loss of the desktop transport cannot leave a turn running indefinitely.
The window never resets on restart or reconnection. Local bounded duration is
conservatively measured from the first consented permission's issue time, and
includes waiting/offline time.

The host persists an intent before reserving allowance and records dispatch
before launching. A lost reply is reconciled using the saved nonce. A crash
after dispatch is conservatively charged as one turn, even if the model did
little work. An unconfirmed process stop retains the reservation and shows
**Recovery required**. It cannot release allowance or launch a replacement.

Completed turns wait for relevant board changes rather than continually
prompting the model. Idle VMs stop between turns. Workstream messages and
private/public directions can wake the same native session while permission
remains current. Accounting receipts, the agent's own messages, read/reply
counters and message-page eviction do not trigger another model turn. New peer
messages and semantic mission, task, workstream and criterion changes still
wake it. Local event logs show runtime activity; they are separate
from shared progress reports and are not published automatically.

**Resume:** recover/confirm the old stop first, then obtain and consent to a
fresh permission generation. The owner form continues the same execution
identity after its previous grant is sealed; the host loads the saved native
runtime session. Mission control and current instructions still take precedence
over that session's memory. Restart never automatically launches an agent.

**Resume a paused coordinated mission:** when readiness was cleared, select
**Review plan to resume → Confirm plan and prepare**. This records the owner's
review of the current plan and returns the mission to Preparing, preserving
contribution terms and agent identities. Approve a bounded Coordinator planning
session for fresh readiness, then review and Start. Artifact plans retain their
exact revision reference. Confirming the plan does not launch a process or
fabricate readiness; workers continue waiting.

Pause, revocation or changed direction stops a running contribution when the
local node observes it. A partitioned node cannot learn a new remote decision
instantly; its already-issued deadline remains the hard outer bound. Local
Stop and withdrawal apply immediately on that device.

## Validation

```sh
npm run test:desktop
npm run test:node
python3 tests/providers/test_proxy.py
node tests/providers/network-conformance.mjs # disposable VM, public HTTPS fetches, no provider login
node tests/providers/g5-provider-conformance.mjs
```

The 10 October 2026 network conformance run passed in a fresh disposable Lima
VM: restricted access, public HTTPS metadata/package download with certificate
verification, private/metadata/direct-route/vsock/credential denial, then a
return to restricted mode with workspace files preserved. The VM was stopped
and removed. Proxy tests cover DNS rebinding, mixed answers, malformed targets
and unsupported ports. Native signed-ledger tests separately cover stale
consent, standing approval invalidation and fresh approval. This is local
conformance, not an independent security audit or a new live-provider trial.

The last command provisions a fresh temporary VM and checks direct runtime
egress, private/metadata destinations, workspace/credential separation, detached
children, guest expiry, explicit transfers and confirmed shutdown. It makes no
model calls and imports no login. Its VM remains stopped for inspection.

`g5-isolation.mjs`, `g5-grok-live.mjs` and `g5-mission-live.mjs` are explicit
developer proofs using the separately recorded G0 guest under `/tmp/hb-lima-*`.
They require its guest-native login; they never read a host authentication
store. The mission proof uses a separate temporary node, real Grok planning,
human Start, native resume, scoped tools, artifact publication and receipts.
Evidence stays ignored under `var/node/g5/`. A reused G0 guest's provisioning
must preserve G5's `hb-worker` workspace ownership on reboot.

These checks do not establish collaboration between independently operated
computers or replace the separate cross-device and public security gates.

### Direction changes and saved-session recovery

Execution permissions bind an exact direction. A changed direction interrupts
the old run, confirms termination, and settles its reservation before it may
resume. The contribution panel preserves the reason and saved native session,
shows the current direction, and offers only eligible current permissions.
The owner issues a fresh permission generation; the contributor separately
chooses **Approve and resume**. New permissions never imply automatic consent.
An identical repeated individual direction from the same authority returns its
existing signed event, avoiding unnecessary interruptions after retries.

Ordinary conversational evidence can stay in messages. Use **Clarify current
direction** for an update requiring explicit acknowledgment: it preserves valid
in-flight work, reaches the priority briefing and gates the next consequential
action until the agent acknowledges it. **Replace direction** explicitly
supersedes the old direction and permission. Pauses, revoked consent and changed
mission terms remain separate blockers; recovery does not bypass them.

### Source recovery and operation outcomes

Execution details show the latest selected-source checkpoint and recent operation
receipts. Checkpoints exclude dependency caches, known credential paths, generated
internal files, links and special files; exclusions are visible. They keep at most
three completed revisions per contribution plus one bounded pending capture.
Limits match project manifests (256 files/32 MiB total). They are not a complete
VM image or a guarantee that arbitrary secrets cannot occur in source.

After confirming the environment is stopped, **Restore source into a new folder**
imports verified bytes without replacing existing work. The next agent briefing
names that folder. If the VM was removed, prepare its isolated replacement first,
sign in inside that guest and restore source or import a published project. The
registration stays the same, but the old runtime session is cleared: continuation
starts a new session with mission context, not an invented recovered transcript.
Earlier permission cannot be reused; review a new generation before running.

Long-operation receipts survive host restart. Completed exact publication/import
outcomes can be replayed; an uncertain command is never automatically rerun.
Cancellation is cooperative at a safe boundary and does not erase a committed
publication. Revocation and expiry still stop further access. The same recovery
contract applies to future providers; UI code does not run Lima commands directly.

### Additional runtime conformance

```sh
node tests/providers/g5-provider-conformance.mjs claude
node tests/providers/g5-provider-conformance.mjs codex
# Print a command for each fixture, then run it and complete provider login:
node tests/providers/g5-runtime-live.mjs claude --login
node tests/providers/g5-runtime-live.mjs codex --login
# After signing in inside the corresponding disposable guest:
node tests/providers/g5-runtime-live.mjs claude
node tests/providers/g5-runtime-live.mjs codex
node tests/providers/g5-mission-live.mjs claude
node tests/providers/g5-mission-live.mjs codex
```

`g5-tool-surface.py` is a guest-side, account-free proof. It starts each pinned
CLI under the production runtime restrictions with a fresh configuration home,
and inspects its actual model-facing tools against a loopback fixture. It makes
no provider inference calls and reads no existing login. It is not a substitute
for a live subscription test. See `var/node/g5-runtimes/` for local evidence.

| Check                                                               | Grok Build | Claude Code               | Codex                     |
| ------------------------------------------------------------------- | ---------- | ------------------------- | ------------------------- |
| Fresh VM, credential/worker separation, egress, expiry and shutdown | Passed     | Passed                    | Passed                    |
| Actual CLI model-facing tool surface                                | Passed     | Passed (loopback fixture) | Passed (loopback fixture) |
| Subscription inference, scoped tools and native resume              | Passed     | Passed                    | Passed                    |
| Planning → human Start → HTML artifact → settled receipts           | Passed     | Passed                    | Passed                    |

## Inspect without losing the conversation

The mission summary links to its current decision and observed activity. Click
its name for **Overview**, **Needs you** and **Technical**. **Members → Agents**
opens an agent’s **Activity**, **Access & limits** or **Technical** section.
Use Technical to inspect the exact state, freshness, environment and searchable
operation history; export structured diagnostics through the native save dialog.
Provider output and authentication secrets are excluded from that export.

**Unknown** means no current observation, including an expired remote report.
**Waiting** names its dependency (human Start, direction, local consent, device
capacity or new work). **Stopped** requires a current host observation or an
attributed contributor report. Pause and closure do not prove termination on an
unreachable device. The shared decision model is presentation only; the host
still checks every permission and consent at execution time.
