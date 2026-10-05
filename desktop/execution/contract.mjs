import { createHash } from "node:crypto";
import { z } from "zod";
import { Id } from "../model.mjs";

// Separate from the trusted-local web runner's v1 protocol. That provider is
// deliberately not an implementation of this contract.
export const EXECUTION_PROVIDER_VERSION = 2;
export const POLICY = Object.freeze({
  version: 1,
  provider: "lima-vz",
  runtime: "grok",
  runtimeVersion: "1.0.46",
  runtimeSha256:
    "45b0943e736f00a249b9cf02af2be9e0749d97c09a6f55cfcf3029a1a836f23e",
  os: "ubuntu-24.04-arm64",
  imageRelease: "20260926",
  imageSha256:
    "1d6bffe64b848468ac97f821d369a4846d983de1800ccf6b5ec8853e85cefc55",
  cpus: 2,
  memoryMiB: 2048,
  diskGiB: 8,
  workspace: "/workspace",
  hostMounts: false,
  hostCredentials: false,
  workerNetwork: "none",
  runtimeNetwork: "provider-only",
  runtimeHosts: Object.freeze([
    "cli-chat-proxy.grok.com",
    "api.x.ai",
    "auth.x.ai",
    "accounts.x.ai",
    "grok.com",
  ]),
  credentials: "guest-native-login",
  nativeTools: false,
});
export const POLICY_DIGEST = createHash("sha256")
  .update(JSON.stringify(POLICY))
  .digest("hex");
// Keep the original Grok policy byte-for-byte stable: existing consent and
// journals remain valid. Each additional runtime has its own consent digest.
export const POLICIES = Object.freeze({
  grok: POLICY,
  claude: Object.freeze({
    ...POLICY,
    runtime: "claude",
    runtimeVersion: "2.1.284",
    runtimeSha256:
      "3dd0f96d7ada463152d20300186f6cfc6ab94b57e218f49e3ac86db42ac695a6",
    runtimeHosts: Object.freeze([
      "api.anthropic.com",
      "claude.ai",
      "platform.claude.com",
    ]),
  }),
  codex: Object.freeze({
    ...POLICY,
    runtime: "codex",
    runtimeVersion: "0.155.1",
    runtimeSha256:
      "d6c7e62fbd688d52ee04f3929d0613705d32a920a42db7a139e366eaf1f4a2d7",
    runtimeDistribution: "tar.gz",
    runtimeHosts: Object.freeze([
      "chatgpt.com",
      "api.openai.com",
      "auth.openai.com",
    ]),
  }),
});
export function runtimePolicy(runtime) {
  if (!Object.hasOwn(POLICIES, runtime))
    throw new Error("Unsupported isolated runtime.");
  return POLICIES[runtime];
}
export function policyDigest(runtime) {
  return createHash("sha256")
    .update(JSON.stringify(runtimePolicy(runtime)))
    .digest("hex");
}
export const POLICY_DIGESTS = Object.freeze(
  Object.fromEntries(
    Object.keys(POLICIES).map((runtime) => [runtime, policyDigest(runtime)]),
  ),
);
export const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const Session = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const ExecutionRequests = {
  executionOverview: z.object({ mission: Hash }).strict(),
  executionState: z.object({ contributionId: Id }).strict(),
  executionPrepare: z.object({ contributionId: Id }).strict(),
  executionLogin: z.object({ contributionId: Id }).strict(),
  executionCancelSetup: z.object({ contributionId: Id }).strict(),
  executionSignIn: z.object({ contributionId: Id }).strict(),
  executionLoginInput: z
    .object({
      contributionId: Id,
      text: z
        .string()
        .min(1)
        .max(4096)
        .regex(/^[^\r\n\x00]+$/),
    })
    .strict(),
  executionCancelLogin: z.object({ contributionId: Id }).strict(),
  executionOpenLogin: z
    .object({ contributionId: Id, url: z.string().url().max(8192) })
    .strict(),
  executionStart: z.object({ contributionId: Id, grant: Hash }).strict(),
  executionStop: z.object({ contributionId: Id }).strict(),
  executionExport: z.object({ contributionId: Id }).strict(),
  executionImport: z.object({ contributionId: Id }).strict(),
};

