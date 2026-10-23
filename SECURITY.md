# Security and release status

Harakiri is experimental coordination infrastructure. The decentralized branch
uses signed peer records and contributor-controlled VM execution. These controls
have regression tests; they are not an independent security assessment or proof
that untrusted public participation is safe. The published 0.4.9 developer preview
and newer source have different protocols. Use a matching build on every peer.

## Report a vulnerability

Use this repository's private vulnerability reporting channel if enabled. If it
is unavailable, contact the maintainer through their GitHub profile to arrange a
private report. Public issues should contain only a request for a private contact,
not credentials, invitation links, private mission records or exploit details.
Include the source commit/build, affected trust boundary, minimal reproduction,
expected result and observed result. Use isolated profiles and accounts you own.

## Boundaries

- A signature establishes the author of a record. It does not make messages,
  documents, code, model output or tool responses trustworthy instructions.
- Joining, assignment, readiness and an unlimited budget do not authorize
  execution. Owner control and the contributor's exact local consent are distinct.
  Revocation, expiry and withdrawal remain enforceable independently of a prompt.
- Agent workers run inside a Linux VM and a confined worker process. Provider
  credentials remain with the guest runtime, not the worker, peer, renderer or
  host workspace. Internet access is an explicit local setting; public HTTPS
  does not allow private destinations, inbound listeners or host mounts.
- Artifact previews use an isolated renderer. No artifact can install skills,
  add MCP tools, access node keys or change consent. Reviews state which exact
  revision and methods they cover; author claims never become independent proof.
- Network routes cannot admit a participant. Opt-in address lookup publishes an
  endpoint identifier and relay route, not mission history. Returned routes pass
  the same local relay/LAN policy as invitation routes. Services can observe
  metadata and deny service; users can replace or disable them.
- P2P ingress bounds connections, frames, histories, catalogs and blob traffic.
  Per-peer budgets mitigate one noisy participant; they are not Sybil resistance
  or a defense against a sufficiently large distributed denial of service.
- Private conversations are readable by their recipients' hosting nodes. Revoking
  access cannot erase copies already downloaded. A compromised OS account can
  access local data and use the node; this is outside VM isolation guarantees.

## Recovery

Device → Node identity offers a protected recovery file. It encrypts keys,
replicated history and downloaded artifacts with scrypt and AES-256-GCM. It does
not include provider sign-ins, VM images, unexported source, runtime conversation
or permission to run agents. A separate source checkpoint covers selected source
files and exposes exclusions; it is not a complete VM backup or secret scanner.

Restore only into an empty node, with the original node stopped. Recovery validates
history with the native service and opens offline. Keep one active writer for an
identity. An old backup can omit later events; reconcile with peers before making
new decisions. Conflicting histories are preserved and may require explicit
resolution. Recovery is not key rotation: if a signing key is compromised, pause
work, revoke affected contributions/membership and arrange a new identity and
explicit handover while remaining authority is available. There is no automatic
owner election or magical recovery of a lost sole owner's key.

## Public distribution gate

The source includes fail-closed Developer ID signing/notarization tooling and
signed release metadata verification; supplying credentials and passing real
clean-Mac checks remains a release operation. Development builds remain explicitly
ad-hoc signed. The app does not silently download or execute an unsigned updater.
See [release procedure](docs/RELEASING.md).

Before broad untrusted use, obtain independent security review and demonstrate the
independent-device journey, partition recovery, fresh-device installation and
provider subscription behavior. Review dependency notices and vulnerability
reports for the exact lockfiles and runtime images. Local tests do not close these
gates. Preserve a report of findings, remedies and unresolved limitations.
