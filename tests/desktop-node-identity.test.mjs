import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeIdentity } from "../desktop/node-identity.mjs";
import { secureStorage } from "./helpers/secure-storage.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "hb-keys-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "node");
  const storage = secureStorage();
  return {
    root,
    directory,
    storage,
    identity: new NodeIdentity(directory, storage),
  };
}

test("identity enrollment is explicit, encrypted, private and stable", async (t) => {
  const { directory, storage, identity } = fixture(t);
  assert.equal(identity.enrolled(), false);
  assert.equal(existsSync(directory), false);
  const [keys, concurrent] = await Promise.all([
    identity.enroll(),
    identity.enroll(),
  ]);
  assert.deepEqual(keys, concurrent);
  const bytes = readFileSync(identity.file);
  assert.equal(bytes.includes(Buffer.from(keys.owner_seed)), false);
  assert.equal(bytes.includes(Buffer.from(keys.transport_seed)), false);
  assert.equal(statSync(directory).mode & 0o077, 0);
  assert.equal(statSync(identity.file).mode & 0o077, 0);
  assert.deepEqual(await new NodeIdentity(directory, storage).load(), keys);
  assert.deepEqual(await identity.enroll(), keys);
  assert.deepEqual(readFileSync(identity.file), bytes);
});

test("unavailable encryption and a plaintext Linux backend fail before enrollment", async (t) => {
  const { directory, storage } = fixture(t);
  await assert.rejects(
    () =>
      new NodeIdentity(directory, {
        ...storage,
        isAsyncEncryptionAvailable: async () => false,
      }).enroll(),
    /secure key storage/,
  );
  assert.equal(existsSync(directory), false);
  await assert.rejects(
    () =>
      new NodeIdentity(
        directory,
        { ...storage, getSelectedStorageBackend: () => "basic_text" },
        "linux",
      ).enroll(),
    /secure key storage/,
  );
  assert.equal(existsSync(directory), false);
});

test("lost or damaged keys never replace the identity beside existing history", async (t) => {
  const { directory, storage, identity } = fixture(t);
  await identity.enroll();
  const bytes = readFileSync(identity.file);
  await assert.rejects(
    () => new NodeIdentity(directory, secureStorage()).enroll(),
    /could not be unlocked/,
  );
  assert.deepEqual(readFileSync(identity.file), bytes);
  writeFileSync(identity.file, "broken ciphertext");
  await assert.rejects(() => identity.enroll(), /could not be unlocked/);
  assert.equal(readFileSync(identity.file, "utf8"), "broken ciphertext");
  rmSync(identity.file);
  mkdirSync(join(directory, "records"), { mode: 0o700 });
  await assert.rejects(
    () => new NodeIdentity(directory, storage).enroll(),
    /identity is missing/,
  );
  assert.equal(existsSync(identity.file), false);
});

test("symbolic links cannot redirect the profile or encrypted key", async (t) => {
  const { root, directory, storage, identity } = fixture(t);
  const real = join(root, "other");
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, directory);
  await assert.rejects(() => identity.enroll(), /private local directory/);
  rmSync(directory);
  await identity.enroll();
  const original = readFileSync(identity.file);
  rmSync(identity.file);
  const target = join(real, "key");
  writeFileSync(target, original);
  symlinkSync(target, identity.file);
  await assert.rejects(
    () => new NodeIdentity(directory, storage).load(),
    /identity is invalid/,
  );
  assert.deepEqual(readFileSync(target), original);
});

test("OS key rotation rewraps the same identity atomically", async (t) => {
  const { directory, storage, identity } = fixture(t);
  const keys = await identity.enroll();
  const original = readFileSync(identity.file);
  const rotated = new NodeIdentity(directory, {
    ...storage,
    async decryptStringAsync(value) {
      return {
        ...(await storage.decryptStringAsync(value)),
        shouldReEncrypt: true,
      };
    },
  });
  assert.deepEqual(await rotated.load(), keys);
  assert.notDeepEqual(readFileSync(identity.file), original);
  assert.deepEqual(await identity.load(), keys);
});
