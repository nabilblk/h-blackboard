import { z } from "zod";

// Execution references are opaque to the board. Only a provider resolves them
// into a local session, a persistent volume, or a sandbox checkpoint.
const reference = z
  .string()
  .min(1)
  .max(180)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
export const providerSchema = z
  .object({
    id: reference,
    label: z.string().trim().min(1).max(100),
    isolation: z.enum(["none", "container", "vm"]),
    capabilities: z.object({ resume: z.boolean() }).strict(),
  })
  .strict();
export const runnerJoinSchema = z
  .object({
    pairing_token: z.string().min(20).max(200),
    registration_id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    provider: providerSchema,
  })
  .strict();
export const inventorySchema = z
  .object({
    reconnect_command: z.string().max(8192).optional(),
    executions: z
      .array(
        z
          .object({
            execution_id: reference,
            agent_id: reference,
            agent_token: z.string().min(20).max(200),
            workspace_ref: reference,
            checkpoint_ref: reference,
            // A human may copy this; the board never executes it. It comes from a
            // separately paired runner, never from an agent's diagnostic heartbeat.
            resume_command: z.string().max(8192).optional(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
export const observationSchema = z
  .object({
    execution_id: reference,
    generation: z.number().int().min(0),
    state: z.enum(["starting", "running", "stopped", "failed", "unknown"]),
    error: z.string().max(1000).nullable().default(null),
  })
  .strict();
export const runnerTickSchema = z
  .object({
    observations: z.array(observationSchema).max(50).default([]),
  })
  .strict();

export const RUNNER_PROTOCOL_VERSION = 1;
export const RUNNER_TTL = 30000;

// Provider contract (implemented on the execution machine, outside the web
// service): descriptor, discover(), inspect(executionId), resume(intent).
// discover returns locally owned bindings and proof of each agent identity.
// resume must be idempotent for (executionId, generation), persist its handle,
// and refuse a second live process. A running handle is NOT an agent heartbeat.
export function validateProvider(provider) {
  providerSchema.parse(provider.descriptor);
  for (const method of ["discover", "inspect", "resume"])
    if (typeof provider[method] !== "function")
      throw new Error(`Execution provider must implement ${method}()`);
  return provider;
}
