import { build as buildVite } from "vite";
import react from "@vitejs/plugin-react";
import { build as buildJS } from "esbuild";
import { mkdir, copyFile, rename, writeFile, readFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const output = join(root, "var/desktop/build");

export async function buildDesktop() {
  await mkdir(output, { recursive: true });
  // A separate output and entry. Neither a desktop build nor packaging touches
  // the web server's live dist/, database, credentials or public tunnel.
  await buildVite({
    configFile: false,
    root: join(root, "src/desktop"),
    base: "/",
    publicDir: false,
    plugins: [react()],
    build: {
      outDir: join(output, "ui"),
      emptyOutDir: true,
      assetsInlineLimit: 0,
      rolldownOptions: { input: join(root, "src/desktop/desktop.html") },
    },
  });
  await rename(join(output, "ui/desktop.html"), join(output, "ui/index.html"));
  await buildJS({
    entryPoints: [join(root, "desktop/main.mjs")],
    outfile: join(output, "main.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["electron"],
  });
  await copyFile(
    join(root, "desktop/preload.cjs"),
    join(output, "preload.cjs"),
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
  const bundledLicenses = [];
  for (const [name, license] of [
    ["react", "LICENSE"],
    ["react-dom", "LICENSE"],
    ["scheduler", "LICENSE"],
    ["lucide-react", "LICENSE"],
    ["zod", "LICENSE"],
    ["@fontsource/ibm-plex-mono", "LICENSE"],
    ["@fontsource/ibm-plex-sans", "LICENSE"],
    ["vite", "LICENSE.md"],
    ["esbuild", "LICENSE.md"],
  ]) {
    const metadata = JSON.parse(
      await readFile(join(root, "node_modules", name, "package.json"), "utf8"),
    );
    bundledLicenses.push(
      `${name} ${metadata.version}\n${await readFile(join(root, "node_modules", name, license), "utf8")}`,
    );
  }
  await writeFile(
    join(output, "licenses/THIRD-PARTY-NOTICES.txt"),
    bundledLicenses.join("\n\n---\n\n"),
  );
  return output;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await buildDesktop();
