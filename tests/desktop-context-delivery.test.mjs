import test from "node:test";
import assert from "node:assert/strict";
import { ContextDelivery } from "../desktop/execution/delivery.mjs";
import {
  compactBriefing,
  BRIEFING_BYTES,
} from "../desktop/execution/prompt.mjs";
import { createWakeTracker } from "../desktop/execution/wake.mjs";

const message = (n) => ({
  id: n.toString(16).padStart(64, "0"),
  kind: "message",
  author: "human",
  text: `Instruction ${n}`,
});
const snapshot = (items) => ({
  owner: "human",
  context: { agent: { identity: { author: "agent", role: "coordinator" } } },
  main: { items },
  updates: {
    start_after: null,
    items,
    after: items.at(-1)?.id,
    has_more: false,
  },
  tasks: { items: [] },
  artifacts: { items: [] },
});

test("a dependency wait still sees priority instructions beyond the ordinary page and saves independent cursors", () => {
  const chatter = Array.from({ length: 32 }, (_, i) => ({
    ...message(i + 1),
    author: "peer",
  }));
  const important = message(71);
  const current = {
    ...snapshot(chatter),
    priority: {
      items: [important],
      start_after: null,
      after: important.id,
      has_more: false,
    },
  };
  const wake = createWakeTracker({
    seen: [],
    messages: 0,
    waiting: {
      reason: "Waiting for the lesson",
      artifacts: ["a".repeat(64)],
      reviews: [],
    },
  });
  assert.notEqual(wake.peek(current), wake.baseline(current));
  const delivery = new ContextDelivery({}, (visible) =>
    wake.deliver({ ...visible, owner: "human", context: current.context }),
  );
  const ticket = delivery.issue(current.priority, {
    priority: current.priority,
  });
  delivery.confirm({ token: ticket._delivery.token, paths: [""] });
  assert.equal(delivery.priorityCursor, important.id);
  assert.equal(delivery.cursor, null);
  assert.equal(wake.peek(current), wake.baseline(current));
  const restored = new ContextDelivery(delivery.snapshot());
  assert.equal(restored.priorityCursor, important.id);
  assert.equal(restored.cursor, null);
  assert.ok(!restored.received(chatter[0]));
});

test("old conversation context cannot become new work after seen IDs age out", () => {
  const old = message(1);
  const wake = createWakeTracker({ seen: [], messages: 3000 });
  const current = { ...snapshot([]), main: { items: [old] } };
  assert.equal(wake.peek(current), wake.baseline(current));
  current.updates.items.push(message(3001));
  assert.notEqual(wake.peek(current), wake.baseline(current));
});

test("a message omitted from the initial prompt remains new work", () => {
  const raw = snapshot(Array.from({ length: 13 }, (_, i) => message(i + 1)));
  delete raw.updates;
  const compact = compactBriefing(raw);
  assert.equal(compact.main.items.length, 12);
  const wake = createWakeTracker();
  wake.deliver(compact);
  const baseline = wake.baseline(raw);
  assert.notEqual(wake.peek(raw), baseline);
  assert.equal(wake.received(raw.main.items[0]), false);
  assert.notEqual(
    wake.peek(raw),
    baseline,
    "polling cannot consume an instruction",
  );
  wake.deliver(raw);
  assert.equal(wake.peek(raw), wake.baseline(raw));
});

test("cache pointers and partial records never advance message delivery", () => {
  const raw = snapshot([message(1), message(2)]);
  const delivered = new ContextDelivery();
  const result = delivered.issue(raw);
  assert.equal(delivered.cursor, null);
  delivered.confirm({ token: result._delivery.token, paths: ["/context"] });
  assert.equal(delivered.cursor, null);
  delivered.confirm({
    token: result._delivery.token,
    paths: ["/updates/items/1"],
  });
  assert.equal(delivered.cursor, null, "cannot skip an unread prefix");
  delivered.confirm({
    token: result._delivery.token,
    paths: ["/updates/items/0/text"],
  });
  assert.equal(
    delivered.cursor,
    null,
    "text alone omits the message's provenance and scope",
  );
  delivered.confirm({
    token: result._delivery.token,
    paths: ["/updates/items/0"],
  });
  assert.equal(delivered.cursor, message(2).id);
  assert.equal(new ContextDelivery(delivered.snapshot()).cursor, message(2).id);
});

test("semantic page receipts map back to their scoped conversation", () => {
  const page = { items: [message(1), message(2)] };
  const delivered = new ContextDelivery();
  const result = delivered.issue(page, { inbox: page });
  delivered.confirm({ token: result._delivery.token, paths: ["/items/0"] });
  assert.equal(delivered.received(page.items[0]), true);
  assert.equal(delivered.received(page.items[1]), false);
});

