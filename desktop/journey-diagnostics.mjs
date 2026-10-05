import { z } from "zod";
import { createHash } from "node:crypto";
import { OnboardingStore } from "./onboarding-store.mjs";

// Optional local timing, never authority or an execution log. No arbitrary
// output, paths, invitations, message text or provider codes are accepted.
const id = "4ecc3646-d49f-481f-8fa2-f0547818d934";
const event = z
  .object({
    at: z.number().int().nonnegative(),
    subject: z.string().regex(/^[a-f0-9]{64}$/),
    step: z.enum([
      "mission",
      "setup",
      "sign_in",
      "contribution",
      "start_review",
      "result_review",
    ]),
    state: z.enum([
      "preparing",
      "active",
      "paused",
      "closed",
      "archived",
      "pending",
      "running",
      "complete",
      "failed",
      "cancelled",
      "waiting",
      "starting",
      "stopped",
      "expired",
      "review",
      "interrupted",
      "reviewed",
      "started",
      "recording",
      "accepted",
      "abandoned",
    ]),
    previous_ms: z.number().int().nonnegative(),
  })
  .strict();
export class JourneyDiagnostics {
  seen = new Map();
  constructor(directory) {
    this.store = new OnboardingStore(
      directory,
      z
        .object({ id: z.literal(id), events: z.array(event).max(1000) })
        .strict(),
    );
  }
  transition(subject, step, state) {
    const key = createHash("sha256").update(subject).digest("hex");
    const old = this.seen.get(`${key}:${step}`);
    if (old?.state === state) return;
    const at = performance.now();
    const entry = event.parse({
      at: Date.now(),
      subject: key,
      step,
      state,
      previous_ms: old ? Math.max(0, Math.floor(at - old.at)) : 0,
    });
    const rows = this.store.read(id)?.events ?? [];
    this.store.write({ id, events: [...rows.slice(-999), entry] });
    this.seen.set(`${key}:${step}`, { state, at });
    if (this.seen.size > 4096) this.seen.delete(this.seen.keys().next().value);
  }
  summary() {
    const rows = this.store.read(id)?.events ?? [];
    return {
      events: rows.length,
      transitions: rows.reduce(
        (all, r) => ({ ...all, [r.step]: (all[r.step] ?? 0) + 1 }),
        {},
      ),
    };
  }
  clear() {
    this.store.write({ id, events: [] });
    this.seen.clear();
  }
}
