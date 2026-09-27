#!/usr/bin/env node
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { artifactCsp } from "../shared/artifact-preview.mjs";

const escapeHtml = (value) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** Bundle a browser entry module and its imported assets without executing it. */
export async function buildArtifact({
  entry,
  css = [],
  out,
  title = "Artifact",
  lang = "en",
}) {
  if (!entry || !out) throw new Error("--entry and --out are required.");
  if (!/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(lang))
    throw new Error("Use a valid language tag, for example en or fr-CA.");
  const input = resolve(entry),
    output = resolve(out);
  if (input === output || !output.endsWith(".html"))
    throw new Error("Choose an .html output distinct from the source entry.");
  const result = await build({
    absWorkingDir: dirname(input),
    stdin: {
      contents: [input, ...css.map((path) => resolve(path))]
        .map((path) => `import ${JSON.stringify(path)};`)
        .join("\n"),
      resolveDir: dirname(input),
      sourcefile: "artifact-entry.js",
    },
    bundle: true,
    write: false,
    outfile: "artifact.js",
    platform: "browser",
    format: "iife",
    target: "es2022",
    jsx: "automatic",
    minify: true,
    charset: "utf8",
    metafile: true,
    legalComments: "inline",
    define: { "process.env.NODE_ENV": '"production"' },
    supported: { "inline-script": true, "inline-style": true },
    loader: Object.fromEntries(
      [
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".avif",
        ".svg",
        ".woff",
        ".woff2",
        ".ttf",
        ".otf",
        ".ico",
      ].map((ext) => [ext, "dataurl"]),
    ),
    plugins: [
      {
        name: "offline-artifact",
        setup(b) {
          b.onResolve({ filter: /^(https?:)?\/\// }, (args) => ({
            errors: [
              {
                text: `External resource ${args.path} cannot be bundled offline. Download authorized assets locally and import them.`,
              },
            ],
          }));
        },
      },
    ],
    logLevel: "silent",
  });
  if (result.warnings.length)
    throw new Error(
      `Resolve build warnings before publishing:\n${result.warnings.map((w) => w.text).join("\n")}`,
    );
  if (
    Object.values(result.metafile.outputs).some((o) =>
      o.imports.some((i) => i.external),
    )
  )
    throw new Error("The bundle still has external imports.");
  if (result.outputFiles.some((f) => !/\.(js|css)$/.test(f.path)))
    throw new Error("The build produced an asset that was not embedded.");
  const js = result.outputFiles
    .filter((f) => f.path.endsWith(".js"))
    .map((f) => f.text)
    .join("\n");
  const style = result.outputFiles
    .filter((f) => f.path.endsWith(".css"))
    .map((f) => f.text)
    .join("\n");
  const html = `<!doctype html>\n<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${artifactCsp}"><title>${escapeHtml(title)}</title><style>${style}</style></head><body><div id="root"></div><script>${js}</script></body></html>\n`;
  const size = Buffer.byteLength(html);
  if (size > 2 * 1024 * 1024)
    throw new Error(
      "The HTML exceeds the 2 MiB artifact file limit. Reduce dependencies or compress assets.",
    );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, html);
  return {
    path: output,
    size,
    sha256: createHash("sha256").update(html).digest("hex"),
    note: "Bundled only. Open in the Blackboard viewer, test interactions and inspect desktop/mobile screenshots before recording verification.",
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: {
        entry: { type: "string" },
        out: { type: "string" },
        css: { type: "string", multiple: true },
        title: { type: "string" },
        lang: { type: "string" },
        help: { type: "boolean" },
      },
    });
    if (values.help)
      process.stdout.write(
        "Usage: node bin/artifact-build.mjs --entry ./src/main.tsx --out ./dist/index.html --title 'My artifact' [--css ./src/style.css] [--lang en]\nDependencies must be installed in the source project. Mount interactive applications on #root. Imported styles, images and fonts are embedded. This command does not publish or verify the result.\n",
      );
    else
      process.stdout.write(
        JSON.stringify(await buildArtifact(values), null, 2) + "\n",
      );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
