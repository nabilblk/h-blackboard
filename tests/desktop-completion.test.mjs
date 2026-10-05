import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { CompletionService } from "../desktop/completion.mjs";
const h = (s) => s.repeat(64);
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "hb-completion-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const mission = {
    id: h("a"),
    owner: h("b"),
    conflicted: false,
    lifecycle: { revision: h("c"), phase: "active" },
  };
  const details = new Map(
    [h("d"), h("e")].map((revision) => [
      revision,
      {
        revision,
        stale: false,
        artifact: { conversation: "main", heads: [revision] },
        document: { stage: "complete" },
        acceptance: null,
      },
    ]),
  );
  const calls = [];
  let loss = null;
  const node = {
    state: async () => ({
      identity: { owner: mission.owner },
      missions: [mission],
    }),
    handle: async (method, r) => {
      if (method === "artifactDetail") return details.get(r.revision);
      calls.push(method);
      if (method === "artifactAction")
        details.get(r.action.revision).acceptance = {
          accepted: true,
          stale: false,
          author: mission.owner,
        };
      if (method === "missionAction") mission.lifecycle.phase = "closed";
      if (loss === method) {
        loss = null;
        throw new Error("Saved response was lost");
      }
      return { event: h("f") };
    },
  };
  return {
    directory,
    mission,
    details,
    calls,
    drop: (method) => (loss = method),
    service: () => new CompletionService({ directory, node }),
    request: {
      id: randomUUID(),
      mission: mission.id,
      control: mission.lifecycle.revision,
      revisions: [...details.keys()],
      reason: "Reviewed the exact deliverables.",
    },
  };
}
for (const operation of ["artifactAction", "missionAction"])
  test(`completion resumes a lost ${operation} response without duplicate acceptance or premature closure`, async (t) => {
    const f = fixture(t);
    f.drop(operation);
    await assert.rejects(f.service().complete(f.request), /lost/);
    const recovered = f.service();
    await recovered.complete(f.request);
    await recovered.complete(f.request);
    assert.equal(f.calls.filter((v) => v === "artifactAction").length, 2);
    assert.equal(f.calls.filter((v) => v === "missionAction").length, 1);
    assert.equal(recovered.state(f.request.mission)[0].status, "complete");
  });
test("completion checks all revisions before accepting any and never silently accepts stale evidence", async (t) => {
  const f = fixture(t);
  f.details.get(h("e")).stale = true;
  await assert.rejects(f.service().complete(f.request), /changed|review/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.mission.lifecycle.phase, "active");
});
test("changed mission control invalidates a completion review", async (t) => {
  const f = fixture(t);
  f.mission.lifecycle.revision = h("f");
  await assert.rejects(f.service().complete(f.request), /Mission changed/);
  assert.equal(f.calls.length, 0);
});
