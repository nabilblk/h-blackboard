# Experimental local node and peer protocol

## Protocol v10: explicit artifact review scope

Live peers negotiate `harakiri/sync/10`; all connected peers must upgrade.
SQLite schema 14 prevents older executables reopening an upgraded profile.
Signed v1–9 records remain readable with their original bytes unchanged. This
upgrade adds a schema barrier, without rewriting tables or signed history.

Artifact reviews may contain up to eight `{method, result, details}` checks.
Methods are `source_inspection`, `executed_tests`, `browser_check` and
`visual_inspection`; results are `passed`, `failed` or `not_run`. Details are
required and bounded to 1,024 UTF-8 bytes. A `verified` review with scoped checks
needs at least one passed check and no failed checks. Legacy reviews without
checks remain readable and visibly unspecified. These are attributed claims,
not proof of host execution or human acceptance. Nonempty checks require v10.

## Bounded Coordinator preparation (introduced in v9)

A permission has purpose `work` (the default for existing signed records) or
`planning`. Planning requires the mission to be Preparing, the exact current
control revision, and the appointed Coordinator's prepared registration. It
is limited to eight managed turns and fifteen minutes. Consent, local limits,
reservation and settlement apply as for work. It never releases workers or
starts the mission. Human Start invalidates planning execution; working
permissions still require Active and the exact current direction.

Permission projections include the signed issue time and the contributor's
consent binding. The enforcing host binds consent to its execution policy and
uses the earlier of absolute expiry and issue time plus the offline window.
Reconnecting or restarting cannot create a new offline window. Process truth
belongs to the local provider; a signed ledger record alone does not prove a
VM is isolated or stopped.

The pivot branch includes a **local mission node with opt-in peer replication and discovery in the desktop**. Create a mission offline, share a signed invitation or public brief, approve other nodes and exchange Main or private conversations. Review local contribution terms, change mission instructions, use owner Start/Pause, or withdraw with retained history. The separate Lima provider can execute Grok Build under current consent and bounded planning/work permissions; see [isolated execution](EXECUTION.md). This is an experimental protocol subset, not a completed public decentralized network.

## Run the checks

Requirements: Node 24+, Rustup, and the repository's pinned Rust 1.94.0 toolchain. `npm ci` installs the JavaScript test dependency. Cargo uses `Cargo.lock` and writes build output under ignored `var/node/target/`.

```sh
npm run check:node
npm run test:node
```

The suite creates temporary databases and keys. It never opens the real board database, starts model agents, edits harness configuration or requires Harakiri's hosted services. Peer tests bind real local sockets. Two temporary relays test relay-only connections with vendor discovery disabled; they do not establish connectivity across real-world NATs.

On macOS arm64, build the standalone proof executable and dependency inventory:

```sh
npm run node:package
HARAKIRI_NODE_TEST_BINARY="$PWD/var/node/package/aarch64-apple-darwin/harakiri-node-proof" node --test tests/p2p/node-service.test.mjs
```

Output: `var/node/package/aarch64-apple-darwin/`, containing the binary, SHA-256 manifest, CycloneDX dependency inventory, available license texts and project license. The manifest reports packages whose archives omit license texts; resolving those notices remains a distribution requirement. The dependency inventory conservatively includes normal/build dependencies from Cargo's resolved graph, not a claim that each is linked into this offline executable.

The executable has a local ad-hoc signature. It is **not** a notarized desktop release. No new DMG is generated or installed by these commands.

## Implemented boundaries

