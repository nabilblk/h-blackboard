import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { access, mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus, totalmem } from "node:os";
import { createHash } from "node:crypto";
import { Id } from "../model.mjs";
import {
  EXECUTION_PROVIDER_VERSION,
  POLICY_DIGEST,
  POLICY,
  Session,
} from "./contract.mjs";
import { GrokConnection } from "../../bin/grok-acp.mjs";
import { guestTools } from "./tools.mjs";

const exec = promisify(execFile);
const sourceGuest = join(dirname(fileURLToPath(import.meta.url)), "guest");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const MAX_LINE = 2 * 1024 * 1024;
const image = `https://cloud-images.ubuntu.com/releases/24.04/release-${POLICY.imageRelease}/ubuntu-24.04-server-cloudimg-arm64.img`;
const imageDigest = `sha256:${POLICY.imageSha256}`;

// The peer and renderer never supply executable paths, YAML, network policy,
// image URLs, environment variables or arbitrary host commands.
export class LimaProvider {
  version = EXECUTION_PROVIDER_VERSION;
  policy = POLICY_DIGEST;
  handles = new Map();
  bootQueue = Promise.resolve();
  constructor({
    directory,
    namespace = directory,
    resources = sourceGuest,
    executable,
  } = {}) {
    this.directory = directory;
    this.namespace = namespace;
    this.resources = resources;
    this.executable = executable;
    this.maximum = Math.max(
      1,
      Math.min(
        Math.floor(cpus().length / 2),
        Math.floor((totalmem() / 1024 ** 3 - 4) / 2.5),
      ),
    );
  }
  instance(id) {
    // Preserve 128 bits, use lowercase names on case-insensitive APFS, and
    // scope VMs to this desktop profile without lengthy socket paths.
    const digest = createHash("sha256")
      .update(this.namespace + "\0" + Id.parse(id))
      .digest("hex")
      .slice(0, 32);
    return `h${BigInt("0x" + digest)
      .toString(36)
      .padStart(25, "0")}`;
  }
  async binary() {
    if (process.platform !== "darwin" || process.arch !== "arm64")
      throw new Error(
        "This enforcing provider currently supports Apple Silicon macOS only.",
      );
    if (this.executable) return this.executable;
    for (const path of [
      "/opt/homebrew/bin/limactl",
      "/usr/local/bin/limactl",
    ]) {
      if (
        await access(path).then(
          () => true,
          () => false,
        )
      )
        return (this.executable = path);
    }
    throw new Error(
      "Install Lima with brew install lima, then prepare this contribution again.",
    );
  }
  env() {
    return {
      HOME: process.env.HOME,
      USER: process.env.USER,
      TMPDIR: process.env.TMPDIR || "/tmp",
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
      LIMA_HOME: this.directory,
    };
  }
  async run(args, { input, timeout = 30000, maxBuffer = 1024 * 1024 } = {}) {
    const binary = await this.binary();
    if (input === undefined) {
      const { stdout } = await exec(binary, args, {
        env: this.env(),
        timeout,
        maxBuffer,
      });
      return stdout;
    }
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        env: this.env(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      const chunks = [];
      let length = 0;
      let error = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
      child.stdout.on("data", (b) => {
        length += b.length;
        if (length > maxBuffer) child.kill("SIGKILL");
        else chunks.push(b);
      });
      child.stderr.on("data", (b) => {
        error = (error + b.toString()).slice(-2048);
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0 && length <= maxBuffer)
          resolve(Buffer.concat(chunks).toString());
        else
          reject(
            new Error(`Isolated environment command failed: ${error || code}`),
          );
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  }
  guest(id, args, options) {
    return this.run(
      ["shell", "--workdir=/tmp", this.instance(id), "sudo", "--", ...args],
      options,
    );
  }
  async vm(id) {
    const directory = join(this.directory, this.instance(id));
    const exists = await lstat(directory).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (!exists) return { exists: false, running: false };
    if (!exists.isDirectory() || exists.isSymbolicLink())
      throw new Error("Invalid owned VM directory.");
    const output = await this.run(["list", "--json", this.instance(id)]);
    const value = JSON.parse(output.trim());
    if (
      value.name !== this.instance(id) ||
      !["Running", "Stopped"].includes(value.status)
    )
      throw new Error("VM state is uncertain; recover it before execution.");
    return { exists: true, running: value.status === "Running" };
  }
  async boot(id) {
    const previous = this.bootQueue;
    let release;
    this.bootQueue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (!(await this.vm(id)).running) {
        const current = (await this.run(["list", "--json"]))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((s) => JSON.parse(s));
        if (
          current.filter((v) => v.status === "Running").length >= this.maximum
        )
          throw new Error(
            `This device's safe capacity is ${this.maximum} VM(s). Stop another environment first.`,
          );
        await this.run(["start", "--tty=false", this.instance(id)], {
          timeout: 180000,
        });
      }
    } finally {
      release();
    }
  }
  async prepare({ contribution }) {
    const id = contribution.id;
    if (contribution.runtime !== "grok")
      throw new Error(
        "Only Grok Build has an enforcing runtime adapter. Claude and Codex are unavailable here.",
      );
    await this.binary();
    if (
      Buffer.byteLength(
        join(this.directory, this.instance(id), "ssh.sock.1234567890123456"),
      ) >= 100
    )
      throw new Error(
        "The home directory path is too long for Lima's macOS sockets. A shorter local account home is required.",
      );
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(this.directory)).isSymbolicLink())
      throw new Error("Invalid VM storage.");
    const marker = join(this.directory, ".harakiri-provider-v2");
    const existing = await readFile(marker, "utf8").catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (existing && existing !== POLICY_DIGEST)
      throw new Error("VM policy changed; explicit migration is required.");
    if (!existing)
      await writeFile(marker, POLICY_DIGEST, { mode: 0o600, flag: "wx" });
    if (!(await this.vm(id)).exists) {
      const path = join(this.directory, `${this.instance(id)}.yaml`);
      await writeFile(
        path,
        `vmType: vz\narch: aarch64\ncpus: 2\nmemory: 2GiB\ndisk: 8GiB\nimages:\n  - location: ${image}\n    arch: aarch64\n    digest: ${imageDigest}\nmounts: []\nssh:\n  loadDotSSHPubKeys: false\n  forwardAgent: false\n  forwardX11: false\n  forwardX11Trusted: false\n  overVsock: true\ncontainerd:\n  system: false\n  user: false\nportForwards:\n  - guestPortRange: [1, 65535]\n    ignore: true\nhostResolver:\n  enabled: false\npropagateProxyEnv: false\n`,
        { mode: 0o600 },
      );
      await this.run(
        ["create", "--tty=false", `--name=${this.instance(id)}`, path],
        { timeout: 180000 },
      );
    }
    await this.boot(id);
    await this.guest(id, ["install", "-d", "-m", "0755", "/opt/harakiri"]);
    for (const file of [
      "agent.md",
      "bridge.py",
      "mcp.py",
      "control.py",
      "files.py",
      "proxy.py",
      "setup.sh",
    ]) {
      await this.guest(id, ["tee", `/opt/harakiri/${file}`], {
        input: await readFile(join(this.resources, file)),
        maxBuffer: 128 * 1024,
      });
      await this.guest(id, ["chmod", "0644", `/opt/harakiri/${file}`]);
    }
    await this.guest(id, ["tee", "/opt/harakiri/tools.json"], {
      input: JSON.stringify(guestTools()),
      maxBuffer: 256 * 1024,
    });
    await this.guest(id, ["sh", "/opt/harakiri/setup.sh"], { timeout: 240000 });
    await this.guest(id, ["tee", "/opt/harakiri/policy"], {
      input: POLICY_DIGEST,
    });
    return this.inspect({ contribution });
  }
  async inspect({ contribution }) {
    const state = await this.vm(contribution.id);
    if (!state.exists || !state.running)
      return { ...state, stopped: true, authenticated: false };
    const policy = (
      await this.guest(contribution.id, ["cat", "/opt/harakiri/policy"])
    ).trim();
    if (policy !== POLICY_DIGEST)
      throw new Error("VM policy verification failed.");
    const detail = JSON.parse(
      await this.guest(contribution.id, [
        "python3",
        "/opt/harakiri/control.py",
        "inspect",
      ]),
    );
    if (
      typeof detail.stopped !== "boolean" ||
      typeof detail.authenticated !== "boolean"
    )
      throw new Error("Invalid VM inspection.");
    return { ...state, ...detail };
  }
  async login({ contribution }) {
    await this.boot(contribution.id);
    const state = await this.inspect({ contribution });
    if (!state.stopped) throw new Error("Stop the agent before signing in.");
    // Native device login goes directly to the provider in this guest. The
    // desktop never reads, exports or accepts an auth.json from the host.
    const args = [
      await this.binary(),
      "shell",
      "--workdir=/tmp",
      this.instance(contribution.id),
      "sudo",
      "-H",
      "-u",
      "hb-runtime",
      "--",
      "/opt/harakiri/grok",
      "--no-auto-update",
      "login",
      "--device-auth",
    ];
    return {
      command: `LIMA_HOME=${quote(this.directory)} ${args.map(quote).join(" ")}`,
    };
  }
  async launch({
    contribution,
    seconds,
    session,
    prompt,
    onTool,
    onSession,
    onEvent,
    remaining,
  }) {
    const id = contribution.id;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400)
      throw new Error("Invalid execution lease.");
    if (session) Session.parse(session);
    if (this.handles.has(id))
      throw new Error("This contribution already has a live execution.");
    if (this.handles.size >= this.maximum)
      throw new Error(
        "This device has no free VM capacity. Stop an agent first.",
      );
    await this.boot(id);
    const state = await this.inspect({ contribution });
    if (!state.stopped || !state.authenticated)
      throw new Error(
        "Sign in to Grok in this guest and confirm prior execution has stopped.",
      );
    if (!state.workspace_ready)
      throw new Error(
        "VM workspace ownership changed. Prepare the environment again before running.",
      );
    if (remaining) seconds = Math.floor(remaining() / 1000) - 2;
    if (seconds < 1) throw new Error("Permission expired during VM startup.");
    const child = spawn(
      await this.binary(),
      [
        "shell",
        "--workdir=/tmp",
        this.instance(id),
        "sudo",
        "--",
        "systemd-run",
        "--quiet",
        "--pipe",
        "--wait",
        "--collect",
        "--unit=hb-session",
        `--property=RuntimeMaxSec=${seconds}`,
        "--property=TimeoutStopSec=5",
        "--property=KillMode=control-group",
        "--property=ExecStopPost=/usr/bin/systemctl stop hb-agent.slice",
        "python3",
        "/opt/harakiri/bridge.py",
        String(seconds),
      ],
      { env: this.env(), stdio: ["pipe", "pipe", "pipe"] },
    );
    const transport = new EventEmitter();
    transport.stdout = new PassThrough();
    transport.stderr = new PassThrough();
    transport.stdin = new Writable({
      write(data, _encoding, done) {
        try {
          child.stdin.write(
            JSON.stringify({
              kind: "acp",
              message: JSON.parse(data.toString()),
            }) + "\n",
            done,
          );
        } catch (error) {
          done(error);
        }
      },
      final(done) {
        child.stdin.end();
        done();
      },
    });
    transport.kill = (signal) => child.kill(signal);
    child.stderr.resume(); // Never forward runtime/login diagnostics as public mission messages.
    child.stdin.on("error", () => {});
    let input = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input) > MAX_LINE * 2) {
        child.kill("SIGKILL");
        return;
      }
      let end;
      while ((end = input.indexOf("\n")) >= 0) {
        const line = input.slice(0, end);
        input = input.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.kind === "acp")
            transport.stdout.write(JSON.stringify(message.message) + "\n");
          else if (message.kind === "exit") child.stdin.end();
          else if (
            message.kind === "tool" &&
            /^[a-f0-9]{32}$/.test(message.id)
          ) {
            Promise.resolve()
              .then(() => onTool(message.tool, message.arguments))
              .catch((e) => ({ error: e.message }))
              .then((result) => {
                if (!child.stdin.destroyed)
                  child.stdin.write(
                    JSON.stringify({
                      kind: "tool_result",
                      id: message.id,
                      result,
                    }) + "\n",
                  );
              });
          } else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    });
    child.on("error", (error) => transport.emit("error", error));
    child.on("close", (code, signal) => {
      transport.stdout.end();
      transport.stderr.end();
      transport.emit("close", code, signal);
    });
    const diagnostics = new Writable({
      write(_data, _encoding, done) {
        done();
      },
    });
    const connection = new GrokConnection({ transport, diagnostics, onEvent });
    this.handles.set(id, connection);
    const done = (async () => {
      try {
        await connection.initialize();
        connection.sessionId = session;
        const opened = await connection.request(
          session ? "session/load" : "session/new",
          {
            cwd: "/home/hb-runtime/control",
            mcpServers: [
              {
                name: "harakiri",
                command: "/usr/bin/python3",
                args: ["/opt/harakiri/mcp.py"],
                env: [],
              },
            ],
            _meta: {
              sessionKind: "headless",
              yoloMode: false,
              ...(session
                ? { noReplay: true, "x.ai/restore_code": false }
                : {}),
            },
            ...(session ? { sessionId: session } : {}),
          },
        );
        const actual = Session.parse(session || opened.sessionId);
        if (opened.sessionId && opened.sessionId !== actual)
          throw new Error("Runtime resumed another session.");
        connection.sessionId = actual;
        await onSession(actual);
        const result = await connection.request(
          "session/prompt",
          { sessionId: actual, prompt: [{ type: "text", text: prompt }] },
          seconds * 1000,
        );
        if (result.stopReason !== "end_turn")
          throw new Error(`Grok stopped: ${result.stopReason || "unknown"}.`);
        return { session: actual, usage: result._meta?.usage || null };
      } finally {
        await connection.close();
        if (this.handles.get(id) === connection) this.handles.delete(id);
      }
    })();
    return { done };
  }
  resume(request) {
    Session.parse(request.session);
    return this.launch(request);
  }
  async interrupt({ contribution }) {
    const connection = this.handles.get(contribution.id);
    if (connection?.sessionId)
      connection.child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId: connection.sessionId },
        }) + "\n",
      );
  }
  async terminate({ contribution }) {
    const id = contribution.id;
    const state = await this.vm(id);
    if (!state.exists || !state.running) return { stopped: true };
    await this.guest(id, ["python3", "/opt/harakiri/control.py", "stop"], {
      timeout: 45000,
    }).catch(() => {});
    // VM shutdown is the final boundary, including any unexpected detached
    // descendant. An unreachable guest alone is never proof of termination.
    await this.run(["stop", "--tty=false", this.instance(id)], {
      timeout: 45000,
    });
    const verified = await this.vm(id);
    if (verified.running) throw new Error("VM termination is not confirmed.");
    this.handles.delete(id);
    return { stopped: true };
  }
  checkpoint({ session }) {
    return { session: session ? Session.parse(session) : null };
  }
  usage(result) {
    return { turns: 1, tokens: result?.usage?.totalTokens ?? null, cost: null };
  }
  async exportFiles({ contribution }) {
    await this.boot(contribution.id);
    return JSON.parse(
      await this.guest(
        contribution.id,
        ["python3", "/opt/harakiri/control.py", "export"],
        { maxBuffer: 24 * 1024 * 1024, timeout: 60000 },
      ),
    );
  }
  async importFiles({ contribution, files }) {
    await this.boot(contribution.id);
    return JSON.parse(
      await this.guest(
        contribution.id,
        ["python3", "/opt/harakiri/control.py", "import"],
        { input: JSON.stringify({ files }), timeout: 60000 },
      ),
    );
  }
}
