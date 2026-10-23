# Desktop release procedure

Development packaging remains `npm run desktop:dmg`, with an explicit ad-hoc
signature and no notarization claim. Source currently uses protocol 13. Choose a
new application version for a public release, update the lockfile, and require
matching peer versions. Do not replace the published 0.4.9 preview with a different
wire protocol under the same version.

## Build and review

1. Use a clean committed checkout and `npm ci`. Run formatting, `npm test`,
   Python guest tests, `npm run test:node`, `npm run check:node`, `npm run test:ui`
   and `npm run desktop:build`. Preserve the output with the commit.
2. Review `npm audit`, `cargo audit --deny unsound --deny yanked`, the Rust
   dependency inventory and the pinned Lima, Linux,
   runtime and capability-pack provenance. Update affected dependencies and run
   the relevant checks. Source tests do not establish the safety of vendor models.
3. Inspect `var/desktop/build/licenses/bundled-dependencies.json` and the native
   `node/manifest.json`/`sbom.cdx.json`. JavaScript notices follow actual bundler
   inputs; native notices follow Cargo's non-development dependency graph.
   Missing notice text and `noticeReviewRequired` both block release mode. Pinned
   supplemental notices in `licenses/cargo/` are verified against each package's
   upstream commit and file digest; builds never fetch them from a moving branch.
   License expressions still need review;
   an inventory is not a legal determination. Electron/Chromium and fonts have
   their own notices. Downloaded guest components keep their upstream notices.
4. Complete independent-device and security review gates. Record installation on
   a clean Apple Silicon Mac separately from development startup tests.

## Sign and notarize

Install your Developer ID Application certificate in the build Mac's Keychain.
Store notarization credentials using Apple's `notarytool store-credentials`;
keep credentials out of files, arguments captured in logs, and repository state.
Set these environment values on the controlled build machine:

- `HARAKIRI_RELEASE=1`
- `HARAKIRI_SIGN_IDENTITY`: exact Developer ID Application identity.
- `HARAKIRI_SIGN_TEAM`: expected ten-character Apple Team identifier.
- `HARAKIRI_NOTARY_PROFILE`: the stored Keychain profile name.
- `HARAKIRI_RELEASE_KEY`: path to a private Ed25519 PEM signing key (mode 0600).
- `HARAKIRI_RELEASE_SEQUENCE`: a strictly increasing positive release number.

Run `npm run desktop:dmg`. Release mode refuses a dirty checkout, absent signing
configuration, missing notice texts, unresolved notice reviews, signing errors, rejected notarization and
failed stapling/verification. It signs the native executable, updates its digest,
signs the hardened Electron app after fuse/resource changes, notarizes and staples
the app, then signs/notarizes/staples the DMG. No developer-signature fallback is
allowed. This path requires actual Apple credentials and must be validated before
publication; merely building the source does not exercise it.

The output adds `<installer>.release.json`: an Ed25519 signature over exact DMG
SHA-256/size, app and protocol version, architecture, source commit, Apple team,
sequence and a 30-day validity window. Preserve the signing key outside the
repository. Distribute its public key through an already authenticated channel;
a key downloaded beside an untrusted installer cannot authenticate that installer.

## Verify an update without executing it

```sh
node bin/desktop/verify-release.mjs \
  Harakiri-Desktop-VERSION-macOS-arm64.dmg.release.json \
  Harakiri-Desktop-VERSION-macOS-arm64.dmg \
  trusted-release-key.pem MINIMUM_RELEASE_SEQUENCE
```

The verifier checks the trusted signature, installer bytes, architecture, validity
and minimum sequence. Keep the highest accepted sequence in your release process;
passing an older minimum weakens rollback protection. A new release key needs an
independently authenticated rotation announcement. Expired metadata needs a newly
signed release statement; never disable verification to continue.

Check macOS Gatekeeper/signature and stapled notarization on the mounted app as
well. This is a manual verified update path; automatic installation is deliberately
not enabled. Publish the DMG, checksum, signed manifest, dependency inventory and
release notes only after these checks. The landing download stays unchanged until
that separate publication step.

## Source audit checkpoint — 23 October 2026

The updated lockfiles report zero npm vulnerabilities and zero RustSec
vulnerabilities, unsoundness or yanked-package findings against the database used
for this checkpoint. RustSec still reports three upstream maintenance warnings:
`atomic-polyfill 1.0.3`, `paste 1.0.15` and `proc-macro-error 0.4.12`. Keep those
visible and review their dependency paths before release. CI rejects vulnerability,
unsoundness and yanked findings; a clean scan is not a security certification.

The native notice inventory still lacks upstream license texts for `acto`,
`binary-merge`, `enum-assoc`, the three `genawaiter` packages,
`inplace-vec-builder`, the two `reloadable` packages and the three
`rustls-cert-*` packages. Their exact upstream trees also omit standalone license
files. Seven Objective-C/Apple SDK related notices require distribution review.
Do not replace those gaps with invented copyright statements or remove the
release checks. Resolve the notices and review flags with attributable source
evidence before using release mode. Local development builds remain available.