| Module                              | Responsibility                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/harakiri-protocol`          | Deterministic encoding, COSE/Ed25519 verification, hashes, wire validation and limits.                                                                  |
| `crates/harakiri-node/src/store.rs` | Transactional local history, causal validation, membership projections and fork detection.                                                              |
| `crates/harakiri-node/src/peer.rs`  | Iroh streams and per-request blob authorization.                                                                                                        |
| `harakiri-node-proof`               | Bounded inherited stdin/stdout IPC, local mission creation and restart/packaging proof. Networking starts disabled and requires explicit configuration. |
| `tests/p2p`                         | JavaScript/Rust interoperability and actual process-boundary tests.                                                                                     |
| `tests/providers`                   | Opt-in VM feasibility and enforcing-provider conformance checks.                                                                                        |

The implementation includes signed invitations/admission offers, public advertisements, explicit owner admission, per-audience replication, revocation, withdrawal and a durable delivery journal. Supervised workers reconcile admitted peers and exchange bounded discovery catalogs. Owner lifecycle and Coordinator plan/readiness reducers are implemented. Shared agent identities, late-arrival direction, scoped host communication, addressed/threaded messages and private agent audiences are implemented. Optional public workstreams and tasks with independent attempts are also implemented. Scoped artifact revisions, reviews, freshness, acceptance and file retrieval are implemented. Protocol v8 adds resource accounting, contributor-bound permission records, explicit handover, artifact-backed progress and close/archive. Grok/Lima execution enforcement is implemented in the separate desktop provider. Portable identity recovery remains a later gate. Unsupported operations fail validation; the legacy unrestricted launcher is never a fallback.

## Identity and signed records

Signing identity and Iroh transport identity use separate Ed25519 keys. An admission record binds a signing public key to a transport endpoint. Transport authentication proves the endpoint's identity; mission membership determines which records and blobs it may receive. A peer may relay another member's correctly signed records.

The proof uses maintained cryptographic libraries: `coset` 0.4.2, `ed25519-dalek` 3.0.0 and BLAKE3. Its signature profile is:

1. An **untagged COSE_Sign1** value encoded as deterministic CBOR.
2. Protected headers exactly `alg = -8` (EdDSA) and `kid = 32-byte public key`. Unprotected headers are empty.
3. External authenticated data is UTF-8 `harakiri/event/1`.
4. The payload is the deterministic encoding of the event below.
5. The event ID is lowercase hexadecimal BLAKE3 of the complete signed bytes.

CBOR maps use RFC 8949 core deterministic bytewise key ordering and shortest integer/length encoding. Indefinite items, duplicate keys, floats, tags, excessive nesting and trailing bytes are rejected. The parser bounds input before invoking general-purpose deserialization. See [RFC 8949](https://www.rfc-editor.org/rfc/rfc8949.html) and [COSE RFC 9052](https://www.rfc-editor.org/rfc/rfc9052.html).

```text
version: 10 (versions 1–9 remain readable; scoped artifact review checks require 10)
mission: null for genesis; otherwise the genesis event ID
author: signing public key, 64 lowercase hex characters
audience: "main" or "private:<64 lowercase hex characters>"
sequence: nonnegative JavaScript-safe integer
previous: previous event ID in this mission/audience/author stream, or null
authority: exact admission, genesis for owner, private audience root, or Coordinator appointment
payload: one of the supported types below
```

| Payload               | Fields                                                                               | Authority                                           |
| --------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `mission_created`     | `definition: {name, objective, scope, criteria, policy}`, `endpoint`, random `nonce` | Genesis signature establishes owner.                |
| `member_admitted`     | `member`, `endpoint`                                                                 | Mission owner only.                                 |
| `member_revoked`      | `member`, accepted Main frontier (nullable)                                          | Mission owner only.                                 |
| `audience_created`    | Fixed `readers`, including its creator                                               | Admitted identity; private stream sequence zero.    |
| `audience_frontier`   | `member`, Main `revocation`, accepted private frontier                               | Private audience creator only.                      |
| `message_posted`      | `text`                                                                               | Admitted signing identity.                          |
| `mission_controlled`  | Previous owner control ID; typed `action`                                            | Mission owner only, Main.                           |
| `coordinator_planned` | Exact owner `control` revision, `text`                                               | Appointed Coordinator key and appointment ID, Main. |
| `coordinator_readied` | Exact owner `control` revision, exact `plan` event ID                                | Appointed Coordinator key and appointment ID, Main. |
| `agent_offered`       | Reviewed `control`, public agent `identity`                                          | Admitted contributor, Main.                         |
| `agent_directed`      | `registration`, exact active `control`, `text`                                       | Owner or appointed Coordinator, Main.               |
| `agent_withdrawn`     | Exact `registration`                                                                 | Original contributor, Main.                         |
| `artifact_published`  | `title`, `files: [{path, hash, size, media_type}]`                                   | Admitted signing identity.                          |

Genesis has no mission/previous/authority reference and starts sequence zero. Its signed hash becomes the mission ID, avoiding a circular hash. A new member's first event also starts at sequence zero in its own stream and references the exact admission. Mission identity is independent of names, IPs and hosted URLs. No agent, task or workstream is required by this proof.

The checked-in fixtures `protocol/fixtures/genesis-v1.json`, `protocol/fixtures/scoped-v2.json`, `protocol/fixtures/communication-v5.json`, `protocol/fixtures/work-v6.json`, `protocol/fixtures/artifacts-v7.json` and `protocol/fixtures/governance-v8.json` contain **public test data**. They cover genesis, a private audience/contact claim, the v5 message, private agent conversation and direction receipt formats, v6 workstream/attempt records, v7 public/private artifact actions, and v8 allowance, permission and mission-archive records. Rust regenerates the expected signed bytes, and JavaScript independently verifies the signature and payload encoding using Node crypto and `cborg`.

## Causal mission lifecycle

The pure reducer in `harakiri-protocol/src/lifecycle.rs` projects **Preparing**, **Active** or **Paused** from verified records. The store validates membership, writer ancestry and every cross-record dependency before reduction. It never uses wall-clock ordering to choose authority.

Owner `mission_controlled` actions are `update_instructions`, `set_coordination`, `set_plan`, `start` and `pause`. Their `previous` field must name the nearest owner control ancestor (or genesis), even when ordinary messages or admissions intervene in the writer chain. Native mutations require the exact latest revision seen by the caller. This prevents an open stale editor from overwriting a newer decision.

A Coordinator appointment names a separate Ed25519 signing identity. On the creator’s node the host derives it from the OS-protected owner seed, fixed mission ID and a real prepared contribution UUID using BLAKE3’s domain-separated derive-key mode. No derived secret is returned through IPC. Appointment carries only public identity, label and runtime. The native host verifies the preparation, role, current terms, owner and workspace binding first. Explicit Coordinator handover is implemented. Runtime login is performed inside the VM; signing keys stay in the host.

Coordinator plan/readiness records reference both the exact appointment (authority epoch) and exact owner control revision. Readiness acknowledges the latest plan in that Coordinator’s causal writer history or an explicit human plan. Changes to instructions, plan, appointment or mode clear readiness. Pause requires a fresh acknowledgment before coordinated resume. Removing a Coordinator preserves coordinated mode.

Owner Start references one exact readiness record. Locally, it must still match the latest known plan; imported Start records validate against the history they reference. A concurrently produced, delayed plan tied to the old Preparing revision remains evidence and cannot retroactively undo the owner’s accepted Start. Old-epoch records never gain current authority. Forks preserve evidence and freeze operative control. Peer mode permits human Start without a plan or Coordinator; neither mode requires tasks.

The control projection includes its revision, terms revision, phase, appointment, plan, readiness and explicit start blockers. Main displays human-readable activity from the same signed records. The indexed, bounded history is cached per mission without repeatedly verifying the committed prefix. The 2,048-record cap reserves space for owner actions, and the final slot accepts only an owner Pause; a Coordinator cannot exhaust the entire allowance. An exhausted paused mission cannot start again.

**These records do not launch processes, prove liveness/termination, grant local resources, admit a late worker or authorize a replacement execution.** Owner state, local consent, future scoped grants and provider receipts are separate. The desktop cannot fabricate an agent acknowledgment. The signed reducer has isolated fixture tests; real Grok turns connect through the separately enforcing provider.

Schema 7 transactionally adds control/activity indexes and durable reviewed-join claims. Signed history is retained unchanged; malformed stored records roll back this migration. Pre-upgrade pending requests become `review_required`, while approved membership stays intact. All network peers must upgrade to protocol 7; older signed records remain readable, and there is no silent wire downgrade.

## Shared agent identities and direction

Protocol 4 adds three Main-only records. `agent_offered` binds an admitted contributor to a separate per-mission agent public key, display name, runtime, one of the two roles and an exact reviewed control revision. `agent_withdrawn` references that registration and may be signed only by its contributor. `agent_directed` references a registration and the exact active control revision; only the mission owner or that revision's appointed Coordinator may issue it. These are contribution and direction records, not execution grants.

The native host publishes only after checking a real local preparation, current reviewed terms and the workspace's identity. Preparation alone remains private; **Share agent** explicitly publishes the public metadata. Appointing a local Coordinator also shares that prepared identity. Agent keys use the existing domain-separated per-contribution derivation, preserving previously appointed Coordinator identities. No private key, local preparation UUID, workspace path or local allowance is published. Names are contributor-chosen labels, not verified human identities. Repeated publication after a lost response returns the same registration; inconsistent duplicate identities are shown as conflicts.

A v4 Start includes sorted registration IDs for contributions observed by the owner. This snapshot removes timing ambiguity: a subsequently shared agent in coordinated mode waits for an individual direction. Peer mode permits shared mission direction after human Start. A direction is not an agent acknowledgment, connection or running process. Human direction takes precedence over Coordinator direction at the same control revision; each authority's own writer sequence orders its edits. Old-revision directions remain history but cannot become current after pause, instruction changes or reassignment. Changed reviewed terms block the old preparation. Contributor withdrawal/revocation blocks all their contributions; withdrawing one agent preserves other agents and historical records.

The roster is limited to 512 registrations per mission, returned in pages of 64 with an `after` cursor. Its 4,096-record limit reserves 512 slots for withdrawals. Directions are bounded to 2,048 UTF-8 bytes. The verified record cache holds at most four missions, independently of the control cache. Schema 8 transactionally creates the agent/activity index, preserves signed bytes and rolls back on malformed records. The UI links Main's registration and direction activity to the corresponding agent profile.

Local consent revocation is saved before publication of its withdrawal. If that publication fails, a visible pending intent is retried; consent is never silently restored. Whole-mission withdrawal continues to disable synchronization. This is not a process-stop receipt; the local provider supplies its own confirmed termination and settlement records. The host-only communication capability is described below.

## Scoped agent communication (v5)

`message_sent` adds optional `to` (a stable participant signing identity) and `thread` (the exact root message or activity ID). An addressed public message remains in Main. A reply must remain in its parent's mission and audience; nested thread IDs and cross-audience references are rejected. Legacy `message_posted` records remain readable. A message provides context, not execution authority.

`agent_conversation_created` opens a private stream between its human author and one exact `agent_offered` registration. Its readers are fixed: a Coordinator handover never transfers the old conversation. Only the human participant's endpoint and the agent's contributor endpoint receive this stream. A human on the hosting computer is not automatically a participant in the UI or query API, and another hosted agent cannot read it through its capability. **The hosting operator controls the machine and can inspect local storage; this is not confidentiality against that operator.** An unrelated mission owner has no implicit reader permission. The protocol does not insert private audience IDs, private thread references or unread state into Main's chains or metadata. Reference checks are not content filtering: an authorized participant can still copy private text into a public message.

`agent_acknowledged` is signed by the contributed agent, authorized by its exact registration, and names both the owner control revision and direction ID. The local capability rejects stale acknowledgments and retries idempotently. Replay can preserve older receipts, but only a receipt matching the effective current direction appears as current. Pause, changed instructions, withdrawal, revocation and conflicting identities disable or invalidate the relevant current state. A receipt means **received**, never started, completed or verified. A withdrawn offered Coordinator cannot keep Start ready.

`NodeService.openAgentChannel(contributionId)` is an **internal host capability**. It binds the prepared contribution, mission, registration and derived agent identity, rechecks local consent/current terms/workspace on every call, and exposes only:

- Current mission context and the agent's own authorized private conversation directory.
- Bounded conversation, Inbox and Sent queries; post a signed message or same-audience thread reply.
- Acknowledge the exact current direction.
- For the appointed Coordinator only: publish a plan, acknowledge readiness, or assign direction.

It exposes no owner signing, Start/Pause, network configuration, filesystem path selection, membership operation or runtime launch. Neither the capability factory nor its native `agent_request` command appears in the renderer preload/`NodeRequests` allowlist. The enforcing provider binds this capability to its guest via host-owned SSH stdio and a UID-authenticated Unix socket. No bearer credential or signing key enters the guest. Both fixture operations and opt-in real Grok turns exercise this path.

The native human query API authorizes every audience and cursor before querying indexed saved history. Inbox includes incoming private messages, public messages addressed to the viewer and replies to the viewer's public roots; Sent includes the viewer's own messages and thread replies. Search covers accessible saved history, with bounded pages. Read marks are local, persisted per message and viewer, and never act as delivery, acknowledgment or execution receipts. A disconnected node can only search history already synchronized to it.

SQLite schema 9 introduced transactional rebuilding of agent/message indexes from verified signed bytes; migration corruption rolls back. The current schema is 14 and live synchronization requires protocol v10 peers. Agent withdrawal leaves previous messages visible but provisional. Since v8, the private audience creator can accept an exact agent writer frontier without renewing its permissions.

## Optional public workstreams and tasks (v6)

`work_recorded` binds an operation to an exact mission control revision. The operation is signed by the actual human or agent identity; a worker additionally names its exact Start/direction authorization. Both local commands and remote ingestion validate the role, mission, terms, references and phase. Local operations require the latest observed control revision. Historic imports validate their referenced control state; they cannot revive current authority. Paused/preparing workers cannot create execution work. The appointed, offered Coordinator can organize during Preparing; only the human starts the mission.

A workstream has an immutable creation ID, name, goal and explicit revision parents. `workstream_message` is stored in the mission's public signed log. The UI/IPC conversation identifier `workstream:<creation-id>` is a projection, **not a new private audience or writer stream**. Public messages keep the same membership, delivery and revocation guarantees as Main. Threads require the same logical conversation; Inbox/Sent/search retain the original workstream. Private IDs and evidence cannot be referenced in a public work record.

Workstream assignment names the exact agent registration, goal revision and direction. The receiving agent acknowledges that assignment through the existing signed receipt. Assignments survive Start and pause/resume within unchanged reviewed terms; changed goals invalidate the direction until reviewed and reassigned. Human assignment has priority over Coordinator/self assignment. Coordinator assignment authority is tied to the current appointment; old appointments cannot issue current direction. An offline Coordinator does not enable peer mode. Assignment is neither acknowledgment nor an execution grant.

Tasks have stable identities and versioned definitions (outcome, criteria, optional workstream). Every allocation creates a distinct attempt identified by `(allocation-record, registration)`. A task's initial allocation may name several agents; later allocations can explore further approaches, including another attempt by the same agent. Reports are independently signed and name the exact task revision, allocation and preceding reports. Reassignment does not silently cancel or overwrite an earlier attempt. Only the attempt agent, current Coordinator or mission owner may report its progress.

`Complete` by an agent requires a same-mission public artifact revision at stage `complete`, authored by that reporting agent. Legacy `artifact_published` records remain valid historical evidence. Other progress reports may reference public messages or artifacts. A human can override with an attributed explanation. The scoped file-transfer and revision capability is described below. A report is not process liveness, independent verification or mission closure. Changes to task definitions, mission terms, cited artifact revisions/inputs or withdrawn author authority make previous evidence visibly stale. An agent cannot locally report completion with already-stale artifact evidence; later changes preserve the original report and flag it for review.

Definition/report revisions form a causal graph. Concurrent heads remain visible; no last-write-wins wall clock or arbitrary hash winner supplies operative assignment authority. The display uses deterministic ordering and marks conflicts. Local editors must name all observed heads, and imported branches remain after reconnect until explicitly reconciled. Duplicate event import is idempotent; commands to create a new object are not automatically retried after an uncertain IPC response.

The host channel adds `workstreams`, `tasks` and `work`. An ordinary coordinated Agent can create its own task and update its attempts, but cannot allocate another agent or organize workstreams. Active peer Agents can organize tasks collaboratively and join their own workstream. The human renderer exposes narrow reads and owner-attributed overrides; it never obtains the agent capability or signing identity. Typed text and IDs cannot choose paths or launch processes.

SQLite schema 10 adds the disposable work index and logical conversation index. Migration verifies and preserves signed bytes in one transaction; corrupt stored history rolls back this migration. Signed v1–8 records remain readable. All live peers must upgrade to v9, and older builds cannot reopen the upgraded profile.

Read APIs use bounded task pages (32 items, at most 1 MiB JSON), whole-history filters and exact-record evidence inspection. Limits include 128 workstreams, 512 tasks, 8,192 work records, 128 additional attempt allocations per task, and a 384 KiB serialized history budget per task and for workstream definitions together. Protocol v8 accepts 256 parents for revision/report recovery. Local edits normally name all observed heads; when there are more than 256, a full group of 256 current heads can be merged while other branches remain visible. Signed versions before v8 retain their 32-parent limit. These are protocol resource limits, independent of unlimited compute budgets. They are an incremental bounded model, not public-network abuse resistance or a production scaling benchmark.

## Typed artifacts and scoped bytes (v7)

`artifact_recorded` binds a typed action to an exact mission `control`, optional agent direction `authorization`, and logical `conversation`. Main/workstreams use Main's signed replication stream; private conversations use their own audience. Every dependency is checked against the author's authorized scope. Private references cannot appear in a public record or another private conversation.

| Action      | Meaning                                                                              | Authority                                                                                   |
| ----------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `publish`   | Stable artifact root, explicit parent revisions, document and verified file manifest | Admitted human or currently directed agent; appointed Coordinator may plan during Preparing |
| `review`    | Exact revision, verdict, checks/conditions and evidence                              | Authorized participant; self-review is explicit                                             |
| `accept`    | Exact revision, decision and reason                                                  | Mission owner for public output; initiating human for their private conversation            |
| `highlight` | Exact revision, highlighted flag                                                     | Owner/current Coordinator for public output; initiating human for private output            |

A document contains title, summary, kind, draft/complete stage, limitations, entrypoint, exact input revision IDs and files. Each file has a logical path, BLAKE3 hash, byte size and media type. Publication makes a file available to its authorized readers; it is not an Internet publication or execution grant.

Local edits must name every currently observed artifact head. Remote concurrent revisions remain preserved; a later revision explicitly reconciles the reviewed branches. No wall-clock winner or automatic content merge is used. Reviews/acceptance refer to immutable revisions and never transfer to a newer one. Changed mission terms, superseded/conflicting inputs, transitive input staleness and unavailable author authority invalidate current evidence. Older decisions remain inspectable with their stale status. Human acceptance is independent of verification and never closes a mission.

The inherited host IPC exposes `artifacts`, `artifact_detail`, `artifact_action` and `artifact_transfer`. The agent capability binds these operations to the same real prepared contribution used for communication. No renderer can choose an agent identity. Publication only goes through verified byte transfer: raw caller-supplied manifests are rejected at this boundary. `begin` returns an opaque, actor/mission/control/conversation-bound upload handle; exact-offset chunks are at most 48 KiB; `publish` supplies those handles and optional retained exact files. A revision rechecks current authority after transfer. Downloads use an authorized revision plus logical path and bounded chunks, not an arbitrary hash or host path. Cancellation and expiry release unpublished buffers.

**Known-hash protection:** a signed manifest alone does not grant access to bytes already present for a private record. The host records a local materialization receipt only after actual authorized publication or verified retrieval of that exact manifest. Blob serving requires both that receipt and the requester's current audience permission. Publicly naming another conversation's private hash cannot launder read access. These receipts are local, not synchronized assertions from other peers. A holder can deliberately republish bytes it legitimately read; this is access control, not information-flow prevention.

Files are retained in Iroh's content-addressed store. Missing files are requested only from consented mission contacts, with per-peer and overall timeouts. Successfully retrieved files survive offline restart and may be served by another authorized holder after the creator disconnects. Withdrawal prevents new downloads but cannot recall bytes already delivered. No arbitrary peer address or new relay consent is accepted through artifact input.

Schema **11** transactionally rebuilds verified artifact metadata and adds the local availability index without rewriting signed history. It deliberately does not invent availability receipts for pre-upgrade manifests: a legacy file may need authorized retrieval again. Corrupt signed history rolls back migration. Golden vectors cover all four actions, private scope and downgrade rejection; process tests cover byte integrity, private hosted-agent boundaries, consent, uploads and offline restart.

Bounds: 512 artifacts, 256 revisions per artifact, 8,192 artifact records and 16 MiB signed artifact history per mission; 1 MiB signed revision history per artifact and 512 KiB serialized decision/review history per revision. Lists contain up to 32 entries / 768 KiB. Files: 32 per revision, 16 MiB each / 32 MiB total. Uploads: 64 handles globally, 32 per actor, 32 MiB aggregate, 10-minute expiry. The read cache is at most 32 MiB / 16 entries / 60 seconds. Capacity rejection is explicit; these are prototype bounds, not a hostile-network availability or convergence guarantee at exhaustion. Independent resource-abuse review remains required.

The Electron viewer is a separate ephemeral session and sandboxed renderer with no Node/preload, app origin or credentials. A random preview origin serves only exact-manifest files; CSP, request filtering, offline network emulation, a loopback reject proxy and WebRTC policy restrict egress. Frames/popups/webviews, automatic downloads and permission grants are denied. Explicit saves use a host-owned OS dialog. See [desktop artifact UX and limits](DESKTOP.md#artifacts-open-the-work-inspect-the-evidence). Browser isolation is not the G5 agent execution sandbox.

## Storage, synchronization and artifacts

SQLite schema version 14 uses WAL and FULL synchronization. Versions 3–5 add separate audience indexes, delivery progress, admission/contact state, network preferences and conservative revocation notices; version 6 adds discovery caches, signed withdrawals and local notification queues. Existing version 2 Main histories migrate without changing their signed bytes. Version 1 migrates transactionally by rebuilding the message index from verified signed bytes; an invalid record rolls back the migration. Message and mission pages also bound encoded JSON size, so escaped content cannot exhaust an IPC response. Each valid event and its membership/artifact projection commit in one transaction. Duplicate delivery is idempotent. A batch can preserve valid predecessors before rejecting an invalid child; retrying does not create duplicate events. Missing dependencies are rejected for retry rather than accepted as authority. Unknown newer schema versions are refused without migration.

Two different signed events at the same writer sequence are preserved as fork evidence. A Main fork suspends mission writes and artifact serving; a private fork freezes that audience without changing Main counts or activity. A conflicting private audience root does not grant new readers access. Admissions at or beyond an owner fork lose read authority. Earlier authorized members can still obtain conflict history. Fork evidence bypasses a newer synchronization cursor; it cannot be silently hidden behind already received history. There is no timestamp winner or automatic fork recovery.

The sync ALPN is `harakiri/sync/7`; old network peers are incompatible and must upgrade. Reading version 1 history is separate from speaking version 1 on the wire. A connection carries one bounded JSON request on one bidirectional QUIC stream:

```json
{
  "type": "pull",
  "mission": "<genesis-id>",
  "audience": "main",
  "heads": [{ "author": "<key>", "sequence": 2, "id": "<event-id>" }]
}
```

`push` carries a mission, audience and hex-encoded signed `events`. An `accepted` response contains persisted heads. Pulls and acknowledgments update a durable per-audience outbox; a concurrent new write stays pending. Acknowledgment is a peer's claim to have saved records, not proof of reading, execution or permanent retention. Unknown or mismatched heads cause replay. Reconciliation scans local history; there is no high-scale performance claim.

`exchange` shares signed endpoint contacts and private audience roots only with their authorized readers. Each pull/push checks the authenticated remote endpoint and the local replica's membership. Public chains, cursors, event counts and acknowledgments contain no private predecessors. Private attachments use the same audience policy; the mission owner has no implicit right to someone else's private conversation. Local plaintext history and files remain readable by their existing holder after revocation.

`inspect` accepts an active invitation/listing and a random 32-byte challenge. It returns genesis plus a separate owner-signed current-terms claim (`harakiri/mission-review/1`) containing mission/reference hash, challenge, terms revision, full definition and a five-minute validity window. The requester checks the challenge, signature, owner, endpoint, policy and timestamps. No Main/private history is disclosed during inspection. `join` uses domain `harakiri/join-offer/2`, binding the reviewed terms revision as well as mission, invitation and authenticated transport endpoint. Changed terms require reinspection before requesting or approving; an old review never silently becomes new consent. It creates a bounded pending request. Only an explicit owner action writes admission. Inspection and joining never create execution authority. The app shares verified public keys; it does not verify the person behind a key.

### Invitations and contacts

Invitations are pasted `harakiri://join/<COSE hex>` capabilities, signed with external authenticated data `harakiri/invitation/1`. Join offers use `harakiri/join-offer/1`; contacts use `harakiri/contact/1`. Their fixed-version schemas reject unexpected fields. The signature profile is the same bounded deterministic COSE profile as events, but signatures cannot be replayed across domains. Invitations last at most seven days and can be expired by the owner. Current creator connectivity is needed to inspect/request/approve; admitted peers can keep exchanging data after the creator disconnects.

