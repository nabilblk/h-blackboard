import { spawn } from "node:child_process";
const jobs = [
  spawn(
    process.execPath,
    ["--env-file-if-exists=var/tunnel.env", "--watch", "server/http.mjs"],
    { stdio: "inherit" },
  ),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
    stdio: "inherit",
  }),
];
let closing = false;
function stop() {
  if (closing) return;
  closing = true;
  for (const job of jobs) job.kill("SIGTERM");
}
for (const job of jobs) {
  job.on("error", stop);
  job.on("exit", (code) => {
    if (!closing) {
      process.exitCode = code || 0;
      stop();
    }
  });
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
