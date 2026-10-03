// Opt-in subscription proof. Run fresh conformance first, then sign in in that
// guest. Nothing reads a host login store or copies credentials between VMs.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { LimaProvider } from "../../desktop/execution/lima.mjs";
import { runtimePolicy } from "../../desktop/execution/contract.mjs";

const runtime = process.argv[2];
runtimePolicy(runtime);
const directory = "var/node/g5-runtimes";
const proof = JSON.parse(
  await readFile(`${directory}/${runtime}-conformance.json`, "utf8"),
);
assert.equal(proof.contribution.runtime, runtime);
assert.match(proof.directory, /^\/tmp\/hb-g5-[a-zA-Z0-9_-]+$/);
const provider = new LimaProvider({ directory: proof.directory });
const contribution = proof.contribution;
if (process.argv.includes("--login")) {
  // Boot only the disposable fixture and print the native guest command.
  // Leave it running so the developer can complete the interactive login.
  console.log((await provider.login({ contribution })).command);
  process.exit(0);
}
const events = [],
  permissions = [],
  results = [];
let session = null;
try {
  await provider.boot(contribution.id);
  assert.ok(
    (await provider.inspect({ contribution })).authenticated,
    "Complete guest-native login first",
  );
  for (const resume of [false, true]) {
    const handle = await provider.launch({
      contribution,
      session: resume ? session : null,
      seconds: 240,
      prompt: resume
        ? "This is the second isolated conformance turn. Recall the marker from our first turn. Use workspace_read to read runtime-proof.txt, then workspace_exec to run python3 -c 'print(6 * 7)'. Write resumed.txt containing the marker from our first turn and the number printed. Use only the scoped harakiri tools. Finish now; there is no mission."
        : "This is an isolated runtime conformance test, not a mission. Remember the marker 'orbit-42'. Use only the provided harakiri workspace tools. First use workspace_exec to run python3 -c 'print(6 * 7)'. Then workspace_write to create runtime-proof.txt containing exactly 'orbit-42'. Finally workspace_read it back. Do not use board operations or the network. Finish after these three tool calls.",
      onSession(value) {
        if (resume) assert.equal(value, session);
        session = value;
      },
      onEvent(value) {
        events.push(value);
        if (value.update?.sessionUpdate === "tool_call")
          console.log("tool", value.update.title);
      },
      async onTool(tool) {
        permissions.push(tool);
        if (tool === "check_permission") return { allowed: true };
        throw new Error("No mission authority in this runtime test.");
      },
    });
    results.push(await handle.done);
    assert.ok(session);
    assert.ok(permissions.length >= (resume ? 6 : 3));
    assert.equal((await provider.terminate({ contribution })).stopped, true);
  }
  const output = await provider.exportFiles({ contribution });
  assert.equal(
    Buffer.from(
      output.files.find((f) => f.path === "runtime-proof.txt").base64,
      "base64",
    )
      .toString()
      .trim(),
    "orbit-42",
  );
  const resumed = Buffer.from(
    output.files.find((f) => f.path === "resumed.txt").base64,
    "base64",
  ).toString();
  assert.match(resumed, /orbit-42/);
  assert.match(resumed, /42/);
  await writeFile(
    `${directory}/${runtime}-live.json`,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        session,
        results,
        permissions,
        events,
        checks: [
          "real subscription inference",
          "scoped exec/read/write",
          "native session resume after VM shutdown",
          "exact workspace output",
        ],
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    `PASS ${runtime} real inference, scoped tools, stop and saved-session resume`,
  );
} finally {
  await provider.terminate({ contribution });
  await writeFile(
    `${directory}/${runtime}-live-last.json`,
    JSON.stringify({ session, results, permissions, events }, null, 2),
    { mode: 0o600 },
  );
}
