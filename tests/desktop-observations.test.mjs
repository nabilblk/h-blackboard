import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { Observations } from "../src/application/observations.ts";
const flush = () => setImmediate();
test("shared observations deduplicate reads and changes, ignore invalidated responses, and recover after failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const store = new Observations(),
    values = [],
    mirror = [],
    errors = [];
  let calls = 0,
    finish,
    fail = false;
  const load = () => {
    calls++;
    return fail
      ? Promise.reject(new Error("offline"))
      : new Promise((resolve) => {
          finish = resolve;
        });
  };
  const a = store.subscribe(
    "mission",
    load,
    (v) => values.push(v),
    (e) => errors.push(e.message),
  );
  const b = store.subscribe("mission", load, (v) => mirror.push(v));
  t.after(() => {
    a();
    b();
  });
  t.mock.timers.tick(250);
  await flush();
  assert.equal(calls, 1);
  store.invalidate("mission");
  finish({ revision: 1 });
  await flush();
  assert.equal(values.length, 0);
  t.mock.timers.tick(250);
  await flush();
  finish({ revision: 2 });
  await flush();
  assert.deepEqual(values, [{ revision: 2 }]);
  assert.deepEqual(mirror, values);
  t.mock.timers.tick(3000);
  await flush();
  finish({ revision: 2 });
  await flush();
  assert.equal(values.length, 1);
  fail = true;
  store.invalidate();
  t.mock.timers.tick(250);
  await flush();
  assert.deepEqual(errors, ["offline"]);
  fail = false;
  store.invalidate();
  t.mock.timers.tick(250);
  await flush();
  finish({ revision: 2 });
  await flush();
  assert.equal(values.length, 2);
});
test("one shared port bounds concurrency and discards orphan subscriptions", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const store = new Observations(),
    pending = [],
    stops = [];
  let active = 0,
    max = 0,
    delivered = 0;
  for (let i = 0; i < 10; i++)
    stops.push(
      store.subscribe(
        "key" + i,
        () => {
          active++;
          max = Math.max(max, active);
          return new Promise((resolve) =>
            pending.push(() => {
              active--;
              resolve(i);
            }),
          );
        },
        () => delivered++,
      ),
    );
  t.after(() => stops.forEach((stop) => stop()));
  t.mock.timers.tick(250);
  await flush();
  assert.equal(pending.length, 4);
  assert.equal(max, 4);
  stops[0]();
  for (const resolve of pending.splice(0)) resolve();
  await flush();
  assert.equal(delivered, 3);
  t.mock.timers.tick(250);
  await flush();
  assert.equal(pending.length, 4);
  stops.forEach((stop) => stop());
  for (const resolve of pending.splice(0)) resolve();
  await flush();
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(pending.length, 0);
});