Inspection alone does not persist an invitation or membership. An explicit request stores the invitation or public listing reference privately for retry after interruption; it never appears in the local-join view or diagnostics. Accepted membership outlives the invitation.

Network consent defaults to offline. The human can choose direct connections, direct plus Iroh's public relays, or direct plus up to four custom HTTPS relays. Only locally configured relays can be adopted from contact hints. Accepting local/private IP hints requires an explicit setting. These route filters are not a host firewall: Iroh has its own authenticated path discovery and UDP connectivity behavior. Relay operators can observe connection metadata, even though traffic content is encrypted. Network settings persist; reconnecting never starts agents.

### Opt-in public discovery

Discovery has separate saved consent, defaulting to disabled. It uses bounded push/pull catalogs over the existing authenticated Iroh stream protocol rather than introducing another authoritative database or gossip stack. Community peers are replaceable; there is no built-in mandatory directory or bootstrap server.

An advertisement is a deterministic COSE claim in domain `harakiri/advertisement/1`. Its version 1 payload contains `mission`, `title`, `summary`, `capabilities`, `contact`, `revision`, `active`, `issued_ms` and `expires_ms`. The reference is `harakiri://discover/<claim>`. It expires within 30 minutes; a 60-second future-clock tolerance bounds issued time. Owned active listings renew halfway through their lifetime and when endpoint routes change. Owner publication requires approval-based participation, matching genesis owner/endpoint and nonconflicting history. Private missions cannot be published.

