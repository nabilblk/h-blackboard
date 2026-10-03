import { z } from "zod";
const id = z.string().regex(/^[a-f0-9]{64}$/);
const text = (max, min = 1) =>
  z
    .string()
    .min(min)
    .refine((s) => Buffer.byteLength(s) <= max && !s.includes("\0"));
const conversation = z
  .string()
  .regex(/^(main|(?:private|workstream):[a-f0-9]{64})$/);
const ids = (max) =>
  z
    .array(id)
    .max(max)
    .refine((a) => new Set(a).size === a.length);
const path = text(240).refine(
  (s) =>
    !/[\\\x00-\x1f\x7f]/.test(s) &&
    s.split("/").every((p) => p && p !== "." && p !== ".." && !p.includes(":")),
);
const query = z
  .object({
    after: id.nullable().optional(),
    conversation: conversation.nullable().optional(),
    search: text(512, 0).nullable().optional(),
  })
  .strict();
const document = z
  .object({
    title: text(240),
    summary: text(2048),
    kind: z.enum(["plan", "report", "application", "data", "code", "document"]),
    stage: z.enum(["draft", "complete"]),
    limitations: text(4096, 0),
    entrypoint: path.nullable(),
    inputs: ids(16),
    files: z.array(z.never()).max(0),
  })
  .strict();
const action = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("review"),
      revision: id,
      verdict: z.enum(["verified", "changes_requested", "inconclusive"]),
      summary: text(4096),
      conditions: text(4096),
      evidence: ids(16),
    })
    .strict(),
  z
    .object({
      type: z.literal("accept"),
      revision: id,
      accepted: z.boolean(),
      reason: text(2048),
    })
    .strict(),
  z
    .object({
      type: z.literal("highlight"),
      revision: id,
      highlighted: z.boolean(),
    })
    .strict(),
]);
export const artifactTransfer = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("begin"),
      control: id,
      conversation,
      path,
      media_type: text(100),
      size: z
        .number()
        .int()
        .min(0)
        .max(16 * 1024 * 1024),
    })
    .strict(),
  z
    .object({
      type: z.literal("chunk"),
      upload: id,
      offset: z
        .number()
        .int()
        .min(0)
        .max(16 * 1024 * 1024),
      hex: z
        .string()
        .max(96 * 1024)
        .regex(/^(?:[a-f0-9]{2})*$/),
    })
    .strict(),
  z.object({ type: z.literal("cancel"), upload: id }).strict(),
  z
    .object({
      type: z.literal("publish"),
      control: id,
      conversation,
      artifact: id.nullable(),
      parents: ids(256),
      document,
      uploads: ids(32),
      retain: z.array(z.object({ revision: id, path }).strict()).max(32),
    })
    .strict(),
  z
    .object({
      type: z.literal("read"),
      revision: id,
      path,
      offset: z
        .number()
        .int()
        .min(0)
        .max(16 * 1024 * 1024),
    })
    .strict(),
]);
export const ArtifactRequests = {
  artifacts: z.object({ mission: id, query }).strict(),
  artifactDetail: z.object({ mission: id, revision: id }).strict(),
  copyArtifactReference: z.object({ mission: id, revision: id }).strict(),
  artifactAction: z
    .object({ mission: id, control: id, conversation, action })
    .strict(),
  artifactTransfer: z
    .object({ mission: id, transfer: artifactTransfer })
    .strict(),
  artifactOpen: z.object({ mission: id, revision: id, path }).strict(),
  artifactSave: z.object({ mission: id, revision: id, path }).strict(),
};
export const ArtifactAgentOperations = [
  z.object({ type: z.literal("artifacts"), query }).strict(),
  z.object({ type: z.literal("artifact_detail"), revision: id }).strict(),
  z
    .object({
      type: z.literal("artifact_action"),
      control: id,
      conversation,
      action,
    })
    .strict(),
  z
    .object({
      type: z.literal("artifact_transfer"),
      transfer: artifactTransfer,
    })
    .strict(),
];
