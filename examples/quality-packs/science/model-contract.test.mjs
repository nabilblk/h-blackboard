import test from "node:test";
import assert from "node:assert/strict";
import { averageSpeed, numericInput, readingText } from "./model-contract.mjs";

test("zero time and invalid inputs never masquerade as zero speed", () => {
  for (const values of [
    { distance: 10, time: 0 },
    { distance: -1, time: 2 },
    { distance: 1, time: -2 },
    { distance: NaN, time: 2 },
    { distance: 1, time: Infinity },
    { distance: 1001, time: 2 },
    { distance: 1000, time: Number.MIN_VALUE },
  ]) {
    const result = averageSpeed(values);
    assert.equal(result.status, "invalid");
    assert.equal(result.readings[0].value, null);
    assert.equal(result.scene, null);
    assert.ok(result.feedback.length > 10);
    assert.match(readingText(result.readings[0]), /not available/);
  }
});
test("valid readings are labelled, unitful and scientifically qualified", () => {
  assert.equal(averageSpeed({ distance: 10, time: 2 }).readings[0].value, 5);
  assert.equal(averageSpeed({ distance: 0, time: 2 }).readings[0].value, 0);
  assert.match(
    readingText(averageSpeed({ distance: 10, time: 2 }).readings[0]),
    /Average speed: 5 m\/s/,
  );
  assert.match(
    averageSpeed({ distance: 10, time: 2 }).feedback,
    /not a claim of constant/,
  );
  assert.throws(
    () => numericInput(1, { min: 5, max: 2, label: "Distance", unit: "m" }),
    /bounds/,
  );
});
