import test from "node:test";
import assert from "node:assert/strict";
import { runtimeUsage } from "../bin/usage.mjs";

test("Native usage uses terminal aggregates and does not double count cache or reasoning", () => {
  assert.equal(
    runtimeUsage("codex", {
      type: "turn.completed",
      usage: {
        input_tokens: 1000,
        cached_input_tokens: 900,
        output_tokens: 80,
      },
    }).tokens,
    1080,
  );
  assert.equal(
    runtimeUsage("claude", {
      type: "result",
      total_cost_usd: 0.02,
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 50,
        output_tokens: 20,
      },
    }).tokens,
    180,
  );
  const grok = runtimeUsage("grok", {
    type: "turn.usage",
    usage: {
      inputTokens: 5952241,
      outputTokens: 58550,
      totalTokens: 6010791,
      cachedReadTokens: 5254016,
      reasoningTokens: 28265,
      costUsdTicks: 19832030000,
    },
  });
  assert.equal(grok.tokens, 6010791);
  assert.equal(grok.costUsd, 1.983203);
  assert.equal(
    runtimeUsage("grok", {
      type: "session/update",
      usage: { totalTokens: 200 },
    }),
    null,
  );
});

test("Absent usage is unknown, never zero; subscription runtimes without cost reports retain unknown cost", () => {
  assert.equal(
    runtimeUsage("codex", { type: "turn.completed" }).quality,
    "unknown",
  );
  const tokensOnly = runtimeUsage("codex", {
    type: "turn.completed",
    usage: { input_tokens: 10, output_tokens: 3 },
  });
  assert.equal(tokensOnly.costUsd, null);
  assert.equal(tokensOnly.quality, "reported");
  assert.equal(
    runtimeUsage("grok", {
      type: "turn.usage",
      usage: { totalTokens: -1, costUsdTicks: "0" },
    }).tokens,
    null,
  );
});
