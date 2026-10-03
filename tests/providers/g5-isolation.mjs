// Explicit opt-in: harden the existing, isolated G0 proof VM. No production
// mission, host credentials or global runtime configuration is accessed.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { LimaProvider } from "../../desktop/execution/lima.mjs";

const proof = JSON.parse(
  await readFile("var/node/feasibility/vm-profile.json", "utf8"),
);
assert.match(proof.lima_home, /^(\/private)?\/tmp\/hb-lima-[a-zA-Z0-9_-]+$/);
assert.equal(proof.instance, "proof");
const provider = new LimaProvider({ directory: proof.lima_home });
// The production resolver is UUID-only. This test deliberately targets the
// one recorded feasibility VM and never enumerates a person's Lima instances.
provider.instance = () => "proof";
const contribution = { id: randomUUID(), runtime: "grok" };
await provider.boot(contribution.id);
await provider.guest(contribution.id, [
  "install",
  "-d",
  "-m",
  "0755",
  "/opt/harakiri",
]);
await provider.guest(contribution.id, [
  "install",
  "-m",
  "0755",
  "/home/agent-worker/.grok/bin/grok",
  "/opt/harakiri/grok",
]);
await provider.prepare({ contribution });
const checks = [];
const probe = async (name, code) => {
  const output = await provider.guest(contribution.id, [
    "python3",
    "-c",
    `import sys; sys.path.insert(0,'/opt/harakiri'); from control import worker\nr=worker(['python3','-c',${JSON.stringify(code)}]); print(r.stdout.decode()); print(r.stderr.decode(),file=sys.stderr); sys.exit(r.returncode)`,
  ]);
  assert.match(output, /PASS/);
  checks.push(name);
  console.log(`PASS ${name}`);
};
await probe(
  "workspace writes work",
  "from pathlib import Path; p=Path('/workspace/g5-isolation.txt'); p.write_text('isolated'); assert p.read_text() == 'isolated'; print('PASS')",
);
await probe(
  "credentials, host files, policy and control sockets are outside worker root",
  `import os
for p in ['/home/hb-runtime/.grok/auth.json','/opt/harakiri/agent.md','/run/harakiri/mcp.sock','/Users/labs','/proc/1/root/home/hb-runtime']:
 try: os.open(p,os.O_RDONLY)
 except (FileNotFoundError,PermissionError,NotADirectoryError): continue
 raise AssertionError(p)
print('PASS')`,
);
await probe(
  "worker has no external or runtime-proxy network",
  `import socket
for host,port in [('1.1.1.1',443),('127.0.0.1',18080),('192.168.5.2',22),('169.254.169.254',80)]:
 s=socket.socket(); s.settimeout(1)
 assert s.connect_ex((host,port)) != 0
 s.close()
print('PASS')`,
);
await probe(
  "worker cannot regain root or modify system files",
  `import os
try: os.setuid(0)
except PermissionError: pass
else: raise AssertionError('root')
try: open('/usr/local/lib/harakiri-files.py','w')
except (PermissionError,OSError): pass
else: raise AssertionError('policy writable')
print('PASS')`,
);
const transfer = async (request) =>
  JSON.parse(
    await provider.guest(
      contribution.id,
      [
        "python3",
        "-c",
        "import sys,json;sys.path.insert(0,'/opt/harakiri');from control import files;print(json.dumps(files(json.load(sys.stdin))))",
      ],
      { input: JSON.stringify(request) },
    ),
  );
await transfer({
  action: "write",
  path: "g5/nested/result.txt",
  base64: Buffer.from("exact bytes").toString("base64"),
});
assert.equal(
  Buffer.from(
    (await transfer({ action: "read", path: "g5/nested/result.txt" })).base64,
    "base64",
  ).toString(),
  "exact bytes",
);
for (const path of [
  "../home/hb-runtime/.grok/auth.json",
  "/etc/passwd",
  "g5/../../secret",
])
  await assert.rejects(transfer({ action: "read", path }));
checks.push("workspace transfers reject traversal and preserve bytes");
await probe(
  "symlink and hardlink exports rejected",
  `import os,subprocess,json
for p in ['/workspace/g5-symlink','/workspace/g5-hardlink']:
 try: os.unlink(p)
 except FileNotFoundError: pass
os.symlink('/usr/bin/python3','/workspace/g5-symlink')
os.link('/workspace/g5-isolation.txt','/workspace/g5-hardlink')
for p in ['g5-symlink','g5-hardlink']:
 r=subprocess.run(['python3','/usr/local/lib/harakiri-files.py'],input=json.dumps({'action':'read','path':p}),capture_output=True,text=True)
 assert r.returncode != 0
os.unlink('/workspace/g5-symlink'); os.unlink('/workspace/g5-hardlink')
print('PASS')`,
);
await mkdir("var/node/g5", { recursive: true, mode: 0o700 });
await writeFile(
  "var/node/g5/isolation.json",
  JSON.stringify({ at: new Date().toISOString(), checks }, null, 2),
  { mode: 0o600 },
);
console.log(`${checks.length} isolation checks passed.`);
