import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

if (process.platform !== "darwin")
  throw new Error("Creating a DMG requires macOS and its hdiutil command.");

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const project = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const appName = "Harakiri Desktop.app";
const app = join(
  root,
  `var/desktop/packages/Harakiri Desktop-darwin-${process.arch}`,
  appName,
);
const { stdout: version } = await run("/usr/libexec/PlistBuddy", [
  "-c",
  "Print :CFBundleShortVersionString",
  join(app, "Contents/Info.plist"),
]);
if (version.trim() !== project.version)
  throw new Error(
    "The app version is stale. Run npm run desktop:dmg to rebuild.",
  );

const releases = join(root, "var/desktop/releases");
await mkdir(releases, { recursive: true });
const temporary = await mkdtemp(join(releases, ".dmg-"));
const contents = join(temporary, "contents");
const mountpoint = join(temporary, "mounted");
const filename = `Harakiri-Desktop-${project.version}-macOS-${process.arch}.dmg`;
const image = join(temporary, filename);
let attached = false;

async function command(executable, args) {
  const result = await run(executable, args);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

try {
  await mkdir(contents);
  await mkdir(mountpoint);
  // Copy only the packaged app, preserving its signature and framework links.
  // The app already contains all application, font and runtime license notices.
  await command("/usr/bin/ditto", [app, join(contents, appName)]);
  await symlink("/Applications", join(contents, "Applications"));
  await command("/usr/bin/hdiutil", [
    "create",
    "-volname",
    "Harakiri Desktop",
    "-srcfolder",
    contents,
    "-fs",
    "HFS+",
    "-format",
    "UDZO",
    "-imagekey",
    "zlib-level=9",
    image,
  ]);
  await command("/usr/bin/hdiutil", ["verify", image]);
  await command("/usr/bin/hdiutil", [
    "attach",
    "-readonly",
    "-nobrowse",
    "-mountpoint",
    mountpoint,
    image,
  ]);
  attached = true;
  const entries = (await readdir(mountpoint))
    .filter((name) => !name.startsWith("."))
    .sort();
  if (JSON.stringify(entries) !== JSON.stringify(["Applications", appName]))
    throw new Error("Unexpected files in the mounted installer.");
  if ((await readlink(join(mountpoint, "Applications"))) !== "/Applications")
    throw new Error("Invalid Applications shortcut in the installer.");
  await command("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    join(mountpoint, appName),
  ]);
  await command("/usr/bin/hdiutil", ["detach", mountpoint]);
  attached = false;

  const hash = createHash("sha256");
  for await (const chunk of createReadStream(image)) hash.update(chunk);
  const digest = hash.digest("hex");
  await writeFile(
    join(temporary, `${filename}.sha256`),
    `${digest}  ${filename}\n`,
  );
  await rename(image, join(releases, filename));
  await rename(
    join(temporary, `${filename}.sha256`),
    join(releases, `${filename}.sha256`),
  );
  const { size } = await stat(join(releases, filename));
  console.log(`Verified DMG (${(size / 1024 / 1024).toFixed(1)} MiB):`);
  console.log(join(releases, filename));
  console.log(`SHA-256: ${digest}`);
  console.log("Local development build; not Developer ID signed or notarized.");
} finally {
  // If detaching fails, leave the staging area intact for manual cleanup.
  // Never recursively remove a directory containing a mounted volume.
  if (attached) await command("/usr/bin/hdiutil", ["detach", mountpoint]);
  await rm(temporary, { recursive: true, force: true });
}
