// Opt-in real VM test. One disposable profile, no provider login, model calls,
// production missions or host credentials. Only public test metadata is fetched.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LimaProvider } from "../../desktop/execution/lima.mjs";

const directory = await mkdtemp("/tmp/hb-net-");
const provider = new LimaProvider({ directory });
const contribution = {
  id: randomUUID(),
  runtime: "grok",
  networkAccess: "restricted",
};
const evidence = { at: new Date().toISOString(), directory, checks: [] };
const out = join("var/desktop", `network-conformance-${Date.now()}`);
await mkdir(out, { recursive: true, mode: 0o700 });
const check = (name) => {
  evidence.checks.push(name);
  console.log("PASS", name);
};
const worker = async (code) => {
  const response = await provider.guest(
    contribution.id,
    [
      "python3",
      "-c",
      `
import sys
sys.path.insert(0, '/opt/harakiri')
from control import worker, inspect
r=worker(['python3','-c',${JSON.stringify(code)}],timeout=45)
print(r.stdout.decode()); print(r.stderr.decode(),file=sys.stderr)
assert inspect()['stopped'], 'worker processes survived command completion'
sys.exit(r.returncode)
`,
    ],
    { timeout: 60000 },
  );
  assert.match(response, /PASS/);
};
const closedNetwork = `
import socket, os
assert not os.environ.get('HTTPS_PROXY')
assert not os.path.exists('/run/harakiri-internet/proxy.sock')
for host,port in [('1.1.1.1',443),('127.0.0.1',18080),('192.168.5.2',22),('169.254.169.254',80)]:
    s=socket.socket(); s.settimeout(1)
    assert s.connect_ex((host,port)) != 0, (host,port)
    s.close()
print('PASS')`;
try {
  await provider.prepare({ contribution, onProgress: console.log });
  await worker(closedNetwork);
  await worker(
    "open('/workspace/preserved.txt','w').write('network-choice-test'); print('PASS')",
  );
  check("default restricted worker has no internet or proxy socket");
  await provider.terminate({ contribution });
  contribution.networkAccess = "internet";
  contribution.networkRevision = randomUUID();
  await provider.prepare({ contribution, onProgress: console.log });
  await worker(`
import os, json, urllib.request
assert os.environ['HTTPS_PROXY'].startswith('http://127.0.0.1:')
assert open('/workspace/preserved.txt').read() == 'network-choice-test'
with urllib.request.urlopen('https://registry.npmjs.org/is-number/latest',timeout=20) as r:
    data=json.load(r)
assert data['name']=='is-number' and data['dist']['tarball'].startswith('https://')
with urllib.request.urlopen(data['dist']['tarball'],timeout=20) as r:
    body=r.read(1024*1024)
assert body[:2] == b'\\x1f\\x8b'
open('/workspace/download.tgz','wb').write(body)
print('PASS')`);
  check(
    "public HTTPS metadata and package download work with TLS verification and existing files retained",
  );
  await worker(`
import socket,os,urllib.request,urllib.error
for host in ['127.0.0.1','192.168.5.2','10.0.0.1','172.16.0.1','100.100.100.200','169.254.169.254','[::1]','[fc00::1]','[::ffff:127.0.0.1]']:
    # Explicit proxy handler exercises proxy policy even for localhost.
    s=socket.socket(socket.AF_UNIX); s.connect('/run/harakiri-internet/proxy.sock')
    s.sendall(('CONNECT '+host+':443 HTTP/1.1\\r\\n\\r\\n').encode())
    assert b'403 Forbidden' in s.recv(4096), host
    s.close()
try: urllib.request.urlopen('http://example.com/',timeout=5)
except urllib.error.HTTPError as e: assert e.code == 403
else: raise AssertionError('plain HTTP allowed')
os.environ.clear()
for host,port in [('1.1.1.1',443),('127.0.0.1',18080),('192.168.5.2',22),('169.254.169.254',80)]:
    s=socket.socket();s.settimeout(1);assert s.connect_ex((host,port)) != 0,(host,port);s.close()
for family in [socket.AF_VSOCK, socket.AF_NETLINK]:
    try: socket.socket(family)
    except OSError: pass
    else: raise AssertionError('non-IP escape socket allowed')
for path in ['/home/hb-runtime','/run/harakiri','/Users','/opt/harakiri/policy']:
    assert not os.path.exists(path),path
try: os.unlink('/run/harakiri-internet/proxy.sock')
except OSError: pass
else: raise AssertionError('proxy socket writable')
print('PASS')`);
  check(
    "internet mode still denies private/metadata/host destinations, proxy bypass, vsock and credential access",
  );
  await provider.terminate({ contribution });
  contribution.networkAccess = "restricted";
  contribution.networkRevision = randomUUID();
  await provider.prepare({ contribution, onProgress: console.log });
  await worker(closedNetwork);
  await worker(
    "assert open('/workspace/download.tgz','rb').read(2)==b'\\x1f\\x8b'; print('PASS')",
  );
  check(
    "disabling access removes the proxy again and preserves downloaded work",
  );
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.error = error.message;
  throw error;
} finally {
  try {
    evidence.stopped = (await provider.terminate({ contribution })).stopped;
    if (evidence.stopped) {
      await provider.run([
        "delete",
        "--force",
        provider.instance(contribution.id),
      ]);
      await rm(directory, { recursive: true, force: true });
      evidence.removed = true;
    }
  } finally {
    await writeFile(
      join(out, "result.json"),
      JSON.stringify(evidence, null, 2),
      { mode: 0o600 },
    );
    console.log("Evidence:", out);
  }
}
