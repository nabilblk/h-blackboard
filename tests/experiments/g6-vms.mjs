// Explicit, opt-in preparation of three disposable Grok VMs. It never copies
// credentials, starts model turns, or touches production desktop profiles.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, statfs } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { LimaProvider } from "../../desktop/execution/lima.mjs";

const root = resolve("var/experiments/g6");
const file = join(root, "vms.json");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const action = process.argv[2];
assert.ok(
  ["prepare", "status", "stop"].includes(action),
  "Usage: node tests/experiments/g6-vms.mjs prepare|status|stop",
);
await mkdir(root, { recursive: true, mode: 0o700 });
let config = await readFile(file, "utf8")
  .then(JSON.parse)
  .catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
if (!config) {
  assert.equal(action, "prepare", "Prepare the experiment VMs first.");
  const directory = await mkdtemp("/tmp/hb-g6-");
  config = {
    version: 1,
    directory,
    participants: ["A", "B", "C"].map((label) => ({
      label,
      contribution: { id: randomUUID(), runtime: "grok" },
    })),
  };
  await writeFile(file, JSON.stringify(config, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
}
assert.equal(config.version, 1);
assert.match(config.directory, /^\/tmp\/hb-g6-[a-zA-Z0-9_-]+$/);
assert.deepEqual(
  config.participants.map((p) => p.label),
  ["A", "B", "C"],
);
const provider = new LimaProvider({ directory: config.directory });
for (const p of config.participants) {
  assert.equal(p.contribution.runtime, "grok");
  if (action === "stop") {
    console.log(
      p.label,
      await provider.terminate({ contribution: p.contribution }),
    );
    continue;
  }
  const wasRunning = (await provider.vm(p.contribution.id)).running;
  try {
    if (action === "prepare") {
      const fs = await statfs(config.directory);
      assert.ok(
        fs.bavail * fs.bsize >= 8 * 1024 ** 3,
        "Keep at least 8 GiB free before preparing the next test VM.",
      );
      console.log(
        `Preparing ${p.label}: ${provider.instance(p.contribution.id)}`,
      );
      await provider.prepare({ contribution: p.contribution });
      const login = await provider.login({ contribution: p.contribution });
      const command = `#!/bin/sh\nset -eu\nLIMA_HOME=${quote(config.directory)} ${quote(await provider.binary())} start --tty=false ${quote(provider.instance(p.contribution.id))}\n${login.command}\n`;
      await writeFile(join(root, `sign-in-${p.label}.sh`), command, {
        mode: 0o700,
      });
    } else {
      if (!(await provider.vm(p.contribution.id)).exists) {
        console.log(p.label, "not prepared");
        continue;
      }
      await provider.boot(p.contribution.id);
    }
    const state = await provider.inspect({ contribution: p.contribution });
    console.log(
      p.label,
      JSON.stringify({
        authenticated: state.authenticated,
        stopped: state.stopped,
        runtime: "grok",
      }),
    );
  } finally {
    // A status check must not stop an already-running login or execution.
    if (action === "prepare" || !wasRunning)
      await provider.terminate({ contribution: p.contribution });
  }
}
if (action === "prepare") {
  console.log("Prepared and stopped. Sign in separately inside each guest:");
  for (const p of config.participants)
    console.log(`sh ${quote(join(root, `sign-in-${p.label}.sh`))}`);
}
