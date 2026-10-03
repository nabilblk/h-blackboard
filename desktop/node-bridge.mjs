import { spawn } from "node:child_process";

const MAX_FRAME = 6 * 1024 * 1024;
const MAX_PENDING = 32;
const TIMEOUT = 15000;

// This bridge belongs to the native host. The renderer receives named methods,
// never binary/profile paths, key material, arbitrary commands or raw frames.
export class NodeBridge {
  constructor(binary, bootstrap) {
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.failed = null;
    this.child = spawn(binary, ["--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      // No provider credentials, debug flags or dynamic loader overrides cross
      // from the user's shell into the node service.
      env: { PATH: "/usr/bin:/bin" },
    });
    this.closed = new Promise((done) => this.child.once("close", done));
    this.ready = new Promise((resolve, reject) => {
      this.hello = { resolve, reject };
      this.startupTimer = setTimeout(() => this.fail(), TIMEOUT);
    });
    this.child.once("error", () => this.fail());
    this.child.once("close", () => this.fail());
    this.child.stdin.on("error", () => this.fail());
    this.child.stderr.resume(); // Service diagnostics never contain prompts/keys.
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.send(bootstrap);
  }

  send(value) {
    if (this.failed) throw this.failed;
    const payload = Buffer.from(JSON.stringify(value));
    if (!payload.length || payload.length > 128 * 1024)
      throw new Error("The node request is too large.");
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(payload.length);
    this.child.stdin.write(prefix);
    this.child.stdin.write(payload, () => payload.fill(0));
  }

  consume(chunk) {
    if (this.failed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32BE();
        if (!length || length > MAX_FRAME) throw new Error("frame");
        if (this.buffer.length < length + 4) break;
        const result = JSON.parse(this.buffer.subarray(4, length + 4));
        this.buffer = this.buffer.subarray(length + 4);
        if (this.hello) {
          if (
            result.ready !== true ||
            result.version !== 1 ||
            result.network !== "disabled" ||
            result.execution !== "unavailable" ||
            !/^[a-f0-9]{64}$/.test(result.identity?.owner || "") ||
            !/^[a-f0-9]{64}$/.test(result.identity?.endpoint || "")
          )
            throw new Error("handshake");
          clearTimeout(this.startupTimer);
          this.hello.resolve(result.identity);
          this.hello = null;
        } else {
          const pending = this.pending.get(result.id);
          if (!pending || typeof result.ok !== "boolean")
            throw new Error("response");
          clearTimeout(pending.timer);
          this.pending.delete(result.id);
          if (result.ok) pending.resolve(result.value);
          else
            pending.reject(
              new Error(
                "The node rejected this change. Check the mission fields and current state.",
              ),
            );
        }
      }
      if (this.buffer.length > MAX_FRAME + 4) throw new Error("buffer");
    } catch {
      this.fail();
    }
  }

  fail() {
    if (this.failed) return;
    this.failed = new Error(
      "The local node stopped or refused its profile. Your records are preserved. Restart the app; if this repeats, restore the original protected profile.",
    );
    clearTimeout(this.startupTimer);
    this.hello?.reject(this.failed);
    this.hello = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failed);
    }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    this.child.kill("SIGKILL");
  }

  async request(command) {
    await this.ready;
    if (this.failed) throw this.failed;
    if (this.pending.size >= MAX_PENDING)
      throw new Error("The local node is busy. Try again shortly.");
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(), TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, command });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async close() {
    if (!this.failed) {
      try {
        await this.request({ type: "shutdown" });
      } catch {
        /* Already closed. */
      }
    }
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 1000);
    try {
      await this.closed;
    } finally {
      clearTimeout(timer);
    }
  }
}
