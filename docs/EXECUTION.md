# Isolated desktop execution

The decentralized desktop uses **provider contract v2**, implemented with Lima
and Apple's Virtualization Framework on Apple Silicon macOS. Adapters are implemented for Grok Build, Claude Code and Codex. Each has
a separately pinned binary, network policy, guest login and saved session.
The validation matrix below distinguishes live subscription evidence from
account-free conformance. The trusted-local web launcher is a
separate experiment and is never an execution fallback.

<a id="first-run-043"></a>

## First run (0.4.4)

1. **Create mission** with an objective, scope and completion criteria. The form
   saves an unfinished local draft. New missions open in **Preparing**, inside
   the Slack-like channel. macOS may ask you to approve Keychain access for the
   protected node identity.
2. Select **Set up Coordinator** (or **Add agents** in peer mode). Choose Grok
   Build, Claude Code or Codex, a name and local limits. Unlimited is explicit.
   The default Mac export folder is **Documents / Harakiri Exports**; each agent
   has a separate subfolder. Changing it uses a native folder picker.
3. If needed, choose **Install isolated environment provider**. The app downloads
   the official Lima **2.1.1** arm64 release and guest agents, checks pinned
   SHA-256 digests, and installs them under its private application storage.
   Existing Lima installations are also supported. No Homebrew installation,
   administrator command or global runtime configuration change is performed.
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
7. Select **Review and start**, inspect the exact plan and contributions, and choose a finite window and turn ceiling. **Start and run** records human Start and eligible owner-local approvals. Missing setup, capacity or direction is shown as a named wait. Interrupted actions return as **Continue saved Start review**; retries reconcile completed steps.
8. Invite other people through **Invite people**. They connect, review and request admission. After approval they can open Main without an agent, or choose **Contribute an agent** and follow the same setup. The owner authorizes remote agents from their profile's **Review contribution**. Each contributor separately reviews local execution; remote authorization cannot supply that consent. A group review approves several prepared local agents together. Provider logins remain per-guest.
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
| Setting up / Sign-in needed | The environment or guest login needs attention; the current stage is shown. |
| Waiting / Approval needed | A named mission, direction, permission or local consent prerequisite is missing. |
| Ready to start | Current observed authorization and approval allow the named operation; the host revalidates before launch. |
| Starting / Running | Local launch or execution is observed. Running does not prove useful progress. |
| Idle | A turn ended normally and the saved session is waiting for useful updates. |
| Stopping | Stop was requested; termination has not yet been confirmed. |
| Stopped | Execution ended and the reason is retained; continuation uses the saved identity/session when policy permits. |
| Status unknown / Stop unconfirmed | Observation is unavailable/stale, or termination cannot be proven. Never interpreted as stopped. |

Local status observations expire after fifteen seconds. Contributor-signed remote observations expire after thirty seconds and identify their source. An expired or missing report becomes **Status unknown**. Waiting for local approval, owner authorization and direction are distinct reports. Reports are ephemeral peer data; they do not add ledger events, wake models or prove useful progress. Shared direction and progress claims remain separate from process status.

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

The first worker image supplies its system tools, including Python and shell.
Worker network access is disabled; dependency installation, browsing and
arbitrary downloads from agent tools are unavailable. Provide reviewed inputs
through explicit imports or authorized artifacts. HTML artifacts can use
self-contained assets and open through Blackboard's separate isolated viewer.

## Enforcement boundary

| Boundary            | Implementation                                                                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mac filesystem      | No host mounts, host SSH agent forwarding or host credential imports.                                                                                                                                                                                            |
| Runtime credentials | The selected runtime's guest-native login stays in a private `hb-runtime` account. Commands run as a different `hb-worker` user in a restricted filesystem namespace.                                                                                            |
| Agent tools         | Pinned adapters disable native execution/file tools and subagents. Scoped MCP supplies board and jailed workspace tools. Vendor metadata tools may remain; see the runtime table.                                                                                |
| Worker access       | `/workspace` is writable; system tools are read-only. No network, capabilities, privilege escalation, mounts or namespace creation. Process, memory, output and time limits apply.                                                                               |
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
workspace and network limits. Its six exact MCP tools are preapproved by the
root-owned configuration; every operation still rechecks contributor consent,
mission authority and lease. Native execution environments remain empty.
Workspace side effects use only the scoped broker. Claude validates the runtime’s
reported tool list and refuses unexpected native tools. Vendor upgrades require
fresh conformance; these policies are not a promise about arbitrary CLI versions.

The tools are `board`, `workspace_exec`, `workspace_read`, `workspace_write`,
`import_artifact` and `publish_artifact`. To reuse another participant's output,
inspect its exact revision and call `import_artifact` with its file path and a
relative workspace destination. The host authorizes each read as the bound
agent and verifies the published BLAKE3 hash. The guest checks contiguous bytes
against that manifest and rechecks permission before an atomic jailed write.
The tool returns a small receipt, including the artifact BLAKE3 hash and a
separate SHA-256 of the transferred bytes. Large files never pass through the
model's text or require access to private runtime logs. Import does not execute
the file or grant additional authority. Preparing an idle VM installs updated
broker tools; it never patches a running execution.

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
node tests/providers/g5-provider-conformance.mjs
```

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

Clarifications and a new artifact to review within the existing assignment
normally belong in messages. A real change of responsibility needs a new
direction and permission. Pauses, revoked consent and changed mission terms
remain separate blockers; recovery does not bypass them.

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
