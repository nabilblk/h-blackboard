import { writeBundledInventory } from "./licenses.mjs";
import { build as buildVite } from "vite";
import react from "@vitejs/plugin-react";
import { build as buildJS } from "esbuild";
import { mkdir, copyFile, rename, writeFile, readFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeNodeInventory } from "../node/licenses.mjs";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const output = join(root, "var/desktop/build");

export async function buildDesktop() {
  await mkdir(output, { recursive: true });
  await promisify(execFile)(
    "cargo",
    ["build", "--locked", "--release", "--bin", "harakiri-node"],
    { cwd: root, maxBuffer: 4 * 1024 * 1024 },
  );
  await mkdir(join(output, "node"), { recursive: true });
  await copyFile(
    join(root, "var/node/target/release/harakiri-node"),
    join(output, "node/harakiri-node"),
  );
  if (process.platform === "darwin") {
    await promisify(execFile)("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      join(output, "node/harakiri-node"),
    ]);
  }
  await writeNodeInventory({
    output: join(output, "node"),
    binary: join(output, "node/harakiri-node"),
    component: "harakiri-node",
    signature:
      process.platform === "darwin"
        ? "ad-hoc-development-only"
        : "unsigned-development-only",
  });
  // A separate output and entry. Neither a desktop build nor packaging touches
  // the web server's live dist/, database, credentials or public tunnel.
  const bundledModules = new Set();
  await buildVite({
    configFile: false,
    root: join(root, "src/desktop"),
    base: "/",
    publicDir: false,
    plugins: [
      react(),
      {
        name: "harakiri-bundled-inventory",
        generateBundle() {
          for (const id of this.getModuleIds())
            if (id.includes("node_modules/")) bundledModules.add(id);
        },
      },
    ],
    build: {
      outDir: join(output, "ui"),
      emptyOutDir: true,
      assetsInlineLimit: 0,
      rolldownOptions: { input: join(root, "src/desktop/desktop.html") },
    },
  });
  await rename(join(output, "ui/desktop.html"), join(output, "ui/index.html"));
  const hostBundle = await buildJS({
    entryPoints: [join(root, "desktop/main.mjs")],
    outfile: join(output, "main.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["electron"],
    metafile: true,
  });
  await copyFile(
    join(root, "desktop/preload.cjs"),
    join(output, "preload.cjs"),
  );
  await mkdir(join(output, "guest"), { recursive: true });
  for (const name of [
    "agent.md",
    "bridge.py",
    "artifact_io.py",
    "operations.py",
    "checkpoint.py",
    "project.py",
    "control.py",
    "files.py",
    "command.py",
    "buildkit.py",
    "mcp.py",
    "mcp_results.py",
    "proxy.py",
    "worker-network.py",
    "setup.sh",
    "runtimes.py",
    "install-runtime.py",
  ])
    await copyFile(
      join(root, "desktop/execution/guest", name),
      join(output, "guest", name),
    );
  const project = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  await writeFile(
    join(output, "package.json"),
    JSON.stringify(
      {
        name: "harakiri-desktop",
        productName: "Harakiri Desktop",
        version: project.version,
        description: "Local contribution controls for Harakiri Blackboard",
        license: "Apache-2.0",
        type: "module",
        main: "main.mjs",
      },
      null,
      2,
    ) + "\n",
  );
  for (const file of ["LICENSE", "NOTICE"])
    await copyFile(join(root, file), join(output, file));
  await mkdir(join(output, "licenses"), { recursive: true });
  for (const font of ["ibm-plex-mono", "ibm-plex-sans"])
    await copyFile(
      join(root, `public/licenses/${font}.txt`),
      join(output, `licenses/${font}.txt`),
    );
  await mkdir(join(output, "reader-fonts"), { recursive: true });
  for (const family of ["sans", "mono"])
    await copyFile(
      join(
        root,
        `node_modules/@fontsource/ibm-plex-${family}/files/ibm-plex-${family}-latin-400-normal.woff2`,
      ),
      join(output, `reader-fonts/${family}.woff2`),
    );
  for (const id of Object.keys(hostBundle.metafile.inputs))
    bundledModules.add(id);
  await writeBundledInventory({
    root,
    output: join(output, "licenses"),
    modules: bundledModules,
  });
  return output;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await buildDesktop();
