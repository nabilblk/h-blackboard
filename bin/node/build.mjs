// G0 sidecar packaging proof. It does not change the installed desktop bundle.
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdir, copyFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeNodeInventory } from "./licenses.mjs";
const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const host = (await exec("rustc", ["-vV"], { cwd: root })).stdout.match(
  /^host: (.+)$/m,
)?.[1];
if (!host || process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("The packaging proof currently supports macOS arm64 only.");
await new Promise((resolve, reject) => {
  const child = spawn(
    "cargo",
    ["build", "--locked", "--release", "--bin", "harakiri-node-proof"],
    { cwd: root, stdio: "inherit" },
  );
  child.on("error", reject);
  child.on("exit", (code) =>
    code === 0 ? resolve() : reject(new Error(`Node build failed (${code})`)),
  );
});
const output = join(root, "var/node/package", host);
await mkdir(output, { recursive: true });
const binary = join(output, "harakiri-node-proof");
await copyFile(
  join(root, "var/node/target/release/harakiri-node-proof"),
  binary,
);
// A local ad-hoc signature proves the nested executable can be signed. It is
// not Developer ID signing, notarization or approval for public distribution.
await exec("/usr/bin/codesign", ["--force", "--sign", "-", binary]);
await exec("/usr/bin/codesign", ["--verify", "--strict", binary]);
console.log(
  JSON.stringify(
    await writeNodeInventory({
      output,
      binary,
      component: "harakiri-node-proof",
      signature: "ad-hoc-development-only",
    }),
    null,
    2,
  ),
);
