import { packager } from "@electron/packager";
import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";
import { readFile, mkdtemp, cp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildDesktop, root } from "./build.mjs";

if (process.platform !== "darwin")
  throw new Error(
    "The first desktop package targets macOS. Cross-platform release packaging is not configured yet.",
  );
const directory = await buildDesktop();
const project = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const staging = await mkdtemp(join(tmpdir(), "harakiri-package-"));
try {
  // Package an explicit artifact allowlist, never the repository or var/.
  // Internal docs, board databases, tokens, logs and test profiles stay local.
  for (const file of [
    "main.mjs",
    "preload.cjs",
    "package.json",
    "LICENSE",
    "NOTICE",
    "licenses",
    "ui",
  ])
    await cp(join(directory, file), join(staging, file), { recursive: true });
  const paths = await packager({
    dir: staging,
    out: join(root, "var/desktop/packages"),
    name: "Harakiri Desktop",
    appBundleId: "io.harakiri.contributor",
    icon: join(root, "desktop/Harakiri.icns"),
    appVersion: project.version,
    electronVersion: project.devDependencies.electron,
    platform: "darwin",
    arch: process.arch,
    asar: true,
    overwrite: true,
    prune: false,
  });
  for (const path of paths) {
    const licenses = join(
      path,
      "Harakiri Desktop.app/Contents/Resources/licenses",
    );
    await mkdir(licenses, { recursive: true });
    await cp(join(directory, "licenses"), licenses, { recursive: true });
    await cp(join(path, "LICENSE"), join(licenses, "ELECTRON-LICENSE.txt"));
    await cp(
      join(path, "LICENSES.chromium.html"),
      join(licenses, "LICENSES.chromium.html"),
    );
    await cp(join(root, "LICENSE"), join(licenses, "HARAKIRI-LICENSE.txt"));
    await flipFuses(join(path, "Harakiri Desktop.app"), {
      version: FuseVersion.V1,
      resetAdHocDarwinSignature: true,
      strictlyRequireAllFuses: true,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      // The upstream Electron binary ships the standard V8 snapshot. Enabling
      // this fuse without building a separate browser snapshot prevents startup.
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
      [FuseV1Options.WasmTrapHandlers]: true,
    });
    console.log(`Local development package (ad-hoc signed): ${path}`);
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
