import { randomUUID } from "node:crypto";
export const isRetryable = (error) => error?.retryable === true;
export const reconnectDelay = (attempt) =>
  Math.min(10000, 500 * 2 ** Math.min(attempt, 5)) *
  (0.75 + Math.random() * 0.5);
export async function request(url, path, body, token, { signal } = {}) {
  const target = new URL(path, url);
  let response;
  try {
    response = await fetch(target, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([
            signal,
            AbortSignal.timeout(path === "/api/watch" ? 30000 : 15000),
          ])
        : AbortSignal.timeout(path === "/api/watch" ? 30000 : 15000),
    });
  } catch (cause) {
    if (signal?.aborted)
      throw Object.assign(new Error("Board request cancelled.", { cause }), {
        retryable: false,
      });
    throw Object.assign(
      new Error("Board connection interrupted. Reconnecting…", { cause }),
      { retryable: true },
    );
  }
  let data;
  try {
    data = await response.json();
  } catch (cause) {
    throw Object.assign(
      new Error(
        response.ok
          ? "Board response was interrupted. Reconnecting…"
          : `Board service returned HTTP ${response.status}.`,
        { cause },
      ),
      {
        status: response.status,
        retryable:
          response.ok || response.status >= 500 || response.status === 429,
      },
    );
  }
  if (!response.ok)
    throw Object.assign(new Error(data.error || `HTTP ${response.status}`), {
      status: response.status,
      retryable: response.status >= 500 || response.status === 429,
    });
  return data;
}
export const call = async (
  session,
  operation,
  input = {},
  key = randomUUID(),
) => {
  for (let attempt = 0; ; attempt++)
    try {
      return await request(
        session.url,
        "/api/rpc",
        { operation, input: { channel_id: session.channelId, ...input }, key },
        session.token,
      );
    } catch (error) {
      if (attempt >= 2 || !isRetryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
};
