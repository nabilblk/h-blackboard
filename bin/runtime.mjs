import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { resolve, relative, isAbsolute, join } from "node:path";
import { mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const exec = promisify(execFile);
export const shellQuote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

export function localPath(value) {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f]/.test(value))
    throw new Error("Use a non-empty folder path without control characters.");
  if (value.startsWith("~") && value !== "~" && !value.startsWith("~/"))
    throw new Error("Use ~/ for your home folder, or an absolute path.");
  return resolve(
    value === "~"
      ? homedir()
      : value.startsWith("~/")
        ? join(homedir(), value.slice(2))
        : value,
  );
}

export function permissionMode(options) {
  const mode = options.permissions ?? "default";
  if (!["default", "full"].includes(mode))
    throw new Error("--permissions must be default or full");
  if (options["board-only"] && mode === "full")
    throw new Error("--board-only cannot be combined with --permissions full");
  return options["board-only"] ? "board-only" : mode;
}

export async function writableDirectory(path, { create = true } = {}) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await stat(path)).isDirectory())
    throw new Error(`Not a folder: ${path}`);
  const probe = join(path, `.harakiri-check-${randomUUID()}`);
  const handle = await open(probe, "wx", 0o600);
  await handle.close();
  await unlink(probe);
  return realpath(path);
}

function contains(parent, child) {
  const path = relative(parent, child);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith("../") && !isAbsolute(path))
  );
}

export async function prepareWorkspace(options, channelId, defaultStateRoot) {
  const permissions = permissionMode(options);
  if (
    options.cwd !== undefined &&
    (options.workspace !== undefined || options.layout !== undefined)
  )
    throw new Error(
      "--cwd is the legacy shared-folder option. Use either --cwd or --workspace with --layout.",
    );
  const layout =
    options.cwd !== undefined ? "shared" : (options.layout ?? "per-agent");
  if (!["per-agent", "shared"].includes(layout))
    throw new Error("--layout must be per-agent or shared");
  const workspaceRoot = await writableDirectory(
    localPath(
      options.cwd ?? options.workspace ?? `~/Harakiri/missions/${channelId}`,
    ),
  );
  const stateRoot = await writableDirectory(
    localPath(options["state-dir"] ?? defaultStateRoot),
  );
  if (contains(workspaceRoot, stateRoot) || contains(stateRoot, workspaceRoot))
    throw new Error(
      "Workspace and private session state must be separate folders, with neither inside the other. Choose another --workspace or --state-dir.",
    );
  const shared =
    layout === "shared"
      ? workspaceRoot
      : await writableDirectory(join(workspaceRoot, "shared"));
  if (layout === "per-agent")
    await writableDirectory(join(workspaceRoot, "agents"));
  return {
    environment: "local",
    permissions,
    layout,
    workspaceRoot,
    shared,
    stateRoot,
  };
}

export async function prepareAgentWorkspace(config, name) {
  const slug = name.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 60) || "agent";
  const cwd =
    config.layout === "shared"
      ? config.workspaceRoot
      : await writableDirectory(
          join(
            config.workspaceRoot,
            "agents",
            `${slug}-${randomUUID().slice(0, 8)}`,
          ),
        );
  // Resolve symlinks before checking: a custom agents/shared folder must not lead into credentials.
  for (const path of [cwd, config.shared])
    if (contains(path, config.stateRoot) || contains(config.stateRoot, path))
      throw new Error(
        "An agent workspace must not overlap private session state.",
      );
  return { ...config, cwd };
}

export async function preflightRuntime(runtime, permissions) {
  if (!["claude", "codex"].includes(runtime))
    throw new Error("--runtime must be claude or codex");
  async function run(args) {
    try {
      const { stdout, stderr } = await exec(runtime, args, {
        timeout: 10000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return stdout + stderr;
    } catch (error) {
      throw new Error(
        `Cannot run ${runtime} ${args.join(" ")}: ${error.code === "ENOENT" ? "CLI not found on PATH. Install it on the launcher machine." : "CLI preflight failed. Check the installed runtime."}`,
      );
    }
  }
  const version = (await run(["--version"])).trim().slice(0, 160);
  if (permissions === "full") {
    const checks =
      runtime === "codex"
        ? [
            ["exec", "--help"],
            ["exec", "resume", "--help"],
          ]
        : [["--help"]];
    for (const args of checks) {
      const help = await run(args);
      const flags =
        runtime === "codex"
          ? ["--dangerously-bypass-approvals-and-sandbox"]
          : ["--dangerously-skip-permissions", "--settings"];
      if (flags.some((flag) => !help.includes(flag)))
        throw new Error(
          `${runtime} does not support the requested full-access configuration. Update the CLI; no agents were started with reduced permissions.`,
        );
    }
  }
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
  if (s.runtime === "codex") {
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
  }
  if (s.runtime !== "claude")
    throw new Error("Saved runtime must be claude or codex");
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
  if (mode === "default" && s.execution?.shared && s.execution.shared !== s.cwd)
    args.push("--add-dir", s.execution.shared);
  if (s.nativeSession) args.push("--resume", s.nativeSession);
  args.push("--", prompt);
  return { command: "claude", args, input: "" };
}

export function workspaceInstructions(state) {
  return `Local execution workspace: ${JSON.stringify(state.cwd)}. Write your working files here. ${state.execution?.shared ? `Shared mission folder: ${JSON.stringify(state.execution.shared)}. Use it for deliverables and files you deliberately share; coordinate before editing the same file.` : ""} These folders are on the launcher's machine. Folder separation is not a sandbox. Your permission mode is ${state.execution?.permissions || (state.boardOnly ? "board-only" : "default")}. Report tool or policy restrictions to the human; do not claim a setting bypasses machine or organization policy.`;
}