export const Record = z
  .object({
    schema: z.literal(1),
    contribution: Id,
    policy: z.enum(Object.values(POLICY_DIGESTS)),
    status: z.enum([
      "preparing",
      "login_required",
      "ready",
      "reserving",
      "launching",
      "running",
      "waiting",
      "stopping",
      "stopped",
      "recovery_required",
      "failed",
    ]),
    grant: Hash.nullable(),
    execution: Hash.nullable(),
    generation: z.number().int().positive().nullable(),
    nonce: Hash.nullable(),
    reservation: Hash.nullable(),
    session: Session.nullable(),
    // A launched turn is conservatively charged even if the harness crashes.
    dispatched: z.boolean(),
    receipt: Hash.nullable(),
    expiresAt: z.number().int().nonnegative().nullable(),
    updatedAt: z.number().int().nonnegative(),
    wake: z
      .object({
        fingerprint: Hash,
        seen: z.array(Hash).max(768),
        messages: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    reason: z.string().max(2048),
    transitions: z
      .array(
        z
          .object({
            at: z.number(),
            from: z.string(),
            to: z.string(),
            reason: z.string().max(2048),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    // Optional for journals created before interruption recovery was explicit.
    interruption: z
      .object({
        code: z.literal("direction_changed"),
        previous: Hash,
        current: Hash,
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export function newRecord(contribution, now = Date.now(), runtime = "grok") {
  return Record.parse({
    schema: 1,
    contribution,
    policy: policyDigest(runtime),
    status: "preparing",
    grant: null,
    execution: null,
    generation: null,
    nonce: null,
    reservation: null,
    session: null,
    dispatched: false,
    receipt: null,
    expiresAt: null,
    updatedAt: now,
    reason: "Preparing isolated environment.",
  });
}

export function validateProvider(provider) {
  if (
    provider?.version !== EXECUTION_PROVIDER_VERSION ||
    provider?.policy !== POLICY_DIGEST
  )
    throw new Error(
      "An enforcing provider with the reviewed policy is required.",
    );
  if (
    provider.policies &&
    Object.entries(provider.policies).some(
      ([runtime, digest]) =>
        !Object.hasOwn(POLICY_DIGESTS, runtime) ||
        POLICY_DIGESTS[runtime] !== digest,
    )
  )
    throw new Error(
      "Execution provider declares an unreviewed runtime policy.",
    );
  for (const method of [
    "prepare",
    "login",
    "launch",
    "inspect",
    "interrupt",
    "terminate",
    "checkpoint",
    "resume",
    "usage",
    "exportFiles",
    "importFiles",
  ])
    if (typeof provider[method] !== "function")
      throw new Error(`Execution provider is missing ${method}.`);
  return provider;
}

// A grant never receives a new offline window on reconnect, app restart or a
// later turn. The issuer's signed timestamp gives a conservative outer bound.
// Wall time chooses the initial bound; monotonic time enforces it thereafter.
export function permissionLease(
  grant,
  { wall = Date.now, mono = () => performance.now() } = {},
) {
  const deadline = Math.min(
    grant.expires_ms,
    grant.issued_ms + grant.offline_ms,
  );
  const remaining = deadline - wall();
  if (
    !Number.isSafeInteger(deadline) ||
    remaining <= 0 ||
    grant.issued_ms > wall() + 30_000 ||
    grant.sealed ||
    !grant.consent
  )
    throw new Error(
      "Permission expired or unavailable. Request a fresh permission.",
    );
  const started = mono();
  return Object.freeze({
    deadline,
    remaining: () =>
      Math.max(0, Math.min(deadline - wall(), remaining - (mono() - started))),
  });
}
