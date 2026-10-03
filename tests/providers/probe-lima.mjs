// Opt-in G0 proof against a freshly provisioned test VM. Never part of npm test.
// No login, model request, host credential transfer or existing VM is performed.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const exec = promisify(execFile);
const profilePath = process.argv[2];
if (!profilePath)
  throw new Error("Pass the JSON profile of an isolated G0 Lima VM.");
const profile = JSON.parse(await readFile(profilePath, "utf8"));
assert.match(profile.lima_home, /^(\/private)?\/tmp\/hb-lima-[a-zA-Z0-9_-]+$/);
assert.equal(profile.instance, "proof");
const env = { ...process.env, LIMA_HOME: profile.lima_home };
const guest = async (...args) =>
  (
    await exec("limactl", ["shell", "--workdir=/tmp", "proof", ...args], {
      env,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim();
const root = (...args) => guest("sudo", "--", ...args);
const worker = (...args) =>
  guest("sudo", "-H", "-u", "agent-worker", "--", ...args);
const evidence = [];
const check = (name, result) => {
  assert.ok(result, name);
  evidence.push({ name, passed: true });
};
const temporary = await mkdtemp(join(tmpdir(), "hb-host-canary-"));
const hostCanary = join(temporary, "host-only.txt");
await writeFile(hostCanary, "This file must not be mounted into a guest.", {
  mode: 0o600,
});
const unit = `harakiri-g0-${randomUUID()}`;
const pidFile = `/workspace/${unit}.pid`;
const readyFile = `/workspace/${unit}.ready`;
try {
  const identity = await worker("id");
  check(
    "worker has no administrative group",
    identity.includes("agent-worker") &&
      !/\b(sudo|wheel|docker)\b/.test(identity),
  );
  const filesystem = JSON.parse(
    await worker(
      "python3",
      "-c",
      `import os,json,socket,subprocess
checks={"host_canary_unavailable":not os.path.exists(${JSON.stringify(hostCanary)}),"host_home_unmounted":not os.path.exists("/Users"),"no_container_socket":not os.path.exists("/var/run/docker.sock"),"no_ssh_agent":not bool(os.getenv("SSH_AUTH_SOCK"))}
checks["sudo_denied"]=subprocess.run(["sudo","-n","true"],capture_output=True).returncode != 0
try:
 open("/root/hb-probe-secret", "r").read(); checks["root_files_denied"]=False
except PermissionError: checks["root_files_denied"]=True
open("/workspace/hb-persist-fixture.txt","w").write("persisted fixture")
checks["workspace_write"]=open("/workspace/hb-persist-fixture.txt").read()=="persisted fixture"
print(json.dumps(checks))`,
    ),
  );
  for (const [name, value] of Object.entries(filesystem)) check(name, value);
  // PrivateNetwork is applied to this test unit only, leaving an independent
  // guest login usable. G5 must additionally provide a tested provider allowlist.
  const network = await root(
    "systemd-run",
    "--quiet",
    "--wait",
    "--pipe",
    "--collect",
    "--uid=agent-worker",
    "--property=PrivateNetwork=yes",
    "--property=NoNewPrivileges=yes",
    "--property=CapabilityBoundingSet=",
    "--property=RestrictNamespaces=yes",
    "--property=ProtectControlGroups=yes",
    "python3",
    "-c",
    `import socket,subprocess
for address in ["1.1.1.1","169.254.169.254","192.168.5.2"]:
 s=socket.socket();s.settimeout(1)
 try:
  s.connect((address,443));raise AssertionError("forbidden destination reachable")
 except OSError:pass
 finally:s.close()
assert subprocess.run(["unshare","-n","true"],capture_output=True).returncode != 0
print("network-confinement-passed")`,
  );
  check(
    "deny-all network and namespace escape denied",
    network.includes("network-confinement-passed"),
  );

  // The child starts a new session and ignores SIGTERM. Killing only the parent
  // would leave it alive; the cgroup must be empty before stop is acknowledged.
  const childCode = `import signal,time,pathlib; signal.signal(signal.SIGTERM,signal.SIG_IGN); pathlib.Path('${readyFile}').touch(); time.sleep(300)`;
  const code = `import subprocess,time,os
p=subprocess.Popen(["python3","-c",${JSON.stringify(childCode)}],start_new_session=True)
open(${JSON.stringify(pidFile)},"w").write(str(p.pid))
time.sleep(300)`;
  await root(
    "systemd-run",
    "--quiet",
    "--collect",
    `--unit=${unit}`,
    "--uid=agent-worker",
    "--property=NoNewPrivileges=yes",
    "--property=KillMode=control-group",
    "--property=TimeoutStopSec=1",
    "--property=SendSIGKILL=yes",
    "--property=RestrictNamespaces=yes",
    "--property=ProtectControlGroups=yes",
    "python3",
    "-c",
    code,
  );
  const childPid = await worker(
    "python3",
    "-c",
    `import pathlib,time
p=pathlib.Path(${JSON.stringify(pidFile)})
for _ in range(100):
 if p.exists() and pathlib.Path(${JSON.stringify(readyFile)}).exists(): print(p.read_text());break
 time.sleep(.02)
else: raise RuntimeError("child did not start")`,
  );
  assert.match(childPid, /^[1-9][0-9]*$/);
  await root("systemctl", "stop", unit);
  const inactive = await root(
    "systemctl",
    "show",
    unit,
    "--property=ActiveState",
    "--value",
  );
  check("process unit has stopped", ["inactive", "failed"].includes(inactive));
  const stopped = await root(
    "python3",
    "-c",
    `import pathlib
p=pathlib.Path("/proc/${childPid}/stat")
print("stopped" if not p.exists() or p.read_text().split()[2]=="Z" else "running")`,
  );
  check("detached SIGTERM-resistant child terminated", stopped === "stopped");
  check(
    "workspace survives process termination",
    (await worker("cat", "/workspace/hb-persist-fixture.txt")) ===
      "persisted fixture",
  );
  const runtime = await worker(
    "/home/agent-worker/.grok/bin/grok",
    "--version",
  );
  check("Grok Linux ARM64 binary launches", runtime.startsWith("grok "));
  const digest = (
    await worker("sha256sum", "/home/agent-worker/.grok/bin/grok")
  ).split(" ")[0];
  const report = {
    date: new Date().toISOString(),
    runtime,
    binarySha256: digest,
    provider: "Lima VZ / Ubuntu ARM64 / unprivileged worker",
    checks: evidence,
    authentication: "requires independent guest login",
    allowedProviderEgress: "not yet implemented",
    runtimeResume: "not yet tested",
    enforcementStatus: "feasibility only; not a production provider",
  };
  const evidencePath = resolve("var/node/feasibility/vm-evidence.json");
  await writeFile(evidencePath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await root("systemctl", "stop", unit).catch(() => {});
  await root(
    "rm",
    "-f",
    pidFile,
    readyFile,
    "/workspace/hb-persist-fixture.txt",
  ).catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
