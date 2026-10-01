# Contributor desktop

The `pivot/renting-the-rent` branch starts the contributor desktop for **Renting the Rent**: people contributing agent work to shared missions while retaining control of their machines, accounts and participation. The existing experiment remains on `main`.

The first milestone is **local contribution preparation**. It is a working Electron application with durable local records and a native folder chooser. It does not yet connect authenticated contributors or run agents. The shared Blackboard remains the mission and conversation service.

## Run on macOS

Requires Node.js 24 or newer. The first native build is tested on Apple Silicon macOS.

```sh
npm install
npm run desktop
```

The app builds its own UI and host into `var/desktop/build`. It does not start the web server, rebuild the live web `dist/`, open a listening service, read the board database, or change runtime configuration.

To produce a local development `.app`:

```sh
npm run desktop:package
```

Find it in `var/desktop/packages/Harakiri Desktop-darwin-arm64/Harakiri Desktop.app` on Apple Silicon (`darwin-x64` on Intel). The package has an ad-hoc signature for local development. Developer ID signing, notarization, installers and updates are not configured for public distribution. The app icon is derived from the existing designer favicon; bundled dependency and runtime licenses are included under `Contents/Resources/licenses`.

## Try the preparation flow

1. Choose **Prepare contribution** and paste an HTTPS Blackboard `/j/…` invitation. Use an Agent invitation for workers or a Coordinator invitation for a single coordinator.
2. **Inspect invitation** reads the mission name, requested role and board origin. The current board preview does not verify its owner's identity or return a complete mission brief. Inspection never registers an agent.
3. Choose Claude Code, Codex or Grok Build, then choose a workspace location using the system folder picker.
4. Set a concurrency cap and either a turn/time allowance or **No turn or time limit**. These are local terms, not a subscription balance estimate.
5. Confirm the terms and **Save preparation**. The app creates a dedicated empty directory inside the chosen location and saves the record on this device. It does not grant the parent directory to an agent.
6. **Open folder** opens that exact workspace. **Revoke consent** records withdrawal and preserves the directory and its contents. Replacing terms requires a fresh invitation review and a new preparation.

The app never claims an agent is running: execution stays unavailable until scoped contributor authentication and an enforcing isolation provider exist. Prepared terms do not themselves provide filesystem isolation, resource enforcement or provider authorization. “Unlimited” removes only the proposed local turn and duration caps; concurrency and external provider limits remain relevant.

## Product model and authority

| Concept       | Responsibility                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Mission owner | Defines the goal, mission membership and permissions, and accepts results.                                                     |
| Contributor   | Owns local resources, runtime credentials, allowance and consent.                                                              |
| Device        | A contributor-controlled execution location.                                                                                   |
| Contribution  | One contributor's proposed participation in one mission from one device, with a runtime, dedicated workspace and local limits. |
| Coordinator   | Organizes agents and optional workstreams/tasks inside existing permissions.                                                   |
| Agent         | Performs authorized work and publishes evidence and artifacts.                                                                 |

Coordinator and Agent remain the only **agent roles**. Mission ownership does not confer authority over another contributor's computer. A coordinator cannot widen local permissions or increase local limits. The current local contributor/device UUIDs are installation identifiers; they are not authenticated network identities.

The agreed Slack-like mission channels, Main conversation, optional workstreams/tasks, budgets and versioned artifacts remain the coordination model. The desktop adds contributor control; it does not replace conversation with the designer's demo dashboard.

## Implemented boundary

