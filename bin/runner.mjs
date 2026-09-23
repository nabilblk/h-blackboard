import { readFile, mkdir } from "node:fs/promises";
import { atomicJson, exclusive } from "./runner-state.mjs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request, isRetryable, reconnectDelay } from "../server/remote.mjs";
import {
  RUNNER_PROTOCOL_VERSION,
  validateProvider,
} from "../shared/runner-protocol.mjs";
import { LocalProcessProvider } from "./providers/local-process.mjs";
import { shellQuote, localPath } from "./runtime.mjs";

// This controller has no process, filesystem, runtime, or sandbox knowledge.
// Provider implementations own execution handles and durable checkpoints.
export class RunnerController {
  constructor({ connection, provider, transport = request }) {
    this.connection = connection;
    this.provider = validateProvider(provider);
    this.transport = transport;
    this.registered = new Set();
  }
  async send(operation, input) {
    return this.transport(
      this.connection.url,
      `/api/runners/${operation}`,
      input,
      this.connection.token,
    );
  }
  async sync() {
    const bindings = await this.provider.discover();
    const fresh = bindings.filter((b) => !this.registered.has(b.execution_id));
    for (let offset = 0; offset < fresh.length; offset += 50) {
      const chunk = fresh.slice(offset, offset + 50);
      await this.send("inventory", {
        executions: chunk,
        ...(this.connection.reconnectCommand
          ? { reconnect_command: this.connection.reconnectCommand }
          : {}),
      });
      chunk.forEach((b) => this.registered.add(b.execution_id));
    }
    const observations = [];
    for (const binding of bindings)
      observations.push(await this.provider.inspect(binding.execution_id));
    let page;
    for (
      let offset = 0;
      offset < Math.max(1, observations.length);
      offset += 50
    )
      page = await this.send("tick", {
        observations: observations.slice(offset, offset + 50),
      });
    if (page.protocolVersion !== RUNNER_PROTOCOL_VERSION)
      throw new Error(
        "The board and launcher use different execution protocols. Update the launcher.",
      );
    const known = new Map(bindings.map((b) => [b.execution_id, b]));
    const seen = new Map(observations.map((o) => [o.execution_id, o]));
    const changed = [];
    for (const intent of page.executions) {
      const binding = known.get(intent.execution_id);
      const observation = seen.get(intent.execution_id);
      // A board cannot cause a runner to execute an unknown reference or swap
      // storage under an existing identity. The provider checks again locally.
      if (
        !binding ||
        !observation ||
        !intent.resume_allowed ||
        intent.generation <= observation.generation
      )
        continue;
      if (
        intent.workspace_ref !== binding.workspace_ref ||
        intent.checkpoint_ref !== binding.checkpoint_ref
      )
        throw new Error(
          "The board requested a different workspace or checkpoint for an existing execution.",
        );
      changed.push(await this.provider.resume(intent));
    }
    for (let offset = 0; offset < changed.length; offset += 50)
      await this.send("tick", {
        observations: changed.slice(offset, offset + 50),
      });
    return { sessions: bindings.length, resumed: changed.length };
  }
}

export async function runLocalRunner(options) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  if (options.connect && options.config)
    throw new Error(
      "Choose --connect for a new launcher or --config to reconnect an existing one.",
    );
  if (
    [
      "runtime",
      "workspace",
      "permissions",
      "layout",
      "board-only",
      "max-turns",
    ].some((key) => options[key] !== undefined)
  )
    throw new Error(
      "A recovery launcher uses each session's saved runtime, workspace, and permissions.",
    );
  let file, connection;
  if (options.connect) {
    const link = new URL(options.connect);
    if (
      !/^\/r\/[^/]+$/.test(link.pathname) ||
      !["http:", "https:"].includes(link.protocol)
    )
      throw new Error("Use the full launcher connection link from Blackboard.");
    const stateRoot = localPath(
      options["state-dir"] || resolve(root, "var/sessions"),
    );
    const registrationId = randomUUID();
    const credential = await request(link.origin, "/api/runners/join", {
      pairing_token: decodeURIComponent(link.pathname.slice(3)),
      registration_id: registrationId,
      name: options.name || hostname(),
      provider: LocalProcessProvider.descriptor,
    });
    connection = {
      ...credential,
      url: link.origin,
      stateRoot,
      name: options.name || hostname(),
    };
    file = resolve(stateRoot, ".runners", credential.runnerId, "runner.json");
    await atomicJson(file, connection);
    console.log(`Launcher connected. Saved configuration: ${file}`);
    console.log(
      `Reconnect: ${shellQuote(process.execPath)} ${shellQuote(resolve(root, "bin/harakiri.mjs"))} runner --config ${shellQuote(file)}`,
    );
  } else {
    if (!options.config)
      throw new Error(
        "Use runner --connect URL, or runner --config FILE to reconnect.",
      );
    file = resolve(options.config);
    connection = JSON.parse(await readFile(file, "utf8"));
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  connection.reconnectCommand = `${shellQuote(process.execPath)} ${shellQuote(resolve(root, "bin/harakiri.mjs"))} runner --config ${shellQuote(file)}`;
  const release = await exclusive(file + ".lock");
  let stopped = false;
  const abort = new AbortController();
  const stop = () => {
    stopped = true;
    abort.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const provider = new LocalProcessProvider({
    connection,
    directory: dirname(file),
  });
  const controller = new RunnerController({
    connection,
    provider,
    transport: (url, path, input, token) =>
      request(url, path, input, token, { signal: abort.signal }),
  });
  let failures = 0,
    lastCount = -1;
  const wait = (ms) =>
    new Promise((done) => {
      if (stopped) return done();
      const timer = setTimeout(finish, ms);
      function finish() {
        clearTimeout(timer);
        abort.signal.removeEventListener("abort", finish);
        done();
      }
      abort.signal.addEventListener("abort", finish, { once: true });
    });
  try {
    while (!stopped) {
      try {
        const state = await controller.sync();
        if (state.sessions !== lastCount || failures)
          console.log(
            `Launcher connected · ${state.sessions} saved sessions available. Waiting for human resume requests.`,
          );
        lastCount = state.sessions;
        failures = 0;
        await wait(2000);
      } catch (error) {
        if (stopped) break;
        if (!isRetryable(error)) throw error;
        if (!failures)
          console.error(
            "Board disconnected. Keeping execution handles and reconnecting.",
          );
        await wait(reconnectDelay(failures++));
      }
    }
  } finally {
    await release();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
