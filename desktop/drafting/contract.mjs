import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { NodeRequests } from "../node-service.mjs";
const text = (max) =>
  z
    .string()
    .max(max)
    .regex(/^[^\0]*$/);
const list = z.array(text(1024)).max(16);
const listInputs = z
  .object({
    deliverables: text(1024),
    criteria: text(1024),
    assumptions: text(1024),
    openQuestions: text(1024),
  })
  .strict();
export const Brief = z
  .object({
    name: text(120),
    objective: text(4096),
    scope: text(8192),
    deliverables: list,
    criteria: z.array(text(1024)).max(32),
    assumptions: list,
    openQuestions: list,
  })
  .strict();
export const Field = Brief.keyof();
export const Runtime = z.enum(["claude", "codex", "grok"]);
const id = z.string().uuid();
const policy = NodeRequests.createMission.shape.definition.shape.policy;
export const Edit = Brief.partial()
  .extend({
    idea: text(8192).optional(),
    composer: text(8192).optional(),
    listInputs: listInputs.partial().optional(),
    mode: z.enum(["choice", "assisted", "manual"]).optional(),
    runtime: Runtime.optional(),
    policy: policy.optional(),
  })
  .strict();
export const Response = z
  .object({
    reply: text(6000).min(1),
    patch: z
      .object(
        Object.fromEntries(
          Object.entries(Brief.shape).map(([k, v]) => [k, v.nullable()]),
        ),
      )
      .strict(),
    question: z
      .object({
        text: text(1000).min(1),
        choices: z.array(text(240).min(1)).max(3),
      })
      .strict()
      .nullable(),
    assessment: z.object({ ready: z.boolean(), reason: text(1500) }).strict(),
  })
  .strict();
export const responseSchema = zodToJsonSchema(Response, {
  $refStrategy: "none",
});
const partial = Brief.partial();
export const Draft = z
  .object({
    version: z.literal(1),
    id,
    revision: z.number().int().nonnegative(),
    updatedAt: z.number(),
    mode: z.enum(["choice", "manual", "assisted"]),
    runtime: Runtime,
    idea: text(8192),
    composer: text(8192),
    listInputs: listInputs.default({
      deliverables: "",
      criteria: "",
      assumptions: "",
      openQuestions: "",
    }),
    brief: Brief,
    policy,
    fieldRevisions: z
      .object(
        Object.fromEntries(
          Object.keys(Brief.shape).map((k) => [k, z.number()]),
        ),
      )
      .strict(),
    messages: z
      .array(
        z
          .object({
            id,
            role: z.enum(["user", "assistant"]),
            text: text(8192),
            at: z.number(),
            runtime: Runtime,
          })
          .strict(),
      )
      .max(80),
    question: Response.shape.question,
    assessment: Response.shape.assessment
      .extend({ revision: z.number() })
      .nullable(),
    changes: z
      .array(
        z
          .object({
            id,
            at: z.number(),
            revision: z.number(),
            undone: z.boolean(),
            fields: z.array(Field),
            before: partial,
            after: partial,
          })
          .strict(),
      )
      .max(16),
    conflicts: z
      .array(
        z
          .object({
            field: Field,
            value: z.union([text(8192), list, Brief.shape.criteria]),
          })
          .strict(),
      )
      .max(7),
    status: z.enum([
      "idle",
      "thinking",
      "stopped",
      "error",
      "creating",
      "created",
      "uncertain",
    ]),
    error: text(2000).nullable(),
    mission: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    review: z
      .object({
        id,
        draft: id,
        revision: z.number(),
        definition: NodeRequests.createMission.shape.definition,
        assumptions: list,
        openQuestions: list,
      })
      .strict()
      .nullable(),
    creation: z
      .object({ before: z.array(z.string()).max(10000) })
      .strict()
      .nullable(),
  })
  .strict();
export const DraftRequests = {
  signIn: z.object({}).strict(),
  openLogin: z.object({}).strict(),
  cancelLogin: z.object({}).strict(),
  current: z.object({}).strict(),
  runtimes: z.object({}).strict(),
  edit: z.object({ id, changes: Edit }).strict(),
  send: z.object({ id, text: text(8192).trim().min(1) }).strict(),
  stop: z.object({ id }).strict(),
  undo: z.object({ id, change: id }).strict(),
  resolve: z.object({ id, field: Field, accept: z.boolean() }).strict(),
  review: z.object({ id }).strict(),
  create: z
    .object({ id, review: id, acknowledgeOpenDecisions: z.boolean() })
    .strict(),
  discard: z.object({ id }).strict(),
};
