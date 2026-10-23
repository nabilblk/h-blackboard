import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CheckpointStore } from "../desktop/execution/checkpoints.mjs";
const contributor = "11111111-1111-4111-8111-111111111111";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function manifest(content) {
  const files = Object.entries(content)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, bytes]) => ({
      path,
      sha256: hash(bytes),
      size: Buffer.byteLength(bytes),
    }));
  return {
    version: 1,
    algorithm: "sha256",
    digest: hash(JSON.stringify(files)),
    files,
    bytes: files.reduce((n, f) => n + f.size, 0),
    exclusions: [],
    scope: "Selected source tree",
  };
}
test("source checkpoints deduplicate, survive restart, verify bytes and bound retained history", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hb-checkpoints-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let store = new CheckpointStore(root);
  const source = { "index.txt": "hello", "empty.txt": "" };
  const first = manifest(source);
  const started = store.begin(contributor, first);
  assert.deepEqual(new Set(started.missing), new Set(Object.keys(source)));
  for (const [path, bytes] of Object.entries(source))
    store.chunk(contributor, {
      id: started.id,
      path,
      offset: 0,
      base64: Buffer.from(bytes).toString("base64"),
    });
  store.finish(contributor, started.id);
  store = new CheckpointStore(root);
  assert.equal(store.begin(contributor, first).missing.length, 0);
  assert.deepEqual(
    Object.fromEntries(
      store
        .restoreFiles(contributor, first.digest)
        .map((f) => [f.path, Buffer.from(f.base64, "base64").toString()]),
    ),
    source,
  );
  const wrong = manifest({ "file.txt": "expected" });
  store.begin(contributor, wrong);
  assert.throws(
    () =>
      store.chunk(contributor, {
        id: wrong.digest,
        path: "file.txt",
        offset: 0,
        base64: Buffer.from("corrupt!").toString("base64"),
      }),
    /changed/,
  );
  assert.throws(
    () => store.restoreFiles(contributor, wrong.digest),
    /completed/,
  );
  for (let i = 0; i < 5; i++) {
    const data = String(i),
      item = manifest({ "counter.txt": data });
    store.begin(contributor, item);
    store.chunk(contributor, {
      id: item.digest,
      path: "counter.txt",
      offset: 0,
      base64: Buffer.from(data).toString("base64"),
    });
    store.finish(contributor, item.digest);
  }
  assert.equal(store.list(contributor).length, 3);
  assert.throws(
    () => store.begin(contributor, { ...first, digest: "f".repeat(64) }),
    /digest/,
  );
  assert.throws(() => store.read("../../outside", first.digest));
});
