import test from "node:test";
import assert from "node:assert/strict";
import { readDrafts, writeDrafts } from "../shared/desktop-drafts.mjs";
test("desktop drafts survive a fresh reader without crossing owners, missions or private threads", () => {
  const records = new Map();
  const storage = {
    getItem: (k) => records.get(k),
    setItem: (k, v) => records.set(k, v),
  };
  const a = "a".repeat(64),
    b = "b".repeat(64),
    m = "c".repeat(64),
    p = `private:${b}`,
    t = `thread:${b}`;
  writeDrafts(storage, a, m, {
    audience: p,
    drafts: { main: "Main draft", [p]: "Private draft", [t]: "Thread draft" },
  });
  assert.equal(readDrafts(storage, a, m).drafts[p], "Private draft");
  assert.equal(readDrafts(storage, a, m).drafts[t], "Thread draft");
  assert.deepEqual(readDrafts(storage, b, m).drafts, {});
  assert.deepEqual(readDrafts(storage, a, b).drafts, {});
  writeDrafts(storage, a, m, { audience: p, drafts: { [p]: "" } });
  assert.deepEqual(readDrafts(storage, a, m).drafts, {});
  const key = [...records.keys()][0];
  records.set(
    key,
    '{"version":1,"audience":"main","drafts":{"__proto__":"bad","main":7}}',
  );
  assert.deepEqual(readDrafts(storage, a, m).drafts, {});
  records.set(key, "corrupt");
  assert.deepEqual(readDrafts(storage, a, m), { audience: "main", drafts: {} });
  assert.throws(
    () =>
      writeDrafts(
        {
          setItem() {
            throw Error("quota");
          },
        },
        a,
        m,
        { audience: "main", drafts: { main: "Preserve in memory" } },
      ),
    /quota/,
  );
});
