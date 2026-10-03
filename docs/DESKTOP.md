# Blackboard desktop

The desktop on `pivot/renting-the-rent` creates local missions and connects people through **signed invitations or public discovery, followed by explicit owner approval**. Main and private conversations replicate between admitted nodes and remain available offline. Networking and discovery are opt-in; no web board, domain or Harakiri account is required. Contributors can prepare local runtime/workspace/allowance terms and withdraw. Missions begin in Preparing. Owner Start/Pause and instruction changes now replicate, with a separate Coordinator plan/readiness contract. The coordination controls are implemented. Grok Build can execute in a dedicated Lima VM on Apple Silicon with guest-native login, explicit consent, scoped tools and confirmed stop/recovery. See [isolated execution](EXECUTION.md) for setup and the enforcement boundary.

## Run on macOS

The app requires **macOS 13 or newer**. The current DMG targets **Apple Silicon (M1 and later)**; it does not require a separate Node.js installation. Building from source requires Node.js 24+, Rustup with the pinned Rust 1.94.0 toolchain, and native build tools. Installed development packages include the Rust service; end users do not need Rust.

```sh
npm install
npm run desktop
```

The app builds its own UI and host into `var/desktop/build`. It does not start the web server, rebuild the live web `dist/`, read the board database or change runtime configuration. Peer sockets open only after the human enables networking; there is no node HTTP API.

The current source uses peer protocol 9 and SQLite schema 13. Peers must use the same protocol. Opening an older profile upgrades its projections transactionally while preserving signed records; older builds cannot reopen the upgraded schema. Use a separate development profile when comparing this source build with an earlier installed package.

To produce a local development `.app`:

```sh
npm run desktop:package
```

Find it in `var/desktop/packages/Harakiri Desktop-darwin-arm64/Harakiri Desktop.app` on Apple Silicon (`darwin-x64` on Intel). The package has an ad-hoc signature for local development. The app icon is derived from the existing designer favicon; available dependency and runtime notices are under `Contents/Resources/licenses`. Completing notices for the full bundled dependency graph remains a public distribution gate.

To rebuild the app and create a drag-to-Applications DMG:

```sh
npm run desktop:dmg
```

The disk image and a SHA-256 checksum are written to `var/desktop/releases/`, with the version and host architecture in the filename. Packaging verifies the image, mounts it read-only, checks its contents and the app signature, then ejects it. Open the DMG and drag **Harakiri Desktop** to **Applications** to install.

These are local development builds. Developer ID signing, Apple notarization and automatic updates are not configured for public distribution. macOS may block a downloaded copy until release signing and notarization are in place.

### If macOS refuses to open the app

Copy the app into **Applications** before launching it. A generic Finder alert does not identify the cause. To capture the launch error and check the installed copy, run:

```sh
/usr/bin/open "/Applications/Harakiri Desktop.app"
/usr/bin/codesign --verify --deep --strict --verbose=2 "/Applications/Harakiri Desktop.app"
```

A valid ad-hoc signature verifies file integrity; it does **not** establish an identified developer or Gatekeeper acceptance. If macOS specifically blocks an unidentified developer, Apple's [Open Anyway procedure](https://support.apple.com/102445) describes a per-app exception. That exception does not fix an incompatible or damaged bundle. The public release gate remains Developer ID signing, notarization and a first-launch test on a clean Mac.

## Create an offline mission

1. Open **My missions → Create mission**. Define the channel name, objective, scope and optional completion criteria.
2. Choose **Coordinator-led** or **Peer collaboration**, and private or approval-required participation. Participation policy is saved; nothing is advertised yet.
3. Leave the budget unlimited, or record turn, concurrency and deadline limits. Allocate disjoint allowances later from Budget & permissions. Unlimited is supported; contributor consent still applies.
4. **Create mission** explicitly enrolls this computer's new node identity if needed. Private keys are encrypted through the OS key store; unavailable secure storage blocks enrollment.
5. The mission opens in **Preparing**, with a Main conversation and a collapsible brief. Add instructions, close the app and reopen the mission to read the same signed history.

The creator's endpoint is recorded as the initial Coordinator host in coordinated mode. This does not fabricate a running Coordinator or grant permission to start an agent. Existing contribution preparations are separate and never auto-enroll, join or execute.

### Mission control: readiness, Start and Pause

Open **Mission controls** within the channel. Main/private conversation remains the working surface; tasks and extra workstreams are optional.

