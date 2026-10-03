import { z } from "zod";

export const DESKTOP_ORIGIN = "harakiri://desktop";
export const REVIEW_TTL_MS = 10 * 60 * 1000;
export const Runtime = z.enum(["claude", "codex", "grok"]);
export const Id = z.string().uuid();
const Timestamp = z.string().datetime();
const Label = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(
    (value) =>
      !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value),
    "Unsupported control characters",
  );

// Local limits belong to a contributor. They are never read from a mission's
// instructions or from a coordinator's suggested launch configuration.
export const Limits = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("bounded"),
      concurrency: z.number().int().min(1).max(32),
      turns: z.number().int().min(1).max(10000),
      minutes: z.number().int().min(1).max(10080),
    })
    .strict(),
  z
    .object({
      mode: z.literal("unlimited"),
      concurrency: z.number().int().min(1).max(32),
    })
    .strict(),
]);

export const MissionPreview = z
  .object({
    origin: z.string().url().max(2048),
    missionId: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/),
    name: Label,
    role: z.enum(["coordinator", "agent"]),
    inspectedAt: Timestamp,
  })
  .strict();

export const Contribution = z
  .object({
    id: Id,
    contributorId: Id,
    deviceId: Id,
    mission: MissionPreview,
    nodeBinding: z
      .object({
        owner: z.string().regex(/^[a-f0-9]{64}$/),
        revision: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    runtime: Runtime,
    sharedAgent: z
      .object({
        registration: z.string().regex(/^[a-f0-9]{64}$/),
        author: z.string().regex(/^[a-f0-9]{64}$/),
        label: Label,
        withdrawn: z.boolean(),
      })
      .strict()
      .optional(),
    limits: Limits,
    workspace: z.string().min(1).max(4096),
    workspaceIdentity: z
      .object({
        device: z.string(),
        inode: z.string(),
      })
      .strict(),
    status: z.enum(["prepared", "revoked"]),
    createdAt: Timestamp,
    revokedAt: Timestamp.nullable(),
  })
  .strict();

export const Activity = z
  .object({
    id: Id,
    at: Timestamp,
    type: z.enum([
      "contributor_named",
      "contribution_prepared",
      "consent_revoked",
    ]),
    contributionId: Id.nullable(),
    label: Label,
  })
  .strict();

export const State = z
  .object({
    schemaVersion: z.literal(1),
    contributor: z.object({ id: Id, name: Label }).strict(),
    device: z.object({ id: Id, name: Label }).strict(),
    contributions: z.array(Contribution).max(500),
    activity: z.array(Activity).max(1000),
  })
  .strict();

export const Requests = {
  state: z.object({}).strict(),
  inspect: z.object({ invitation: z.string().min(1).max(4096) }).strict(),
  chooseWorkspace: z.object({}).strict(),
  prepare: z
    .object({
      reviewId: Id,
      workspaceChoiceId: Id,
      runtime: Runtime,
      limits: Limits,
    })
    .strict(),
  revoke: z.object({ contributionId: Id }).strict(),
  reveal: z.object({ contributionId: Id }).strict(),
  rename: z.object({ name: Label }).strict(),
};

// Preparation alone is not execution authority. The separate provider-v2
// manager verifies the environment, guest login and current signed permission.
// Never fall back to the unrestricted web launcher.
export function executionReadiness(contribution) {
  const blockers = [];
  if (contribution.status === "revoked")
    blockers.push({
      code: "consent_revoked",
      message: "Your local consent is revoked.",
    });
  if (!contribution.nodeBinding)
    blockers.push({
      code: "contributor_identity",
      message:
        "This board invitation does not authenticate a contributor or device.",
    });
  blockers.push({
    code: "isolated_execution",
    message:
      "Prepare an isolated environment, sign in inside it and approve a current permission before running.",
  });
  return { allowed: false, blockers };
}
