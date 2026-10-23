import { createHash } from "node:crypto";
// Explicit release mode only. Development packaging remains ad-hoc and labelled.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const run = promisify(execFile);
export const releaseMode = process.env.HARAKIRI_RELEASE === "1";
export function signingConfig() {
  const identity = process.env.HARAKIRI_SIGN_IDENTITY,
    team = process.env.HARAKIRI_SIGN_TEAM,
    profile = process.env.HARAKIRI_NOTARY_PROFILE;
  if (
    !identity?.startsWith("Developer ID Application:") ||
    !/^[A-Z0-9]{10}$/.test(team ?? "") ||
    !profile ||
    profile.length > 200
  )
    throw new Error(
      "Release mode requires HARAKIRI_SIGN_IDENTITY, HARAKIRI_SIGN_TEAM and HARAKIRI_NOTARY_PROFILE (stored in Keychain). No ad-hoc fallback is allowed.",
    );
  return { identity, team, profile };
}
export async function assertReleaseTree(root) {
  signingConfig();
  const { stdout } = await run(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    { cwd: root },
  );
  if (stdout.trim())
    throw new Error(
      "Release packaging requires a clean committed source tree.",
    );
}
export async function notarize(file) {
  const { profile } = signingConfig();
  await run(
    "/usr/bin/xcrun",
    [
      "notarytool",
      "submit",
      file,
      "--keychain-profile",
      profile,
      "--wait",
      "--timeout",
      "20m",
    ],
    { timeout: 21 * 60 * 1000, maxBuffer: 1024 * 1024 },
  );
}
export async function signApp(app, electronVersion) {
  const { identity, team } = signingConfig();
  const { signAsync } = await import("@electron/osx-sign");
  const native = join(app, "Contents/Resources/node/harakiri-node");
  await run("/usr/bin/codesign", [
    "--force",
    "--timestamp",
    "--options",
    "runtime",
    "--sign",
    identity,
    native,
  ]);
  await run("/usr/bin/codesign", ["--verify", "--strict", native]);
  const manifestPath = join(app, "Contents/Resources/node/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.sha256 = createHash("sha256")
    .update(await readFile(native))
    .digest("hex");
  manifest.signature = "developer-id";
  manifest.team = team;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  await signAsync({
    app,
    identity,
    type: "distribution",
    platform: "darwin",
    version: electronVersion,
    ignore: (file) => file === native,
    optionsForFile: () => ({
      hardenedRuntime: true,
      entitlements: ["com.apple.security.cs.allow-jit"],
    }),
  });
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  const detail = await run("/usr/bin/codesign", [
    "--display",
    "--verbose=4",
    app,
  ]);
  if (!detail.stderr.split("\n").includes(`TeamIdentifier=${team}`))
    throw new Error("Unexpected signing team.");
  const temporary = await mkdtemp(join(tmpdir(), "harakiri-notary-"));
  try {
    const zip = join(temporary, "Harakiri.zip");
    await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip]);
    await notarize(zip);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  await run("/usr/bin/xcrun", ["stapler", "staple", app]);
  await run("/usr/bin/xcrun", ["stapler", "validate", app]);
  await run("/usr/sbin/spctl", [
    "--assess",
    "--type",
    "execute",
    "--verbose=2",
    app,
  ]);
}
export async function signDmg(file) {
  const { identity } = signingConfig();
  await run("/usr/bin/codesign", [
    "--force",
    "--timestamp",
    "--sign",
    identity,
    file,
  ]);
  await notarize(file);
  await run("/usr/bin/xcrun", ["stapler", "staple", file]);
  await run("/usr/bin/xcrun", ["stapler", "validate", file]);
}
