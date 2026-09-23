import { homedir } from "node:os";
import { resolve, relative, isAbsolute, join } from "node:path";
import { mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export {
  preflightRuntime,
  runtimeArguments,
  runtimeEvent,
} from "./runtime-adapters.mjs";
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

export function workspaceInstructions(state) {
  return `Local execution workspace: ${JSON.stringify(state.cwd)}. Write your working files here. ${state.execution?.shared ? `Shared mission folder: ${JSON.stringify(state.execution.shared)}. Use it for deliverables and files you deliberately share; coordinate before editing the same file.` : ""} These folders are on the launcher's machine. Folder separation is not a sandbox. Your permission mode is ${state.execution?.permissions || (state.boardOnly ? "board-only" : "default")}. Report tool or policy restrictions to the human; do not claim a setting bypasses machine or organization policy.`;
}
