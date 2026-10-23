"""Run inside a disposable Grok VM: real ACP/MCP initialization, no prompt/login."""
import json
import os
import queue
import subprocess
import sys
import threading
import time
import uuid

sys.path.insert(0, "/opt/harakiri")
from control import ENV, runtime_properties
from runtimes import command, environment, spec

assert spec()["runtime"] == "grok"
report = "/home/hb-runtime/.grok/mcp-surface-proof.jsonl"
wrapper = "/opt/harakiri/proof-mcp.py"
# Only record protocol metadata. No board calls, credentials or mission data.
with open(wrapper, "w") as f:
    f.write('''import sys,json
sys.path.insert(0,"/opt/harakiri")
import mcp
original=mcp.Server.handle
def observed(self,method,params):
 value=original(self,method,params)
 with open("/home/hb-runtime/.grok/mcp-surface-proof.jsonl","a") as log:
  log.write(json.dumps({"method":method,"version":value.get("protocolVersion"),"tools":[t["name"] for t in value.get("tools",[])]})+"\\n")
 return value
mcp.Server.handle=observed
mcp.main()
''')
if os.path.exists(report):
    os.unlink(report)
unit = "hb-grok-surface-" + uuid.uuid4().hex
args = ["systemd-run", "--quiet", "--pipe", "--wait", "--collect", "--unit="+unit,
        "--slice=hb-agent.slice", "--uid=hb-runtime", "--working-directory=/home/hb-runtime/control"]
args += ["--property="+p for p in runtime_properties(45)]
# The CLI requires selecting an authentication method before session/new.
# This dummy local value is never used for inference. Direct egress is denied
# by runtime_properties and this test supplies no provider proxy.
args += ["--setenv="+k+"="+v for k,v in {**environment(),"XAI_API_KEY":"fixture-not-a-secret"}.items()]
process = subprocess.Popen(args+command(),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=ENV)
received, errors = queue.Queue(), []
def read_output():
    for line in process.stdout:
        try: received.put(json.loads(line))
        except ValueError: pass
    received.put({"closed":True})
threading.Thread(target=read_output,daemon=True).start()
threading.Thread(target=lambda:errors.append(process.stderr.read(32768).decode(errors="replace")),daemon=True).start()
def request(method,params):
    ident=uuid.uuid4().hex
    process.stdin.write((json.dumps({"jsonrpc":"2.0","id":ident,"method":method,"params":params})+"\n").encode())
    process.stdin.flush()
    end=time.monotonic()+20
    while time.monotonic()<end:
        value=received.get(timeout=max(.01,end-time.monotonic()))
        if value.get("id")==ident:
            assert "error" not in value,value
            return value["result"]
        assert not value.get("closed"),errors
    raise AssertionError("ACP request timed out")
try:
    request("initialize",{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"hb-mcp-proof","version":"1.0.0"}})
    request("authenticate",{"methodId":"xai.api_key","_meta":{"headless":True}})
    opened=request("session/new",{"cwd":"/home/hb-runtime/control","mcpServers":[{"name":"harakiri","command":"/usr/bin/python3","args":[wrapper],"env":[]}],"_meta":{"sessionKind":"headless","yoloMode":False}})
    assert isinstance(opened.get("sessionId"),str)
    records=[]
    end=time.monotonic()+10
    while time.monotonic()<end:
        if os.path.isfile(report):
            with open(report) as f: records=[json.loads(line) for line in f if line.strip()]
        if any(r["method"]=="tools/list" for r in records): break
        time.sleep(.1)
    with open("/opt/harakiri/tools.json") as f: expected={t["name"] for t in json.load(f)}
    advertised=next(r for r in records if r["method"]=="tools/list")
    initialized=next(r for r in records if r["method"]=="initialize")
    assert initialized["version"] in ("2024-11-05","2025-03-26","2025-06-18","2025-11-25")
    assert set(advertised["tools"])==expected
    print(json.dumps({"result":"PASS Grok MCP initialization and catalog loading","version":initialized["version"],"tools":sorted(expected),"inference":False}))
finally:
    subprocess.run(["systemctl","stop",unit],capture_output=True,env=ENV,timeout=10)
    process.wait(timeout=10)
    os.unlink(wrapper)
