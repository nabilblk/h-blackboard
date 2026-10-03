import { z } from "zod";
const id = z.string().regex(/^[a-f0-9]{64}$/);
const text = (max) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((s) => Buffer.byteLength(s) <= max && !s.includes("\0"));
const refs = (max) =>
  z
    .array(id)
    .max(max)
    .refine((a) => new Set(a).size === a.length);
const positive = z.number().int().positive().max(0xffffffff);
export const criterion = {
  index: z.number().int().min(0).max(31),
  wording: text(1024),
  met: z.boolean(),
  summary: text(4096),
  evidence: z.array(id).max(32),
};
// Consent and usage are host capabilities. The renderer cannot fabricate them.
export const governAction = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("allocate"),
      node: id,
      turns: positive.nullable(),
      slots: positive.max(1024),
    })
    .strict(),
  z.object({ type: z.literal("reclaim"), seal: id }).strict(),
  z
    .object({
      type: z.literal("grant"),
      previous: id.nullable(),
      allocation: id,
      registration: id,
      direction: id,
      execution: id,
      generation: positive,
      turns: positive,
      expires_ms: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      offline_ms: positive.max(86400000),
    })
    .strict(),
  z
    .object({ type: z.literal("retire_grant"), grant: id, reason: text(2048) })
    .strict(),
  z
    .object({ type: z.literal("resolve"), reservation: id, reason: text(2048) })
    .strict(),
  z
    .object({
      type: z.literal("seal_grant"),
      grant: id,
      settlements: refs(512),
    })
    .strict(),
  z
    .object({
      type: z.literal("seal_allocation"),
      allocation: id,
      grants: refs(256),
    })
    .strict(),
  z.object({ type: z.literal("criterion"), ...criterion }).strict(),
]);
const missionAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_plan_artifact"), revision: id }).strict(),
  z.object({ type: z.literal("close"), reason: text(2048) }).strict(),
  z.object({ type: z.literal("archive"), reason: text(2048) }).strict(),
  z.object({ type: z.literal("restore") }).strict(),
  z
    .object({
      type: z.literal("handover"),
      registration: id,
      coordinator: z
        .object({
          author: id,
          label: text(120),
          runtime: z.enum(["claude", "codex", "grok"]),
        })
        .strict(),
      settlements: z.array(id).max(512),
    })
    .strict(),
]);
export const GovernanceRequests = {
  consentGrant: z
    .object({
      mission: id,
      grant: id,
      contributionId: z.string().min(1).max(80),
    })
    .strict(),
  governance: z.object({ mission: id }).strict(),
  govern: z.object({ mission: id, control: id, action: governAction }).strict(),
  missionAction: z
    .object({ mission: id, revision: id, action: missionAction })
    .strict(),
  privateRecovery: z
    .object({
      mission: id,
      audience: z.string().regex(/^private:[a-f0-9]{64}$/),
    })
    .strict(),
  reconcilePrivate: z
    .object({
      mission: id,
      audience: z.string().regex(/^private:[a-f0-9]{64}$/),
      member: id,
      revocation: id,
      accepted: id.nullable(),
    })
    .strict(),
};
export const GovernanceAgentOperations = [
  z.object({ type: z.literal("governance") }).strict(),
  z
    .object({ type: z.literal("criterion"), control: id, ...criterion })
    .strict(),
  z
    .object({ type: z.literal("plan_artifact"), control: id, revision: id })
    .strict(),
];
