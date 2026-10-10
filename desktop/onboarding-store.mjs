import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  rmSync,
  mkdirSync,
  lstatSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Id } from "./model.mjs";

export class OnboardingStore {
  constructor(directory, schema, { maxBytes = 262144 } = {}) {
    this.directory = directory;
    this.schema = schema;
    this.maxBytes = maxBytes;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (
      !lstatSync(directory).isDirectory() ||
      lstatSync(directory).isSymbolicLink()
    )
      throw new Error("Setup storage must be a real directory.");
    chmodSync(directory, 0o700);
  }
  read(id) {
    let fd;
    try {
      fd = openSync(
        join(this.directory, `${Id.parse(id)}.json`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size > this.maxBytes)
        throw new Error("Invalid setup journal.");
      const value = this.schema.parse(JSON.parse(readFileSync(fd, "utf8")));
      if (value.id !== id) throw new Error("Setup identity mismatch.");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  write(value) {
    const parsed = this.schema.parse(value);
    const serialized = JSON.stringify(parsed);
    if (Buffer.byteLength(serialized) > this.maxBytes)
      throw new Error("Local journal is full. Shorten or clear saved input.");
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    let fd;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, serialized);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(
        temporary,
        join(this.directory, `${Id.parse(parsed.id)}.json`),
      );
      fd = openSync(this.directory, "r");
      fsyncSync(fd);
      return parsed;
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  }
}