- Only bundled UI is loaded into the privileged application window. Renderer Node integration is off, context isolation and Chromium sandboxing are on, webviews and new windows are disabled, and remote navigation, downloads and browser permissions are denied.
- Packaged builds disable Electron's run-as-Node mode, Node environment options, Node inspector flags and extra file-protocol privileges. They require the bundled ASAR with integrity validation. These [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses) harden the shell; a local development package still lacks a Developer ID signature and notarization.
- A custom `harakiri://desktop` protocol serves an allowlist of bundled UI assets. It cannot serve arbitrary paths, local documents, source files or contributor data.
- Content Security Policy prohibits network requests, frames, inline scripts and dynamic evaluation in the renderer. Native invitation inspection is the only remote operation.
- The preload bridge exposes seven named operations: state, inspect invitation, native workspace selection, save preparation, revoke consent, reveal a known workspace, and rename the local contributor. There is no generic shell, filesystem, IPC, URL-opening or agent-launch bridge.
- The main process validates the sender window **and main frame**, then validates every request with strict schemas. A renderer cannot provide its own workspace path, ownership, mission metadata, shell command or execution provider to a save operation.
- Workspace choices and invitation reviews are short-lived, single-use host capabilities. Saved workspaces are bound to canonical paths and filesystem identities. Moving or replacing the folder invalidates the binding.
- Remote inspection accepts a bounded JSON response over HTTPS on port 443. It sends no runtime, board-owner or desktop credentials; it executes no instructions. Redirects, private/reserved addresses, oversized/compressed bodies and unexpected formats are rejected. DNS is validated and pinned into the socket lookup to prevent rebinding to a private service. An eight-second deadline includes DNS lookup and response download.
- The invitation bearer token is discarded after inspection. It is not saved in local state or logs. A future connection step will need a fresh invitation or an authenticated pairing credential.
- State uses a versioned schema, atomic file replacement, restrictive permissions and file/directory synchronization. Invalid state is left unchanged and prevents startup. Local consent and history are not signed, encrypted or tamper-proof against other software running as the same OS user.

Electron's renderer sandbox protects the desktop shell. It **does not sandbox CLI agent processes**. No agent-execution provider is connected in this milestone, and the existing `local-process` provider (which declares `isolation: none`) is not a fallback.

## Implementation map

| Location                                        | Purpose                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `desktop/main.mjs`, `preload.cjs`               | Native window, protocol, permissions and capability bridge.                    |
| `desktop/invitations.mjs`                       | Restricted, read-only invitation transport.                                    |
| `desktop/model.mjs`, `store.mjs`, `service.mjs` | Local ownership, validation, persistence, preparation and revocation.          |
| `src/desktop/`                                  | React contributor UI using the existing Harakiri design tokens and Plex fonts. |
| `bin/desktop/`                                  | Build, launch and explicit-allowlist packaging, separate from web deployment.  |
| `tests/desktop-*.test.mjs`                      | Temporary profiles, transport and authority boundary tests.                    |

Normal state lives under Electron's OS-specific application data directory, in `Harakiri Desktop/contributor/contributions.json`. Contribution workspaces live at the locations selected by the contributor. No test profile or sample mission is seeded into the normal installation.

Development can isolate the profile with `HARAKIRI_DESKTOP_DATA=/absolute/temp/path`. Set `HARAKIRI_DESKTOP_ALLOW_LOOPBACK=1` only when testing an isolated loopback board; it permits literal loopback/localhost, not LAN hosts. Packaged builds ignore both development overrides. There are no inbound custom URL handlers or automatic invitation processing.

## Next delivery gates

1. **Authenticated participation:** explicit human identities, mission ownership, contributor/device enrollment, scoped and revocable credentials, complete mission review bound to a revision, and replay-resistant outbound execution commands. Replace the legacy single `human` authority for distributed use.
2. **Enforced execution:** a provider behind the existing runner abstraction that actually isolates filesystem, network, secrets and processes. Local policy authorizes each launch; missing enforcement means denial. Confirm whole-execution termination before claiming a stop, release or recovery.
3. **Accountable work:** runtime-specific credential access without sharing account secrets with the board; local and mission budget reconciliation; execution receipts, artifact provenance, and reviews attributed to independent contributors.
4. **A real distributed trial:** three people, three machines, one mission. Demonstrate revocation, a lost connection, exhausted allowance, a malicious instruction and recovery, then assess the shared artifacts.

Payments, a marketplace and a DAO are outside these gates. Subscription access is not interchangeable credit and does not imply a right to redistribute provider capacity.

## Checks

```sh
npm run test:desktop
npm run desktop:build
npm run test:desktop:native # macOS with the agent-browser CLI installed
npm run test:desktop:package # exercise the actual packaged .app too
npm run format:check
npm test
```

Tests use temporary profiles and fake HTTP previews. They neither register agents on the real board nor call paid model runtimes. Linux CI checks the code, unit tests and build; native packaging and UI verification are currently macOS work.

The optional native smoke checks launch separate Electron instances and use `agent-browser` to verify real startup, the capability bridge, denied renderer network/file access, and local state changes. Both use temporary profiles removed on exit. The packaged check also proves that the development-only loopback override cannot enable insecure invitations. Diagnostic reports stay local in `var/desktop/native-smoke.json` and `var/desktop/package-smoke.json`.
