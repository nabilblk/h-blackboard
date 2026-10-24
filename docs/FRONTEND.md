# Frontend components and application boundary

The decentralized desktop has three independent layers: reusable UI components,
workspace screens, and an application client. Electron is a transport adapter.
Mission authority, signed records, storage, networking and execution enforcement
remain in the host and Rust node.

```text
src/ui/                       Designer tokens and reusable React controls
    ↑
src/workspace/                Connected shell, Home, Inbox, My agents and Settings
src/desktop/                  Mission conversations, feature forms and hooks
    ↓
src/application/client.ts     Framework-independent application ports
src/application/contracts/   Requests and responses, including generated node types
    ↑ implements
src/platform/electron/        Adapter to the allowlisted preload surface
    ↓
desktop/ + crates/             Native services, protocol and enforcement
```

`src/desktop/main.tsx` selects the Electron adapter and supplies it through
`ApplicationProvider`, then mounts `src/workspace/Workspace.tsx`. Screens call `useApplication()` rather than reading native
globals. Importing a screen does not require Electron to exist. Multiple isolated
clients can run without replacing a process-wide singleton. Effects subscribe
to the supplied port and clean up when it changes or the view unmounts.

The five ports cover workspace preferences/contributions, mission records,
local execution, reviewed setup/consent workflows, and private mission drafting. They expose typed
operations, not a generic IPC invocation, filesystem handle or shell endpoint.
Commands retain their exact mission revisions, readiness references and consent
inputs. Errors and rejected authority checks pass through to the caller.

## Changing or replacing the frontend

- Reuse `src/ui/` for new React screens. It has no application or backend imports.
- Replace React by implementing another presentation layer against
  `BlackboardClient`. The contracts contain no React or Electron dependency.
- An alternative host implements these ports. The existing browser fixtures
  demonstrate injection without native globals; they are not a production
  network transport.
- The current adapter uses Electron's existing preload. A remote/web host would
  still need its own authenticated transport and appropriate local execution
  capabilities. This change does not expose a new HTTP API.
- Generated node DTOs describe the public protocol and remain versioned with it.
  Regenerate with `npm run node:types`; check with
  `node bin/node/types.mjs --check`. Changing backend internals need not change
  a UI; changing the protocol contract requires an explicit migration.

Pure lifecycle projections in `shared/mission-presentation.mjs` and related
modules remain framework-independent. A running process, a permission, a signed
report and completed work remain distinct. The UI is never the enforcement
boundary, even when it disables a button.

The original web experiment under `src/App.tsx` and `server/` retains its own
HTTP client. This separation targets the active decentralized desktop; it does
not silently change that older product or its deployment.

## Component reference

The supplied designer HTML and token file remain the visual source. `src/tokens.css`
is unchanged. Reading/controls use IBM Plex Sans; labels, identifiers and code use
IBM Plex Mono. Shared styles live in `src/ui/`, while `src/workspace/workspace.css` owns the new workspace layout and
`desktop.css` retains the feature layouts. The workspace defaults to the supplied
designer light palette; its dark appearance uses the original dark tokens. Theme
selection is local and also applies to portal-based dialogs. The component catalogue runs without a node, database or credentials:

```sh
npm run dev:ui
```

Open <http://127.0.0.1:4518>. Its example records exist only in the page.

| Component | Use | Behavior |
| --- | --- | --- |
| `Button` | Ordinary, primary or destructive actions | Default `type="button"`; explicitly use `type="submit"` in forms. Use `size="compact"` for message-row actions. Disabled, hover and focus share one treatment. |
| `IconButton` | Compact named actions | Requires an accessible label. |
| `Disclosure` | Sidebar groups, settings, evidence and history | Whole-row native keyboard target, styled chevron, optional count. Children stay mounted to preserve drafts. |
| `ViewTabs` | Contextual view selection | Labeled pressed buttons, normal Tab navigation plus arrows/Home/End. Panels can live elsewhere; it does not claim ARIA tabpanel semantics. |
| `ActionPopover` | Secondary action groups | Ordinary tab-reachable buttons; closes on action, outside click, focus exit or Escape. Escape restores trigger focus. |
| `Field` | One labeled input/select/textarea | Native wrapping label, shared field typography and spacing. Form state and validation belong to the screen. |
| `GrowingTextarea` | Editable brief fields and list entries | Fits the controlled text up to a bounded height, then scrolls; forwards normal native textarea props. |
| `ChoiceGroup` | Runtime and other exclusive choices | Native labeled radio inputs, one shared focus and selected treatment. |
| `JourneySteps` | Read-only setup progress | Ordered steps with `aria-current`; does not imply execution permission. |
| `ScreenBoundary` | Recoverable screen failure | Preserves navigation and offers retry; never changes saved mission state. |
| `Status` | Attributed state labels | Text plus a square marker. Neutral by default; explicit semantic tones. Color never replaces the label. |

