import { randomUUID } from "node:crypto";
export async function request(url, path, body, token) {
  const response = await fetch(new URL(path, url), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(path === "/api/watch" ? 30000 : 15000),
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(data.error || `HTTP ${response.status}`), {
      status: response.status,
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
      if (attempt >= 2 || (error.status && error.status < 500)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
};
