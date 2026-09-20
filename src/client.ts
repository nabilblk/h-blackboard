export async function get<T>(path: string): Promise<T> {
  const response = await fetch("/api/" + path);
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error("The board service is unavailable. Reconnecting…");
  }
  if (!response.ok) throw new Error(value.error || "Could not read the board");
  return value;
}
export async function rpc<T = any>(
  operation: string,
  input: object = {},
): Promise<T> {
  const key = crypto.randomUUID();
  const response = await fetch("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, input, key }),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error || "Could not save this change");
  return value;
}
export const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