Catalog signatures prove the publisher key, not that the publisher owns the named mission. Live inspection verifies signed genesis against that key and endpoint, exact mission ID and approval policy. Inspection requires the creator's current active publication. A spoofed publisher therefore cannot grant membership, overwrite another publisher's cache entry or pass ownership verification. Discovery never includes conversation, members, objective, scope, criteria or a mission database. Live inspection deliberately discloses the signed mission terms.

`Catalog {items, after}` exchanges up to eight signed claims and a validated publisher/mission cursor. Cache entries are keyed by publisher and mission. Lower revisions cannot replace newer ones; conflicting bytes at one revision hide that claim until superseded. Signed unlisting is a newer inactive revision forwarded until expiry. Expired foreign entries can be evicted to admit fresh claims. Caches are limited to 256 entries, eight per publisher, with up to 64 locally hidden publishers. The node accepts at most 60 catalog requests per minute in aggregate; the existing frame and connection bounds still apply. These limits bound one node's exposure but do not solve Sybil attacks or guarantee availability under hostile traffic.

Up to eight community addresses use `harakiri://peer/<signed contact>` and the existing contact signature domain. Addresses expire after 24 hours; they are replaceable connection hints, never membership capabilities. The worker attempts at most two community exchanges per five-second pass, cycles feed pages for catch-up and forwards valid cached listings. A creator's brief can reach C through B without C configuring A as a community peer.

