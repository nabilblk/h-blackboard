import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  signRelease,
  verifyRelease,
  hashRelease,
} from "../desktop/release-manifest.mjs";
test("release provenance rejects modified installers, wrong signing keys, rollback and expired metadata", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hb-release-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "installer.dmg");
  await writeFile(file, "test installer bytes");
  const pair = generateKeyPairSync("ed25519"),
    pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    pub = pair.publicKey.export({ type: "spki", format: "pem" });
  const input = {
    schema: 1,
    product: "io.harakiri.contributor",
    version: "0.5.0",
    sequence: 5,
    protocol: 13,
    platform: "darwin",
    arch: "arm64",
    filename: "Harakiri-Desktop-0.5.0-macOS-arm64.dmg",
    team: "ABCDEFGHIJ",
    source: "a".repeat(40),
    issued: 1000000,
    expires: 2000000,
    ...(await hashRelease(file)),
  };
  const envelope = signRelease(input, pem),
    options = { minimumSequence: 5, arch: "arm64", now: 1100000 };
  assert.deepEqual(await verifyRelease(envelope, pub, file, options), input);
  await assert.rejects(
    verifyRelease(envelope, pub, file, { ...options, minimumSequence: 6 }),
    /rollback/,
  );
  await assert.rejects(
    verifyRelease(envelope, pub, file, { ...options, now: 3000000 }),
    /expired/,
  );
  await assert.rejects(
    verifyRelease(envelope, pub, file, { ...options, arch: "x64" }),
    /architecture/,
  );
  const other = generateKeyPairSync("ed25519").publicKey.export({
    type: "spki",
    format: "pem",
  });
  await assert.rejects(
    verifyRelease(envelope, other, file, options),
    /signature/,
  );
  await writeFile(file, "modified installer bytes");
  await assert.rejects(verifyRelease(envelope, pub, file, options), /bytes/);
});
