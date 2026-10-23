// Explicit opt-in: disposable VMs and loopback provider fixtures. No login,
// subscription inference, real mission or user runtime configuration is used.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { LimaProvider } from "../../desktop/execution/lima.mjs";

const requested = process.argv.slice(2);
const runtimes = requested.length ? requested : ["grok", "claude", "codex"];
assert.ok(
  runtimes.every((runtime) => ["grok", "claude", "codex"].includes(runtime)),
  "Choose grok, claude or codex",
);
const directory = await mkdtemp("/tmp/hb-catalog-");
const provider = new LimaProvider({ directory });
const evidence = "var/iterations/agent-experience-2026-10-11";
await mkdir(evidence, { recursive: true });
const results = [];
for (const runtime of runtimes) {
  const contribution = {
    id: randomUUID(),
    runtime,
    role: "agent",
    networkAccess: "restricted",
  };
  const result = { runtime, contribution, directory, passed: false };
  results.push(result);
  try {
    const state = await provider.prepare({
      contribution,
      onProgress: console.log,
    });
    assert.equal(state.authenticated, false);
    await provider.guest(contribution.id, ["tee", "/tmp/tool-surface.py"], {
      input: await readFile(
        runtime === "grok"
          ? "tests/providers/grok-mcp-surface.py"
          : "tests/providers/g5-tool-surface.py",
      ),
    });
    result.output = await provider.guest(
      contribution.id,
      ["python3", "/tmp/tool-surface.py"],
      { timeout: 90000 },
    );
    assert.match(
      result.output,
      /PASS (actual model-facing tool surface|Grok MCP initialization)/,
    );
    result.passed = true;
    console.log(result.output);
  } finally {
    result.stopped = (await provider.terminate({ contribution })).stopped;
    await writeFile(
      join(evidence, "runtime-catalog-proof.json"),
      JSON.stringify({ at: new Date().toISOString(), results }, null, 2),
      { mode: 0o600 },
    );
  }
}
