import { spawn } from "node:child_process";
export function publicError(message) {
  const error = new Error(message);
  error.publicMessage = message;
  return error;
}
// Owned process groups, no shell interpolation, bounded pipes, explicit stop.
export function startProcess(
  binary,
  args,
  { cwd, env, signal, timeout = 180000 },
) {
  if (signal?.aborted) throw publicError("Stopped. Your draft is saved.");
  const child = spawn(binary, args, {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  let killTimer;
  const kill = (s) => {
    try {
      process.platform === "win32"
        ? child.kill(s)
        : process.kill(-child.pid, s);
    } catch {}
  };
  const stop = () => {
    kill("SIGTERM");
    killTimer ??= setTimeout(() => kill("SIGKILL"), 1000);
  };
  const timer = setTimeout(stop, timeout);
  signal?.addEventListener("abort", stop, { once: true });
  child.once("close", () => {
    clearTimeout(timer);
    clearTimeout(killTimer);
    // A child may ignore TERM and close inherited pipes when its parent exits.
    // Finish the owned group even when the leader has already stopped.
    kill("SIGKILL");
    signal?.removeEventListener("abort", stop);
  });
  child.stop = stop;
  return child;
}
export async function collect(child, input) {
  return new Promise((resolve, reject) => {
    let stdout = "",
      stderr = "",
      bytes = 0;
    for (const [name, stream] of [
      ["stdout", child.stdout],
      ["stderr", child.stderr],
    ]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 2 * 1024 * 1024) {
          child.stop();
          reject(
            publicError(
              "The runtime output was too large. Your draft is unchanged.",
            ),
          );
          return;
        }
        if (name === "stdout") stdout += chunk;
        else stderr += chunk;
      });
    }
    child.once("error", () =>
      reject(
        publicError(
          "The local CLI could not be opened. Check its installation and try again.",
        ),
      ),
    );
    child.stdin.on("error", () => {});
    child.once("close", (code) =>
      code === 0 ? resolve(stdout) : reject(runtimeFailure(stderr)),
    );
    child.stdin.end(input);
  });
}
export function runtimeFailure(detail = "") {
  const hint = /quota|rate.?limit|usage|balance|capacity|429/i.test(detail)
    ? "The provider's usage allowance is unavailable. Try later or choose another runtime."
    : /login|sign.?in|auth|401|403/i.test(detail)
      ? "Sign in to this runtime, then retry your saved message."
      : "The runtime stopped before completing its reply. Retry, choose another runtime, or continue manually.";
  return publicError(hint);
}
export class JsonLines {
  constructor(child, onMessage = () => {}) {
    this.child = child;
    this.next = 0;
    this.pending = new Map();
    this.waiters = new Set();
    this.buffer = "";
    this.bytes = 0;
    this.onMessage = onMessage;
    child.stdout.setEncoding("utf8");
    child.stderr.resume();
    child.stdout.on("data", (chunk) => {
      try {
        this.buffer += chunk;
        this.bytes += Buffer.byteLength(chunk);
        if (this.bytes > 2 * 1024 * 1024)
          throw publicError("The runtime output was too large.");
        if (Buffer.byteLength(this.buffer) > 2 * 1024 * 1024)
          throw publicError("The runtime output was too large.");
        let at;
        while ((at = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, at);
          this.buffer = this.buffer.slice(at + 1);
          if (!line.trim()) continue;
          const m = JSON.parse(line);
          if (m.method && m.id !== undefined) {
            this.send({
              id: m.id,
              error: {
                code: -32601,
                message: "Drafting has no tools or approval capabilities.",
              },
            });
            throw publicError(
              "The runtime requested a tool. This text-only drafting session was stopped.",
            );
          }
          this.onMessage(m);
          for (const w of this.waiters)
            if (w.match(m)) {
              this.waiters.delete(w);
              w.resolve(m);
            }
          if (m.id !== undefined && this.pending.has(m.id)) {
            const p = this.pending.get(m.id);
            this.pending.delete(m.id);
            m.error
              ? p.reject(runtimeFailure(JSON.stringify(m.error)))
              : p.resolve(m.result);
          }
        }
      } catch (e) {
        this.fail(e);
        child.stop();
      }
    });
    child.stdin.on("error", (e) => this.fail(e));
    child.once("error", (e) => this.fail(e));
    child.once("close", () => this.fail(runtimeFailure()));
  }
  fail(e) {
    this.failure ||= e;
    for (const p of [...this.pending.values(), ...this.waiters])
      p.reject(this.failure);
    this.pending.clear();
    this.waiters.clear();
  }
  send(m) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  }
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ id, method, params });
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  wait(match) {
    const p = new Promise((resolve, reject) => {
      if (this.failure) reject(this.failure);
      else this.waiters.add({ match, resolve, reject });
    });
    void p.catch(() => {});
    return p;
  }
  async close() {
    this.fail(publicError("Drafting session ended."));
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const closed = new Promise((resolve) => this.child.once("close", resolve));
    this.child.stop();
    await closed;
  }
}
