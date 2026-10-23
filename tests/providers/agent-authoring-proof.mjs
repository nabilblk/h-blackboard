// Explicit opt-in real Linux jail proof. Fresh VM, no agent login or mission.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LimaProvider } from "../../desktop/execution/lima.mjs";
const directory = await mkdtemp("/tmp/hb-authoring-");
const provider = new LimaProvider({ directory });
const contribution = {
  id: randomUUID(),
  runtime: "grok",
  networkAccess: "restricted",
};
const evidence =
  process.argv[2] ?? "var/iterations/generic-capabilities-2026-10-12";
await mkdir(evidence, { recursive: true });
await writeFile(
  join(evidence, "authoring-vm.json"),
  JSON.stringify({ directory, contribution }, null, 2),
);
const checks = [];
try {
  await provider.prepare({ contribution, onProgress: console.log });
  const guest = async (code) =>
    provider.guest(contribution.id, [
      "python3",
      "-c",
      `import sys,json;sys.path.insert(0,'/opt/harakiri');from control import files,worker\n${code}`,
    ]);
  const probe = async (name, code) => {
    assert.match(await guest(code), /PASS/);
    checks.push(name);
    console.log("PASS " + name);
  };
  await probe(
    "general-purpose guest has Python and no preinstalled web toolkit",
    `r=worker(['python3','-c',"import json,pathlib,shutil;assert shutil.which('python3');assert not shutil.which('esbuild');assert not pathlib.Path('/usr/local/lib/harakiri-buildkit/web-artifact-1').exists();assert json.loads(pathlib.Path('/usr/local/lib/harakiri-buildkit/selected.json').read_text())['pack']=='general';print('PASS')"]);assert r.returncode==0,r.stderr;print(r.stdout.decode())`,
  );
  await probe(
    "range read, stale patch refusal, exact patch and complete project import",
    `import base64,hashlib
files({'action':'write','path':'src/main.js','base64':base64.b64encode(b'export const x = 41;').decode()})
r=files({'action':'read_text','path':'src/main.js','limit':8});assert r['next_offset']==8
try: files({'action':'patch','path':'src/main.js','sha256':'0'*64,'edits':[{'old':'41','new':'42'}]})
except ValueError: pass
else: raise AssertionError('stale write')
files({'action':'patch','path':'src/main.js','sha256':r['sha256'],'edits':[{'old':'41','new':'42'}]})
assert '42' in files({'action':'read_text','path':'src/main.js'})['text']
assert files({'action':'search','paths':['src/main.js'],'query':'42'})['matches'][0]['line']==1
files({'action':'import_project','destination':'review','files':[{'path':'a.txt','base64':'NDI='}]})
assert files({'action':'read_text','path':'review/a.txt'})['text']=='42'
for request in ({'action':'import_project','destination':'review','files':[{'path':'a.txt','base64':'YmFk'}]}, {'action':'import_project','destination':'broken','files':[{'path':'a.txt','base64':'NDI='},{'path':'../escape','base64':'NDI='}]}):
 try: files(request)
 except ValueError: pass
 else: raise AssertionError('invalid or overwriting project accepted')
assert files({'action':'read_text','path':'review/a.txt'})['text']=='42'
try: files({'action':'read_text','path':'broken/a.txt'})
except ValueError: pass
else: raise AssertionError('partial project exposed')
print('PASS')`,
  );
  contribution.capabilityPack = "web-3d";
  await provider.prepare({ contribution, onProgress: console.log });
  await probe(
    "offline Node and esbuild bundle Three.js under worker restrictions",
    `result=worker(['/bin/sh','-c','node --version && esbuild /usr/local/lib/harakiri-buildkit/web-artifact-1/three/build/three.module.js --bundle --format=esm --outfile=/workspace/three.js']);assert result.returncode==0, result.stderr;assert len(files({'action':'read_text','path':'three.js'})['text'])>1000;print('PASS')`,
  );
  await probe(
    "large stdout stays retrievable with explicit preview truncation",
    `result=worker(['python3','-I','/usr/local/lib/harakiri-command.py'],json.dumps({'command':"python3 -c 'print(\\\"x\\\"*40000)'",'timeout_seconds':10}).encode(),timeout=15)
r=json.loads(result.stdout);assert r['exitCode']==0,r;assert r['logs']['stdout']['preview_truncated'];assert not r['logs']['stdout']['capture_truncated']
receipt=json.loads(files({'action':'read_text','path':r['receipt']})['text']);assert receipt['tool']=='workspace_exec';assert receipt['logs']==r['logs']
f=files({'action':'read_text','path':r['logs']['stdout']['path'],'offset':32000,'limit':8001,'sha256':r['logs']['stdout']['sha256']});assert len(f['text'])==8001;assert f['next_offset'] is None;print('PASS')`,
  );
  await probe(
    "credentials and broker remain outside worker root; direct internet still denied",
    `code="import os,socket;assert not os.path.exists('/home/hb-runtime');assert not os.path.exists('/run/harakiri/mcp.sock');s=socket.socket();s.settimeout(1);assert s.connect_ex(('1.1.1.1',443))!=0;print('PASS')"
r=worker(['python3','-c',code]);assert r.returncode==0,r.stderr;print(r.stdout.decode())`,
  );
  contribution.capabilityPack = "general";
  await provider.prepare({ contribution, onProgress: console.log });
  await probe(
    "removing optional toolkit keeps workspace and generic authoring usable",
    `assert '42' in files({'action':'read_text','path':'src/main.js'})['text'];r=worker(['python3','-c',"import pathlib,shutil;assert not shutil.which('esbuild');assert not pathlib.Path('/usr/local/lib/harakiri-buildkit/web-artifact-1').exists();print('PASS')"]);assert r.returncode==0,r.stderr;print(r.stdout.decode())`,
  );
} finally {
  let stopped = false;
  try {
    stopped = (await provider.terminate({ contribution })).stopped;
    assert.equal(stopped, true, "Test VM termination must be confirmed");
  } finally {
    await writeFile(
      join(evidence, "authoring-proof.json"),
      JSON.stringify(
        { at: new Date().toISOString(), checks, directory, stopped },
        null,
        2,
      ),
    );
  }
}
