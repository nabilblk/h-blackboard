import {
  constants,
  openSync,
  fstatSync,
  readFileSync,
  mkdirSync,
  lstatSync,
  chmodSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Id } from "../model.mjs";
import { Record } from "./contract.mjs";

// One fsynced journal per contribution. An intent is durable before any launch
// or reservation; recovery never infers termination from a missing JS process.
export class ExecutionStore {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (
      !lstatSync(directory).isDirectory() ||
      lstatSync(directory).isSymbolicLink()
    )
      throw new Error("Execution storage must be a real directory.");
    chmodSync(directory, 0o700);
  }
  path(contribution) {
    return join(this.directory, `${Id.parse(contribution)}.json`);
  }
  read(contribution) {
    let fd;
    try {
      fd = openSync(
        this.path(contribution),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size > 16384)
        throw new Error("Invalid execution record.");
      const raw = readFileSync(fd);
      if (raw.length > 16384) throw new Error("Invalid execution record.");
      const record = Record.parse(JSON.parse(raw));
      if (record.contribution !== contribution)
        throw new Error("Execution identity mismatch.");
      return record;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  write(record) {
    const value = Record.parse(record);
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    let fd;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(value) + "\n");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.path(value.contribution));
      fd = openSync(this.directory, "r");
      fsyncSync(fd);
      return value;
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  }
  update(contribution, change) {
    const value = this.read(contribution);
    if (!value) throw new Error("Prepare this contribution first.");
    return this.write({
      ...value,
      ...change,
      contribution,
      updatedAt: Date.now(),
    });
  }
}
