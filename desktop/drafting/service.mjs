import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { OnboardingStore } from "../onboarding-store.mjs";
import { NodeRequests } from "../node-service.mjs";
import { Draft, DraftRequests, Response, Brief } from "./contract.mjs";
import {
  briefFields,
  emptyBrief,
  draftDefinition,
  briefReadiness,
} from "../../shared/mission-draft.mjs";

const journalId = "00000000-0000-4000-8000-000000000001";
const maxJournalBytes = 8 * 1024 * 1024;
const same = isDeepStrictEqual;
function fresh(runtime = "claude") {
  return {
    version: 1,
    id: randomUUID(),
    revision: 0,
    updatedAt: Date.now(),
    mode: "choice",
    runtime,
    idea: "",
    composer: "",
    listInputs: {
      deliverables: "",
      criteria: "",
      assumptions: "",
      openQuestions: "",
    },
    brief: emptyBrief(),
    policy: {
      coordination: "coordinated",
      participation: "private",
      budget: { mode: "unlimited" },
    },
    fieldRevisions: Object.fromEntries(briefFields.map((f) => [f, 0])),
    messages: [],
    question: null,
    assessment: null,
    changes: [],
    conflicts: [],
    status: "idle",
    error: null,
    mission: null,
    review: null,
    creation: null,
  };
}

/** A local authoring service. Runtime output can only propose brief fields.
 * Creation is a separate human IPC command; no execution/agent capabilities
 * or node keys are ever given to the runtime. One active draft per desktop. */
