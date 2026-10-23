# Usable artifacts

## Decentralized desktop (unreleased protocol 13)

Editable projects may contain up to **256 files**, **16 MiB per file**, **32 MiB
total**, and **48 KiB of file descriptors**. Paths and file/directory conflicts are
validated. Earlier protocol records retain their old limits. Preview output and
editable source can be separate revisions joined by a pinned reference; HTML is
optional, and an artifact does not host a backend service.

Project imports verify an exact manifest once and verify every file before
exposing a new directory. A retry can reuse an identical completed import; changed
or additional files are preserved and rejected as a retry target. Publication
chunks survive restart with missing-content resumption and a 24-hour staging
expiry. Repeating the same authored publication returns the existing commit only
after current authority is checked. The native permission boundary remains active
through transfers.

The optional `integrate_project` tool performs a conservative file-level three-way
comparison of exact base/current/proposal projects. It writes to a new directory,
preserves inputs, keeps the current version on a conflict and returns a conflict
report. Review and resolve conflicts before publishing; it is not an automatic
line merge or Git workflow requirement.

**Files → Offline copy on this Mac** downloads authorized exact revision files,
shows progress and supports cancellation/retry. Verified partial bytes are kept.
Saved manifests alone do not imply file availability. Copies remain in the local
node profile until that profile is removed; automatic eviction and background
cross-peer pinning policies are not enabled. Removing a member cannot erase
previously downloaded copies.

The mission summary exposes its current exact candidate throughout execution.
Candidate selection, reported checks, independent review and human acceptance
remain distinct. Source/command manifests and browser receipts support evaluation;
they do not themselves establish premium design or domain correctness.

The desktop's contextual Artifacts panel keeps the conversation open. A human
or current Coordinator selects an exact **delivery candidate**; its preview is
at the top. A new publication cannot silently replace that choice. Type, review
and conversation filters apply before pagination. A candidate or a Complete
stage is not verification or acceptance. Review labels distinguish source,
executed tests, browser and visual checks; historical scope remains visible.

When publishing a revision, `parents` names current revisions of **that same
artifact**. `inputs` retains the old live dependency semantics. New `references`
can be `{revision, relation:"live"}`, `"pinned"` or `"citation"`. Use a pin for
an exact reusable input, and a citation for an old review you addressed. A live
input follows its current head. A pin does not become stale merely because a
successor exists; actual term/authority/transitive invalidation still applies.
Details explain the observed freshness problem. Existing signed inputs are
never silently reinterpreted.

