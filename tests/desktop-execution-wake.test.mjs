import test from "node:test";
import assert from "node:assert/strict";
import { createWakeTracker } from "../desktop/execution/wake.mjs";

const initial = () => ({
  context: {
    lifecycle: { revision: "control", phase: "active" },
    agent: { identity: { author: "agent" }, acknowledgment: null },
    conversations: [{ id: "main", unread: 0, writable: true }],
  },
  main: {
    items: [
      {
        id: "instruction",
        kind: "message",
        author: "human",
        text: "Build the guide",
        unread: true,
        replies: 0,
      },
    ],
  },
  inbox: { items: [] },
  workstreams: [{ id: "stream", goal: "Review", unread: 0 }],
  tasks: { items: [] },
  criteria: [],
});

test("own output, acknowledgments, read counters and accounting never spin an idle agent", () => {
  const fingerprint = createWakeTracker();
  const state = initial();
  const baseline = fingerprint(state);
  state.context.agent.acknowledgment = "signed-ack";
  state.context.conversations[0].unread++;
  state.workstreams[0].unread++;
  state.main.items[0].unread = false;
  state.main.items[0].replies++;
  state.main.items.push(
    { id: "own-post", kind: "message", author: "agent", text: "Waiting" },
    {
      id: "receipt",
      kind: "governance",
      author: "host",
      text: "Resources updated",
    },
  );
  assert.equal(fingerprint(state), baseline);
  // Background records can push meaningful messages out of the current page.
  state.main.items = [{ id: "reserve", kind: "governance", author: "host" }];
  assert.equal(fingerprint(state), baseline);
});

test("peer messages wake once across overlapping pages and retain arrivals during work", () => {
  const fingerprint = createWakeTracker();
  const state = initial();
  const before = fingerprint(state);
  const message = {
    id: "peer-result",
    kind: "message",
    author: "peer",
    text: "Review revision",
  };
  state.main.items.push(message);
  state.inbox.items.push(message);
  const after = fingerprint(state);
  assert.notEqual(after, before);
  assert.equal(fingerprint(state), after);
  state.main.items.reverse();
  assert.equal(fingerprint(state), after);
  state.inbox.items.push({
    id: "human-correction",
    kind: "message",
    author: "human",
    text: "Check the second round",
  });
  assert.notEqual(fingerprint(state), after);
});

test("criterion corrections, task changes and workstream goals still wake agents", () => {
  const fingerprint = createWakeTracker();
  const state = initial();
  let previous = fingerprint(state);
  for (const change of [
    () =>
      state.criteria.push({
        index: 0,
        met: false,
        report: "human-review",
        stale: false,
      }),
    () => (state.criteria[0].stale = true),
    () => state.tasks.items.push({ id: "task", status: "assigned" }),
    () => (state.workstreams[0].goal = "Check new evidence"),
    () => (state.context.conversations[0].writable = false),
  ]) {
    change();
    const next = fingerprint(state);
    assert.notEqual(next, previous);
    previous = next;
  }
});

test("saved wake context survives permission renewal without spending a turn on old messages", () => {
  const current = createWakeTracker();
  const state = initial();
  const before = current(state);
  const restored = createWakeTracker(current.snapshot());
  assert.equal(restored(state), before);
  state.main.items.push({
    id: "new-human-direction",
    kind: "message",
    author: "human",
    text: "Test the alternative",
  });
  assert.notEqual(restored(state), before);
  assert.ok(restored.snapshot().seen.every((v) => /^[a-f0-9]{64}$/.test(v)));
});