export class DraftingService {
  constructor({ directory, runtime, node }) {
    this.runtime = runtime;
    this.node = node;
    this.active = null;
    this.creating = null;
    this.storageError = null;
    try {
      this.store = new OnboardingStore(
        directory,
        z.object({ id: z.literal(journalId), draft: Draft }).strict(),
        { maxBytes: maxJournalBytes },
      );
      const draft = this.read();
      if (draft.status === "thinking") {
        draft.status = "stopped";
        draft.error =
          "Drafting was interrupted. Your brief and conversation are saved. Send a message to continue.";
        this.save(draft);
      } else if (draft.status === "creating") {
        draft.status = "uncertain";
        draft.error =
          "Creation was interrupted. Checking local missions before any retry.";
        this.save(draft);
      }
    } catch {
      // A damaged private draft must not prevent the mission workspace from
      // opening. Preserve the original journal for recovery; never reset it.
      this.storageError = new Error(
        "Your private draft could not be opened. It has been preserved. Check local storage access and restart the app; your existing missions remain available.",
      );
    }
  }
  read() {
    if (this.storageError) throw this.storageError;
    return this.store.read(journalId)?.draft ?? this.save(fresh());
  }
  save(draft) {
    draft.updatedAt = Math.max(Date.now(), draft.updatedAt + 1);
    // Bound suggestion history without dropping the brief or conversation.
    while (
      draft.changes.length > 1 &&
      Buffer.byteLength(JSON.stringify({ id: journalId, draft })) >
        maxJournalBytes
    )
      draft.changes.shift();
    this.store.write({ id: journalId, draft });
    return structuredClone(draft);
  }
  require(id, { mutable = true } = {}) {
    const d = this.read();
    if (d.id !== id)
      throw new Error("This draft has been replaced. Reopen New mission.");
    if (mutable && ["creating", "created", "uncertain"].includes(d.status))
      throw new Error(
        "This brief is frozen for creation. Return to My missions to inspect the result.",
      );
    return d;
  }
  view(d) {
    const { review, creation, ...visible } = d;
    return visible;
  }
  async current() {
    let d = this.read();
    if (d.status === "uncertain" && !this.creating && d.creation) {
      const state = await this.node.state();
      const matches = state.missions.filter(
        (m) =>
          !d.creation.before.includes(m.id) &&
          m.owner === state.identity?.owner &&
          same(m.definition, d.review.definition),
      );
      if (matches.length === 1) {
        d.mission = matches[0].id;
        d.status = "created";
        d.error = null;
        this.save(d);
      }
    }
    return this.view(d);
  }
  async handle(method, input = {}) {
    const request = DraftRequests[method]?.parse(input);
    if (!request) throw new Error("Unknown drafting operation.");
    if (method === "current") return this.current();
    if (method === "runtimes") return this.runtime.list();
    return this[method](request);
  }
  edit({ id, changes }) {
    const d = this.require(id);
    d.revision++;
    d.review = null;
    for (const [field, value] of Object.entries(changes)) {
      if (briefFields.includes(field)) {
        d.brief[field] = value;
        d.fieldRevisions[field] = d.revision;
        d.conflicts = d.conflicts.filter((p) => p.field !== field);
      } else if (field === "listInputs") Object.assign(d.listInputs, value);
      else d[field] = value;
    }
    return this.view(this.save(d));
  }
  async send({ id, text }) {
    if (this.active)
      throw new Error(
        "Wait for this reply or stop it before sending another message.",
      );
    const d = this.require(id);
    if (d.conflicts.length)
      throw new Error(
        "Review the suggested changes before continuing the conversation.",
      );
    if (d.messages.length >= 78)
      throw new Error(
        "This conversation is full. You can still edit and create the saved brief.",
      );
    this.commitListInputs(d);
    const base = structuredClone(d);
    d.messages.push({
      id: randomUUID(),
      role: "user",
      text,
      at: Date.now(),
      runtime: d.runtime,
    });
    d.composer = "";
    d.mode = "assisted";
    d.status = "thinking";
    d.error = null;
    d.review = null;
    this.save(d); // Persist the user's intent before checking login or starting a process.
    const controller = new AbortController();
    const job = { controller, id, done: null };
    this.active = job;
    job.done = Promise.resolve()
      .then(() =>
        this.runtime.run({
          draft: structuredClone(d),
          signal: controller.signal,
        }),
      )
      .then((output) => {
        if (controller.signal.aborted || this.active !== job) return;
        const result = Response.parse(output);
        const next = this.require(id);
        const before = {},
          after = {};
        next.revision++;
        for (const field of briefFields) {
          const value = result.patch[field];
          if (value === null || same(value, next.brief[field])) continue;
          if (next.fieldRevisions[field] !== base.fieldRevisions[field]) {
            next.conflicts.push({ field, value });
          } else {
            before[field] = next.brief[field];
            after[field] = value;
            next.brief[field] = value;
            next.fieldRevisions[field] = next.revision;
          }
        }
        if (Object.keys(after).length)
          next.changes = [
            ...next.changes,
            {
              id: randomUUID(),
              at: Date.now(),
              revision: next.revision,
              undone: false,
              fields: Object.keys(after),
              before,
              after,
            },
          ].slice(-16);
        next.messages.push({
          id: randomUUID(),
          role: "assistant",
          text: result.reply,
          at: Date.now(),
          runtime: d.runtime,
        });
        next.question = result.question;
        next.assessment = { ...result.assessment, revision: next.revision };
        next.status = "idle";
        next.error = null;
        next.review = null;
        this.save(next);
      })
      .catch((error) => {
        if (this.active !== job) return;
        const next = this.read();
        if (
          next.id !== id ||
          ["creating", "created", "uncertain"].includes(next.status)
        )
          return;
        next.status = controller.signal.aborted ? "stopped" : "error";
        next.error =
          error.name === "ZodError"
            ? "The helper returned an invalid brief. Your existing work is safe. Ask it to try again, switch runtime, or edit manually."
            : error.publicMessage ||
              "The drafting runtime could not finish. Check its sign-in or subscription allowance, then send a message to continue. Your draft is saved.";
        this.save(next);
      })
      .finally(() => {
        if (this.active === job) this.active = null;
      });
    return this.view(d);
  }
  async stop({ id }) {
    this.require(id);
    if (this.active?.id === id) {
      this.active.controller.abort();
      await this.active.done;
    }
    const d = this.require(id);
    d.status = "stopped";
    d.error = "Stopped. Your brief and conversation are saved.";
    return this.view(this.save(d));
  }
  undo({ id, change }) {
    const d = this.require(id);
    const entry = d.changes.find((c) => c.id === change && !c.undone);
    if (!entry) throw new Error("This change is no longer available to undo.");
    const fields = entry.fields.filter(
      (f) =>
        d.fieldRevisions[f] === entry.revision &&
        same(d.brief[f], entry.after[f]),
    );
    if (!fields.length)
      throw new Error(
        "These fields have changed since that suggestion. Your newer edits have been kept.",
      );
    d.revision++;
    for (const field of fields) {
      d.brief[field] = entry.before[field];
      d.fieldRevisions[field] = d.revision;
    }
    entry.undone = true;
    d.review = null;
    return this.view(this.save(d));
  }
  resolve({ id, field, accept }) {
    const d = this.require(id);
    const p = d.conflicts.find((c) => c.field === field);
    if (!p) throw new Error("This suggestion has already been resolved.");
    d.conflicts = d.conflicts.filter((c) => c.field !== field);
    d.revision++;
    if (accept) {
      Brief.shape[field].parse(p.value);
      d.changes = [
        ...d.changes,
        {
          id: randomUUID(),
          at: Date.now(),
          revision: d.revision,
          undone: false,
          fields: [field],
          before: { [field]: d.brief[field] },
          after: { [field]: p.value },
        },
      ].slice(-16);
      d.brief[field] = p.value;
      d.fieldRevisions[field] = d.revision;
    }
    d.review = null;
    return this.view(this.save(d));
  }
  review({ id }) {
    const d = this.require(id);
    if (this.active || d.conflicts.length)
      throw new Error(
        "Finish or stop the reply and review suggested changes first.",
      );
    this.commitListInputs(d);
    const ready = briefReadiness(d.brief, d.policy);
    if (!ready.valid) throw new Error(ready.errors.join(" "));
    const definition = NodeRequests.createMission.shape.definition.parse(
      draftDefinition(d.brief, d.policy),
    );
    d.review = {
      id: randomUUID(),
      draft: id,
      revision: d.revision,
      definition,
      assumptions: d.brief.assumptions.map((s) => s.trim()).filter(Boolean),
      openQuestions: d.brief.openQuestions.map((s) => s.trim()).filter(Boolean),
    };
    this.save(d);
    return d.review;
  }
  commitListInputs(d) {
    for (const [field, input] of Object.entries(d.listInputs)) {
      if (!input.trim()) continue;
      const value = Brief.shape[field].parse([...d.brief[field], input.trim()]);
      d.revision++;
      d.brief[field] = value;
      d.fieldRevisions[field] = d.revision;
      d.listInputs[field] = "";
    }
  }
  async create({ id, review, acknowledgeOpenDecisions }) {
    const d = this.require(id, { mutable: false });
    if (d.status === "created") return this.view(d);
    if (
      this.creating ||
      this.active ||
      ["creating", "uncertain"].includes(d.status)
    )
      throw new Error(
        "Creation is already in progress or needs recovery. Check My missions before trying again.",
      );
    if (!d.review || d.review.id !== review || d.review.revision !== d.revision)
      throw new Error(
        "The brief changed. Review it again before creating the mission.",
      );
    if (
      (d.review.assumptions.length || d.review.openQuestions.length) &&
      !acknowledgeOpenDecisions
    )
      throw new Error(
        "Acknowledge the working assumptions and open questions first.",
      );
    d.status = "creating";
    d.error = null;
    this.save(d);
    this.creating = id;
    try {
      let state = await this.node.state();
      if (state.status === "not_enrolled") {
        await this.node.handle("enroll", {});
        state = await this.node.state();
      }
      d.creation = { before: state.missions.map((m) => m.id) };
      this.save(d);
      const result = await this.node.handle("createMission", {
        definition: d.review.definition,
      });
      d.mission = result.mission;
      d.status = "created";
      d.error = null;
      return this.view(this.save(d));
    } catch (error) {
      d.status = d.creation ? "uncertain" : "error";
      d.error = d.creation
        ? "The creation result is uncertain. Check My missions before making another draft; this request will not be sent twice."
        : "The mission could not be created. Your reviewed brief is saved. Check node identity access and try again.";
      this.save(d);
      throw new Error(d.error);
    } finally {
      this.creating = null;
    }
  }
  async discard({ id }) {
    const d = this.require(id, { mutable: false });
    if (this.creating) throw new Error("Wait for mission creation to finish.");
    if (this.active) await this.stop({ id });
    return this.view(this.save(fresh(d.runtime)));
  }
  async close() {
    if (this.active) {
      this.active.controller.abort();
      await this.active.done;
    }
  }
}
