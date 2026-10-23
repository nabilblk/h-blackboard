import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Id } from "../model.mjs";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const states = [
  "running",
  "complete",
  "failed",
  "cancel_requested",
  "cancelled",
  "uncertain",
];
export const OperationStart = z
  .object({
    kind: z.enum(["publish", "import", "command", "checkpoint", "review"]),
    fingerprint: Hash,
    label: z.string().trim().min(1).max(160),
  })
  .strict();
const Record = OperationStart.extend({
  id: Hash,
  contribution: Id,
  state: z.enum(states),
  startedAt: z.number(),
  updatedAt: z.number(),
  attempts: z.number().int().positive(),
  progress: z
    .object({
      completed: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      detail: z.string().max(240),
    })
    .strict()
    .nullable(),
  result: z.unknown().nullable(),
  error: z.string().max(1024).nullable(),
}).strict();
export const OperationProgress = z
  .object({
    id: Hash,
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    detail: z.string().max(240),
  })
  .strict();

/** Local-only, per-contribution receipts. A journal never grants permission or
 * claims that a lost response rolled back a native commit. */
export class OperationJournal {
  constructor(directory, now = Date.now) {
    this.directory = join(directory, "operations");
    this.now = now;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  folder(contribution) {
    return join(this.directory, Id.parse(contribution));
  }
  path(contribution, id) {
    return join(this.folder(contribution), `${Hash.parse(id)}.json`);
  }
  save(value) {
    const record = Record.parse(value);
    const bytes = JSON.stringify(record);
    if (Buffer.byteLength(bytes) > 256 * 1024)
      throw new Error("Operation receipt exceeds 256 KiB.");
    mkdirSync(this.folder(record.contribution), {
      recursive: true,
      mode: 0o700,
    });
    const target = this.path(record.contribution, record.id),
      temporary = `${target}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temporary, target);
      const dir = openSync(this.folder(record.contribution), "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return record;
  }
  get(contribution, id) {
    Id.parse(contribution);
    let value;
    try {
      const path = this.path(contribution, id);
      if (statSync(path).size > 256 * 1024)
        throw new Error("Operation receipt exceeds 256 KiB.");
      value = Record.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (value.contribution !== contribution)
      throw new Error("Operation unavailable for this contribution.");
    return value;
  }
  list(contribution, limit = 30) {
    Id.parse(contribution);
    const values = [];
    let names;
    try {
      names = readdirSync(this.folder(contribution));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const recent = names
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => ({
        name,
        at: statSync(join(this.folder(contribution), name)).mtimeMs,
      }))
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
    for (const { name } of recent) {
      const value = this.get(contribution, name.slice(0, -5));
      if (!value) continue;
      if (value.contribution === contribution) values.push(value);
    }
    return values.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }
  begin(contribution, input) {
    const request = OperationStart.parse(input);
    const id = createHash("sha256")
      .update(
        JSON.stringify([
          Id.parse(contribution),
          request.kind,
          request.fingerprint,
        ]),
      )
      .digest("hex");
    const previous = this.get(contribution, id);
    if (
      previous &&
      ["complete", "running", "cancel_requested"].includes(previous.state)
    )
      return previous;
    if (previous?.kind === "command" && previous.state === "uncertain")
      return previous;
    const entries = this.list(contribution, 257);
    if (entries.length >= 256) {
      const removable = entries
        .filter((r) => ["complete", "failed", "cancelled"].includes(r.state))
        .at(-1);
      if (!removable)
        throw new Error("Resolve outstanding operations before starting more.");
      unlinkSync(this.path(contribution, removable.id));
    }
    return this.save({
      ...request,
      id,
      contribution,
      state: "running",
      startedAt: previous?.startedAt ?? this.now(),
      updatedAt: this.now(),
      attempts: (previous?.attempts ?? 0) + 1,
      progress: previous?.progress ?? null,
      result: null,
      error: null,
    });
  }
  update(contribution, input) {
    const { id, ...progress } = OperationProgress.parse(input);
    if (progress.completed > progress.total)
      throw new Error("Invalid operation progress.");
    const record = this.get(contribution, id);
    if (!record) throw new Error("Operation unavailable.");
    if (record.state !== "running") return record;
    if (
      this.now() - record.updatedAt < 250 &&
      progress.completed < progress.total
    )
      return record;
    return this.save({ ...record, progress, updatedAt: this.now() });
  }
  finish(contribution, id, result) {
    const record = this.get(contribution, id);
    if (!record) throw new Error("Operation unavailable.");
    if (record.state === "complete") return record;
    // A successful committed result wins over a cancellation request. Neither
    // cancellation nor a closed caller can undo an already durable result.
    return this.save({
      ...record,
      state: "complete",
      result,
      error: null,
      updatedAt: this.now(),
    });
  }
  fail(contribution, id, error, state = "uncertain") {
    if (!["failed", "cancelled", "uncertain"].includes(state))
      throw new Error("Invalid operation outcome.");
    const record = this.get(contribution, id);
    if (!record) throw new Error("Operation unavailable.");
    if (record.state === "complete") return record;
    return this.save({
      ...record,
      state,
      error: String(error).slice(0, 1024),
      updatedAt: this.now(),
    });
  }
  cancel(contribution, id) {
    const record = this.get(contribution, id);
    if (!record) throw new Error("Operation unavailable.");
    if (record.state !== "running") return record;
    return this.save({
      ...record,
      state: "cancel_requested",
      updatedAt: this.now(),
    });
  }
  interrupted(contribution) {
    for (const record of this.list(contribution, 256)) {
      if (["running", "cancel_requested"].includes(record.state))
        this.fail(
          contribution,
          record.id,
          "Execution ended before its receipt arrived. Inspect saved output before retrying.",
        );
    }
  }
}
