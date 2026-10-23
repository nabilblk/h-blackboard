import { createHash, randomUUID } from "node:crypto";

export const messageKey = (message) =>
  createHash("sha256")
    .update(JSON.stringify(message.id ?? message))
    .digest("hex");
const pages = ["main", "inbox", "workstream", "updates", "priority"];
const under = (path, parent) =>
  parent === "" || path === parent || path.startsWith(`${parent}/`);

// A response being produced is not delivery. Only the bounded prompt or the MCP
// transport's completed output fragments may advance this per-contribution view.
// Tickets never grant authority and are valid only inside this runtime turn.
export class ContextDelivery {
  constructor(
    saved = {},
    onDelivery = () => {},
    { now = Date.now, onMetric = () => {} } = {},
  ) {
    this.now = now;
    this.onMetric = onMetric;
    this.timing = new Map();
    this.seen = new Set(saved.seen ?? []);
    this.cursor = saved.cursor ?? null;
    this.priorityCursor = saved.priorityCursor ?? null;
    this.tickets = new Map();
    this.pages = [];
    this.onDelivery = onDelivery;
  }
  observe(source) {
    for (const key of pages)
      for (const message of source[key]?.items ?? []) {
        if (typeof message.id !== "string" || this.timing.has(message.id))
          continue;
        this.timing.set(message.id, {
          observedAt: this.now(),
          deliveredAt: null,
        });
      }
    while (this.timing.size > 2048)
      this.timing.delete(this.timing.keys().next().value);
  }
  responded(id) {
    const timing = this.timing.get(id);
    this.onMetric({
      type: "addressed_reply",
      message: id,
      at: this.now(),
      deliveryToResponseMs:
        timing?.deliveredAt == null
          ? null
          : Math.max(0, this.now() - timing.deliveredAt),
      scope: "local turn; delivery is not understanding",
    });
  }
  received(message) {
    return this.seen.has(messageKey(message));
  }
  expose(value, paths = [""], source = value, notice = null) {
    this.observe(source);
    const visible = { ...source };
    for (const key of pages) {
      const page = source[key];
      if (!page?.items) continue;
      visible[key] = { ...page, items: [] };
      for (let index = 0; index < page.items.length; index++) {
        const message = page.items[index];
        if (paths.some((path) => under(`/${key}/items/${index}`, path))) {
          const timing = this.timing.get(message.id);
          if (timing && timing.deliveredAt === null) {
            timing.deliveredAt = this.now();
            this.onMetric({
              type: "context_delivery",
              message: message.id,
              at: timing.deliveredAt,
              observedToDeliveryMs: Math.max(
                0,
                timing.deliveredAt - timing.observedAt,
              ),
              scope:
                "first observed locally to emitted context; not peer network latency",
            });
          }
          this.seen.add(messageKey(message));
          visible[key].items.push(message);
        }
      }
      if (
        ["updates", "priority"].includes(key) &&
        !this.pages.some((p) => p.page === page)
      )
        this.pages.push({ key, page });
    }
    // Only a contiguous delivered prefix may move the native insertion cursor.
    for (const { key, page } of this.pages) {
      const cursor = key === "priority" ? "priorityCursor" : "cursor";
      if (
        page.start_after !== undefined &&
        page.start_after !== this[cursor] &&
        !page.items.some((m) => m.id === this[cursor])
      )
        continue;
      for (const message of page.items) {
        if (!this.received(message)) break;
        this[cursor] = message.id;
      }
    }
    this.pages = this.pages
      .filter((p) => !p.page.items.every((m) => this.received(m)))
      .slice(-16);
    while (this.seen.size > 2048)
      this.seen.delete(this.seen.values().next().value);
    this.onDelivery(visible, paths, source, notice);
  }
  issue(value, projection = value, notice = null) {
    this.observe(projection);
    const token = randomUUID();
    // The native transport is bounded; keep this bookkeeper bounded too.
    if (
      Buffer.byteLength(JSON.stringify({ value, projection, notice })) >
      4 * 1024 * 1024
    )
      throw new Error("Delivery result is too large; use a focused query.");
    this.tickets.set(token, { value, projection, notice });
    while (this.tickets.size > 8)
      this.tickets.delete(this.tickets.keys().next().value);
    return { ...value, _delivery: { token } };
  }
  confirm({ token, paths }) {
    const ticket = this.tickets.get(token);
    if (
      !ticket ||
      !Array.isArray(paths) ||
      paths.length > 64 ||
      paths.some((p) => typeof p !== "string" || p.length > 1024)
    )
      throw new Error(
        "Delivery receipt expired or invalid; refresh the briefing.",
      );
    const wrapped = Object.keys(ticket.projection).find(
      (k) => ticket.projection[k] === ticket.value,
    );
    const mapped = wrapped
      ? paths.map((p) => (p === "" ? "" : `/${wrapped}${p}`))
      : paths;
    this.expose(ticket.projection, mapped, ticket.projection, ticket.notice);
    return { delivered: true };
  }
  snapshot() {
    return {
      seen: [...this.seen],
      cursor: this.cursor,
      priorityCursor: this.priorityCursor,
    };
  }
}
