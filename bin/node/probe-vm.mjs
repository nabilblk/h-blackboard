// Opt-in feasibility infrastructure, separate from the desktop and real VMs.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  access,
  rm,
} from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const directory = join(root, "var/node/feasibility");
const path = join(directory, "vm-profile.json");
const version = "1.0.46";
const digest =
  "45b0943e736f00a249b9cf02af2be9e0749d97c09a6f55cfcf3029a1a836f23e";
const action = process.argv[2];
if (!["create", "start", "stop", "delete"].includes(action))
  throw new Error("Usage: node bin/node/probe-vm.mjs create|start|stop|delete");
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("The VM proof currently requires Apple Silicon macOS.");
await mkdir(directory, { recursive: true, mode: 0o700 });
let profile;
if (action === "create") {
  const exists = await access(path).then(
    () => true,
    () => false,
  );
  if (exists)
    throw new Error(
      "A test profile is already recorded. Start it, or explicitly delete it before creating another.",
    );
  profile = { lima_home: await mkdtemp("/tmp/hb-lima-"), instance: "proof" };
  await writeFile(path, JSON.stringify(profile, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
} else profile = JSON.parse(await readFile(path, "utf8"));
if (
  !/^(\/private)?\/tmp\/hb-lima-[a-zA-Z0-9_-]+$/.test(profile.lima_home) ||
  profile.instance !== "proof"
)
  throw new Error("Refusing an unrecognized VM profile.");
const env = { ...process.env, LIMA_HOME: profile.lima_home };
async function lima(args) {
  await new Promise((resolve, reject) => {
    const child = spawn("limactl", ["--tty=false", ...args], {
      env,
      cwd: root,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `Lima operation failed (${code}); recorded profile was preserved.`,
            ),
          ),
    );
  });
}
if (action === "create") {
  await lima([
    "create",
    "--name=proof",
    join(root, "tests/providers/lima-proof.yaml"),
  ]);
  await lima(["start", "proof"]);
  const guest = (args) =>
    exec(
      "limactl",
      [
        "shell",
        "--workdir=/tmp",
        "proof",
        "sudo",
        "-H",
        "-u",
        "agent-worker",
        "--",
        ...args,
      ],
      { env, timeout: 180000 },
    );
  await guest(["mkdir", "-p", "/home/agent-worker/.grok/bin"]);
  const binary = "/home/agent-worker/.grok/bin/grok";
  await guest([
    "curl",
    "--proto",
    "=https",
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    `https://x.ai/cli/grok-${version}-linux-aarch64`,
    "-o",
    binary,
  ]);
  const actual = (await guest(["sha256sum", binary])).stdout.split(" ")[0];
  if (actual !== digest) {
    await guest(["rm", "-f", binary]);
    throw new Error(
      "Guest runtime digest mismatch; the download was removed and never executed.",
    );
  }
  await guest(["chmod", "700", binary]);
  console.log((await guest([binary, "--version"])).stdout.trim());
  console.log("Guest login command (no host credentials are copied):");
  console.log(
    `LIMA_HOME=${profile.lima_home} limactl shell proof sudo -H -u agent-worker -- ${binary} login --device-auth`,
  );
} else if (action === "start") await lima(["start", "proof"]);
else if (action === "stop") await lima(["stop", "proof"]);
else {
  // Explicit deletion applies only to the dedicated proof instance. No personal
  // Lima/Colima VM is ever enumerated, stopped or deleted by this script.
  await lima(["delete", "--force", "proof"]);
  await rm(profile.lima_home, { recursive: true, force: true });
  await rm(path);
}
