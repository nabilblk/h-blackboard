import { readFile, readdir, mkdir, open } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { atomicJson, alive } from "../runner-state.mjs";
import { shellQuote } from "../runtime.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fingerprint = (state) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        state.agentId,
        state.channelId,
        new URL(state.url).origin,
        state.runtime,
        state.cwd,
        state.execution?.permissions,
        state.execution?.layout,
        state.execution?.workspaceRoot,
        state.execution?.shared,
        !!state.boardOnly,
      ]),
    )
    .digest("hex");

export class LocalProcessProvider {
  static descriptor = {
    id: "local-process",
    label: "Local process",
    isolation: "none",
    capabilities: { resume: true },
  };
  descriptor = LocalProcessProvider.descriptor;
  constructor({
    connection,
    directory,
    command = process.execPath,
    cli = resolve(root, "bin/harakiri.mjs"),
    env = process.env,
  }) {
    this.connection = connection;
    this.directory = directory;
    this.command = command;
    this.cli = cli;
    this.env = env;
    this.bindings = null;
    this.saving = Promise.resolve();
  }
  async load() {
    if (!this.bindings) {
      try {
        this.bindings = JSON.parse(
          await readFile(resolve(this.directory, "executions.json"), "utf8"),
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        this.bindings = [];
      }
    }
  }
  async save() {
    const value = JSON.parse(JSON.stringify(this.bindings));
    this.saving = this.saving.then(() =>
      atomicJson(resolve(this.directory, "executions.json"), value),
    );
    return this.saving;
  }
  async discover() {
    await this.load();
    const directory = await readdir(this.connection.stateRoot, {
      withFileTypes: true,
    });
    const discovered = [];
    for (const entry of directory) {
      if (!entry.isDirectory() || !/^ag_[a-zA-Z0-9_-]+$/.test(entry.name))
        continue;
      const file = resolve(
        this.connection.stateRoot,
        entry.name,
        "session.json",
      );
      let state;
      try {
        state = JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (
        state.channelId !== this.connection.channelId ||
        new URL(state.url).origin !== this.connection.url ||
        (!state.execution && !state.nativeSession)
      )
        continue;
      let binding = this.bindings.find((b) => b.agentId === state.agentId);
      if (!binding) {
        binding = {
          id: `ex_${randomUUID()}`,
          agentId: state.agentId,
          file,
          fingerprint: fingerprint(state),
          workspaceRef: `ws_${randomUUID()}`,
          checkpointRef: `cp_${randomUUID()}`,
          generation: 0,
          state: "unknown",
          error: null,
          pid: null,
        };
        this.bindings.push(binding);
        await this.save();
      }
      discovered.push({
        execution_id: binding.id,
        agent_id: state.agentId,
        agent_token: state.token,
        workspace_ref: binding.workspaceRef,
        checkpoint_ref: binding.checkpointRef,
        resume_command: `${shellQuote(this.command)} ${shellQuote(this.cli)} resume --session ${shellQuote(binding.file)}`,
      });
    }
    return discovered;
  }
  async binding(id) {
    await this.load();
    const binding = this.bindings.find((b) => b.id === id);
    if (!binding) throw new Error("Unknown local execution reference.");
    return binding;
  }
  async inspect(id) {
    const binding = await this.binding(id);
    let lock = null;
    try {
      lock = Number(await readFile(binding.file + ".lock", "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const running = alive(lock) || alive(binding.pid);
    if (lock !== null && !running)
      return {
        execution_id: id,
        generation: binding.generation,
        state: "unknown",
        error:
          "The previous worker left a stale lock. Inspect the processes on this machine before using the manual resume command.",
      };
    let state = running
      ? lock
        ? "running"
        : "starting"
      : binding.state === "failed"
        ? "failed"
        : "stopped";
    // A previous runner may have exited after spawning the worker. Inspect the
    // session lock before reconciling the same generation; never spawn a twin.
    if (binding.state === "starting" && !running) state = "failed";
    const error =
      state === "failed"
        ? binding.error ||
          "The previous process stopped before confirming a connection. Resume to retry."
        : null;
    return { execution_id: id, generation: binding.generation, state, error };
  }
  async resume(intent) {
    const binding = await this.binding(intent.execution_id);
    if (
      intent.workspace_ref !== binding.workspaceRef ||
      intent.checkpoint_ref !== binding.checkpointRef
    )
      throw new Error("Local resume cannot replace a workspace or checkpoint.");
    if (intent.generation <= binding.generation)
      return this.inspect(binding.id);
    const current = await this.inspect(binding.id);
    binding.generation = intent.generation;
    if (["starting", "running"].includes(current.state)) {
      await this.save();
      return { ...current, generation: binding.generation };
    }
    let log;
    try {
      if (current.state === "unknown" && current.error)
        throw new Error(current.error);
      const state = JSON.parse(await readFile(binding.file, "utf8"));
      if (fingerprint(state) !== binding.fingerprint)
        throw new Error(
          "Saved execution settings changed. Restore the original runtime, workspace and permissions before resuming.",
        );
      binding.state = "starting";
      binding.error = null;
      binding.pid = null;
      await this.save();
      await mkdir(resolve(dirname(binding.file), "logs"), {
        recursive: true,
        mode: 0o700,
      });
      log = await open(
        resolve(dirname(binding.file), "logs/launcher.log"),
        "w",
        0o600,
      );
      const child = spawn(
        this.command,
        [this.cli, "resume", "--session", binding.file],
        { detached: true, stdio: ["ignore", log.fd, log.fd], env: this.env },
      );
      binding.pid = child.pid || null;
      child.once("exit", (code, signal) => {
        binding.state = code === 0 ? "stopped" : "failed";
        binding.error =
          code === 0
            ? null
            : `Agent process exited (${signal || code}). See the runtime error or launcher log on the execution machine.`;
        binding.pid = null;
        this.save().catch(() => {});
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      await this.save();
      child.unref();
    } catch (error) {
      binding.state = "failed";
      binding.error = String(error.message).slice(0, 1000);
      await this.save();
    } finally {
      await log?.close();
    }
    return this.inspect(binding.id);
  }
}
