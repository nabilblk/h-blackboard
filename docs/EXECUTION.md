# Isolated desktop execution

The decentralized desktop uses **provider contract v2**, implemented with Lima
and Apple's Virtualization Framework on Apple Silicon macOS. Adapters are implemented for Grok Build, Claude Code and Codex. Each has
a separately pinned binary, network policy, guest login and saved session.
The validation matrix below distinguishes live subscription evidence from
account-free conformance. The trusted-local web launcher is a
separate experiment and is never an execution fallback.

## First run

1. Install Lima (`brew install lima`). Lima 2.1.1 is the validated version. The
   desktop package includes its own application runtime and native node service.
2. Create or join a mission, review its terms and prepare a Claude Code, Codex or Grok Build contribution.
   Share it from **Members → Agents**. A coordinated mission's owner appoints
   its Coordinator from **Mission controls**.
3. Expand your agent in **Members → Agents**, or open **Your contribution**.
   Select **Prepare isolated environment**. This downloads checksum-pinned
   Ubuntu and selected runtime components into an app-owned VM. No agent starts yet.
4. Select **Sign in to [runtime]…**, copy the displayed command into Terminal and
   complete the provider login. Claude opens a subscription authorization link
   and asks for the returned code. Codex and Grok use device login. This is a new login **inside this VM**. The app
   does not copy your Mac's Grok/Claude/Codex credentials or change their config.
   Each contribution has its own guest account and login. Return to the app;
   it detects the guest login file. Actual provider authorization is checked
   when the runtime connects, so a present login can still be expired or quota-limited.
5. In **Budget & permissions**, the owner allocates turns/slots to the
   contributor and issues a permission for that specific shared agent. During
   Preparing, only the appointed Coordinator can receive a **planning**
   permission (at most eight turns and fifteen minutes).
6. The contributor selects that permission in Local execution and chooses
   **Approve and run**. Consent binds the exact local preparation and isolation
   policy. A real Coordinator can now publish its plan and exact readiness.
   The planning run stops after one useful turn; it cannot start workers.
7. The human selects **Start mission**. Issue fresh work permissions and approve
   them on the contributing devices. Main, workstreams, private messages,
   tasks and artifacts remain the normal working interface.

**Joining, sharing an agent, assigning a task and issuing permission never
start a process on their own.** A device's human explicitly approves local
execution. A late arrival also needs a current shared direction.

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

Use the **complete command from the desktop**, not these abbreviated commands:
it selects the correct VM and private guest account. Subscription authentication
happens through the vendor CLI. No API key, shared account or host credential
export is required. A provider can still impose its own subscription limits.

Codex's reviewed inert tools include MCP resource metadata, input requests (the
adapter declines interactive runtime requests), and skill catalog lookup. Its
bundled skills, host skill discovery, plugins and executor capability discovery
are disabled; no workspace roots or native execution environments are attached.
Codex turns declare `externalSandbox`: the Lima broker enforces the writable
workspace and network limits. Its five exact MCP tools are preapproved by the
root-owned configuration; every operation still rechecks contributor consent,
mission authority and lease. Native execution environments remain empty.
Workspace side effects use only the scoped broker. Claude validates the runtime’s
reported tool list and refuses unexpected native tools. Vendor upgrades require
fresh conformance; these policies are not a promise about arbitrary CLI versions.

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
remains current. Local event logs show runtime activity; they are separate
from shared progress reports and are not published automatically.

**Resume:** recover/confirm the old stop first, then obtain and consent to a
fresh permission generation. The owner form continues the same execution
identity after its previous grant is sealed; the host loads the saved native
runtime session. Mission control and current instructions still take precedence
over that session's memory. Restart never automatically launches an agent.

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
