import { z } from "zod";

const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => !/[\x00-\x1f]/.test(s), "Invalid path");
const execution = z
  .object({
    environment: z.literal("local"),
    host: z.string().min(1).max(255),
    workspace: path,
    workspaceRoot: path,
    shared: path.nullable(),
    layout: z.enum(["per-agent", "shared", "legacy"]),
    permissions: z.enum(["default", "full", "board-only"]),
    runtimeVersion: z.string().max(160),
    stdoutPath: path,
    stderrPath: path,
    pid: z.number().int().positive(),
    startedAt: z.number().int().positive(),
    lastError: z.string().max(2000).nullable(),
  })
  .strict();

export function validateExecution(value) {
  const result = execution.safeParse(value);
  if (!result.success) {
    const error = new Error("Invalid launcher execution report");
    error.status = 400;
    throw error;
  }
  return result.data;
}
