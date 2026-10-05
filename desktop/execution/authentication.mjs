// Authentication output is memory-only and local to this device. Never put it
// in execution logs, signed mission records, or persistent setup journals.
const domains = {
  grok: new Set(["auth.x.ai", "accounts.x.ai", "grok.com", "x.ai"]),
  claude: new Set([
    "claude.ai",
    "claude.com",
    "platform.claude.com",
    "console.anthropic.com",
  ]),
  codex: new Set(["auth.openai.com", "chatgpt.com"]),
};
export function loginURL(runtime, value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      domains[runtime]?.has(url.hostname)
    );
  } catch {
    return false;
  }
}
export function cleanLoginOutput(value) {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "");
}
export function loginLinks(runtime, text) {
  return [
    ...new Set(
      (text.match(/https:\/\/[^\s<>"']+/g) || [])
        .map((s) => s.replace(/[),.;]+$/, ""))
        .filter((s) => loginURL(runtime, s)),
    ),
  ].slice(-5);
}

export function loginPresentation(runtime, output, startedAt, previous = {}) {
  const urls = loginLinks(runtime, output);
  const url = urls.at(-1) ?? null;
  const code = url ? new URL(url).searchParams.get("user_code") : null;
  const printed = output
    .replace(/https?:\/\/[^\s<>"']+/g, "")
    .match(
      /(?:user\s+code|enter\s+(?:the\s+)?code|code)\s*[:=]\s*([A-Z0-9]{4}[- ][A-Z0-9]{4})\b/i,
    )?.[1];
  const expiry = output.match(
    /(?:expires?\s+in|valid\s+for)\s+(\d+)\s*(seconds?|minutes?)\b/i,
  );
  // Only display a provider expiry if the CLI actually supplied one. The
  // separate 10-minute local login-process limit is not an OAuth lifetime.
  const seconds = expiry
    ? Number(expiry[1]) *
      (expiry[2].toLowerCase().startsWith("minute") ? 60 : 1)
    : null;
  const sameChallenge = previous.url === url;
  const expiresAt =
    sameChallenge && previous.expiresAt
      ? previous.expiresAt
      : seconds && seconds <= 3600
        ? Date.now() + seconds * 1000
        : null;
  const failure = /expired|expiration/i.test(output)
    ? "expired"
    : /access_denied|denied|declined/i.test(output)
      ? "denied"
      : /network|timed? ?out|ECONN|connection refused/i.test(output)
        ? "connection"
        : null;
  return {
    url,
    urls,
    code: code || printed || null,
    expiresAt,
    startedAt,
    localDeadline: startedAt + 600000,
    failure,
  };
}
