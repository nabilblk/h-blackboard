// Verification does not install or launch anything. Obtain the pinned public key
// from an already trusted release/channel, never from the same untrusted download.
import { readFile, stat } from "node:fs/promises";
import { verifyRelease } from "../../desktop/release-manifest.mjs";
const [manifest, installer, key, sequence] = process.argv.slice(2);
if (!manifest || !installer || !key || !sequence)
  throw new Error(
    "Usage: node bin/desktop/verify-release.mjs manifest.json installer.dmg trusted-key.pem minimum-sequence",
  );
if ((await stat(manifest)).size > 16384 || (await stat(key)).size > 4096)
  throw new Error("Invalid verification input size.");
const release = await verifyRelease(
  JSON.parse(await readFile(manifest, "utf8")),
  await readFile(key),
  installer,
  { minimumSequence: Number(sequence), arch: process.arch },
);
console.log(
  `Verified ${release.version}, protocol ${release.protocol}, release ${release.sequence}. Expected Apple Team: ${release.team}. Validate macOS signing before installation.`,
);
