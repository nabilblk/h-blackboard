import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OperationJournal } from "../desktop/execution/operations.mjs";

test("lost responses retain an exact receipt across restart and cannot cross contributions", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hb-operations-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = {
    kind: "publish",
    fingerprint: "a".repeat(64),
    label: "Publish reviewed project",
  };
  const journal = new OperationJournal(dir);
  const first = journal.begin("11111111-1111-4111-8111-111111111111", input);
  journal.update("11111111-1111-4111-8111-111111111111", {
    id: first.id,
    completed: 2,
    total: 3,
    detail: "Uploading files",
  });
  journal.finish("11111111-1111-4111-8111-111111111111", first.id, {
    event: "b".repeat(64),
  });
  const reopened = new OperationJournal(dir);
  assert.equal(
    reopened.begin("11111111-1111-4111-8111-111111111111", input).result.event,
    "b".repeat(64),
  );
  assert.equal(reopened.list("11111111-1111-4111-8111-111111111111").length, 1);
  assert.equal(
    reopened.get("22222222-2222-4222-8222-222222222222", first.id),
    null,
  );
});

test("cancellation cannot erase a committed result and interruption is honestly uncertain", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hb-operations-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const journal = new OperationJournal(dir);
  const input = {
    kind: "import",
    fingerprint: "c".repeat(64),
    label: "Import source",
  };
  const record = journal.begin("11111111-1111-4111-8111-111111111111", input);
  assert.equal(
    journal.cancel("11111111-1111-4111-8111-111111111111", record.id).state,
    "cancel_requested",
  );
  journal.finish("11111111-1111-4111-8111-111111111111", record.id, {
    destination: "review",
  });
  assert.equal(
    journal.fail(
      "11111111-1111-4111-8111-111111111111",
      record.id,
      "late timeout",
    ).state,
    "complete",
  );
  const command = journal.begin("11111111-1111-4111-8111-111111111111", {
    ...input,
    kind: "command",
  });
  journal.interrupted("11111111-1111-4111-8111-111111111111");
  assert.equal(
    journal.get("11111111-1111-4111-8111-111111111111", command.id).state,
    "uncertain",
  );
  assert.equal(
    journal.begin("11111111-1111-4111-8111-111111111111", {
      ...input,
      kind: "command",
    }).state,
    "uncertain",
  );
  assert.equal(
    journal.get("11111111-1111-4111-8111-111111111111", record.id).state,
    "complete",
  );
});
