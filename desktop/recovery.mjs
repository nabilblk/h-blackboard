// Portable, authenticated recovery of node identity and replicated history.
// Provider credentials, live VM images and contributor execution approvals are
// deliberately outside this archive. Restore into a NEW profile only.
import {
  randomBytes,
  scrypt as derive,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { promisify } from "node:util";
import {
  open,
  mkdir,
  readdir,
  lstat,
  unlink,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { NodeIdentity, Keys } from "./node-identity.mjs";

const MAGIC = Buffer.from("HBREC001");
const LIMIT = 512 * 1024 * 1024,
  FILES = 20000;
export const RecoveryRequest = z
  .object({ passphrase: z.string().min(16).max(1024) })
  .strict();
const Record = z
  .object({
    path: z.string().max(512),
    size: z
      .number()
      .int()
      .min(0)
      .max(256 * 1024 * 1024),
  })
  .strict();
const allowed = (path) =>
  /^(identity\.json|node\.sqlite(?:-wal|-shm)?|blobs\/[a-zA-Z0-9_.\/-]+)$/.test(
    path,
  ) && path.split("/").every((p) => p && p !== "." && p !== "..");
async function key(passphrase, salt) {
  RecoveryRequest.parse({ passphrase });
  return promisify(derive)(passphrase, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}
async function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const r = await fd.write(buffer, offset);
    if (!r.bytesWritten) throw new Error("Recovery write failed.");
    offset += r.bytesWritten;
  }
}
async function readExactly(fd, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const r = await fd.read(buffer, offset, length - offset, position + offset);
    if (!r.bytesRead) throw new Error("Incomplete recovery file.");
    offset += r.bytesRead;
  }
  return buffer;
}
async function syncDirectory(path) {
  const fd = await open(path, "r");
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
async function entries(root, relative = "", found = []) {
  for (const item of (await readdir(join(root, relative))).sort()) {
    const path = relative ? `${relative}/${item}` : item;
    if (!relative && ["profile.lock", "artifact-staging"].includes(item))
      continue;
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink())
      throw new Error("Recovery cannot include symbolic links.");
    if (info.isDirectory() && (path === "blobs" || path.startsWith("blobs/")))
      await entries(root, path, found);
    else if (info.isFile() && allowed(path))
      found.push(Record.parse({ path, size: info.size }));
    else throw new Error("Unexpected file in node records; recovery stopped.");
    if (found.length > FILES)
      throw new Error("Node recovery exceeds the file limit.");
  }
  return found;
}

export async function exportRecovery({ records, keys, passphrase, file }) {
  Keys.parse(keys);
  const files = await entries(records);
  if (
    !files.some((f) => f.path === "identity.json") ||
    !files.some((f) => f.path === "node.sqlite")
  )
    throw new Error("Node history is incomplete.");
  if (files.reduce((n, f) => n + f.size, 0) > LIMIT - 32 * 1024 * 1024)
    throw new Error(
      "Recovery exceeds 480 MiB. Retain a closed-app profile backup instead.",
    );
  const salt = randomBytes(16),
    nonce = randomBytes(12),
    header = Buffer.concat([MAGIC, salt, nonce]);
  const secret = await key(passphrase, salt),
    cipher = createCipheriv("aes-256-gcm", secret, nonce);
  cipher.setAAD(header);
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  let output;
  try {
    output = await open(temporary, "wx", 0o600);
    await writeAll(output, header);
    const put = async (buffer) => {
      await writeAll(output, cipher.update(buffer));
    };
    const json = async (value) => {
      const bytes = Buffer.from(JSON.stringify(value));
      const size = Buffer.alloc(4);
      size.writeUInt32BE(bytes.length);
      await put(size);
      await put(bytes);
      bytes.fill(0);
    };
    await json({ version: 1, keys, files: files.length, created: Date.now() });
    for (const record of files) {
      await json(record);
      const input = await open(join(records, record.path), "r");
      try {
        if ((await input.stat()).size !== record.size)
          throw new Error("Node history changed during recovery export.");
        for (let at = 0; at < record.size;) {
          const bytes = await readExactly(
            input,
            Math.min(65536, record.size - at),
            at,
          );
          await put(bytes);
          at += bytes.length;
          bytes.fill(0);
        }
      } finally {
        await input.close();
      }
    }
    await writeAll(output, cipher.final());
    await writeAll(output, cipher.getAuthTag());
    await output.sync();
    await output.close();
    output = null;
    await rename(temporary, file);
    await syncDirectory(dirname(file));
    return {
      files: files.length,
      bytes: files.reduce((n, f) => n + f.size, 0),
    };
  } finally {
    secret.fill(0);
    await output?.close();
    await rm(temporary, { force: true });
  }
}

