// Opt-in real Grok subscription test in the recorded G0 VM. Credentials stay
// inside that guest; only the one native login file changes guest ownership.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { LimaProvider } from "../../desktop/execution/lima.mjs";

const proof = JSON.parse(
  await readFile("var/node/feasibility/vm-profile.json", "utf8"),
);
assert.match(proof.lima_home, /^(\/private)?\/tmp\/hb-lima-[a-zA-Z0-9_-]+$/);
assert.equal(proof.instance, "proof");
const provider = new LimaProvider({ directory: proof.lima_home });
provider.instance = () => "proof";
const contribution = { id: randomUUID(), runtime: "grok" };
await provider.boot(contribution.id);
await provider.prepare({ contribution });
if (!(await provider.inspect({ contribution })).authenticated)
  await provider.guest(contribution.id, [
    "install",
    "-m",
    "0600",
    "-o",
    "hb-runtime",
    "-g",
    "hb-runtime",
    "/home/agent-worker/.grok/auth.json",
    "/home/hb-runtime/.grok/auth.json",
  ]);
const events = [],
  tools = [];
let session = null;
await mkdir("var/node/g5", { recursive: true, mode: 0o700 });
try {
  const handle = await provider.launch({
    contribution,
    seconds: 180,
    prompt:
      "This is an isolated runtime conformance test, not a mission. Use only the provided harakiri workspace tools. First use workspace_exec to run python3 -c 'print(6 * 7)'. Then use workspace_write to create g5-runtime.txt containing exactly '42'. Finally read it back using workspace_read and report success. Do not request board operations, spawn agents or use the network. Finish after these three tool calls.",
    onSession: (value) => {
      session = value;
    },
    onEvent: (event) => {
      events.push(event);
      if (event.update?.sessionUpdate === "tool_call")
        console.log("tool", event.update.title);
    },
    onTool: async (tool) => {
      tools.push(tool);
      if (tool === "check_permission") return { allowed: true };
      throw new Error("This conformance test has no mission authority.");
    },
  });
  const result = await handle.done;
  assert.ok(session);
  assert.ok(tools.length >= 3, "Real MCP workspace calls must occur");
  const file = await provider.guest(contribution.id, [
    "python3",
    "-c",
    "import sys,json;sys.path.insert(0,'/opt/harakiri');from control import files;print(json.dumps(files({'action':'read','path':'g5-runtime.txt'})))",
  ]);
  assert.equal(
    Buffer.from(JSON.parse(file).base64, "base64").toString().trim(),
    "42",
  );
  // Validate what the pinned harness actually sent to the model, not just
  // what its YAML declares. No native file/shell/subagent tools may appear.
  const schema = JSON.parse(
    await provider.guest(contribution.id, [
      "python3",
      "-c",
      "import os,json;out=[]\nfor root,dirs,files in os.walk('/home/hb-runtime/.grok'):\n if 'tool_definitions.json' in files:\n  with open(os.path.join(root,'tool_definitions.json')) as f: out.append([t['function']['name'] for t in json.load(f)])\nprint(json.dumps(out))",
    ]),
  );
  assert.ok(
    schema.length,
    "Pinned runtime must expose its actual tool definitions for conformance",
  );
  for (const names of schema)
    for (const name of names)
      assert.ok(
        ["search_tool", "use_tool"].includes(name) || /^harakiri__/.test(name),
        `Unexpected native tool: ${name}`,
      );
  await writeFile(
    "var/node/g5/grok-live.json",
    JSON.stringify(
      { at: new Date().toISOString(), session, result, tools, schema, events },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log("PASS isolated Grok MCP tools and native-tool exclusion");
} finally {
  await provider.terminate({ contribution });
  await writeFile(
    "var/node/g5/grok-live-last.json",
    JSON.stringify({ session, tools, events }, null, 2),
    { mode: 0o600 },
  );
}