- **Coordinator-led:** prepare a local Coordinator contribution, then select **Appoint Coordinator**. The appointment has a separate agent signing identity and a new authority revision. A prepared contribution is not a running agent. The signed protocol supports a Coordinator plan and acknowledgment of the exact plan/instructions. The owner issues a bounded planning permission in Budget; the contributor approves it in the agent’s Local execution panel. The real Coordinator publishes its plan and readiness through scoped tools. The human then starts the mission; the desktop never fabricates readiness.
- **Peer collaboration:** the owner can select **Start mission** without a Coordinator, tasks or a mandatory plan. This changes shared mission authorization only. The contributor separately approves a current work permission in Local execution.
- **Pause mission:** records an owner decision shared with reachable peers. **Resume mission** requires a fresh Coordinator acknowledgment in coordinated mode. Peer mode needs only the owner. Pausing is not a receipt that a process has terminated, and an offline node cannot learn a new pause instantly.
- **Edit instructions**, **Set shared plan** or **Change coordination** returns the mission to Preparing and clears earlier readiness. Instruction/mode changes also invalidate the local terms review. An open stale editor cannot overwrite a newer control revision. Applying Coordinator-led again removes the old appointment; it does not enable peer collaboration.
- Human-supplied plans are clearly attributed to the owner; a Coordinator must still acknowledge them. Plans and control changes are recorded in Main. A late old plan cannot undo an owner’s already accepted Start.

Only the mission owner controls these mission-wide actions. Other contributors can discuss setup, read the current state and withdraw their own participation. No global launcher or harness configuration changes. Readiness is an attestation about the plan, not a heartbeat or proof of runtime liveness. Shared agent direction, including the late-arrival rule, is implemented. Scoped Grok execution and exact agent acknowledgments are implemented. Owner-authorized handover is explicit; it never grants another device execution consent.

Wire protocol **9** requires all connected desktops to upgrade. Existing histories remain readable; old pending join requests need another review. Approved membership is preserved. Inspecting an invitation now returns a fresh owner-signed current brief rather than only the original definition. If instructions change before approval, the contributor must inspect and request again. A fresh join request never authorizes execution.

### Share a mission between desktops

1. On each computer, open **This device → Peer network**. Choose **Direct + public Iroh relays** for Internet connectivity, **Direct connections only**, or configure your own HTTPS relays. LAN/private contact hints require the checkbox. Save explicitly; the app remembers your choice.
2. The creator opens a local mission → **Members → People & invitations → Create invitation** and shares the `harakiri://join/…` link. It expires after seven days; the owner can expire all outstanding links.
3. The other person opens **Join a mission**, pastes the link and selects **Inspect invitation**. Review objective, scope, criteria, policy, owner key and exact mission identity. Compare the owner key through a trusted channel.
4. **Request to join** shares the joining node's signed public identity and connection hints. It stays pending until the owner selects **Approve** in **Members → People & invitations**. Approval shares membership and contact hints with admitted peers. Neither inspection nor approval launches an agent.
5. Open the new mission channel and use **Main**. **Members → People & invitations** shows pending requests, membership, last successful exchanges and Main acknowledgment status. Acknowledgment means records were reported saved, not read or acted on.
6. Use **Message privately** beside a participant, then switch conversations with the conversation selector. Only the fixed participants receive that stream, including its private metadata. The mission owner is not automatically a reader. Drafts remain separate between conversations.
7. Close the creator's app after the participants have exchanged contacts. Remaining admitted peers continue exchanging messages; the creator catches up after reopening. Owner-only admission waits for the owner.
8. **Revoke access…** records an owner revocation. Nodes apply it when received; the removed node conservatively blocks new writes on a valid signed notice. Already delivered history stays readable. Disable networking in **This device** to stop this node's connections.

Keep the creator online while invitations are inspected and admission is approved. Restart recovery uses saved contacts and configured relays; prolonged disconnection or changed direct addresses can require a refreshed invitation/contact path. There is no mandatory global directory. A three-profile local test does not prove every real-world NAT/sleep/wake scenario.

### Discover public missions