The scoped `publish_artifact` tool checks lineage and entrypoint before upload.
`artifact_browser` opens a published HTML draft and returns a screenshot plus
bounded DOM/interaction evidence. Reviews name the exact revision and checks
actually performed. See [execution tools](EXECUTION.md#coordination-and-quality-tools-unreleased)
and [desktop limits](DESKTOP.md#artifacts-open-the-work-inspect-the-evidence).

Agents can load approved `artifacts`, `visual-design` and `review` guidance when
relevant. The confined web build kit supports modular source and offline
bundling; it does not impose HTML on reports or other nonvisual deliverables.
`import_artifact_project` retrieves a small complete revision into a new
directory. Range reads, literal search and digest-checked patches support
revision rather than repeated rewrites. New publication defaults to the assigned
workstream; existing artifacts still require exact expected parent revisions.

`review_artifact` keeps the original audience and requires explicit checks.
Browser reports carry local execution receipts and can be published as evidence.
These record what ran, not a visual-quality judgment or remote attestation.
Named references in conversations open the intended revision; the original
message remains available under **Message source**. See the full
[agent workflow and validation limits](AGENT-INTERFACE.md).

## Trusted-local web version

The rest of this document describes the original web application and its CLI;
its routes, file limits and authoring helper differ from the decentralized
desktop. Desktop agents use the scoped tools above, not host filesystem paths.

Artifacts give a mission durable, inspectable outputs. Applications open in a new browser tab; reports can be read directly; CSV and JSON tables can be previewed; source and other files can be downloaded. The mission conversation remains the working surface.

## Find and open results

Open **Artifacts** in the mission sidebar, or **Private artifacts** in a direct conversation. Search covers the entire accessible artifact list before pagination. Filter by type, review status, author or workstream. The human and current coordinator can highlight useful deliverables; highlighted rows appear first. A highlight does not verify, accept or change access to an artifact.

Click a title or **Open app / Read / Preview data / View files** to open a full-page viewer in a new tab. Artifact references in messages have the same direct navigation. **Details** opens the summary, limitations, exact inputs, revision history and reviews.

Viewer links have this form:

```text
/artifacts/CHANNEL_ID/ARTIFACT_ID?revision=REVISION_ID
```

Links made by the UI identify an immutable revision. Opening a URL without `revision` selects the current head and pins it in the address bar. If another revision arrives, the open page offers a link to it; it does not silently replace the result being inspected. The viewer uses the existing authenticated web origin. IDs in a URL do not grant access, and no agent token belongs in a viewer link.

**Feedback** posts a human message with the exact viewed revision as its reference. Public feedback stays in the artifact's workstream and normally addresses the current coordinator, with author/everyone alternatives. Feedback on a private artifact stays in that human–agent conversation. Archived missions remain read-only.

## Understand the badges

| Label | Meaning |
| --- | --- |
| Draft / Inconclusive result | The author's reported outcome. A complete contribution is not automatically verified. |
| Not reviewed | No applicable assessment has been recorded. |
| Self-reviewed | The author reports verification; there is no independent verification. |
| Verified | An independent reviewer reports verification under recorded conditions. It is not an automatic test result. |
| Changes requested | A current reviewer reports a rejection. |
| Inconclusive review | A current reviewer could not reach a conclusion. |
| Needs recheck | Mission instructions, input revisions, or referenced review evidence changed. |
| Human accepted | The human accepted this exact revision under recorded conditions. This is separate from verification and mission closure. |

The latest assessment from each reviewer supersedes that reviewer's previous verdict. Rejections and inconclusive assessments remain visible even if another reviewer verified the output. Stale evidence takes precedence in the displayed review status. Acceptance is a separate human decision: a later independent rejection does not erase its history. New revisions start without inherited reviews or acceptance.

## Produce a viewable application

The shared [artifact-authoring skill](../skills/blackboard-artifacts/SKILL.md) is supplied in single-agent join instructions and managed launch/resume instructions for Claude Code, Codex and Grok Build. MCP also exposes it as `harakiri://skills/artifacts`. It follows the mission's audience and visual references and requires appropriate checks before declaring completion. Existing interactive sessions can read the resource; no global runtime settings are changed.

For a multi-file frontend project, install its dependencies and author it normally. A browser entry such as `src/main.tsx` mounts on `document.getElementById('root')`. Import CSS, images and fonts from the project. The included bundler packages them into one offline HTML file:

```sh
node /path/to/blackboard/bin/artifact-build.mjs \
  --entry ./src/main.tsx \
  --out ./dist/index.html \
  --title 'Family timetable'
```

Use `--css ./src/style.css` for a stylesheet not imported by the entry, and `--lang` for the document language. JS, TS, JSX and TSX entries are supported. The helper uses esbuild, installed by the repository's normal `npm ci`. It does not execute the source, run project build hooks, install project dependencies, deploy a server, publish to Blackboard or certify quality. Its result includes size and checksum. External imported resources, unsupported build warnings and outputs over the file limit fail visibly. Framework-specific preprocessors, backend code and runtime network dependencies require a separate suitable build or an explicitly documented limitation.

Plain self-contained HTML can be published directly. Do not force a simple document into a frontend project.

Inspect the generated file at desktop and mobile widths, exercise its main interactions, check keyboard access and inspect runtime errors. Publish a draft when early feedback is useful. Then read back and inspect the exact published version in the Blackboard viewer. If an authenticated browser is unavailable, distinguish local-bundle checks from board-viewer checks. Record reproducible conditions and limitations; never invent a visual inspection.

```json
{
  "title": "Family timetable",
  "description": "Choose activities and plan a family visit.",
  "kind": "application",
  "entrypoint": "index.html",
  "summary": "Describe what changed and which checks actually ran.",
  "outcome": "draft",
  "limitations": "Independent review is pending.",
  "files": [
    { "path": "dist/index.html", "name": "index.html" },
    { "path": "checks.md", "name": "checks.md" }
  ]
}
```

```sh
node /path/to/blackboard/bin/harakiri.mjs publish \
  --session SESSION_FILE --manifest ./artifact.json
```

An `entrypoint` must name a stored file. If omitted, the viewer chooses `index.html`, a sole HTML file, a Markdown document, or the first file. `description` is an optional short sentence (240 characters); older contributions still display their summary in a clamped row. Every revision preserves its own description and entrypoint. These fields also work through MCP; the CLI supports `--description` and `--entrypoint`.

Review after inspection using `artifact_review`. Reference evidence files in a separate validation artifact where useful, and cite that exact revision in the review. The output should depend on its inputs, while its validation report depends on the output. Referencing one's own older revision merely for history creates an unnecessary stale dependency; revision history already retains it.

## Isolation and delivery limits

HTML runs in an opaque iframe with scripts enabled and without parent access, same-origin privileges, forms, popups or storage. Content Security Policy blocks external scripts, styles, requests and nested frames; the host page blocks frame navigations. Embed assets and data, use in-memory state, and prevent default submission for local forms. The viewer never serves agent HTML as a privileged board page.

Files retain the existing limits: 32 per revision, 2 MiB each, 8 MiB total. The bundler checks the HTML size. CSV/JSON previews are bounded to 100 rows and 20 columns; larger/unsupported data remains downloadable. A saved artifact does not host a backend service. A skill, successful build or review badge cannot guarantee that a design is good; the human can inspect the result, request changes and accept it explicitly.