test("reaction metrics distinguish local observation, emitted context and response without inventing remote latency", () => {
  let now = 100;
  const metrics = [];
  const delivered = new ContextDelivery({}, () => {}, {
    now: () => now,
    onMetric: (m) => metrics.push(m),
  });
  const page = { items: [message(1), message(2)] };
  delivered.observe({ priority: page });
  now = 150;
  const ticket = delivered.issue(page, { priority: page });
  assert.equal(metrics.length, 0, "a cached result is not delivery");
  delivered.confirm({
    token: ticket._delivery.token,
    paths: ["/items/0/text"],
  });
  assert.equal(metrics.length, 0, "partial text lacks the source context");
  now = 225;
  delivered.confirm({ token: ticket._delivery.token, paths: ["/items/0"] });
  assert.equal(metrics[0].observedToDeliveryMs, 125);
  now = 500;
  delivered.confirm({ token: ticket._delivery.token, paths: ["/items/0"] });
  assert.equal(metrics.length, 1, "re-reading is not new delivery");
  delivered.responded(message(1).id);
  assert.equal(metrics[1].deliveryToResponseMs, 275);
  delivered.responded(message(2).id);
  assert.equal(metrics[2].deliveryToResponseMs, null);
  const resumed = new ContextDelivery(delivered.snapshot(), () => {}, {
    onMetric: (m) => metrics.push(m),
  });
  resumed.responded(message(1).id);
  assert.equal(
    metrics[3].deliveryToResponseMs,
    null,
    "a new turn cannot invent an old timing interval",
  );
});

test("large pending instructions are delivered whole or remain pending under a byte bound", () => {
  const raw = snapshot(
    Array.from({ length: 32 }, (_, i) => ({
      ...message(i + 1),
      text: "🌍".repeat(4000),
    })),
  );
  const compact = compactBriefing(raw);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= BRIEFING_BYTES);
  assert.ok(
    compact.updates.items.length > 0 && compact.updates.items.length < 32,
  );
  assert.ok(compact.updates.items.every((m) => m.text === "🌍".repeat(4000)));
  assert.equal(compact.updates.has_more, true);
  const delivered = new ContextDelivery();
  delivered.expose(compact);
  assert.equal(delivered.cursor, compact.updates.items.at(-1).id);
  assert.equal(delivered.received(raw.updates.items.at(-1)), false);
});

test("briefing metadata cannot overflow a full message and shared-state budget", () => {
  for (const width of [682, 683, 684, 1024, 4096]) {
    for (const character of ["x", "🌍"]) {
      const items = Array.from({ length: 32 }, (_, i) => ({
        ...message(i + 1),
        text: character.repeat(width),
      }));
      const raw = {
        ...snapshot(items),
        priority: {
          start_after: null,
          items: items.slice(0, 3),
          after: items[2].id,
          has_more: false,
        },
        inbox: { items: items.slice(0, 3) },
        workstreams: [],
        artifacts: {
          items: Array.from({ length: 12 }, (_, i) => ({
            id: String(i),
            summary: "a".repeat(600),
          })),
        },
        criteria: Array.from({ length: 7 }, () => ({ text: "c".repeat(300) })),
        watched: [],
        workforce: Array.from({ length: 4 }, () => ({
          direction: { text: "d".repeat(2000) },
        })),
        observations: [],
      };
      const compact = compactBriefing(raw);
      assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= BRIEFING_BYTES);
      assert.ok(
        compact.priority.items.length,
        "human instructions have priority",
      );
      for (const key of ["priority", "updates"]) {
        const page = compact[key];
        assert.deepEqual(
          page.items,
          raw[key].items.slice(0, page.items.length),
        );
        assert.equal(page.after, page.items.at(-1)?.id ?? null);
        assert.equal(page.has_more, page.items.length < raw[key].items.length);
        assert.equal(compact.omitted.includes(key), page.briefing_truncated);
      }
      const delivered = new ContextDelivery();
      delivered.expose(compact);
      assert.equal(delivered.cursor, compact.updates.after);
      for (const item of raw.updates.items.slice(
        compact.updates.items.length,
      )) {
        if (
          !compact.priority.items.some((priority) => priority.id === item.id)
        ) {
          assert.equal(delivered.received(item), false);
        }
      }
    }
  }
});

test("an oversized required context still fails instead of silently losing mission authority", () => {
  const raw = snapshot([]);
  raw.context.mission = { criteria: Array(40).fill("x".repeat(2000)) };
  assert.throws(() => compactBriefing(raw), /context budget/);
});

test("Coordinator wakes on a worker stop, not report renewal or its own VM state", () => {
  const raw = snapshot([]);
  raw.context.agent.id = "self";
  raw.workforce = [
    { id: "worker", status: "directed" },
    { id: "self", status: "directed" },
  ];
  raw.observations = [
    {
      report: { registration: "worker", state: "running", issued_ms: 1 },
      remaining_ms: 20000,
    },
  ];
  const wake = createWakeTracker();
  const baseline = wake(raw);
  raw.observations[0].report.issued_ms = 200;
  raw.observations[0].remaining_ms = 29000;
  raw.observations.push({ report: { registration: "self", state: "stopped" } });
  assert.equal(wake.peek(raw), baseline);
  raw.observations[0].report.state = "stopped";
  assert.notEqual(wake.peek(raw), baseline);
  raw.observations = [];
  assert.notEqual(
    wake.peek(raw),
    baseline,
    "expired reports are unknown, not running forever",
  );
});