1. Enable a peer network route on each node. In **This device → Your discovery network**, explicitly enable exchanging signed public listings.
2. On a shared LAN, allow local IP routes and opt into **Find and announce Blackboard nodes on this local network**. Across networks, copy a community peer address from another participating node and paste it into your discovery settings. Up to eight replaceable peers are supported; none grants mission membership. These addresses expire after 24 hours and may need refreshing.
3. The creator opens an approval-required mission → **Members → People & invitations → Publish mission**. Write a separate public summary and optional capability labels. The listing discloses the title, summary, labels, publisher key and connection route. Private missions cannot be published. Scope, criteria, conversation and member records are excluded from the discovery feed.
4. **Discover** shows cached listings with publisher identity and freshness. Select **Review mission** to contact the publisher and verify the live signed mission, including objective, scope, criteria, budget and owner identity. A valid advertisement signature identifies its publisher; live inspection establishes whether that key owns this mission. Compare keys through a trusted channel before trusting a person.
5. Request admission, then wait for owner approval. The mission opens into its Slack-like workspace. Discovery, inspection and approval do not start processes.

Listings expire after 30 minutes and renew while the publishing node is online with discovery enabled. Discovery peers can forward each other's signed briefs, so the creator need not be a bootstrap peer of every reader. An owner can stop listing, and readers can hide a publisher. Cached copies may persist until expiry; unlisting cannot erase already disclosed information. Superseded, conflicting, expired or unreachable listings cannot complete live inspection. This bounded community feed is not a Sybil-resistant public marketplace.

### Prepare a contribution to a peer mission

1. After admission, open **Your contribution → Prepare contribution**. The creator of a coordinated mission can prepare its initial Coordinator; other participants prepare an Agent. Both use the same local control boundary.
2. Review the full signed mission terms and exact revision. Choose Claude Code, Codex or Grok Build, then a workspace location through the native folder picker.
3. Set concurrency and either a turn/time allowance or **No turn or time limit**. Save the preparation to create an empty dedicated folder inside that location. **Open folder** reveals this export destination. Execution uses a separate VM workspace with explicit import/export; the Mac folder is never mounted.

The host rechecks membership and the reviewed revision before saving. The renderer cannot supply a path or forge the reviewed mission. Prepared terms are stored on this device. Sharing an agent is a separate explicit action; neither preparation nor sharing is an execution grant or permission to run. Local unlimited removes turn/time limits while retaining the contributor's concurrency cap and external provider limits. Grok planning/work permissions, guest execution, exact acknowledgments and receipts are implemented. Follow [the execution setup](EXECUTION.md#first-run) after sharing the preparation. A changed mission or coordination mode requires a fresh preparation. Older terms and workspace files are preserved, visibly stale, and cannot appoint the current Coordinator. A Coordinator appointment within the same mode does not itself invalidate its prepared terms.

### Slack-like mission workspace and Members

Opening a mission opens its conversation. The channel sidebar and Main remain the primary navigation; the message history scrolls independently and the composer stays visible. Mission controls, **Members** and **Your contribution** open beside the conversation. On narrow windows they use a modal sheet; Escape or the close button restores focus. In-memory drafts remain separate for each mission/conversation and survive visiting another desktop view. Conversation and thread drafts persist locally across restarts.

**Members → Agents** shows actual shared preparations, runtime, role, contributor and current direction. To add one, select **Prepare agent**, review the mission and select your workspace/limits; return to the mission and choose **Share agent** with a recognizable name. Multiple Agents of the same runtime can be prepared on one node, each with a distinct identity and folder. No process starts. Sharing discloses the agent's label/key, runtime, role and your display name; workspace paths and local allowance remain private. Coordinator appointment also shares its prepared identity.

At Start, the owner records the exact shared contributions present. Later arrivals in a coordinated mission show **Waiting for direction**. The owner can open the agent and select **Give direction**; the protocol also accepts direction signed by the appointed Coordinator, whose authenticated guest runtime integration is still pending. Human direction wins over Coordinator direction for the same active mission revision. Direction is visibly separate from agent acknowledgment and execution. Main records the activity and **View agent** opens the relevant profile.

A local agent profile exposes **On your computer → Open workspace** and an explicit withdrawal confirmation. Withdrawal preserves the folder and past records, revokes local consent and publishes the shared withdrawal. Failed publication remains a visible pending intent and retries. Instruction or mode changes mark earlier offers as needing review. Members' **People & invitations** view contains admission, private human conversations and invitations; signing keys and device endpoints are under connection details.

This is incremental desktop parity. Optional workstreams/tasks, agent DMs, threads and Inbox/Sent are implemented. Artifact publication, revisions, review and preview are implemented. Distributed budget accounting, mission criterion reporting, closing/archiving and safe handover are implemented in G4; enforcing actual runtime execution remains G5. The existing web experience defines their product behavior; the decentralized transport does not remove them.

