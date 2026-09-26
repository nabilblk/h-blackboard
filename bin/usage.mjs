// Only terminal per-turn aggregates are accepted. Cached/reasoning counters
// overlap input/output for Codex and Grok and must not be added twice.
const number = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const tokens = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
export const unknownUsage = (source = "No terminal runtime usage report") => ({
  tokens: null,
  costUsd: null,
  quality: "unknown",
  source,
});
export function runtimeUsage(runtime, event) {
  let count = null,
    cost = null;
  if (runtime === "claude" && event.type === "result") {
    const u = event.usage;
    if (tokens(u?.input_tokens) !== null && tokens(u?.output_tokens) !== null)
      count = tokens(
        u.input_tokens +
          u.output_tokens +
          (u.cache_read_input_tokens || 0) +
          (u.cache_creation_input_tokens || 0),
      );
    cost = number(event.total_cost_usd);
  } else if (runtime === "codex" && event.type === "turn.completed") {
    const u = event.usage;
    if (tokens(u?.input_tokens) !== null && tokens(u?.output_tokens) !== null)
      count = tokens(u.input_tokens + u.output_tokens);
  } else if (runtime === "grok" && event.type === "turn.usage") {
    const u = event.usage;
    count = tokens(u?.totalTokens);
    if (
      count === null &&
      tokens(u?.inputTokens) !== null &&
      tokens(u?.outputTokens) !== null
    )
      count = tokens(u.inputTokens + u.outputTokens);
    const ticks = number(u?.costUsdTicks);
    cost = ticks === null ? null : ticks / 1e10;
  } else return null;
  return count === null && cost === null
    ? unknownUsage(`${runtime}: usage unavailable`)
    : {
        tokens: count,
        costUsd: cost,
        quality: "reported",
        source: `${runtime}: terminal turn aggregate`,
      };
}
