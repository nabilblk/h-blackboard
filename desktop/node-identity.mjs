import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const Keys = z
  .object({
    version: z.literal(1),
    owner_seed: z.string().regex(/^[a-f0-9]{64}$/),
    transport_seed: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

// Electron safeStorage wraps the key with the OS key store. Never fall back to
// plaintext, regenerate a missing key beside existing history, or expose it over
// the preload bridge. This does not defend against a compromised OS account.
export class NodeIdentity {
  constructor(directory, secureStorage, platform = process.platform) {
    this.directory = directory;
    this.file = join(directory, "keys.v1.enc");
    this.secureStorage = secureStorage;
    this.platform = platform;
  }

  enrolled() {
    if (!existsSync(this.directory)) return false;
    this.checkDirectory();
    if (!existsSync(this.file)) {
      if (readdirSync(this.directory).length)
        throw new Error(
          "The node identity is missing. Your local records were preserved; restore this device's protected profile before continuing.",
        );
      return false;
    }
    return true;
  }

  checkDirectory() {
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
      throw new Error("The node profile must be a private local directory.");
  }

  async checkEncryption() {
    if (
      !(await this.secureStorage.isAsyncEncryptionAvailable()) ||
      (this.platform === "linux" &&
        ["basic_text", "unknown"].includes(
          this.secureStorage.getSelectedStorageBackend(),
        ))
    )
      throw new Error(
        "Unlock your operating system's secure key storage to open this node. Your local records have been preserved.",
      );
  }

  async load() {
    await this.checkEncryption();
    this.checkDirectory();
    const stat = lstatSync(this.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
      throw new Error(
        "The protected node identity is invalid. Restore the original profile; a new identity will not be generated over it.",
      );
    try {
      const decrypted = await this.secureStorage.decryptStringAsync(
        readFileSync(this.file),
      );
      const keys = Keys.parse(JSON.parse(decrypted.result));
      if (decrypted.shouldReEncrypt) await this.save(keys);
      return keys;
    } catch {
      throw new Error(
        "The node identity could not be unlocked. Restore the original protected profile on this device before continuing.",
      );
    }
  }

  async enroll() {
    if (this.enrolling) return this.enrolling;
    this.enrolling = this.createOrLoad();
    try {
      return await this.enrolling;
    } finally {
      this.enrolling = null;
    }
  }

  async createOrLoad() {
    if (this.enrolled()) return this.load();
    await this.checkEncryption();
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.checkDirectory();
    chmodSync(this.directory, 0o700);
    const keys = {
      version: 1,
      owner_seed: randomBytes(32).toString("hex"),
      transport_seed: randomBytes(32).toString("hex"),
    };
    await this.save(keys);
    return keys;
  }

  async save(keys) {
    const ciphertext = await this.secureStorage.encryptStringAsync(
      JSON.stringify(keys),
    );
    const temporary = join(this.directory, `.keys-${randomUUID()}.tmp`);
    let fd;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, ciphertext);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.file);
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
}