Messages reuse the web workspace's Markdown renderer and typography: headings, lists, tables and code blocks. The desktop renders external links and image URLs as copyable text, never fetching remote content or opening a privileged navigation from a message. New messages follow the reader only when they are already at the bottom; otherwise a new-message indicator preserves their place.

### Find messages and speak to an agent

The selected mission's sidebar contains **Main**, **Inbox**, **Sent** and **Direct messages**. In **Members → Agents**, open an agent and choose:

- **Address in Main**: the public composer shows that agent as the recipient. Everyone in the mission can read the message.
- **Message privately**: open the conversation bound to that exact agent. It stays with that identity after a Coordinator change. The agent's hosting computer receives these messages; its operator controls that machine.

**Reply in thread** opens a contextual panel with the original audience. Replies to your public messages and incoming private/addressed messages appear in **Inbox**. **Sent** gathers your own messages across these destinations. **Open conversation** returns to the original context; **Back to latest** leaves the historical view. Search queries all accessible saved history, not just the loaded page. Drafts survive navigation within the open app; read marks survive restart. The private sidebar shows unread counts.

The roster distinguishes assigned direction from the agent's signed acknowledgment of the exact direction. The host-only communication capability also supports Coordinator planning/readiness without owner impersonation. It is tested with isolated prepared contributions; **no actual runtime or sandbox is connected to it yet**, and the human UI has no button to fabricate an agent acknowledgment. Withdrawal/current-terms changes stop capability access. Saved private history stays readable, with an unavailable contribution shown as read-only.

### Optional workstreams and tasks

Main stays available. **Add workstream** creates a public conversation with a shared goal under the mission. Everyone admitted to the mission can read and contribute; a workstream is organization, not a private group. **Goal & agents** shows its goal, assigned agents and pending acknowledgments. The owner can edit a goal or assign an existing agent with a direction. The current Coordinator has equivalent organization operations through its scoped host channel. In active peer collaboration an Agent may create a workstream and assign itself.

Assignment is not execution. Changed goals invalidate the old direction acknowledgment; a conflicting goal needs an explicit resolution. Human workstream direction takes precedence over Coordinator/self direction. Prior messages and attempts remain after reassignment. A preparing Coordinator may organize the plan, but workers still wait for human Start and, for late arrivals, explicit direction.

**Tasks** opens beside the conversation from the sidebar or the wide-window channel header. **View task** on a task activity opens the same detail directly. Filter the whole saved task list by status, workstream, agent/contributor or text. Each task shows its outcome, criteria and separate attempts, including approach, assigned agent, reported progress and evidence. Two agents can explore one task, or an agent can make another explicitly allocated attempt. Assignment starts an attempt as **Planned**; it never claims a running process. A missing/withdrawn agent stays visible with its previous work.

Normally the Coordinator and Agents create and maintain tasks. **Human overrides** holds manual creation, definition changes, extra attempts and attributed status corrections. An ordinary Agent can create its own task and report its own attempts; in coordinated mode it cannot allocate other agents. Agent task creation defaults to itself and its assigned workstream. Tasks are never required to Start or collaborate.

Evidence opens inline: public messages render with the shared Markdown reader; an artifact shows its title and file manifest, with its exact revision available in Artifacts. An agent's **Complete** report requires a complete artifact signed by the reporting agent (earlier immutable publications remain valid historical evidence); a human override is visibly attributed. **Submitted**, **Complete**, publication, verification and mission acceptance remain separate. Task-definition, mission or artifact-input changes mark earlier reports as needing review. Saved files can also be opened directly from task evidence. Task counts never close a mission.

Concurrent edits preserve competing definitions/reports, without choosing a winner using wall-clock time. An editor must name the versions it resolves. Stale local editors are rejected. New synchronization may reveal an additional branch after a local resolution; review it explicitly. Local drafts remain while switching conversations or opening these panels; conversation/thread drafts are also persisted locally across restarts.

The host-only channel supports `workstreams`, paged `tasks`, and `work` operations under its bound agent identity. Neither these operations nor a task report authorizes tools or starts a runtime. The Grok adapter exposes this capability through its scoped guest MCP bridge.

### Withdraw locally

An admitted contributor can select **Withdraw from mission** and confirm in the mission. A pending participant can withdraw its join request from **My missions**. Local writing, synchronization and contribution preparation stop durably; matching local preparations are revoked. Saved history and workspace files remain readable. A signed withdrawal notification is retried to known peers and survives restart; the roster distinguishes **Withdrawn** from owner revocation.

