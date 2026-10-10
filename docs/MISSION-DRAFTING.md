# Shape a mission with your agent

Available since **0.4.8**, including the current **0.4.9 developer preview** on
`pivot/renting-the-rent`.
Download it from the [landing page](https://bb.harakiri.io/#download), or run
`npm run desktop` from source.

## From an idea to a mission

1. Open **New mission** and write a rough idea. Choose your installed Claude
   Code, Codex or Grok Build, then **Shape it with my agent**. You can also
   choose **Write the brief myself**.
2. Discuss the idea beside an editable brief. The helper proposes an objective,
   scope, deliverables and completion criteria, and asks one useful question
   at a time. Answer in your own words, select a suggestion, ask it to suggest
   an option, or leave the question for the team to investigate.
3. Edit any field yourself. A delayed reply cannot replace a field you changed
   while it was running: you choose between your text and the proposed change.
   Applied suggestions are marked and can be undone without reverting newer
   human edits.
4. Choose **Review mission**. Review the exact content and settings that will
   be shared. Assumptions and questions left for the team require explicit
   acknowledgment. Only **Create mission** creates the signed mission.
5. Continue in the existing Slack-like workspace. The mission is **Preparing**.
   Set up its Coordinator, review planning and start when ready.

Both authoring modes use the same saved draft. Switching mode or runtime does
not discard the brief or conversation. A helper is a local authoring capability,
not a third agent role, a mission member or the future Coordinator.

**Brief ready for review** means that the required name and objective are
present and the content fits the mission contract. The helper's assessment is
advisory, not proof that a goal is feasible. Exploratory missions may leave
criteria open. Tasks, extra workstreams and workforce configuration are not
required to write a brief. Coordinator readiness remains a separate, later
execution condition.

Deliverables, accepted assumptions and open questions are included in labeled
sections of the exact reviewed scope. The private drafting transcript is not
published to the mission. Creation neither appoints nor starts agents, enables
networking, publishes discovery nor grants execution permission.

## Your CLI and subscription

Install and sign in to your preferred CLI on the Mac. Harakiri discovers the
native executable; it does not install a runtime or alter global settings.

| Runtime | Live-tested version | Authentication and drafting session |
| --- | --- | --- |
| Claude Code | 2.1.295 | Its native subscription login; headless safe/restricted mode, no tools, hooks, project instructions, plugins or MCP integrations. |
| Codex | 0.162.0 | Its native ChatGPT login; an ephemeral app-server session with empty environments, disabled tools/integrations and read-only policy. |
| Grok Build | 1.0.41 | Its native subscription login; ACP with a text-only agent profile and a preflight check for inherited extensions. |

The runtime gate currently accepts Claude 2.1.295+, Codex 0.162+ in the 0.x
series, and Grok 1.0.41+ in the 1.0 series. These are compatibility gates, not
claims that every future release has been tested. Unknown major/minor families
fail closed where applicable. The native CLIs must already be trusted software.

Claude and Codex use their own existing login stores; Harakiri does not copy
credentials. If login is missing, use `claude auth login` or `codex login`, then
retry. API-key environment variables are not inherited, and drafting requires
subscription authentication instead of silently falling back to paid API use.

If Grok's usual profile contains hooks, plugins, MCP/LSP servers or project
instructions, Harakiri uses a separate private local profile. **Sign in to
private drafting** requests Grok's own device login. Open the fresh link in your
browser. This is a one-time local sign-in; your normal Grok configuration and
credentials are not changed or copied. Expired/cancelled links stop being
actionable. Managed extensions that cannot be excluded block drafting.

Drafting consumes your selected provider's subscription allowance. Provider
limits still apply, including when the later mission has unlimited budget.
Changing the provider sends the current brief and conversation to that provider.

## Privacy and recovery

- One private draft per desktop profile is saved in `mission-drafts-v1` under
  the app's user-data directory. It includes the brief, transcript, unsent
  message, unfinished list entries and bounded suggestion history.
- Files use owner-only permissions and atomic writes. The draft journal is
  **not application-encrypted**. The runtime uses a separate app-managed
  working directory; provider-native logging and retention can still apply.
- Sending transmits the idea, current brief and conversation to the selected
  provider. No other mission history, node keys or execution grants are passed
  to it. Manual authoring works without a model or provider login.
- **Stop**, runtime failure, closing the window and restart preserve the draft.
  An interrupted turn does not resume automatically. Retry, send another
  message, switch runtime or continue manually.
- An unreadable draft is preserved for recovery and does not block opening
  existing missions. Repair local storage access and restart; the app does not
  silently replace a damaged journal.
- Creation uses a frozen, explicitly reviewed revision. If its native response
  is lost, Harakiri checks newly created local missions before considering the
  result recovered; it never automatically repeats an uncertain create. Check
  **My missions** before explicitly discarding an uncertain draft.
- Conversation history is bounded to 80 messages; the final two slots are
  reserved so a reply can finish. Once full, the brief remains editable and
  reviewable. Up to 16 suggestions can be retained for undo, within an 8 MiB
  journal bound. Completing creation or explicitly discarding the draft clears
  that private authoring journal for the next mission.

The drafting profile restricts a local CLI. **It is not an OS or Lima sandbox.**
The host denies runtime tool/approval requests and rejects tool events, but this
does not turn an installed CLI into untrusted-code isolation. Actual mission
agents retain the existing [Lima execution and consent boundary](EXECUTION.md).

## Implementation and verification

`DraftingAPI` is a typed application port. React screens use it through the
injected client. `desktop/drafting/` owns storage, model adapters, validation,
revision conflicts and reviewed creation. Shared pure helpers build the exact
mission definition. The preload exposes an explicit method allowlist and
accepts calls only from the trusted app frame. Models can propose brief fields;
they never receive the creation or execution API.

```sh
npm test                     # Persistence, conflicts, undo, cancellation, review and authority
npm run test:drafting:ui      # Real React + isolated draft service, controlled provider
npm run desktop:build        # Types and native/renderer bundles
node tests/desktop-native.mjs # Isolated native identity, creation, history and restart
```

On 9 October 2026, all three installed runtimes produced real structured briefs
for the same community science-fair idea using the restricted adapters.
Follow-up turns took approximately 12 s (Claude), 18 s (Codex) and 29 s (Grok).
These are individual smoke checks, not comparative benchmarks or reliability
estimates. Grok's separate local login was exercised. The native manual
draft → review → Preparing mission → Slack workspace journey also passed.
Tests use temporary journals/profiles and do not populate the real workspace.

Validation: 242 application tests, including 15 drafting cases; component and
inspector checks; assisted-drafting browser interactions; native creation and
restart; and a three-profile invitation/messaging journey. Composer and review
controls remain visible at 1280px and 900px widths in Electron.

This change does not alter peer protocol 11 or SQLite schema 15. Independent
usability and cross-device trials remain separate validation gates.
