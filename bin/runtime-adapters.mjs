import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import runtimes from "../shared/runtimes.json" with { type: "json" };

const exec = promisify(execFile);
const grokBridge = fileURLToPath(new URL("./grok-acp.mjs", import.meta.url));
const errorEvent = (event) =>
  event.type === "error" || event.type === "turn.failed" || event.is_error
    ? {
        error: String(
          event.message ||
            event.error?.message ||
            event.result ||
            "Runtime turn failed",
        ),
      }
    : {};

export const adapters = {
  claude: {
    checks: (mode) =>
      mode === "full"
        ? [
            {
              args: ["--help"],
              flags: ["--dangerously-skip-permissions", "--settings"],
            },
          ]
        : [],
    arguments(s, file, prompt, mcp, mode) {
      const args = [
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--strict-mcp-config",
        "--mcp-config",
        JSON.stringify({
          mcpServers: {
            harakiri: { command: process.execPath, args: [mcp, file] },
          },
        }),
        "--allowedTools",
        "mcp__harakiri__*",
      ];
      if (mode === "full")
        args.push(
          "--dangerously-skip-permissions",
          "--settings",
          JSON.stringify({ sandbox: { enabled: false } }),
        );
      if (mode === "board-only") args.push("--tools", "");
      if (
        mode === "default" &&
        s.execution?.shared &&
        s.execution.shared !== s.cwd
      )
        args.push("--add-dir", s.execution.shared);
      if (s.nativeSession) args.push("--resume", s.nativeSession);
      args.push("--", prompt);
      return { command: "claude", args, input: "" };
    },
    event: (event) => ({
      ...errorEvent(event),
      ...(event.type === "system" && event.session_id
        ? { sessionId: event.session_id }
        : {}),
    }),
  },
  codex: {
    checks: (mode) =>
      mode === "full"
        ? [
            ["exec", "--help"],
            ["exec", "resume", "--help"],
          ].map((args) => ({
            args,
            flags: ["--dangerously-bypass-approvals-and-sandbox"],
          }))
        : [],
    arguments(s, file, prompt, mcp, mode) {
      const args = ["exec"];
      if (s.nativeSession) args.push("resume");
      args.push(
        "--json",
        "--skip-git-repo-check",
        "-c",
        'approval_policy="never"',
      );
      if (mode === "full")
        args.push("--dangerously-bypass-approvals-and-sandbox");
      else
        args.push(
          "-c",
          `sandbox_mode=${JSON.stringify(mode === "board-only" ? "read-only" : "workspace-write")}`,
        );
      args.push(
        "-c",
        `mcp_servers.harakiri.command=${JSON.stringify(process.execPath)}`,
        "-c",
        `mcp_servers.harakiri.args=${JSON.stringify([mcp, file])}`,
        "-c",
        "mcp_servers.harakiri.required=true",
        "-c",
        'mcp_servers.harakiri.default_tools_approval_mode="approve"',
      );
      // In the restricted mode the shared output folder is writable on both exec and resume.
      if (
        mode === "default" &&
        s.execution?.shared &&
        s.execution.shared !== s.cwd
      )
        args.push(
          "-c",
          `sandbox_workspace_write.writable_roots=${JSON.stringify([s.execution.shared])}`,
        );
      if (s.nativeSession) args.push(s.nativeSession);
      args.push("-");
      return { command: "codex", args, input: prompt };
    },
    event: (event) => ({
      ...errorEvent(event),
      ...(event.type === "thread.started"
        ? { sessionId: event.thread_id }
        : {}),
    }),
  },
  grok: {
    versionArgs: ["--no-auto-update", "--version"],
    checks: () => [
      {
        args: ["--no-auto-update", "agent", "--help"],
        flags: ["--no-leader", "--always-approve"],
      },
    ],
    validate(mode) {
      if (mode === "board-only")
        throw new Error(
          "Grok Build does not yet support --board-only. Use its default permissions in a disposable workspace for integration checks.",
        );
    },
    preflight: (run) => run(process.execPath, [grokBridge, "--check"], 45000),
    arguments(s, file, prompt, mcp, mode) {
      return {
        command: process.execPath,
        args: [grokBridge],
        input: JSON.stringify({
          cwd: s.cwd,
          shared: s.execution?.shared,
          nativeSession: s.nativeSession,
          permissions: mode,
          file,
          mcp,
          prompt,
        }),
      };
    },
    event: (event) => ({
      ...errorEvent(event),
      ...(event.type === "session.started"
        ? { sessionId: event.sessionId }
        : {}),
    }),
  },
};

function adapter(runtime) {
  if (!Object.hasOwn(runtimes, runtime) || !Object.hasOwn(adapters, runtime))
    throw new Error(`Runtime must be ${Object.keys(runtimes).join(", ")}`);
  return adapters[runtime];
}

export async function preflightRuntime(runtime, permissions, cwd) {
  const spec = adapter(runtime);
  // Validate unsupported modes before registration, including for waiting agents.
  spec.validate?.(permissions);
  async function run(command, args, timeout = 10000) {
    try {
      const { stdout, stderr } = await exec(command, args, {
        cwd,
        timeout,
        maxBuffer: 2 * 1024 * 1024,
      });
      return stdout + stderr;
    } catch (error) {
      if (command === process.execPath && error.stderr)
        throw new Error(error.stderr.trim().slice(-2000));
      throw new Error(
        `Cannot run ${runtime} ${args.join(" ")}: ${error.code === "ENOENT" ? "CLI not found on PATH. Install it on the launcher machine." : "CLI preflight failed. Check the installed runtime."}`,
      );
    }
  }
  const version = (await run(runtime, spec.versionArgs || ["--version"]))
    .trim()
    .slice(0, 160);
  for (const { args, flags } of spec.checks(permissions)) {
    const help = await run(runtime, args);
    if (flags.some((flag) => !help.includes(flag)))
      throw new Error(
        `${runtime} does not support the requested ${permissions === "full" ? "full-access configuration" : "runtime integration"}. Update the CLI; no agents were started with reduced permissions.`,
      );
  }
  await spec.preflight?.(run);
  return version;
}

export function runtimeArguments(s, file, prompt, mcp) {
  const mode =
    s.execution?.permissions || (s.boardOnly ? "board-only" : "default");
  if (
    !["default", "full", "board-only"].includes(mode) ||
    (s.boardOnly && mode === "full")
  )
    throw new Error(
      "Invalid saved permission mode. Full access cannot be used with board-only sessions.",
    );
  const spec = adapter(s.runtime);
  spec.validate?.(mode);
  return spec.arguments(s, file, prompt, mcp, mode);
}

export function runtimeEvent(runtime, event) {
  return adapter(runtime).event(event);
}