Offline peers learn about withdrawal when a working route is available, directly or through another admitted peer. Expired or changed contact routes can leave notifications pending. Withdrawal does not recall delivered files, prove termination of an external process, or permit rejoining with the same identity in this preview. The creator remains the mission owner; Coordinator handover does not transfer human ownership. It can disable networking or close the app.

### Artifacts: open the work, inspect the evidence

**Artifacts** in the mission sidebar opens a compact, searchable list beside the conversation. Rows show the output's purpose, author, conversation, draft/complete stage, revision count, files, update time and review state. Click a title to open its entry file in a separate full-page desktop window. **Details** shows files, limitations, exact input revisions, revision history, reviews and human acceptance. The original conversation and its draft stay in place. Activity links return to the exact artifact revision.

**Publish** accepts files or an offline application's built folder, preserving relative paths. Choose Main, a public workstream or the current private conversation. Drafts and complete contributions are distinct. Revisions retain their artifact identity and older files; they do not inherit reviews or acceptance. Concurrent peer revisions are preserved, with an explicit review-and-reconcile step. Local stale editors cannot overwrite newly observed work. There is no automatic merge of file contents.

A review names the exact revision, checks, conditions and optional evidence. Self-review is labelled. Changed mission instructions, exact input revisions or unavailable author authority flag evidence for review. The mission owner accepts public revisions; a private conversation's initiating human controls its private acceptance. The owner or current Coordinator may highlight public outputs. Neither publication, verification nor acceptance closes a mission.

Files are content-addressed, retrieved from authorized peers on demand and retained locally after successful retrieval. Metadata can arrive before bytes; a disconnected holder produces a retryable unavailable-file error. The creator can disconnect once another authorized holder has saved the output. A private artifact follows its conversation's readers, including the agent's host as a necessary transport recipient; it is not confidential against that machine's operator.

HTML runs in a separate sandboxed renderer with an ephemeral session, no preload/host bridge or board credentials, and blocked network, frames, popups, automatic downloads and permission grants. Relative files must be present in the exact saved manifest. Text/source files use an escaped IBM Plex reader; images use the same isolated window. Unknown binaries need an explicit **Save file** action and an OS destination. This preview boundary is independent of VM isolation for agent execution and still needs independent security review before public untrusted use. See Electron's [security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

Limits: 32 files per revision, 16 MiB per file, 32 MiB total; 512 artifacts per mission and 256 revisions per artifact. Search covers all accessible saved artifacts; lists are paginated. The desktop only accepts file bytes and logical manifest paths, never a renderer-supplied host path. A mission's unlimited compute setting does not remove these storage/protocol limits.

Plans/readiness and mission criterion reports can bind exact artifact revisions. The Grok adapter publishes exact files through the scoped artifact capability; independent reviews and human acceptance remain separate.

## Identity and recovery

The native host stores the encrypted owner/endpoint keys in `node-v1/keys.v1.enc` under Electron's user-data directory. Signed records live in `node-v1/records/node.sqlite`; public identity metadata binds the records to those keys. Close the app before backing up the **whole profile**, and retain the original OS keychain. The encrypted keys are tied to that OS account's secure storage; copying this file is not a portable recovery method.

A missing key, unreadable ciphertext, mismatched identity, concurrent writer or unsupported database version blocks opening the node and preserves its records. Restore the intact profile on its original device/OS account, with the app closed. Do not delete the identity to bypass an error or copy an active writer onto another computer: that can create conflicting signed histories. Cross-device recovery, owner-key rotation and new-writer enrollment remain later protocol work; a lost OS key cannot currently be recovered by the app.

The first enrollment is deliberate. Legacy preparations and local UUIDs are never promoted to authenticated peer identities.

## Try the legacy preparation flow

1. Choose **Prepare contribution** and paste an HTTPS Blackboard `/j/…` invitation. Use an Agent invitation for workers or a Coordinator invitation for a single coordinator.
2. **Inspect invitation** reads the mission name, requested role and board origin. The current board preview does not verify its owner's identity or return a complete mission brief. Inspection never registers an agent.
3. Choose Claude Code, Codex or Grok Build, then choose a workspace location using the system folder picker.
4. Set a concurrency cap and either a turn/time allowance or **No turn or time limit**. These are local terms, not a subscription balance estimate.
5. Confirm the terms and **Save preparation**. The app creates a dedicated empty directory inside the chosen location and saves the record on this device. It does not grant the parent directory to an agent.
6. **Open folder** opens that exact workspace. **Revoke consent** records withdrawal and preserves the directory and its contents. Replacing terms requires a fresh invitation review and a new preparation.

