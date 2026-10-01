import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { State } from "./model.mjs";

export class DesktopStore {
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, "contributions.json");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink())
      throw new Error(
        "The desktop data directory must not be a symbolic link.",
      );
    chmodSync(directory, 0o700);
    if (existsSync(this.file)) {
      const stat = lstatSync(this.file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 8 * 1024 * 1024
      )
        throw new Error(
          "The desktop state file is not valid. It has been left unchanged.",
        );
      try {
        this.value = State.parse(JSON.parse(readFileSync(this.file, "utf8")));
        this.assertOwnership(this.value);
      } catch {
        throw new Error(
          "The desktop state could not be validated. It has been left unchanged; restore a backup before continuing.",
        );
      }
      chmodSync(this.file, 0o600);
    } else {
      this.write({
        schemaVersion: 1,
        contributor: { id: randomUUID(), name: "You" },
        device: {
          id: randomUUID(),
          name: hostname().slice(0, 100) || "This device",
        },
        contributions: [],
        activity: [],
      });
    }
  }

  assertOwnership(value) {
    const ids = new Set();
    for (const item of value.contributions) {
      if (
        item.contributorId !== value.contributor.id ||
        item.deviceId !== value.device.id ||
        ids.has(item.id) ||
        (item.status === "revoked") !== (item.revokedAt !== null)
      )
        throw new Error("Invalid contribution ownership or state.");
      ids.add(item.id);
    }
  }

  read() {
    return structuredClone(this.value);
  }

  write(next) {
    const parsed = State.parse(next);
    this.assertOwnership(parsed);
    const temporary = join(this.directory, `.state-${randomUUID()}.tmp`);
    let fd;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(parsed, null, 2) + "\n");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.file);
      this.value = parsed;
      // Sync the directory entry as well as the new file before acknowledging
      // a saved or revoked consent record to the renderer.
      const directory = openSync(this.directory, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  }

  update(change) {
    const next = this.read();
    change(next);
    this.write(next);
    return this.read();
  }
}
