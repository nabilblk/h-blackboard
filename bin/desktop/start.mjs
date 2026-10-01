import electron from "electron";
import { spawn } from "node:child_process";
import { buildDesktop } from "./build.mjs";

const output = await buildDesktop();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [output, ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