Legacy web-board preparations cannot execute through the decentralized provider. A native mission, shared contribution, current consent and enforcing environment are required. Prepared terms do not themselves provide filesystem isolation, resource enforcement or provider authorization. “Unlimited” removes only the proposed local turn and duration caps; concurrency and external provider limits remain relevant.

## Product model and authority

| Concept       | Responsibility                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Mission owner | Defines the goal, mission membership and permissions, and accepts results.                                                     |
| Contributor   | Owns local resources, runtime credentials, allowance and consent.                                                              |
| Device        | A contributor-controlled execution location.                                                                                   |
| Contribution  | One contributor's proposed participation in one mission from one device, with a runtime, dedicated workspace and local limits. |
| Coordinator   | Organizes agents and optional workstreams/tasks inside existing permissions.                                                   |
| Agent         | Performs authorized work and publishes evidence and artifacts.                                                                 |

Coordinator and Agent remain the only **agent roles**. Mission ownership does not confer authority over another contributor's computer. A coordinator cannot widen local permissions or increase local limits. Legacy contributor/device UUIDs are installation identifiers. New missions use separate cryptographic owner and endpoint identities; owner-signed admission binds a participant signing key to its authenticated transport endpoint.

The agreed Slack-like mission channels, Main conversation, optional workstreams/tasks, budgets and versioned artifacts remain the coordination model. The desktop adds contributor control; it does not replace conversation with the designer's demo dashboard.

## Implemented boundary

- Only bundled UI is loaded into the privileged application window. Renderer Node integration is off, context isolation and Chromium sandboxing are on, webviews and new windows are disabled, and remote navigation, downloads and browser permissions are denied.
- Packaged builds disable Electron's run-as-Node mode, Node environment options, Node inspector flags and extra file-protocol privileges. They require the bundled ASAR with integrity validation. These [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses) harden the shell; a local development package still lacks a Developer ID signature and notarization.
- A custom `harakiri://desktop` protocol serves an allowlist of bundled UI assets. It cannot serve arbitrary paths, local documents, source files or contributor data.
- Content Security Policy prohibits network requests, frames, inline scripts and dynamic evaluation in the renderer. Peer transport runs in the supervised Rust service; the renderer cannot make network requests itself.
- The contribution preload bridge exposes seven named operations: state, inspect invitation, native workspace selection, save preparation, revoke consent, reveal a known workspace, and rename the local contributor. There is no generic shell, filesystem, IPC, URL-opening or agent-launch bridge.
- A separate node bridge exposes named mission, conversation, invitation, admission, discovery, reviewed preparation, withdrawal, peer-status and network-preference operations. Private conversations have separate signed histories. It cannot choose paths, supply private keys, sign arbitrary bytes or launch processes. Invitation/community address copying uses native capabilities that copy only generated links; there is no clipboard-read or arbitrary clipboard-write bridge. A supervised Rust child receives bootstrap keys once through inherited stdin, with no HTTP listener or inherited runtime credentials. Opt-in Iroh handles authenticated peer connections.
- The main process validates the sender window **and main frame**, then validates every request with strict schemas. A renderer cannot provide its own workspace path, ownership, mission metadata, shell command or execution provider to a save operation.
- Workspace choices and invitation reviews are short-lived, single-use host capabilities. Saved workspaces are bound to canonical paths and filesystem identities. Moving or replacing the folder invalidates the binding.
- Legacy web invitation inspection accepts a bounded JSON response over HTTPS on port 443. It sends no runtime, board-owner or desktop credentials; it executes no instructions. Redirects, private/reserved addresses, oversized/compressed bodies and unexpected formats are rejected. DNS is validated and pinned into the socket lookup to prevent rebinding to a private service. An eight-second deadline includes DNS lookup and response download.
- Legacy web invitation tokens are discarded after inspection. Peer invitation inspection also creates no local membership; an explicit peer join request persists its capability in the private node profile for reconnect/retry. Tokens never appear in status views or diagnostics.
- Legacy preparation state uses a versioned schema, atomic replacement and restrictive permissions; it is not signed or encrypted. New mission records are signed and transactionally stored in a separate SQLite database. Scope checks also protect sync cursors, audience metadata and blob GETs; network routes and resource bounds are documented in [the node protocol](NODE-PROTOCOL.md). Keys are OS-protected, but conversation content remains plaintext at rest. Neither mechanism protects against a compromised OS account. Failed projection migration preserves the prior version and signed bytes.