export async function importRecovery({
  file,
  passphrase,
  directory,
  secureStorage,
  validate,
}) {
  // Never merge recovered state into an existing signer or replace its keys.
  try {
    if ((await readdir(directory)).length)
      throw new Error(
        "Restore requires an empty node profile. Keep the current profile intact.",
      );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const parent = dirname(directory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = join(parent, `.recovery-${randomBytes(12).toString("hex")}`);
  await mkdir(staging, { mode: 0o700 });
  const input = await open(file, "r");
  let scratch, secret;
  try {
    const info = await input.stat();
    if (!info.isFile() || info.size < 56 || info.size > LIMIT)
      throw new Error("Invalid recovery file size.");
    const header = await readExactly(input, 36, 0);
    if (!header.subarray(0, 8).equals(MAGIC))
      throw new Error("Unsupported recovery file.");
    secret = await key(passphrase, header.subarray(8, 24));
    const decipher = createDecipheriv(
      "aes-256-gcm",
      secret,
      header.subarray(24),
    );
    decipher.setAAD(header);
    decipher.setAuthTag(await readExactly(input, 16, info.size - 16));
    const scratchPath = join(staging, ".unlinked");
    scratch = await open(scratchPath, "wx+", 0o600);
    await unlink(scratchPath);
    // Authenticate before interpreting any archive path or private key. The
    // private temporary inode is unlinked immediately, including on a crash.
    try {
      for (let at = 36; at < info.size - 16;) {
        const bytes = await readExactly(
          input,
          Math.min(65536, info.size - 16 - at),
          at,
        );
        await writeAll(scratch, decipher.update(bytes));
        at += bytes.length;
      }
      await writeAll(scratch, decipher.final());
    } catch {
      throw new Error(
        "Recovery could not be authenticated. Check the passphrase and original file.",
      );
    }
    const total = (await scratch.stat()).size;
    let at = 0;
    const take = async (length) => {
      if (length > total - at) throw new Error("Incomplete recovery archive.");
      const b = await readExactly(scratch, length, at);
      at += length;
      return b;
    };
    const json = async () => {
      const size = (await take(4)).readUInt32BE();
      if (!size || size > 4096) throw new Error("Invalid recovery record.");
      const bytes = await take(size);
      try {
        return JSON.parse(bytes);
      } finally {
        bytes.fill(0);
      }
    };
    const metadata = z
      .object({
        version: z.literal(1),
        keys: Keys,
        files: z.number().int().min(2).max(FILES),
        created: z.number().int().nonnegative(),
      })
      .strict()
      .parse(await json());
    const records = join(staging, "records");
    await mkdir(records, { mode: 0o700 });
    const seen = new Set();
    for (let i = 0; i < metadata.files; i++) {
      const record = Record.parse(await json());
      if (!allowed(record.path) || seen.has(record.path))
        throw new Error("Invalid or repeated recovery path.");
      seen.add(record.path);
      const destination = join(records, record.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const output = await open(destination, "wx", 0o600);
      try {
        for (let left = record.size; left;) {
          const bytes = await take(Math.min(65536, left));
          await writeAll(output, bytes);
          left -= bytes.length;
        }
        await output.sync();
      } finally {
        await output.close();
      }
    }
    if (at !== total || !seen.has("identity.json") || !seen.has("node.sqlite"))
      throw new Error("Recovery archive is incomplete or has extra data.");
    // Native verification checks the signing identities and saved event store.
    // Recovery bootstrap forces networking and discovery OFF before binding.
    await validate(metadata.keys, records);
    const identity = new NodeIdentity(staging, secureStorage);
    await identity.checkEncryption();
    await identity.save(metadata.keys);
    // An empty directory can be replaced atomically; an existing identity cannot.
    try {
      if ((await readdir(directory)).length)
        throw new Error("Node profile is no longer empty.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rename(staging, directory);
    await syncDirectory(parent);
    return { files: metadata.files, created: metadata.created };
  } finally {
    secret?.fill(0);
    await input.close();
    await scratch?.close();
    await rm(staging, { recursive: true, force: true });
  }
}
