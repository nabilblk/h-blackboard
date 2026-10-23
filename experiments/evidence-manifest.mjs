// Experiment metadata, not a mission/runtime policy. Keep manifests and raw
// traces local; only deliberately reviewed evidence should be published.
import { z } from "zod";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, lstatSync } from "node:fs";
import { resolve, sep } from "node:path";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const label = z.string().min(1).max(200);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const ExperimentManifest = z
  .object({
    schema: z.literal(1),
    run: z.string().uuid(),
    startedAt: z.string().datetime(),
    kind: z.enum(["protocol_rehearsal", "live_agents"]),
    code: z
      .object({
        commit: z.string().regex(/^[a-f0-9]{40,64}$/),
        dirty: z.boolean(),
        sourceSha256: digest,
      })
      .strict(),
    versions: z
      .object({
        app: label,
        protocol: z.number().int().positive(),
        schema: z.number().int().positive(),
        host: label,
        toolsSha256: digest,
      })
      .strict(),
    topology: z
      .object({
        computers: z.number().int().positive(),
        operators: z.number().int().positive(),
        nodes: z.number().int().positive(),
        agents: z
          .array(
            z
              .object({
                alias: label,
                node: label,
                role: z.enum(["coordinator", "agent"]),
                harness: label.nullable(),
                model: label.nullable(),
              })
              .strict(),
          )
          .min(1)
          .max(1000),
      })
      .strict(),
    policies: z
      .object({
        transport: z.enum(["disabled", "direct", "relay", "mixed"]),
        workspace: z.enum(["restricted", "internet"]),
        permissionSha256: digest,
        budget: z.enum(["unlimited", "limited"]),
      })
      .strict(),
    inputs: z
      .array(z.object({ name: label, sha256: digest }).strict())
      .min(1)
      .max(256),
    acceptance: z.array(z.string().min(1).max(1000)).min(1).max(64),
    evidence: z
      .object({
        timeline: z.literal("timeline.jsonl"),
        artifactIds: z.literal("exact-revision"),
        interventions: z.literal("record-every-operator-action"),
        usage: z.literal("native-counters-or-unknown"),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const agents = value.topology.agents;
    if (new Set(agents.map((a) => a.alias)).size !== agents.length)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Agent aliases must be unique",
      });
    if (new Set(agents.map((a) => a.node)).size > value.topology.nodes)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Agent topology exceeds the declared nodes",
      });
    if (agents.filter((a) => a.role === "coordinator").length > 1)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At most one initial Coordinator per mission",
      });
    if (
      value.kind === "live_agents" &&
      agents.some((a) => !a.harness || !a.model)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Live runs require observed harness and model versions",
      });
    if (new Set(value.inputs.map((i) => i.name)).size !== value.inputs.length)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Input names must be unique",
      });
  });

export function fingerprintFiles(root, names) {
  const files = [...new Set(names)].sort();
  return sha256(
    JSON.stringify(
      files.map((name) => {
        if (
          !name ||
          name.startsWith("/") ||
          name
            .split(/[\\/]/)
            .some((part) => !part || part === ".." || part === ".")
        )
          throw new Error("Use explicit relative input paths");
        let path = resolve(root);
        for (const part of name.split("/")) {
          path += sep + part;
          if (lstatSync(path).isSymbolicLink())
            throw new Error("Input paths cannot contain symbolic links");
        }
        if (!lstatSync(path).isFile())
          throw new Error("Inputs must be regular files");
        return { name, sha256: sha256(readFileSync(path)) };
      }),
    ),
  );
}

export function sourceSnapshot(root = process.cwd()) {
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  const names = git(
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  )
    .split("\0")
    .filter(Boolean);
  // Deleted files remain represented by the commit + dirty flag; remaining
  // source files include untracked implementation, unlike `git diff` alone.
  const deleted = new Set(git("ls-files", "--deleted", "-z").split("\0"));
  return {
    commit: git("rev-parse", "HEAD").trim(),
    dirty: !!git("status", "--porcelain").trim(),
    sourceSha256: fingerprintFiles(
      root,
      names.filter((n) => !deleted.has(n)),
    ),
  };
}
