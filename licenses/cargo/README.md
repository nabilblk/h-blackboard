# Supplemental Cargo notices

These are upstream notices omitted from the published crate archives. Each source
is pinned to the commit in that crate's `.cargo_vcs_info.json`, with a SHA-256
digest. The build checks the package version, declared license, commit and digest;
it does not fetch notices or run upstream code.

`supplemental.json` records provenance. These texts are reproduced unchanged.
They do not constitute a license opinion or complete release approval. In
particular, the objc2 workspace notice links to terms and discusses SDK-derived
code: those packages are explicitly marked for review. Missing texts and required
reviews block public release mode; local development builds report them.

When updating a dependency, inspect its packaged notices first, then retrieve any
missing notices from its exact upstream commit. Review applicability before
updating this manifest. Do not replace a missing notice with guessed copyright
holders or copy the license from an unrelated version.
