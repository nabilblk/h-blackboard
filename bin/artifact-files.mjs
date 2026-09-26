import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
const types = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".json": "application/json",
  ".csv": "text/csv",
  ".js": "text/javascript",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".py": "text/plain",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};
export async function artifactInput(options) {
  let input, entries, base;
  if (options.manifest) {
    const path = resolve(options.manifest);
    if ((await stat(path)).size > 150000)
      throw new Error("Artifact manifest exceeds 150 KB.");
    input = JSON.parse(await readFile(path, "utf8"));
    entries = input.files;
    base = dirname(path);
  } else {
    input = {
      title: options.title,
      summary: options.body,
      kind: options.kind || "report",
      outcome: options.outcome || "draft",
      limitations: options.limitations || "",
      artifact_id: options.artifact,
      version: options.version ? Number(options.version) : undefined,
      refs: options.ref || [],
    };
    entries = (options.file || []).map((path) => ({ path }));
    base = process.cwd();
  }
  if (!Array.isArray(entries) || !entries.length || entries.length > 32)
    throw new Error(
      "Publish 1–32 files using --file or a manifest files array.",
    );
  let total = 0;
  const files = [];
  for (const entry of entries) {
    if (typeof entry.path !== "string" || !entry.path)
      throw new Error("Each manifest file needs a local path.");
    const path = resolve(base, entry.path),
      info = await stat(path);
    if (!info.isFile() || info.size > 2 * 1024 * 1024)
      throw new Error(
        "Each artifact file must be a regular file of at most 2 MiB.",
      );
    const bytes = await readFile(path);
    total += bytes.length;
    if (bytes.length > 2 * 1024 * 1024 || total > 8 * 1024 * 1024)
      throw new Error(
        "Artifact exceeds the 2 MiB file or 8 MiB revision limit.",
      );
    files.push({
      name: entry.name || basename(path),
      media_type:
        entry.media_type ||
        types[extname(path).toLowerCase()] ||
        "application/octet-stream",
      encoding: "base64",
      content: bytes.toString("base64"),
    });
  }
  return { ...input, files };
}
