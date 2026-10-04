"""Run inside a disposable prepared VM. Inspect the pinned CLI's actual model
request against a loopback fixture, without a provider account or inference.
No real login store is read: the harness gets a fresh private config directory.
"""
import http.server
import json
import os
import pwd
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import uuid

sys.path.insert(0, "/opt/harakiri")
from control import runtime_properties, ENV
from runtimes import command, environment, private_directory, spec

runtime = spec()["runtime"]
assert runtime in ("claude", "codex")
captured = queue.Queue()


class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        size = int(self.headers.get("Content-Length", 0))
        assert size < 4 * 1024 * 1024
        body = json.loads(self.rfile.read(size))
        if body.get("tools"):
            captured.put(body["tools"])
        self.send_response(400)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"error":{"type":"invalid_request_error","message":"Intentional fixture completion: no model inference."}}')


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{server.server_port}"
directory = tempfile.mkdtemp(prefix="tool-surface-", dir=private_directory())
identity = pwd.getpwnam("hb-runtime")
os.chown(directory, identity.pw_uid, identity.pw_gid)
unit = "hb-surface-" + uuid.uuid4().hex
session = str(uuid.uuid4())
variables = environment()
variables.update({"HTTPS_PROXY": "http://127.0.0.1:18080", "HTTP_PROXY": "http://127.0.0.1:18080", "NO_PROXY": "127.0.0.1"})
if runtime == "claude":
    variables.update({"CLAUDE_CONFIG_DIR": directory, "ANTHROPIC_API_KEY": "fixture-not-a-secret", "ANTHROPIC_BASE_URL": base})
else:
    variables["CODEX_HOME"] = directory
    with open(private_directory() + "/config.toml", "rb") as f:
        approvals = tomllib.load(f)["mcp_servers"]["harakiri"]["tools"]
    with open("/opt/harakiri/tools.json") as f:
        expected_tools = {tool["name"] for tool in json.load(f)}
    assert set(approvals) == expected_tools, "Every scoped tool needs an explicit noninteractive policy"
    assert all(value == {"approval_mode": "approve"} for value in approvals.values())
    shutil.copyfile(private_directory() + "/config.toml", directory + "/config.toml")
    with open(directory + "/config.toml", "r+") as f:
        original = f.read()
        f.seek(0)
        f.write('model = "gpt-5.4"\nmodel_provider = "fixture"\n' + original + f'''
[model_providers.fixture]
name = "Fixture"
base_url = "{base}"
wire_api = "responses"
requires_openai_auth = false
''')
args = ["systemd-run", "--quiet", "--pipe", "--wait", "--collect", "--unit=" + unit,
        "--slice=hb-agent.slice", "--uid=hb-runtime", "--working-directory=/home/hb-runtime/control"]
args += ["--property=" + p for p in runtime_properties(60)]
args += ["--setenv=" + k + "=" + v for k, v in variables.items()]
args += command((False, session))
process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=ENV)
output, errors = queue.Queue(), []


def read_output():
    for line in process.stdout:
        try:
            output.put(json.loads(line))
        except ValueError:
            output.put({"invalid": line[:256].decode(errors="replace")})
    output.put({"closed": True})


threading.Thread(target=read_output, daemon=True).start()
threading.Thread(target=lambda: errors.append(process.stderr.read(65536).decode(errors="replace")), daemon=True).start()


def send(value):
    process.stdin.write((json.dumps(value) + "\n").encode())
    process.stdin.flush()


def request(method, params):
    ident = str(uuid.uuid4())
    send({"id": ident, "method": method, "params": params})
    end = time.monotonic() + 25
    while time.monotonic() < end:
        message = output.get(timeout=25)
        if message.get("id") == ident:
            assert "error" not in message, message
            return message["result"]
        assert not message.get("closed"), errors
    raise AssertionError("Request timed out: " + method)


try:
    if runtime == "codex":
        request("initialize", {"clientInfo": {"name": "hb-surface-proof", "version": "1.0.0"}, "capabilities": {"experimentalApi": True}})
        send({"method": "initialized"})
        thread = request("thread/start", {"cwd": "/home/hb-runtime/control", "environments": [], "selectedCapabilityRoots": [], "runtimeWorkspaceRoots": [], "approvalPolicy": "never", "sandbox": "read-only"})["thread"]["id"]
        request("turn/start", {"threadId": thread, "environments": [], "runtimeWorkspaceRoots": [], "approvalPolicy": "never", "sandboxPolicy": {"type": "externalSandbox", "networkAccess": "restricted"}, "input": [{"type": "text", "text": "Say hello. Use no tools."}]})
    else:
        send({"type": "user", "session_id": session, "message": {"role": "user", "content": "Say hello. Use no tools."}, "parent_tool_use_id": None})
    try:
        tools = captured.get(timeout=40)
    except queue.Empty:
        raise AssertionError({"output": list(output.queue), "errors": errors})
    names = []
    for tool in tools:
        if tool.get("type") == "namespace":
            names += [tool["name"] + "." + item["name"] for item in tool["tools"]]
            continue
        assert tool.get("type", "function") in ("function", "custom"), tool
        names.append(tool["name"])
    prefix = "mcp__harakiri__" if runtime == "claude" else "mcp__harakiri."
    scoped = {prefix + name for name in ("board", "workspace_exec", "workspace_read", "workspace_write", "import_artifact", "publish_artifact")}
    allowed = scoped | ({"EndConversation"} if runtime == "claude" else {"update_plan", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource", "request_user_input", "skills.list", "skills.read"})
    assert scoped <= set(names), names
    assert set(names) <= allowed, names
    if runtime == "claude":
        init = next((m for m in list(output.queue) if m.get("type") == "system" and m.get("subtype") == "init"), None)
        assert init and init["session_id"] == session, list(output.queue)
        assert scoped <= set(init["tools"]) <= allowed, init["tools"]
    print(json.dumps({"runtime": runtime, "tools": names, "inference": False, "result": "PASS actual model-facing tool surface contains only scoped and reviewed inert tools"}))
finally:
    subprocess.run(["systemctl", "stop", unit], env=ENV, capture_output=True, timeout=10)
    process.wait(timeout=10)
    server.shutdown()
    shutil.rmtree(directory)
