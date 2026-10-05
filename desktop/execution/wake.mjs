import { createHash } from "node:crypto";

const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const withoutUnread = ({ unread: _unread, ...value }) => value;

// One tracker per permission generation. Message pages are bounded views: a
// record leaving a page, a read mark, or an accounting receipt is not new work.
// Keep recent immutable message identities so overlapping pages and their
// unread/reply counters cannot repeatedly wake an otherwise idle runtime.
export function createWakeTracker(saved) {
  const seen = new Set(saved?.seen ?? []);
  let messages = saved?.messages ?? 0;
  const track = (value) => {
    const { agent, conversations, ...context } = value.context ?? {};
    const author = agent?.identity?.author;
    for (const page of [value.main, value.inbox, value.workstream]) {
      for (const message of page?.items ?? []) {
        if (message.author === author || message.kind === "governance")
          continue;
        const id = digest(
          message.id ?? {
            author: message.author,
            text: message.text,
            audience: message.audience,
            thread: message.thread,
          },
        );
        if (seen.has(id)) continue;
        seen.add(id);
        messages++;
        // More than the three current 200-record pages; bounded even for a
        // long permission. Retained history can be reread through board tools.
        if (seen.size > 768) seen.delete(seen.values().next().value);
      }
    }
    const { acknowledgment: _acknowledgment, ...identity } = agent ?? {};
    return digest({
      context: {
        ...context,
        agent: identity,
        conversations: (conversations ?? []).map(withoutUnread),
      },
      messages,
      tasks: value.tasks,
      workstreams: Array.isArray(value.workstreams)
        ? value.workstreams.map(withoutUnread)
        : [],
      // Criterion reports share the governance feed with resource receipts.
      // Observe their semantic state separately, retaining human corrections
      // and evidence freshness without waking on every reservation/receipt.
      criteria: value.criteria ?? [],
    });
  };
  track.snapshot = () => ({ seen: [...seen], messages });
  return track;
}
