// Opt-in real VM conformance. Creates a fresh, disposable Lima home. No model
// calls, host/guest login stores or production desktop profiles are used.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { LimaProvider } from "../../desktop/execution/lima.mjs";
import { runtimePolicy } from "../../desktop/execution/contract.mjs";

// macOS' default temporary path is itself too long for Lima UNIX sockets.
const directory = await mkdtemp("/tmp/hb-g5-");
const provider = new LimaProvider({ directory });
const runtime = process.argv[2] || "grok";
runtimePolicy(runtime);
const contribution = { id: randomUUID(), runtime };
const evidence =
  runtime === "grok"
    ? "var/node/g5/provider-conformance.json"
    : `var/node/g5-runtimes/${runtime}-conformance.json`;
await mkdir(dirname(evidence), { recursive: true, mode: 0o700 });
await writeFile(evidence, JSON.stringify({ directory, contribution }), {
  mode: 0o600,
});
const checks = [];
const check = (name) => {
  checks.push(name);
  console.log("PASS", name);
};
const python = (code, options) =>
  provider.guest(contribution.id, ["python3", "-c", code], options);
try {
  console.log("Preparing fresh pinned VM", directory);
  const state = await provider.prepare({ contribution });
  assert.equal(state.authenticated, false);
  assert.equal(state.stopped, true);
  check(`fresh pinned Ubuntu/${runtime} provisioning without inherited login`);
  const runtimeProbe = `import sys,subprocess,socket
sys.path.insert(0,'/opt/harakiri')
from control import runtime_properties,ENV
code=${JSON.stringify(`import socket,os
for host,port in [('1.1.1.1',443),('169.254.169.254',80),('192.168.5.2',22)]:
 s=socket.socket(); s.settimeout(1); assert s.connect_ex((host,port)) != 0; s.close()
for path in ['/workspace','/opt/harakiri/agent.md','/opt/harakiri/policy']:
 try: open(path,'w')
 except OSError: pass
 else: raise AssertionError(path)
for host in ['127.0.0.1','169.254.169.254','example.com']:
 s=socket.create_connection(('127.0.0.1',18080),2); s.sendall(('CONNECT '+host+':443 HTTP/1.1\\r\\n\\r\\n').encode()); assert b'403' in s.recv(1024); s.close()
print('PASS')`)}
args=['systemd-run','--quiet','--pipe','--wait','--collect','--unit=hb-egress-proof','--slice=hb-agent.slice','--uid=hb-runtime','--working-directory=/home/hb-runtime/control']
args += ['--property='+p for p in runtime_properties(30)]
result=subprocess.run(args+['python3','-c',code],capture_output=True,env=ENV)
print(result.stdout.decode());print(result.stderr.decode(),file=sys.stderr);sys.exit(result.returncode)`;
  assert.match(await python(runtimeProbe, { timeout: 45000 }), /PASS/);
  check(
    "actual runtime cgroup denies direct Internet/LAN/metadata and proxy denies other destinations",
  );
  assert.match(
    await python(
      `import sys,subprocess,json,os,time
sys.path.insert(0,'/opt/harakiri');from control import worker,inspect
code=${JSON.stringify(`import os,signal,time
for path in ['/home/hb-runtime/.grok','/home/hb-runtime/.claude','/home/hb-runtime/.codex','/run/harakiri','/Users','/proc/1/root/home']:
 try: os.listdir(path)
 except OSError: pass
 else: raise AssertionError(path)
if os.fork()==0:
 os.setsid();signal.signal(signal.SIGTERM,signal.SIG_IGN)
 while True: time.sleep(1)
print('PASS',flush=True)`)}
r=worker(['python3','-c',code],timeout=3)
print(r.stdout.decode())
assert inspect()['stopped'], 'detached worker escaped the execution slice'
`,
      { timeout: 20000 },
    ),
    /PASS/,
  );
  check(
    "detached SIGTERM-resistant worker and credential/proc escape attempts confined",
  );
  // Simulate losing the desktop transport: a root transient session's lease
  // must stop the entire slice without a live host monitor.
  await python(
    `import subprocess,time,sys
sys.path.insert(0,'/opt/harakiri');from control import inspect
child=['systemd-run','--quiet','--collect','--unit=hb-orphan-proof','--slice=hb-agent.slice','--property=TimeoutStopSec=1','python3','-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(120)']
subprocess.run(child,check=True)
session=['systemd-run','--quiet','--collect','--unit=hb-session','--property=RuntimeMaxSec=2','--property=TimeoutStopSec=1','--property=KillMode=control-group','--property=ExecStopPost=/usr/bin/systemctl stop hb-agent.slice','sleep','120']
subprocess.run(session,check=True)
assert not inspect()['stopped']
end=time.monotonic()+12
while time.monotonic()<end:
 if inspect()['stopped']:break
 time.sleep(.1)
else:raise AssertionError('guest lease did not stop orphan')
print('PASS')`,
    { timeout: 20000 },
  );
  check(
    "guest lease tears down complete process tree after host transport disappears",
  );
  await provider.importFiles({
    contribution,
    files: [
      {
        path: "import.txt",
        base64: Buffer.from("reviewed input").toString("base64"),
      },
    ],
  });
  const exported = await provider.exportFiles({ contribution });
  assert.equal(
    Buffer.from(
      exported.files.find((f) => f.path === "import.txt").base64,
      "base64",
    ).toString(),
    "reviewed input",
  );
  check("explicit import/export preserves bytes without host mounts");
} finally {
  const stopped = await provider.terminate({ contribution });
  assert.equal(stopped.stopped, true);
  check("VM stop confirmed by hypervisor state");
  await mkdir("var/node/g5", { recursive: true, mode: 0o700 });
  await writeFile(
    evidence,
    JSON.stringify(
      { at: new Date().toISOString(), directory, contribution, checks },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
