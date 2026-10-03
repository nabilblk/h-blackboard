// Device-local only; never sent to a peer. Owner + mission + conversation keep
// private drafts separate. Versioned and bounded; corrupt storage is harmless.
const hash = /^[a-f0-9]{64}$/;
const channel = /^(main|(?:private|workstream):[a-f0-9]{64})$/;
const draftKey = /^(main|(?:private|workstream|thread):[a-f0-9]{64})$/;
const key = (owner, mission) => {
  if (!hash.test(owner) || !hash.test(mission))
    throw new Error("Invalid draft identity");
  return `harakiri.drafts.v1:${owner}:${mission}`;
};
export function readDrafts(storage, owner, mission) {
  const empty = { audience: "main", drafts: {} };
  try {
    const raw = storage.getItem(key(owner, mission));
    if (!raw || raw.length > 1024 * 1024) return empty;
    const value = JSON.parse(raw);
    if (
      value.version !== 1 ||
      !channel.test(value.audience) ||
      !value.drafts ||
      typeof value.drafts !== "object" ||
      Array.isArray(value.drafts)
    )
      return empty;
    const drafts = Object.fromEntries(
      Object.entries(value.drafts)
        .filter(
          ([k, v]) =>
            draftKey.test(k) && typeof v === "string" && v.length <= 16384,
        )
        .slice(0, 128),
    );
    return { audience: value.audience, drafts };
  } catch {
    return empty;
  }
}
export function writeDrafts(storage, owner, mission, session) {
  const value = {
    version: 1,
    audience: channel.test(session.audience) ? session.audience : "main",
    drafts: Object.fromEntries(
      Object.entries(session.drafts).filter(
        ([k, v]) =>
          draftKey.test(k) &&
          typeof v === "string" &&
          v.length > 0 &&
          v.length <= 16384,
      ),
    ),
  };
  if (
    Object.keys(value.drafts).length > 128 ||
    JSON.stringify(value).length > 1024 * 1024
  )
    throw new Error(
      "Draft storage is full. Send or clear older drafts before leaving this channel.",
    );
  storage.setItem(key(owner, mission), JSON.stringify(value));
}
