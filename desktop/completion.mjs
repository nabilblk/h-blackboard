import { z } from "zod";
import { readdirSync } from "node:fs";
import { Id } from "./model.mjs";
import { Hash } from "./execution/contract.mjs";
import { OnboardingStore } from "./onboarding-store.mjs";
// Old journals stay readable, but an old request cannot authorize a new close.
const savedRequest = z
  .object({
    id: Id,
    mission: Hash,
    control: Hash,
    revisions: z
      .array(Hash)
      .min(1)
      .max(32)
      .refine((v) => new Set(v).size === v.length),
    reason: z.string().trim().min(1).max(2048),
    closeConfirmed: z.literal(true).optional(),
  })
  .strict();
const request = savedRequest.extend({ closeConfirmed: z.literal(true) });
export const CompletionRequests = {
  completeMission: request,
  completionState: z.object({ mission: Hash }).strict(),
  discardCompletion: z.object({ id: Id }).strict(),
};
const schema = z
  .object({
    id: Id,
    request: savedRequest,
    status: z.enum([
      "recording",
      "accepted",
      "complete",
      "interrupted",
      "abandoned",
    ]),
    accepted: z.array(Hash).max(32),
    message: z.string().max(2048),
  })
  .strict();
export class CompletionService {
  active = new Map();
  closed = false;
  constructor({ directory, node }) {
    this.store = new OnboardingStore(directory, schema);
    this.node = node;
  }
  state(mission) {
    return readdirSync(this.store.directory)
      .filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))
      .map((f) => this.store.read(f.slice(0, -5)))
      .filter((j) => j.request.mission === mission);
  }
  complete(input) {
    const r = request.parse(input);
    if (this.closed) return Promise.reject(new Error("Desktop is closing."));
    const current = this.active.get(r.id);
    if (current)
      return JSON.stringify(current.request) === JSON.stringify(r)
        ? current.promise
        : Promise.reject(new Error("Completion review changed."));
    const p = this.run(r).finally(() => this.active.delete(r.id));
    this.active.set(r.id, { request: r, promise: p });
    return p;
  }
  async run(r) {
    let job = this.store.read(r.id);
    if (
      job &&
      JSON.stringify({ ...job.request, closeConfirmed: true }) !==
        JSON.stringify(r)
    )
      throw new Error("Completion review changed. Review a new action.");
    if (job?.status === "complete") return job;
    if (job?.status === "abandoned")
      throw new Error(
        "This completion review was replaced. Review current results.",
      );
    const state = await this.node.state();
    const m = state.missions.find((m) => m.id === r.mission);
    if (!m || m.owner !== state.identity.owner || m.conflicted)
      throw new Error("Mission owner and unconflicted history required.");
    const closed = ["closed", "archived"].includes(m.lifecycle.phase);
    if (m.lifecycle.phase === "preparing")
      throw new Error(
        "The mission is still preparing. Review the plan and Start before reviewing final results. To end preparation, use Close mission.",
      );
    if (!closed && m.lifecycle.revision !== r.control)
      throw new Error("Mission changed. Review the current results.");
    job ??= {
      id: r.id,
      request: r,
      status: "recording",
      accepted: [],
      message: "Recording acceptance of the exact reviewed revisions.",
    };
    // Upgrade a pending legacy review only after renewed, explicit confirmation.
    job.request = r;
    this.store.write(job);
    try {
      // Validate every selected revision before recording the first decision.
      const details = await Promise.all(
        r.revisions.map((revision) =>
          this.node.handle("artifactDetail", { mission: r.mission, revision }),
        ),
      );
      for (const d of details) {
        if (
          d.stale ||
          d.artifact.conversation !== "main" ||
          d.document.stage !== "complete" ||
          !d.artifact.heads.includes(d.revision) ||
          d.artifact.heads.length !== 1
        )
          throw new Error(
            "A selected deliverable changed or needs review. Existing acceptance decisions remain saved.",
          );
      }
      for (const d of details) {
        if (
          !d.acceptance?.accepted ||
          d.acceptance.stale ||
          d.acceptance.author !== m.owner
        ) {
          if (closed)
            throw new Error(
              "Mission is closed but a selected revision was not accepted. Inspect saved results.",
            );
          await this.node.handle("artifactAction", {
            mission: r.mission,
            control: r.control,
            conversation: "main",
            action: {
              type: "accept",
              revision: d.revision,
              accepted: true,
              reason: r.reason,
            },
          });
        }
        if (!job.accepted.includes(d.revision)) job.accepted.push(d.revision);
        this.store.write(job);
      }
      job.status = "accepted";
      job.message = "Deliverables accepted. Recording mission closure.";
      this.store.write(job);
      if (!closed)
        await this.node.handle("missionAction", {
          mission: r.mission,
          revision: r.control,
          action: { type: "close", reason: r.reason },
        });
      job.status = "complete";
      job.message =
        "Selected deliverables accepted and mission closed. Saved conversations and files remain available.";
      return this.store.write(job);
    } catch (e) {
      job.status = "interrupted";
      job.message = e.message.slice(0, 2048);
      this.store.write(job);
      throw e;
    }
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.active.values()].map((v) => v.promise));
  }
  async discard(id) {
    await this.active.get(id)?.promise.catch(() => {});
    const job = this.store.read(id);
    if (!job) return;
    this.store.write({
      ...job,
      status: "abandoned",
      message:
        "Review replaced by the human. Previously recorded acceptance decisions are preserved.",
    });
  }
}
