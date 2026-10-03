import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";
const exec = promisify(execFile);
const file = new URL("../../src/desktop/node-contract.ts", import.meta.url);
const { stdout } = await exec(
  "cargo",
  ["run", "--quiet", "--locked", "--bin", "harakiri-node", "--", "--types"],
  { cwd: new URL("../..", import.meta.url), maxBuffer: 1024 * 1024 },
);
const generated = await format(stdout, { parser: "typescript" });
if (process.argv.includes("--check")) {
  if ((await readFile(file, "utf8")) !== generated)
    throw new Error(
      "Node contracts changed. Run npm run node:types and include the generated types.",
    );
} else await writeFile(file, generated);
