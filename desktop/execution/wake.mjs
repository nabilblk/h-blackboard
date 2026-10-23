import { createHash } from "node:crypto";
import { messageKey } from "./delivery.mjs";

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
  let waiting = saved?.waiting ?? null;
  const consume = (value) => {
    const { agent, conversations, ...context } = value.context ?? {};
    const author = agent?.identity?.author;
    // Current nodes provide a durable insertion cursor. Older conversation
    // pages are context, not new deliveries, even after bounded seen IDs age
    // out. The fallback remains for previous guest snapshots and tests.
    const pages =
      value.updates || value.priority
        ? [value.priority, value.updates]
        : [value.main, value.inbox, value.workstream];
    for (const page of pages) {
      for (const message of page?.items ?? []) {
        if (message.author === author || message.kind === "governance")
          continue;
        // An explicit dependency wait ignores unrelated chatter, but human
        // instructions and messages addressed to this agent always wake it.
        if (
          waiting &&
          page !== value.priority &&
          message.author !== value.owner &&
          !(value.humans ?? []).includes(message.author) &&
          !(message.to && (message.to === author || message.to === agent?.id))
        )
          continue;
        const id = messageKey(message);
        if (seen.has(id)) continue;
        seen.add(id);
        messages++;
        // More than the three current 200-record pages; bounded even for a
        // long permission. Retained history can be reread through board tools.
        if (seen.size > 2048) seen.delete(seen.values().next().value);
      }
    }
  };
  const baseline = (value) => {
    const { agent, conversations, ...context } = value.context ?? {};
    const {
      acknowledgment: _acknowledgment,
      pending_clarifications: _pending,
      ...identity
    } = agent ?? {};
    return digest({
      context: {
        ...context,
        agent: identity,
        conversations: (conversations ?? []).map(withoutUnread),
      },
      messages,
      workforce:
        agent?.identity?.role === "coordinator"
          ? (value.workforce ?? [])
              .filter((a) => a.id !== agent.id)
              .map((a) => ({
                id: a.id,
                status: a.status,
                direction: a.direction,
                assignment: a.assignment,
                observation:
                  (value.observations ?? []).find(
                    (o) => o.report.registration === a.id,
                  )?.report.state ?? "unknown",
              }))
          : undefined,
      tasks: waiting ? undefined : value.tasks,
      workstreams:
        !waiting && Array.isArray(value.workstreams)
          ? value.workstreams.map(withoutUnread)
          : [],
      // Criterion reports share the governance feed with resource receipts.
      // Observe their semantic state separately, retaining human corrections
      // and evidence freshness without waking on every reservation/receipt.
      criteria: waiting ? undefined : (value.criteria ?? []),
      artifacts: waiting
        ? (value.watched ?? []).map((d) => ({
            revision: d.revision,
            heads: waiting.artifacts.includes(d.revision)
              ? d.artifact.heads
              : undefined,
            reviews: waiting.reviews.includes(d.revision)
              ? d.reviews
              : undefined,
            stale: d.stale,
          }))
        : value.artifacts,
    });
  };
  const track = (value) => {
    consume(value);
    return baseline(value);
  };
  track.baseline = baseline;
  track.deliver = consume;
  track.peek = (value) => createWakeTracker(track.snapshot())(value);
  track.received = (message) => seen.has(messageKey(message));
  track.wait = (value) => {
    waiting = value;
  };
  track.snapshot = () => ({ seen: [...seen], messages, waiting });
  return track;
}