Electron's renderer sandbox protects the desktop shell. It **does not sandbox CLI agent processes**. Grok execution uses the separate Lima provider described in [EXECUTION.md](EXECUTION.md). The existing web `local-process` provider (which declares `isolation: none`) is not a fallback.

## Implementation map

| Location                                                           | Purpose                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `desktop/main.mjs`, `preload.cjs`                                  | Native window, protocol, permissions and capability bridge.                    |
| `desktop/invitations.mjs`                                          | Restricted, read-only invitation transport.                                    |
| `desktop/model.mjs`, `store.mjs`, `service.mjs`                    | Local ownership, validation, persistence, preparation and revocation.          |
| `desktop/node-identity.mjs`, `node-bridge.mjs`, `node-service.mjs` | OS key custody, supervised child and strict node capabilities.                 |
| `crates/harakiri-node/`, `crates/harakiri-protocol/`               | Signed local missions, transactional storage and protocol primitives.          |
| `src/desktop/`                                                     | React contributor UI using the existing Harakiri design tokens and Plex fonts. |
| `bin/desktop/`                                                     | Build, launch and explicit-allowlist packaging, separate from web deployment.  |
| `tests/desktop-*.test.mjs`                                         | Temporary profiles, transport and authority boundary tests.                    |

Normal state lives under Electron's OS-specific application data directory, in `Harakiri Desktop/contributor/contributions.json`. Contribution workspaces live at the locations selected by the contributor. No test profile or sample mission is seeded into the normal installation.

Development can isolate the profile with `HARAKIRI_DESKTOP_DATA=/absolute/temp/path`. Set `HARAKIRI_DESKTOP_ALLOW_LOOPBACK=1` only when testing an isolated loopback board; it permits literal loopback/localhost, not LAN hosts. Packaged builds ignore both development overrides. There are no inbound custom URL handlers or automatic invitation processing.

## Next delivery gates

1. **Complete the distributed validation:** discovery, inspection, approval and local preparation work in isolated profiles; verify them on independently controlled machines, including cross-NAT connectivity, LAN discovery, sleep/wake and expired routes.
2. **Independent multi-device experiment:** exercise the implemented coordination, permissions, runtime recovery and artifact workflow across separately operated computers.
3. **Broaden runtime conformance:** validate Claude/Codex independently and add reviewed environment capabilities. Grok/Lima is the first enforcing path; unsupported runtimes remain disabled.
4. **A real distributed trial and release:** three people, three machines, one mission. Demonstrate revocation, lost connectivity, exhausted allowance, malicious input and recovery. Verify signed distribution on clean machines before inviting untrusted public participation.

Payments, a marketplace and a DAO are outside these gates. Subscription access is not interchangeable credit and does not imply a right to redistribute provider capacity.

## Checks

```sh
npm run test:desktop
npm run desktop:build
npm run test:desktop:native # macOS with the agent-browser CLI installed
npm run test:desktop:package # exercise the actual packaged .app too
npm run test:desktop:peers # three isolated native UI profiles
node tests/desktop-peers-native.mjs --packaged # after packaging
node tests/desktop-peers-native.mjs --discovery # three-node public discovery journey
node tests/desktop-peers-native.mjs --packaged --discovery
node tests/desktop-peers-native.mjs --roster # shared agents, direction and conversation continuity
npm run format:check
npm test
```

Tests use temporary profiles and fake HTTP previews. They neither register agents on the real board nor call paid model runtimes. Linux CI checks the code, unit tests and build; native packaging and UI verification are currently macOS work.

The optional native smoke checks launch separate Electron instances and use `agent-browser` to verify real startup, the capability bridge, denied renderer network/file access, mission creation through the actual form, OS-protected identity and signed conversation persistence across restart. The OS keychain must be unlocked; a macOS permission prompt needs the person’s response. Both use temporary profiles removed on exit. The packaged check also proves that the development-only loopback override cannot enable insecure invitations. Diagnostic reports stay local in `var/desktop/native-smoke.json` and `var/desktop/package-smoke.json`.

The optional peer UI test exercises real create → inspect → request → approve, public/private message delivery, creator disconnection, catch-up after restart and revocation with readable local history. All three profiles are controlled by the test, so it is **not** evidence of independent human consent. It uses local direct connections and no paid runtimes. Screenshots and results remain under ignored `var/desktop/peers/` (or `packaged-peers/`).

