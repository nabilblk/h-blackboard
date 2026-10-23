import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  renameSync,
  statSync,
  openSync,
  closeSync,
  fsyncSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { Id } from "../model.mjs";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const path = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (p) =>
      !/[\\:\x00-\x1f\x7f]/.test(p) &&
      p.split("/").every((s) => s && s !== "." && s !== ".."),
  );
const entry = z
  .object({
    path,
    size: z
      .number()
      .int()
      .min(0)
      .max(16 * 1024 * 1024),
    sha256: hash,
  })
  .strict();
export const SourceManifest = z
  .object({
    version: z.literal(1),
    algorithm: z.literal("sha256"),
    digest: hash,
    files: z.array(entry).max(256),
    bytes: z
      .number()
      .int()
      .min(0)
      .max(32 * 1024 * 1024),
    exclusions: z
      .array(z.object({ path, reason: z.string().max(240) }).strict())
      .max(256),
    scope: z.string().max(240),
  })
  .strict();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function validateManifest(value) {
  const manifest = SourceManifest.parse(value);
  const files = manifest.files;
  if (
    new Set(files.map((f) => f.path)).size !== files.length ||
    files.reduce((n, f) => n + f.size, 0) !== manifest.bytes
  )
    throw new Error("Invalid source manifest totals.");
  const canonical = JSON.stringify(
    files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })),
  );
  if (
    Buffer.byteLength(canonical) > 48 * 1024 ||
    digest(canonical) !== manifest.digest
  )
    throw new Error("Source manifest digest differs from its entries.");
  return manifest;
}
function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/** Local private-permission storage, separate from published artifacts. Keeps the
 * latest three completed source captures; no credentials or transcript recovery. */
export class CheckpointStore {
  constructor(directory) {
    this.directory = join(directory, "checkpoints");
  }
  folder(contribution) {
    const folder = join(this.directory, Id.parse(contribution));
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    return folder;
  }
  file(contribution, name) {
    return join(this.folder(contribution), name);
  }
  blob(contribution, digest) {
    return this.file(contribution, `${hash.parse(digest)}.blob`);
  }
  read(contribution, id) {
    const file = this.file(contribution, `${hash.parse(id)}.json`);
    if (statSync(file).size > 128 * 1024)
      throw new Error("Checkpoint record too large.");
    const value = JSON.parse(readFileSync(file, "utf8"));
    validateManifest(value.manifest);
    if (value.manifest.digest !== id)
      throw new Error("Checkpoint identity mismatch.");
    return value;
  }
  list(contribution) {
    return readdirSync(this.folder(contribution))
      .filter((n) => /^[a-f0-9]{64}\.json$/.test(n))
      .slice(0, 4)
      .map((n) => this.read(contribution, n.slice(0, -5)))
      .filter((r) => r.complete)
      .sort((a, b) => b.at - a.at);
  }
  begin(contribution, input) {
    const manifest = validateManifest(input),
      id = manifest.digest;
    const keep = this.list(contribution).slice(0, 3);
    // One pending checkpoint per contribution. A new source tree supersedes a
    // partial capture; completed checkpoints stay available until commit.
    const preserved = new Set(keep.map((r) => r.manifest.digest));
    for (const name of readdirSync(this.folder(contribution))) {
      if (
        /^[a-f0-9]{64}\.json$/.test(name) &&
        !preserved.has(name.slice(0, -5))
      )
        rmSync(this.file(contribution, name));
      if (name.endsWith(".part")) rmSync(this.file(contribution, name));
    }
    const missing = manifest.files.filter((f) => {
      try {
        const bytes = readFileSync(this.blob(contribution, f.sha256));
        return bytes.length !== f.size || digest(bytes) !== f.sha256;
      } catch (error) {
        if (error.code === "ENOENT") return true;
        throw error;
      }
    });
    save(this.file(contribution, `${id}.json`), {
      at: Date.now(),
      complete: missing.length === 0,
      manifest,
    });
    this.prune(contribution);
    return {
      id,
      missing: missing.map((f) => f.path),
      complete: missing.length === 0,
    };
  }
  chunk(contribution, input) {
    const request = z
      .object({
        id: hash,
        path,
        offset: z.number().int().nonnegative(),
        base64: z
          .string()
          .max(65536)
          .regex(
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
          ),
      })
      .strict()
      .parse(input);
    const record = this.read(contribution, request.id);
    const file = record.manifest.files.find((f) => f.path === request.path);
    if (!file || record.complete)
      throw new Error("Checkpoint transfer unavailable.");
    const bytes = Buffer.from(request.base64, "base64"),
      part = this.file(contribution, `${file.sha256}.part`);
    let size = 0;
    try {
      size = statSync(part).size;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (size !== request.offset || size + bytes.length > file.size)
      throw new Error("Checkpoint offset mismatch.");
    const fd = openSync(part, "a", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (size + bytes.length === file.size) {
      if (digest(readFileSync(part)) !== file.sha256) {
        rmSync(part);
        throw new Error("Source changed during checkpoint.");
      }
      renameSync(part, this.blob(contribution, file.sha256));
    }
    return { offset: size + bytes.length };
  }
  finish(contribution, id) {
    const record = this.read(contribution, id);
    for (const file of record.manifest.files) {
      const bytes = readFileSync(this.blob(contribution, file.sha256));
      if (bytes.length !== file.size || digest(bytes) !== file.sha256)
        throw new Error("Checkpoint is incomplete.");
    }
    save(this.file(contribution, `${id}.json`), { ...record, complete: true });
    this.prune(contribution);
    return {
      id,
      files: record.manifest.files.length,
      bytes: record.manifest.bytes,
      at: record.at,
      exclusions: record.manifest.exclusions,
    };
  }
  prune(contribution) {
    const completed = this.list(contribution);
    for (const old of completed.slice(3))
      rmSync(this.file(contribution, `${old.manifest.digest}.json`));
    const references = new Set();
    for (const name of readdirSync(this.folder(contribution)).filter((n) =>
      /^[a-f0-9]{64}\.json$/.test(n),
    ))
      for (const f of this.read(contribution, name.slice(0, -5)).manifest.files)
        references.add(f.sha256);
    for (const name of readdirSync(this.folder(contribution)))
      if (
        /^[a-f0-9]{64}\.blob$/.test(name) &&
        !references.has(name.slice(0, -5))
      )
        rmSync(this.file(contribution, name));
  }
  restoreFiles(contribution, id) {
    const record = this.read(contribution, id);
    if (!record.complete)
      throw new Error("Only a completed checkpoint can be restored.");
    return record.manifest.files.map((f) => {
      const bytes = readFileSync(this.blob(contribution, f.sha256));
      if (bytes.length !== f.size || digest(bytes) !== f.sha256)
        throw new Error("Checkpoint integrity check failed.");
      return { path: f.path, base64: bytes.toString("base64") };
    });
  }
}
