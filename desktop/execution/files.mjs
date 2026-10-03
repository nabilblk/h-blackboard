import { constants } from "node:fs";
import { mkdir, open, lstat } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const pathSchema = z
  .string()
  .max(240)
  .min(1)
  .refine(
    (p) =>
      !/[\\\x00-\x1f\x7f:]/.test(p) &&
      p.split("/").every((s) => s && s !== "." && s !== ".."),
  );
const filesSchema = z
  .array(
    z
      .object({
        path: pathSchema,
        base64: z
          .string()
          .max(24 * 1024 * 1024)
          .regex(
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
          ),
      })
      .strict(),
  )
  .max(256);
const MAX = 16 * 1024 * 1024;

export async function exportWorkspace(contribution, input) {
  const files = filesSchema.parse(input);
  if (new Set(files.map((f) => f.path)).size !== files.length)
    throw new Error("Duplicate export paths.");
  const decoded = files.map((f) => ({
    path: f.path,
    bytes: Buffer.from(f.base64, "base64"),
  }));
  if (decoded.reduce((n, f) => n + f.bytes.length, 0) > MAX)
    throw new Error("Export exceeds 16 MiB.");
  // Validate prefix conflicts before creating any files.
  const names = new Set(files.map((f) => f.path));
  for (const file of files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++)
      if (names.has(parts.slice(0, i).join("/")))
        throw new Error("Conflicting export paths.");
  }
  const directory = join(contribution.workspace, `export-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  for (const { path, bytes } of decoded) {
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const file = await open(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
  }
  return { exported: files.length, directory };
}

// Called only with paths returned by Electron's native file picker. Renderer
// requests contain a contribution ID, never local file paths.
export async function readImportFiles(paths) {
  if (!paths || paths.length === 0) return null;
  if (paths.length > 32) throw new Error("Choose at most 32 files per import.");
  const files = [];
  let total = 0;
  for (const path of paths) {
    const name = pathSchema.parse(basename(path));
    if (files.some((f) => f.path === name))
      throw new Error("Choose files with distinct names.");
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size > MAX
    )
      throw new Error("Only regular files without links can be imported.");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = await file.stat();
      if (
        current.ino !== info.ino ||
        current.dev !== info.dev ||
        current.nlink !== 1
      )
        throw new Error("Selected file changed.");
      total += current.size;
      if (total > MAX) throw new Error("Import exceeds 16 MiB.");
      const bytes = Buffer.alloc(current.size + 1);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const part = await file.read(
          bytes,
          bytesRead,
          bytes.length - bytesRead,
          bytesRead,
        );
        if (!part.bytesRead) break;
        bytesRead += part.bytesRead;
      }
      if (bytesRead !== current.size)
        throw new Error("Selected file changed while reading.");
      files.push({
        path: name,
        base64: bytes.subarray(0, bytesRead).toString("base64"),
      });
    } finally {
      await file.close();
    }
  }
  return files;
}