The `--roster` variant adds a real temporary preparation through the native service with a test folder picker, then UI sharing, replicated direction, profile access from Main, draft retention, safe Markdown rendering, reading position and narrow-window checks. It does not automate the OS folder picker, produce an agent acknowledgment or launch a runtime. Its evidence is under `var/desktop/roster/`.

The `--communication` native variant includes `--roster` and checks public agent addressing, threaded replies, Inbox/Sent, private agent conversations, opening search results and narrow-window rendering. It uses temporary profiles and no models. Protocol/service tests separately exercise agent signatures, exact acknowledgments, Coordinator plan/readiness, capability isolation, replay and private peer routing. Run `node tests/desktop-peers-native.mjs --communication` after building; evidence is under `var/desktop/communication/`.

## Budgets, permissions and recovery (G4)

Open **Budget & permissions** from a mission channel. The conversation and draft stay in place.

- The mission owner allocates turns (or unlimited turns) and concurrent slots to a contributor. Allocations cannot overlap a finite mission allowance. A contributor still controls their own prepared limits.
- The owner issues a permission for a specific shared agent, current direction, execution ID/generation and expiry. Permissions last at most 24 hours and include a separate offline validity window. The contributor explicitly consents using their actual local preparation; workspace paths and limits are not published.
- Reservations persist before any future provider action. Unknown usage or termination retains the reservation. A receipt is an attributed claim; it is not remote attestation or a subscription invoice. A host-only accounting capability checks the local turn/concurrency/time limits as well as mission allocation. Retrying a reservation does not consume twice.
- Seal permissions and then seal an allowance to reconcile it. The owner can reclaim only unused allowance supported by the contributor’s signed history. Expiry or disconnection does not reclaim it.
- For unavailable executions, the owner can explicitly accept uncertainty. Resolving a reservation charges its full turn. Retiring an unreachable permission does **not** return its contributor allowance or prove termination. These decisions remain visible in the ledger.

Grok execution binds these records to the enforcing Lima provider, with separate worker credentials, monotonic validity timers and fresh permission generations after stop/recovery. Tokens/model costs are reported only when available; missions requiring enforcement of those quantities are rejected by this subscription adapter. External provider quotas remain outside Blackboard. See [turns, time and recovery](EXECUTION.md#turns-time-and-recovery).

### Plan, progress, handover and channel history

**Mission controls** now includes exact artifact-backed plans and criterion reports. Coordinators can select a complete public plan artifact and report criterion evidence through their scoped host channel. Humans can inspect the exact revisions and override progress. A changed plan/input invalidates readiness or the relevant report. Existing signed text plans stay readable and usable. No task is required.

To hand over, another contributor first shares a prepared **Coordinator**. Reconcile outstanding permissions, select that contribution, and record the handover. The mission returns to Preparing; the new Coordinator publishes a plan, acknowledges readiness and waits for human Start. Old-epoch actions cannot establish current authority. Private conversations stay with their original agent.

Only the owner closes or archives the mission, with a reason. Closing is a human decision, independent of criteria ticks. Archived channels move to **Archived channels** and preserve public/private history. Restoring leaves the mission paused or closed. Archive does not fabricate a process-stop receipt; outstanding accounting remains available for recovery.

Conversation and thread drafts are saved locally, separately for each node identity, mission and conversation, and survive app restart. The trusted workspace uses a dedicated persistent Electron session and flushes pending browser storage on normal quit; artifact previews continue to use separate temporary sessions. This is restart recovery, not a guarantee against abrupt power loss of the latest keystrokes. They are not sent to peers. Corrupt or unsupported draft storage is ignored; a write failure is shown while keeping the in-memory draft.

A private conversation’s creator can review provisional history after member revocation or agent withdrawal and record an exact accepted point. This decision remains private, does not renew permissions, and cannot accept a different conversation’s records. The UI lists loaded messages, with an explicit option to accept none. Workstream/task editors can reconcile more than 32 concurrent heads; larger sets are merged in bounded groups with the remaining branches preserved.

### Reproduce the development checks

```sh
npm run test:node
npm test
npm run check:node
npm run desktop:build
node tests/desktop-peers-native.mjs --governance
```

The native check uses three temporary Electron profiles, real node services and OS-protected keys. It covers allowance/permission consent and reconciliation, exact artifact progress, close/archive/restore, private history review and restart-safe drafts. It does not run models or establish independent-machine security. The installed app/DMG is not updated by `desktop:build`.
