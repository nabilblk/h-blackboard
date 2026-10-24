import test from "node:test";
import assert from "node:assert/strict";
import { reviewReferences } from "../shared/artifact-review.mjs";

test("linked review records accept complete copied board references without extracting prose", () => {
  const a = "a".repeat(64),
    b = "b".repeat(64),
    c = "c".repeat(64);
  assert.deepEqual(reviewReferences(" \n \t"), []);
  assert.deepEqual(reviewReferences(`${a}\t${b}`), [a, b]);
  assert.deepEqual(
    reviewReferences(
      `[Message](harakiri://message/${a})\n[Lesson \\[1\\]](harakiri://artifact/${b})\nharakiri://artifact/${c}`,
    ),
    [a, b, c],
  );
  for (const value of [
    "Owner artifact-preview observations and Main correction request at 03:23. Full visible diagram captured in integrated-closed-circuit-connections.png in the study evidence.",
    `The observation is ${a}`,
    `${a}\nDescribe a screenshot here`,
    `[Message](harakiri://message/${a}) extra prose`,
    `harakiri://artifact/${a})`,
    `[Message](harakiri://message/${a}`,
    `[Message](harakiri://message/${a}?other=1)`,
    `[Message](https://example.com/${a})`,
    `[Agent](harakiri://agent/${a})`,
    `harakiri://message/${a.slice(0, 10)}`,
  ])
    assert.throws(() => reviewReferences(value), /Move descriptions/);
  assert.throws(
    () => reviewReferences(`${a}\n[Same message](harakiri://message/${a})`),
    /more than once/,
  );
  const ids = Array.from({ length: 17 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  assert.equal(reviewReferences(ids.slice(0, 16).join("\n")).length, 16);
  assert.throws(() => reviewReferences(ids.join("\n")), /at most 16/);
});
