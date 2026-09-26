#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  open,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { pipeline } from "node:stream/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  call,
  request,
  isRetryable,
  reconnectDelay,
} from "../server/remote.mjs";
import {
  prepareWorkspace,
  prepareAgentWorkspace,
  preflightRuntime,
  runtimeArguments,
  runtimeEvent,
  writableDirectory,
  workspaceInstructions,
  shellQuote as quote,
} from "./runtime.mjs";
import { runtimeLog } from "./runtime-logs.mjs";
import { TurnBudget } from "./budget-client.mjs";
import { runtimeUsage, unknownUsage } from "./usage.mjs";
import runtimes from "../shared/runtimes.json" with { type: "json" };
const root = fileURLToPath(new URL("..", import.meta.url));
const program = fileURLToPath(import.meta.url);
const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    board: { type: "string" },
    file: { type: "string", multiple: true },
    manifest: { type: "string" },
    title: { type: "string" },
    artifact: { type: "string" },
    version: { type: "string" },
    outcome: { type: "string" },
    limitations: { type: "string" },
    ref: { type: "string", multiple: true },
    runtime: { type: "string" },
    count: { type: "string" },
    name: { type: "string" },
    capabilities: { type: "string" },
    workstream: { type: "string" },
    private: { type: "boolean" },
    thread: { type: "string" },
    role: { type: "string" },
    session: { type: "string" },
    connect: { type: "string" },
    config: { type: "string" },
    data: { type: "string" },
    body: { type: "string" },
    to: { type: "string" },
    kind: { type: "string" },
    cwd: { type: "string" },
    workspace: { type: "string" },
    layout: { type: "string" },
    permissions: { type: "string" },
    "state-dir": { type: "string" },
    "max-turns": { type: "string" },
    "board-only": { type: "boolean" },
    help: { type: "boolean" },
  },
});
async function save(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}
async function session() {
  if (!options.session) throw new Error("--session <file> is required");
  return JSON.parse(await readFile(resolve(options.session), "utf8"));
}
async function register(name, execution) {
  if (!options.board) throw new Error("--board <join URL> is required");
  const url = new URL(options.board);
  if (!/^\/j\/[^/]+$/.test(url.pathname))
    throw new Error("Use the full join URL from Invite agents.");
  if (!Object.hasOwn(runtimes, options.runtime))
    throw new Error(`--runtime must be ${Object.keys(runtimes).join(", ")}`);
  const result = await request(url.origin, "/api/join", {
    invitation: decodeURIComponent(url.pathname.slice(3)),
    name:
      name || options.name || `${options.runtime}-${randomUUID().slice(0, 6)}`,
    runtime: options.runtime,
    capabilities: options.capabilities || "",
    stream: options.workstream,
    role: options.role,
    registration_id: randomUUID(),
  });
  const directory = resolve(
    execution?.stateRoot ||
      options["state-dir"] ||
      resolve(root, "var/sessions"),
    result.agent.id,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = resolve(directory, "session.json");
  const value = {
    url: url.origin,
    channelId: result.channelId,
    token: result.token,
    agentId: result.agent.id,
    name: result.agent.name,
    runtime: options.runtime,
    cursor: 0,
    nativeSession: null,
    cwd: execution?.cwd || resolve(options.cwd || directory),
    boardOnly: !!options["board-only"],
    ...(execution
      ? {
          execution: {
            environment: execution.environment,
            permissions: execution.permissions,
            layout: execution.layout,
            workspaceRoot: execution.workspaceRoot,
            shared: execution.shared,
            runtimeVersion: execution.runtimeVersion,
          },
        }
      : {}),
  };
  await save(file, value);
  return { file, value };
}
async function guide() {
  return (
    await Promise.all(
      ["participation", "coordination"].map((name) =>
        readFile(resolve(root, `skills/blackboard-${name}/SKILL.md`), "utf8"),
      ),
    )
  ).join("\n\n");
}
const mcp = resolve(root, "server/mcp.mjs");
async function worker(file, resume = false) {
  let state = JSON.parse(await readFile(file, "utf8"));
  const lock = file + ".lock";
  try {
    const handle = await open(lock, "wx", 0o600);
    await handle.writeFile(String(process.pid));
    await handle.close();
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const pid = Number(await readFile(lock, "utf8"));
    try {
      process.kill(pid, 0);
      throw new Error(`This instance is already running (PID ${pid}).`);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await unlink(lock);
    return worker(file, resume);
  }
  let stopped = false,
    child = null,
    status = "idle",
    paused = false;
  const shutdown = new AbortController();
  let permission = null,
    turnPermission = null,
    interrupted = false,
    heartbeat = null,
    controlError = null;
  const canRun = (p) => p && ["planning", "authorized"].includes(p.state);
  // Publishing a plan advances the readiness revision during the planning turn.
  // It must not interrupt the coordinator before it can acknowledge that plan.
  const permissionKey = (p) =>
    p && (p.state === "planning" ? "planning" : `${p.state}:${p.revision}`);
  const execution = {
    environment: "local",
    budgetProtocol: 1,
    host: hostname(),
    workspace: state.cwd,
    workspaceRoot: state.execution?.workspaceRoot || state.cwd,
    shared: state.execution?.shared || null,
    layout: state.execution?.layout || "legacy",
    permissions:
      state.execution?.permissions ||
      (state.boardOnly ? "board-only" : "default"),
    runtimeVersion: state.execution?.runtimeVersion || "",
    stdoutPath: resolve(dirname(file), "logs/stdout.jsonl"),
    stderrPath: resolve(dirname(file), "logs/stderr.log"),
    pid: process.pid,
    startedAt: Date.now(),
    lastError: null,
  };
  const redact = (message) =>
    String(message).replaceAll(state.token, "[redacted]").slice(-2000);
  const budget = new TurnBudget(state, () => save(file, state));
  const maxTurns = Number(options["max-turns"] || 0);
  let turns = 0;
  const killChild = () => {
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  };
  const stop = () => {
    stopped = true;
    shutdown.abort();
    killChild();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const beat = () =>
    (heartbeat ||= (async () => {
      try {
        const control = await request(
          state.url,
          "/api/heartbeat",
          { status, execution },
          state.token,
        );
        permission = control.participation;
        controlError =
          permission &&
          ["waiting", "planning", "authorized", "paused", "closed"].includes(
            permission.state,
          ) &&
          Number.isInteger(permission.revision)
            ? null
            : new Error(
                "The board service does not support mission preparation. Restart it with the updated Blackboard version before launching agents.",
              );
        paused = !canRun(permission);
      } catch {
        // Never begin a new turn using a cached authorization after a disconnect.
        permission = null;
        paused = true;
      }
      if (child && (paused || permissionKey(permission) !== turnPermission)) {
        interrupted = true;
        killChild();
      }
    })().finally(() => {
      heartbeat = null;
    }));
  const timer = setInterval(beat, 12000);
  async function turn(prompt, context) {
    turnPermission = permissionKey(context.participation);
    interrupted = false;
    status =
      context.participation.state === "planning" ? "planning" : "working";
    await beat();
    if (controlError) throw controlError;
    if (paused || stopped || permissionKey(permission) !== turnPermission)
      return false;
    const reservation = await budget.reserve(context);
    if (!reservation.granted) {
      status = "waiting";
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return false;
    }
    await beat();
    if (paused || stopped || permissionKey(permission) !== turnPermission) {
      await budget.settle(
        {
          tokens: 0,
          costUsd: 0,
          quality: "reported",
          source: "Authorization changed before process start",
        },
        "interrupted",
      );
      return false;
    }
    const phase =
      context.participation.state === "planning"
        ? "PREPARATION ONLY. Read the mission, publish an initial shared plan with plan_update, then read its current startupRevision and call coordinator_ready. You may organize planned work, but do not implement the mission or start execution. Finish this turn while waiting for the human to start."
        : "Execution is authorized under the current mission and direction. Read pending assignments and human instructions before acting. Tasks and additional workstreams remain optional.";
    prompt = `${phase}\n${workspaceInstructions(state)}\nCurrent budget and reserved allowance: ${JSON.stringify({ budget: context.budget, run: reservation.run })}. Preserve partial results as artifacts. ${reservation.run.purpose === "finalization" ? "Use this turn for verification, synthesis and final handoff within the remaining budget." : ""}\nCurrent mission and authorization: ${JSON.stringify({ mission: context.mission, participation: context.participation, role: context.mission.coordinatorId === state.agentId ? "coordinator" : "agent" })}\n\n${prompt}`;
    const spec = runtimeArguments(state, file, prompt, mcp);
    let usage = unknownUsage();
    let buffer = "",
      errorText = "",
      transcript = "",
      failed = false;
    const stdoutLog = await runtimeLog(execution.stdoutPath);
    let stderrLog;
    try {
      stderrLog = await runtimeLog(execution.stderrPath);
    } catch (error) {
      stdoutLog.destroy();
      throw error;
    }
    let outputFinished;
    let logError;
    let sessionSaved = Promise.resolve();
    let sessionSaveError;
    await budget.starting();
    const result = await new Promise((done) => {
      child = spawn(spec.command, spec.args, {
        cwd: state.cwd,
        env: process.env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      sessionSaved = budget.process(child.pid).catch((error) => {
        sessionSaveError = error;
        killChild();
      });
      child.once("error", (error) => {
        errorText = `${state.runtime} could not start: ${error.message}`;
        failed = true;
      });
      child.stdin.on("error", (error) => {
        if (error.code !== "EPIPE") {
          errorText = error.message;
          failed = true;
          killChild();
        }
      });
      outputFinished = Promise.all(
        [
          pipeline(child.stdout, stdoutLog),
          pipeline(child.stderr, stderrLog),
        ].map((pending) =>
          pending.catch((error) => {
            logError = error;
            killChild();
          }),
        ),
      );
      child.stdin.end(spec.input);
      child.stderr.setEncoding("utf8");
      child.stdout.setEncoding("utf8");
      child.stderr.on("data", (b) => {
        errorText = (errorText + b.toString()).slice(-3000);
      });
      child.stdout.on("data", (b) => {
        transcript = (transcript + b.toString()).slice(-1000000);
        buffer += b.toString();
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const rawEvent = JSON.parse(line);
            usage = runtimeUsage(state.runtime, rawEvent) || usage;
            const event = runtimeEvent(state.runtime, rawEvent);
            if (event.sessionId && event.sessionId !== state.nativeSession) {
              state.nativeSession = event.sessionId;
              // Persist the native identity before the turn finishes, so a
              // process failure can still resume the original conversation.
              sessionSaved = sessionSaved
                .then(() => save(file, state))
                .catch((error) => {
                  sessionSaveError = error;
                  killChild();
                });
            }
            if (event.error) {
              failed = true;
              errorText = event.error.slice(-3000);
            }
          } catch {}
        }
      });
      child.once("close", (code) => done(code));
    });
    await outputFinished;
    await sessionSaved;
    child = null;
    await budget.settle(
      usage,
      interrupted || stopped || paused
        ? "interrupted"
        : result === 0 && !failed
          ? "completed"
          : "failed",
    );
    await writeFile(resolve(dirname(file), "last-turn.jsonl"), transcript, {
      mode: 0o600,
    });
    await save(file, state);
    child = null;
    if (logError)
      throw new Error(`Cannot write runtime logs: ${logError.message}`);
    if (sessionSaveError)
      throw new Error(
        `Cannot save runtime session: ${sessionSaveError.message}`,
      );
    if (paused || stopped || interrupted) return false;
    if (result !== 0 || failed)
      throw Object.assign(
        new Error(errorText || `${state.runtime} exited with code ${result}`),
        { runtimeFailure: true },
      );
    status = "idle";
    await beat();
    turns++;
    return true;
  }
  try {
    await budget.recover();
    await beat();
    if (controlError) throw controlError;
    await writableDirectory(state.cwd, { create: false });
    if (execution.shared && execution.shared !== state.cwd)
      await writableDirectory(execution.shared, { create: false });
    if (resume) {
      execution.runtimeVersion = await preflightRuntime(
        state.runtime,
        execution.permissions,
        state.cwd,
      );
      if (state.execution)
        state.execution.runtimeVersion = execution.runtimeVersion;
    }
    // Validate saved configuration even when the mission is currently paused.
    runtimeArguments(state, file, "", mcp);
    const instructions = await guide();
    let initial = true;
    const recoveringSession = !!state.nativeSession;
    let waitingCursor = state.cursor;
    let reconnects = 0;
    while (!stopped && (!maxTurns || turns < maxTurns)) {
      try {
        await budget.recover();
        await beat();
        if (controlError) throw controlError;
        if (paused) {
          status = permission?.state === "waiting" ? "waiting" : "paused";
          await beat();
          // Watch without acknowledging or replacing the durable replay cursor.
          // Registration/preparation never consumes a model turn for a worker.
          const update = await request(
            state.url,
            "/api/watch",
            {
              channel_id: state.channelId,
              after: waitingCursor,
              timeout: 1000,
            },
            state.token,
            { signal: shutdown.signal },
          );
          waitingCursor = update.cursor;
          reconnects = 0;
          continue;
        }
        if (initial) {
          const ctx = await call(state, "context_read");
          if (!canRun(ctx.participation)) continue;
          const missed = recoveringSession
            ? await call(state, "updates_read", { after: state.cursor })
            : null;
          const current = ctx.agents.find((a) => a.id === state.agentId);
          const completed = await turn(
            `${instructions}\n\nYou are ${state.name}, registered in Harakiri as ${current?.role || "agent"}. Your identity is ${state.agentId}. ${workspaceInstructions(state)} Read context_read now, follow the mission and human instructions, and publish useful findings through Harakiri MCP. ${state.boardOnly ? "This is a board-only integration run. Use Harakiri tools only." : ""} You and the other agents own execution tasks. Use task_create and task_update when concrete work benefits from ownership or progress tracking; keep reports useful to the human. Tasks are optional. Do not run a watch loop yourself: this launcher will wake your session when relevant updates arrive. Finish the turn when waiting.${missed ? `\n\nResuming your saved conversation. Missed updates from your last acknowledged cursor follow; further pages will arrive in subsequent turns. Current mission permissions and newer human instructions take precedence over outdated requests.\n${JSON.stringify(missed.events)}` : ""}`,
            ctx,
          );
          if (completed) {
            state.cursor = missed ? missed.cursor : ctx.cursor;
            initial = false;
            await call(state, "updates_read", {
              after: state.cursor,
              acknowledge: state.cursor,
            });
            await save(file, state);
          }
          continue;
        }
        const page = await request(
          state.url,
          "/api/watch",
          { channel_id: state.channelId, after: state.cursor, timeout: 20000 },
          state.token,
          { signal: shutdown.signal },
        );
        if (stopped) break;
        if (page.events.length) {
          const ctx = await call(state, "context_read");
          if (!canRun(ctx.participation)) continue;
          const completed = await turn(
            `New Harakiri updates. Human instructions have priority. Re-read context_read if goals, roles or assignments changed. Act only if there is useful work; publish evidence rather than repeated acknowledgments.\n${JSON.stringify(page.events)}\nFinish this turn when waiting; the launcher continues listening.`,
            ctx,
          );
          if (!completed) continue;
        }
        state.cursor = page.cursor;
        await call(state, "updates_read", {
          after: state.cursor,
          acknowledge: state.cursor,
        });
        await save(file, state);
        reconnects = 0;
      } catch (e) {
        if (stopped) break;
        if (!e.runtimeFailure && isRetryable(e)) {
          await new Promise((r) => setTimeout(r, reconnectDelay(reconnects++)));
          continue;
        }
        throw e;
      }
    }
  } catch (error) {
    status = "error";
    execution.lastError = redact(error.message);
    await beat();
    await call(state, "message_post", {
      body: `Runtime needs human attention: ${execution.lastError.slice(0, 1000)}`,
      audience: "human",
      direct_agent_id: state.agentId,
      kind: "question",
    }).catch(() => {});
    throw new Error(execution.lastError);
  } finally {
    clearInterval(timer);
    killChild();
    if (status !== "error")
      await request(
        state.url,
        "/api/heartbeat",
        { status: "offline", execution },
        state.token,
      ).catch(() => {});
    await save(file, state);
    await unlink(lock).catch(() => {});
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
async function main() {
  const cmd = positionals[0];
  if (options.help || !cmd) {
    console.log(
      `Harakiri Blackboard

publish --session FILE --title TITLE --body SUMMARY --file PATH [--file PATH ...]
  [--kind report|plan|code|data|application|validation|other] [--outcome draft|complete|inconclusive]
  [--limitations TEXT] [--artifact ID --version N] [--ref REVISION_ID] [--private]
publish --session FILE --manifest PATH

join --board URL --runtime ${Object.keys(runtimes).join("|")} [--name NAME]
launch --board URL --runtime ${Object.keys(runtimes).join("|")} --count N [--role agent|coordinator] [--workstream NAME] [--capabilities TEXT]
  [--permissions default|full] [--workspace DIR] [--layout per-agent|shared]
  [--state-dir DIR] [--board-only] [--max-turns N]
resume --session FILE
runner --connect URL [--state-dir DIR] [--name NAME]
runner --config FILE
context --session FILE
post --session FILE --body TEXT [--to everyone|human|coordinator|AGENT_ID] [--kind message|finding|question|decision] [--private | --thread MESSAGE_ID]
act OPERATION --session FILE --data JSON
watch --session FILE

New launches default to ~/Harakiri/missions/<mission-id>, separate agent folders,
and default runtime permissions. Full access disables runtime sandboxing and
approval prompts; OS and managed policies still apply. --board-only cannot be
combined with full access. --cwd DIR is an alias for an explicit shared workspace.
Credentials and rotating live logs stay in --state-dir (default: var/sessions).
Resume retains the saved folder, permission mode, identity, and native session.

launch runs managed instances until Ctrl+C and prints workspace, log and resume
paths. Interactive agents use join and retain their existing runtime settings.
--to addresses a public message. --private sends only to the human. --thread
inherits the original visibility. CLI and MCP use the same board operations.`,
    );
    return;
  }
  if (cmd === "runner") {
    const { runLocalRunner } = await import("./runner.mjs");
    await runLocalRunner(options);
    return;
  }
  if (cmd === "worker" || cmd === "resume") {
    if (!options.session) throw new Error("--session <file> is required");
    if (
      [
        "cwd",
        "workspace",
        "layout",
        "permissions",
        "board-only",
        "state-dir",
      ].some((key) => options[key] !== undefined)
    )
      throw new Error(
        "Resume uses the saved workspace and permissions. Launch a new instance to choose different settings.",
      );
    await worker(resolve(options.session), cmd === "resume");
    return;
  }
  if (cmd === "join") {
    if (
      ["workspace", "layout", "permissions"].some(
        (key) => options[key] !== undefined,
      )
    )
      throw new Error(
        "Workspace and permission settings apply to launch. An interactive agent keeps the settings of its existing runtime.",
      );
    const { file, value } = await register();
    console.log(
      JSON.stringify(
        {
          agentId: value.agentId,
          session: file,
          context: `${quote(process.execPath)} ${quote(program)} context --session ${quote(file)}`,
          post: `${quote(process.execPath)} ${quote(program)} post --session ${quote(file)} --body 'Your finding'`,
          watch: `${quote(process.execPath)} ${quote(program)} watch --session ${quote(file)}`,
          act: `${quote(process.execPath)} ${quote(program)} act OPERATION --session ${quote(file)} --data '{}'`,
          instructions: await guide(),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (cmd === "launch") {
    const count = Number(options.count || 1);
    if (!Number.isInteger(count) || count < 1 || count > 1000)
      throw new Error("--count must be between 1 and 1000");
    const invite = new URL(options.board || "");
    invite.searchParams.set("format", "json");
    const info = await request(invite.origin, invite.pathname + invite.search);
    if (info.role === "coordinator" && count !== 1)
      throw new Error(
        "A coordinator invitation launches one instance. Use an Agent invitation for a group.",
      );
    if (options.role && options.role !== info.role)
      throw new Error("The requested role must match the invitation role.");
    const config = await prepareWorkspace(
      options,
      info.channelId,
      resolve(root, "var/sessions"),
    );
    config.runtimeVersion = await preflightRuntime(
      options.runtime,
      config.permissions,
      config.workspaceRoot,
    );
    const prepared = [];
    for (let i = 0; i < count; i++) {
      const name = options.name
        ? `${options.name}${count > 1 ? `-${i + 1}` : ""}`
        : `${options.runtime}-${randomUUID().slice(0, 6)}`;
      prepared.push({
        name,
        execution: await prepareAgentWorkspace(config, name),
      });
    }
    console.log(
      `Workspace: ${config.workspaceRoot}\nLayout: ${config.layout} · Permissions: ${config.permissions}\nShared: ${config.shared}`,
    );
    const processes = [];
    const completions = [];
    let stopping = false;
    const stop = () => {
      stopping = true;
      processes.forEach((c) => c.kill("SIGTERM"));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    let failed = false;
    try {
      for (const item of prepared) {
        if (stopping) break;
        const { file, value } = await register(item.name, item.execution);
        console.log(
          `${value.name} · ${value.agentId}\nWorking folder: ${value.cwd}\nLive output: ${resolve(dirname(file), "logs/stdout.jsonl")}\nErrors: ${resolve(dirname(file), "logs/stderr.log")}\nResume: ${quote(process.execPath)} ${quote(program)} resume --session ${quote(file)}`,
        );
        if (stopping) break;
        const args = [program, "worker", "--session", file];
        if (options["max-turns"])
          args.push("--max-turns", options["max-turns"]);
        const child = spawn(process.execPath, args, { stdio: "inherit" });
        processes.push(child);
        completions.push(
          new Promise((done) => {
            child.once("error", () => {
              failed = true;
              done();
            });
            child.once("close", (code) => {
              if (code !== 0 && !stopping) failed = true;
              done();
            });
          }),
        );
        await new Promise((r) => setTimeout(r, 100));
      }
      await Promise.all(completions);
    } finally {
      stop();
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
    if (failed) process.exitCode = 1;
    return;
  }
  const s = await session();
  await request(s.url, "/api/heartbeat", { status: "idle" }, s.token);
  if (cmd === "context")
    console.log(JSON.stringify(await call(s, "context_read"), null, 2));
  else if (cmd === "publish") {
    const { artifactInput } = await import("./artifact-files.mjs");
    const input = await artifactInput(options);
    console.log(
      JSON.stringify(
        await call(s, "artifact_publish", {
          ...input,
          ...(options.private ? { direct_agent_id: s.agentId } : {}),
          ...(s.pendingBudget?.id ? { run_id: s.pendingBudget.id } : {}),
        }),
        null,
        2,
      ),
    );
  } else if (cmd === "post")
    console.log(
      JSON.stringify(
        await call(s, "message_post", {
          body: options.body,
          audience: options.to || "everyone",
          ...(options.private ? { direct_agent_id: s.agentId } : {}),
          ...(options.thread ? { thread_id: options.thread } : {}),
          ...(options.workstream ? { stream_id: options.workstream } : {}),
          kind: options.kind || "message",
        }),
        null,
        2,
      ),
    );
  else if (cmd === "act") {
    if (!positionals[1]) throw new Error("Specify an operation");
    console.log(
      JSON.stringify(
        await call(s, positionals[1], JSON.parse(options.data || "{}")),
        null,
        2,
      ),
    );
  } else if (cmd === "watch") {
    const result = await request(
      s.url,
      "/api/watch",
      { channel_id: s.channelId, after: s.cursor, timeout: 20000 },
      s.token,
    );
    s.cursor = result.cursor;
    await call(s, "updates_read", { after: s.cursor, acknowledge: s.cursor });
    await save(resolve(options.session), s);
    console.log(JSON.stringify(result, null, 2));
  } else throw new Error(`Unknown command: ${cmd}`);
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
