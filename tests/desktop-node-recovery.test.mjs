import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportRecovery, importRecovery } from "../desktop/recovery.mjs";
import { NodeIdentity } from "../desktop/node-identity.mjs";
const keys = {
  version: 1,
  owner_seed: "1".repeat(64),
  transport_seed: "2".repeat(64),
};
const passphrase = "a separate long recovery passphrase";
const secureStorage = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (text) => Buffer.from(text),
  decryptStringAsync: async (bytes) => ({ result: bytes.toString() }),
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hb-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = join(root, "source");
  await mkdir(join(records, "blobs"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(records, "identity.json"),
    JSON.stringify({
      version: 1,
      owner: "3".repeat(64),
      endpoint: "4".repeat(64),
    }),
  );
  await writeFile(join(records, "node.sqlite"), Buffer.alloc(200001, 51));
  await writeFile(
    join(records, "blobs", "sample.data"),
    Buffer.alloc(150123, 77),
  );
  await mkdir(join(records, "artifact-staging"));
  await writeFile(
    join(records, "artifact-staging", "private-partial"),
    "not recovered",
  );
  return { root, records, file: join(root, "node.hbrecovery") };
}
test("portable recovery preserves exact history bytes, authenticates first, and rewraps keys", async (t) => {
  const f = await fixture(t),
    directory = join(f.root, "restored");
  await exportRecovery({ ...f, keys, passphrase });
  const encrypted = await readFile(f.file);
  assert.equal(encrypted.includes(Buffer.from(keys.owner_seed)), false);
  let verified = false;
  await importRecovery({
    file: f.file,
    passphrase,
    directory,
    secureStorage,
    validate: async (actual, records) => {
      assert.deepEqual(actual, keys);
      assert.deepEqual(
        await readFile(join(records, "node.sqlite")),
        await readFile(join(f.records, "node.sqlite")),
      );
      verified = true;
    },
  });
  assert.ok(verified);
  assert.deepEqual(
    await new NodeIdentity(directory, secureStorage).load(),
    keys,
  );
  assert.deepEqual(
    await readFile(join(directory, "records/blobs/sample.data")),
    await readFile(join(f.records, "blobs/sample.data")),
  );
  assert.equal(
    (await readdir(join(directory, "records"))).includes("artifact-staging"),
    false,
  );
  await assert.rejects(
    importRecovery({
      file: f.file,
      passphrase,
      directory,
      secureStorage,
      validate: async () => {},
    }),
    /empty node profile/,
  );
});
test("wrong passphrase, tampering and failed native verification leave no identity or plaintext files", async (t) => {
  const f = await fixture(t);
  await exportRecovery({ ...f, keys, passphrase });
  for (const [label, phrase, mutate, validate] of [
    [
      "wrong",
      "wrong but sufficiently long password",
      false,
      async () => {
        throw new Error("must not parse");
      },
    ],
    [
      "corrupt",
      passphrase,
      true,
      async () => {
        throw new Error("must not parse");
      },
    ],
    [
      "invalid-history",
      passphrase,
      false,
      async () => {
        throw new Error("history invalid");
      },
    ],
  ]) {
    const original = await readFile(f.file);
    const bytes = Buffer.from(original);
    if (mutate) bytes[50] ^= 1;
    const file = join(f.root, label + ".hbrecovery");
    await writeFile(file, bytes);
    const directory = join(f.root, label);
    await assert.rejects(
      importRecovery({
        file,
        passphrase: phrase,
        directory,
        secureStorage,
        validate,
      }),
      /authenticated|history invalid/,
    );
    await assert.rejects(readFile(join(directory, "keys.v1.enc")), {
      code: "ENOENT",
    });
    assert.equal(
      (await readdir(f.root)).some((n) => n.startsWith(".recovery-")),
      false,
    );
  }
});
test("backup does not follow links or silently include unexpected sensitive files", async (t) => {
  const f = await fixture(t);
  await symlink("/etc/hosts", join(f.records, "blobs/link"));
  await assert.rejects(exportRecovery({ ...f, keys, passphrase }), /symbolic/);
  await rm(join(f.records, "blobs/link"));
  await writeFile(join(f.records, "credentials.json"), "secret");
  await assert.rejects(
    exportRecovery({ ...f, keys, passphrase }),
    /Unexpected/,
  );
});