Use a sidebar disclosure for **Archived channels**. Use section disclosures for
mission settings, assessments, history and technical details. Counts indicate
records, not progress. Put a primary action in a button, not inside a disclosure
title. Titles must not contain other interactive controls.

Add shared control styles to the component layer. Screen CSS should arrange
components, not override their fonts, colors, focus states or disclosure markers.
Keep conversation/draft state mounted while contextual panels open. New controls
must preserve human Start, contributor consent and local Stop.

## Checks

```sh
npm test                      # Includes frontend dependency/adapter checks
npm run desktop:build         # Types, native service, renderer and host bundles
npm run test:ui               # Components, inspectors, drafting, conversations and connected workspace
node tests/desktop-native.mjs # Isolated native profile; requires macOS
```

`test:ui` needs the `agent-browser` CLI and its browser installed. It checks
keyboard disclosure, focus, draft retention, view selection, popover dismissal,
form submission and narrow layouts. Inspector fixtures inject read-only clients;
they do not alter the real workspace or execute models. Native tests separately
exercise the real preload, protected identity, mission history and restart.

The drafting journey uses `MissionDraft`, `DraftConversation`, `BriefEditor` and
`DraftReview`, plus a serialized autosave hook. Runtime processes and journals
live under `desktop/drafting/`; the UI cannot invoke a shell or inspect login
stores. `shared/mission-draft.mjs` defines pure readiness and exact handoff
formatting. `npm run test:drafting:ui` tests the real screens against a temporary
draft service and a deterministic provider, including late-reply conflicts,
undo, mode changes, restart and explicit reviewed creation. It is also included
in `test:ui`. See [mission drafting](MISSION-DRAFTING.md) for the product and
runtime boundary.

The default tests reject backend imports/direct native globals in screens and
application dependencies in reusable controls. They also reject raw disclosures
in desktop screens. This prevents the unstyled native controls from returning.

## Connected workspace (0.5.1 source)

Home, cross-mission Inbox, My agents, Discover and Settings stay outside the selected
mission. Mission Conversation, Work, People and Brief share a stable shell. The
conversation remains mounted across these views; drafts are scoped to the local
author and mission. Global search finds missions/actions; conversation search
queries saved message history. Keyboard navigation and Back/Forward preserve
reading context rather than reissuing commands.

`ContextPanel` supports inline pages inside the new workspace and the original
inspector layout in isolated feature fixtures. Both use the same application
operations; inline presentation does not create a second authorization path.
`src/application/observations.ts` shares subscriptions by port identity, bounds
parallel reads and backs off failures. My agents and Inbox use those observations
instead of unbounded per-render request loops. Execution presentation preserves
uncertain/stale states; no optimistic badge proves a process stopped.

`tests/workspace-ui.mjs` drives the production components with isolated ports:
first launch, mission switches, draft continuity, threads, invitation admission,
setup configuration, stop failures, appearance, compact keyboard navigation,
exact artifact opening/acceptance and capability destinations. Native tests use
a temporary protected profile and the real preload/service. Neither seeds the
user's workspace or changes runtime credentials.

Autonomous acceptance adds two source-blind tester personas: a mission owner and
an independent contributor operating separate real desktop profiles. They use
the visible UI, record actions and failures, inspect actual model-produced work,
and retest after controlled engineering corrections. Keep baseline and corrected
runs separate. Count product retries separately from browser-automation mistakes;
exclude authentication and engineering pauses from product latency. Agent timings
are proxy observations, not human usability benchmarks. Two profiles on one Mac
do not prove independent-device behavior. A fixture pass, a running process, and
an accepted deliverable remain different evidence.