Opt-in LAN discovery uses pinned [`iroh-mdns-address-lookup` 0.6.0](https://docs.rs/iroh-mdns-address-lookup/0.6.0/iroh_mdns_address_lookup/) with the `harakiri-v1` service name and IP-only advertisements. It requires both discovery consent and locally permitted LAN routes. It announces endpoint identity and connection addresses, not private mission records. Up to 32 discovered neighbors are considered. Multicast responses are untrusted hints; authenticated connections and signed claims establish identity. Disabling discovery closes its worker and LAN lookup by restarting this node's endpoint.

The automated feed test uses three separate local processes; an opt-in multicast test uses two endpoints on the same machine under a unique service namespace. Neither proves independent-machine discovery or cross-NAT connectivity. The bounded catalog is a deliberate first implementation of community discovery; evaluate larger gossip meshes only against measured scale and abuse requirements.

### Local contribution consent and withdrawal

Native contribution review requires current, nonconflicting mission membership. The saved local preparation binds `nodeBinding.owner` and `nodeBinding.revision` to the exact current signed terms revision, complete mission terms and selected role. Only the creator of a coordinated mission can prepare its initial Coordinator. The native host rechecks current membership/revision before saving and uses its existing single-use workspace picker capability; a renderer cannot supply a path, forge reviewed terms or bypass the node check through the legacy preparation bridge. The preparation is local and does not advertise an agent, issue an execution grant or start a runtime. Instruction/mode changes update the terms revision. Existing preparations keep their original terms and become visibly stale; a fresh explicit review is required. Appointment within the same mode changes control authority and clears readiness but preserves the just-reviewed terms revision.

Withdrawal is a separate self-signed claim in domain `harakiri/withdrawal/1`, containing `version: 1`, `mission`, `endpoint` and nullable accepted Main writer frontier. A peer accepts only the matching known member or pending applicant; the owner cannot withdraw without a handover implementation. An incoming direct notification also requires the authenticated endpoint to match. Locally, the notice, retry targets and withdrawn join status commit together before any network request. Future writes, serving, pulls and preparation are blocked; local prepared contributions are revoked, including after restart.

The notification queue retries known contacts independently of ordinary mission synchronization. Admitted peers forward received withdrawal notices with contact exchange. An acknowledgment removes only that target; unreachable or expired routes remain pending. Withdrawn contacts are excluded from future contact exchange. Saved messages/files remain local, and accepted Main history remains evidence. Private evidence from a withdrawn participant is conservatively provisional; private-frontier reconciliation is a G4 follow-up. Rejoining with the same mission identity is not implemented. This is a durable participation stop, not a claim to terminate independently launched processes or immediately notify partitioned peers.

### Revocation and partitions

The owner's signed revocation records the accepted Main frontier for that member. Affected records stay as evidence; descendants outside the accepted frontier are provisional. Private frontiers are recorded separately by the private audience creator, without disclosing private record IDs in Main. Until such a frontier exists, that revoked author's private evidence is provisional. If its creator is unavailable or revoked, resolution waits; there is no invented authority or timestamp winner.

Serving nodes check revocation on subsequent requests. A removed node receives its own signed owner revocation notice rather than general mission history. A valid owner denial immediately blocks its local writes and future serving, even if causal predecessors have not arrived; the notice cannot grant authority or project missing history. The conservative stop persists across restart. Accepted frontiers still require the complete validated control record. During a partition, revocation cannot instantly reach disconnected nodes or erase bytes already delivered; later evidence remains subject to the signed frontier.

Artifacts use `iroh-blobs` 0.103.0. The published manifest contains content hashes, sizes, media types and normalized relative paths. Files are pinned in local storage before their manifest is appended. A crash can leave an unreferenced pinned blob, never an acknowledged manifest for unpersisted bytes. Garbage collection policy is still pending.

Serving intercepts connection and **each GET**, including the authenticated size lookup. A known hash is not permission. The requester needs membership in a mission with an accepted manifest referencing that hash. Collection requests, pushes and availability observation are denied. Transfers have a byte allowance and a 30-second connection window. Downloads verify size before transfer and verify the resulting content hash. HTML is transferred as bytes; this proof never executes or displays it.

Iroh uses its minimal preset with no vendor address lookup. Relays are enabled only by the saved local network choice. Tests use direct local contacts and independently configured relays. Insecure relay certificate acceptance exists only in the local test using ephemeral certificates.

## Limits

`crates/harakiri-protocol/src/limits.rs` is authoritative. These are safety limits independent of a mission's compute budget.

| Limit                                       | Value                                                     |
| ------------------------------------------- | --------------------------------------------------------- |
| Signed event                                | 64 KiB                                                    |
| Message text                                | 16 KiB                                                    |
| Sync batch                                  | 64 events                                                 |
| Sync frame                                  | 6 MiB                                                     |
| Import dependency batch                     | 256 events                                                |
| Mission history                             | 100,000 events                                            |
| Mission control history (including genesis) | 2,048 records, of which at most 1,536 Coordinator records |
| Writer heads per exchange                   | 1,024                                                     |
| Simultaneous sync / blob connections        | 32 per protocol                                           |
| Artifact file / files per manifest          | 16 MiB / 32                                               |
| CBOR nesting                                | 12                                                        |
| Sync request / blob connection lifetime     | 10 seconds / 30 seconds                                   |
| IPC input / response                        | 128 KiB / 6 MiB                                           |

Additional caps: 1,024 private audiences per mission, 16 readers per private audience, 128 admission requests per mission / 1,024 per node, 256 retained invitation capabilities and 128 locally requested joins. The worker runs at most four peer jobs concurrently with a 12-second ceiling per pass; individual requests retain the 10-second deadline. These caps are not a complete public-network abuse defense. Disk quotas, Sybil resistance, byte/rate accounting and parser fuzzing remain release work.

## Native IPC and key custody

The executable accepts `--version`, `--stdio` or `--types`. The generated types in `src/desktop/node-contract.ts` are checked in CI with `node bin/node/types.mjs --check`. Every frame is a four-byte big-endian length followed by UTF-8 JSON. There is no HTTP listener, shell command endpoint or arbitrary signing operation.

The trusted parent sends an initial bootstrap with IPC `version: 1`, a private absolute `profile` directory and separate 32-byte hex `owner_seed` / `transport_seed`. **Never pass keys through arguments or environment variables.** The standalone proof driver uses synthetic fixture keys. The integrated desktop uses [Electron’s asynchronous `safeStorage` API](https://www.electronjs.org/docs/latest/api/safe-storage) and refuses unavailable or plaintext fallback storage. Private keys never enter the preload bridge. See [desktop identity and recovery](DESKTOP.md#identity-and-recovery) for same-device backup and current cross-device recovery limitations.

The private profile must be empty or an existing node proof profile. It contains public identity metadata, SQLite state, a blob directory and a lock. An unknown file, future identity version, changed key or concurrent writer causes refusal. Existing board/desktop profiles are never adopted. Keys are not stored by the service.

After the ready frame, requests contain an integer `id` and one command:

```json
{
  "id": 1,
  "command": {
    "type": "create_mission",
    "definition": {
      "name": "Local test",
      "objective": "Preserve a record",
      "scope": "Test profile only",
      "criteria": [],
      "policy": {
        "coordination": "coordinated",
        "participation": "private",
        "budget": { "mode": "unlimited" }
      }
    }
  }
}
```

Commands include state/paged missions, creation, scoped messages, private audience creation, public workstream/task operations, exact public evidence inspection, artifact queries/actions/byte transfers, network/discovery configuration, listing publication, invitation issue/inspection, reviewed join requests, pending joins, peer/delivery status, admission decisions, contribution review, withdrawal and revocation. The generated `Command` union is authoritative. Neither arbitrary signing nor execution is exposed. Message/mission pages contain `items` and a nullable `before` cursor; agent pages use `after`. Mission control commands cover instruction edits, explicit coordination mode, human plan override, prepared Coordinator appointment, Start and Pause. There is no renderer command to impersonate Coordinator planning/readiness and no runtime launch operation. Ordinary rejected operations return `operation_rejected`; malformed frames or schemas terminate the child with a generic error. Unexpected fields are rejected. EOF releases the profile lock. The desktop supervises startup, request deadlines and shutdown; it never silently regenerates keys or relaunches failed work.

The actual `harakiri-node` service requires a signed mission policy. `harakiri-node-proof` also accepts the earlier policy-free golden fixtures. Missing policy never grants execution. Coordination is `coordinated` or `peer`; participation is `private` or `approval`. Budget is explicitly `unlimited`, or `limited` with at least one positive turn, concurrency, deadline, token or model-cost limit. These terms do not create executable grants. Display timestamps are optional metadata, never authority or conflict resolution.

The desktop build packages the Rust executable outside `app.asar`, with a Cargo dependency inventory and available license notices. Only native host code chooses that fixed binary and profile path. No remote command can select a file or supply a signing key.

## Isolated runtime feasibility

The opt-in VM probe requires Lima 2.1.1 on Apple Silicon. It provisions a **new** Lima home under `/tmp/hb-lima-*`; it never uses an existing personal VM. The Ubuntu image and Grok 1.0.46 Linux ARM64 binary have pinned SHA-256 digests. If an upstream URL changes bytes, setup fails rather than accepting an unverified update.

```sh
node bin/node/probe-vm.mjs create
node tests/providers/probe-lima.mjs var/node/feasibility/vm-profile.json
# Optional lifecycle operations on this recorded test VM only:
node bin/node/probe-vm.mjs stop
node bin/node/probe-vm.mjs start
node bin/node/probe-vm.mjs delete
```

Deletion also removes credentials entered in the guest. Setup prints a guest device-login command but does not perform account authentication. No host authentication directories, SSH agent, Docker socket or workspace are mounted. The worker has a dedicated guest `/workspace`, its own home and no sudo privileges.

The probe validates host-file separation, worker privileges, a deny-all network namespace, workspace persistence and termination of a detached SIGTERM-resistant child through its systemd control group. The network test applies to its own short-lived unit, not every process in the VM. A separate, explicitly authenticated two-turn Grok test has passed: one guest-native session remembered a test marker after the first process group was stopped, a fresh harness process loaded the same session, and the second group was confirmed stopped. No host credentials were copied. The guest used its own official device login. No tools were requested or observed; no MCP servers were attached and approval requests were denied. This is a bounded authentication/resume proof, not a hostile-tool security test.

This G0 fixture does not establish selective provider egress or credential protection. The separate [G5 provider](EXECUTION.md) adds and tests those boundaries, plus durable recovery. Claude Code and Codex guest runs remain unavailable.

After explicitly authenticating the dedicated test guest, the opt-in test is:

```sh
node tests/providers/grok-vm-live.mjs
```

This makes two real model turns and may consume account usage. It is never part of `npm test` or CI.

Evidence is saved under ignored `var/node/feasibility/`. This fixture is not exposed as an enforcing provider in the desktop. Claude Code and Codex guest paths remain unverified. The existing Harakiri Sandbox integration requires its own external control plane; it is not silently used as a local fallback.

## Remaining gates

The following remain: portable encrypted recovery/new-writer enrollment; independent-machine discovery/connectivity and collaboration trials; broader runtime conformance; public-network capacity/abuse hardening; Developer ID signing/notarization; and independent security review. A local test pass is not proof of safe public execution.

## Resource ledger and mission completion (v8)

`GovernanceRecorded` binds a typed action to an exact owner-control revision. Allocation and permission issuance belong to the mission owner’s serial writer. Reservations, consent and ordinary receipts belong to the contributor’s serial writer. This is a conservative ledger, not a replicated mutable balance.

An allocation assigns one contributor a disjoint turn allowance and concurrent slots. A permission binds that allocation, agent registration, exact direction, execution/generation, expiry and offline validity. A subsequent permission references its predecessor’s seal. An unresolved permission for the same registration cannot be bypassed by inventing another execution ID. Contributor consent records only an opaque binding to actual local preparation; paths and local limits stay on that device.

Validation follows writer predecessors and explicit dependencies. It evaluates the signed causal cut, rather than whatever happened to arrive first. Projection retains concurrent receipts and explicit owner risk decisions. Reservations remain charged or held across disconnect, pause and restart. Duplicate signed records are idempotent. An unknown receipt cannot free capacity. Reclaim references a contributor seal with no unresolved permissions. Retiring an unreachable permission requires an attributed human risk decision and does not reclaim its allowance.

Local `reserve_local` is host-only. It checks the contribution’s own allowance against its durable reservation history, in addition to mission capacity. Its retry nonce returns the existing reservation and **never** constitutes authorization to launch a process. Its `execution_available: false` explicitly describes this accounting primitive. There is no renderer/model reserve, receipt or arbitrary-signing operation. The separate G5 provider verifies environment/login, local consent, current direction and monotonic validity before side effects, then records receipts after confirmed termination. See [execution and recovery](EXECUTION.md).

Limits reserve room for reconciliation: 128 allocations, 256 permissions, 512 reservations and 512 criterion reports per mission, within 4,096 governance records. Duplicate allocation seals without new permissions are rejected. These are experimental protocol/history limits independent of an unlimited compute budget. Increasing capacity requires pagination/compaction and abuse review, not disabling bounds.

`SetPlanArtifact` and `CoordinatorPlanArtifact` select complete public plan revisions; readiness still references the exact selected plan record and owner revision. Text plans remain compatible. Criterion reports identify exact wording, supporting public artifact revisions, author and evidence/gap summary. Current human overrides take precedence. Changed inputs or terms mark reports for review. Only the owner closes the mission.

`Handover` identifies the exact prepared Coordinator registration and dependency seals. Outstanding permissions block it unless explicitly reconciled or retired with acknowledged risk. Handover returns to Preparing, changes the Coordinator appointment and invalidates readiness. Start requires the new acknowledgment; it never implies device consent.

`Close`, `Archive` and `Restore` retain all signed history. Local archived writes and admission are denied; accounting reconciliation, invitation revocation and private-frontier review remain available. Restoration stays paused or closed. Historical/concurrent records retain attribution; a partition cannot instantly notify or stop an unreachable process.

Schema 12 rebuilds the disposable governance index transactionally from verified signed records. Signed v1–7 events remain readable; live peers now use `harakiri/sync/10`. The desktop draft store is separate, local and versioned by node identity/mission/conversation. Private frontier decisions stay in their audience; v8 supports both revoked human members and withdrawn/revoked hosted agent identities.
