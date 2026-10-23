"""Multiplex ACP and scoped board tools over a host-owned SSH stdio channel.

No listening host port, bearer token, signing key or host path enters the VM.
The guest Unix socket authenticates its peer with kernel SO_PEERCRED.
"""
import base64
import hashlib
import concurrent.futures
import json
import os
import pwd
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import uuid
from control import ENV, files, worker, runtime_properties
from runtimes import command, environment
from artifact_io import BoardError, import_artifact, import_project, publication_preflight, publication_context, valid_path
from operations import Operation, fingerprint
from checkpoint import capture as capture_checkpoint

MAX_LINE = 2 * 1024 * 1024
output_lock = threading.Lock()
pending = {}
pending_lock = threading.Lock()
stopping = threading.Event()
runtime = None
deadline = time.monotonic() + int(sys.argv[1])


def emit(value):
    raw = json.dumps(value)
    if len(raw.encode()) > MAX_LINE:
        raise ValueError("Transport message too large")
    with output_lock:
        print(raw, flush=True)


def board(tool, arguments):
    request = uuid.uuid4().hex
    future = concurrent.futures.Future()
    with pending_lock:
        if len(pending) >= 4:
            raise ValueError("Too many pending board operations")
        pending[request] = future
    try:
        emit({"kind": "tool", "id": request, "tool": tool, "arguments": arguments})
        return future.result(timeout=max(0.1, min(60, deadline - time.monotonic())))
    finally:
        with pending_lock:
            pending.pop(request, None)


def serve_tool(connection):
    with connection:
        connection.settimeout(150)
        _, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != pwd.getpwnam("hb-runtime").pw_uid:
            return
        operation = None
        try:
            with connection.makefile("rb") as stream:
                raw = stream.readline(MAX_LINE + 1)
            if len(raw) > MAX_LINE or stopping.is_set() or time.monotonic() >= deadline:
                raise ValueError("Permission expired or request too large")
            message = json.loads(raw)
            tool, args = message["tool"], message["arguments"]
            # Every side effect first rechecks host consent, exact mission
            # control and lease. A compromised worker has no socket access.
            checked = board("check_permission", {"tool": tool, "operation": args.get("operation", {}).get("type") if isinstance(args.get("operation"), dict) else None})
            if checked.get("error"):
                raise BoardError(checked)
            if checked.get("allowed") is not True:
                raise ValueError("Execution permission is unavailable")
            if tool == "check_permission":
                value = checked
            elif tool == "capabilities":
                if args:
                    raise ValueError("Capabilities takes no arguments")
                value = board(tool, {})
                if not value.get("error"):
                    probe = worker(["/usr/bin/python3", "-c", "import json, shutil, sys; print(json.dumps({'python':sys.version.split()[0], 'executables':{n:bool(shutil.which(n)) for n in ['python3','node','npm','git','curl','make']}}))"], timeout=10)
                    value["workspace"] = json.loads(probe.stdout)
                    kit = worker(["/usr/bin/python3", "-c", "print(open('/usr/local/lib/harakiri-buildkit/selected.json').read())"], timeout=10, network=False)
                    value["buildkit"] = json.loads(kit.stdout) if kit.returncode == 0 else {"available": False}
                    if value["buildkit"].get("pack") != value["authoring"]["pack"]:
                        raise ValueError("Installed authoring toolkit differs from local approval; prepare this environment again")
                    if value["buildkit"].get("buildkit") == "web-artifact-1":
                        value["build_recipe"] = {"bundle": "esbuild src/main.js --bundle --format=esm --outfile=dist/app.js --alias:three=/usr/local/lib/harakiri-buildkit/web-artifact-1/three/build/three.module.js", "delivery": "Publish dist/index.html plus local app.js/assets, source files, licences and build instructions. No external CDN is needed.", "license_files": ["/usr/local/lib/harakiri-buildkit/web-artifact-1/three/LICENSE", "/usr/local/lib/harakiri-buildkit/web-artifact-1/esbuild/README.md", "/usr/local/lib/harakiri-buildkit/web-artifact-1/node/LICENSE"]}
            elif tool == "workspace_exec":
                operation = Operation(board, "command", fingerprint({"arguments": args, "request": uuid.uuid4().hex}), "Run workspace command")
                seconds = args.get("timeout_seconds", 60)
                if type(seconds) is not int or not 1 <= seconds <= 120:
                    raise ValueError("timeout_seconds must be 1..120")
                seconds = min(seconds, max(1, int(deadline - time.monotonic()) - 3))
                result = worker(["python3", "-I", "/usr/local/lib/harakiri-command.py"],
                                json.dumps({**args, "timeout_seconds": seconds}).encode(), timeout=seconds + 3)
                value = json.loads(result.stdout)
                if deadline - time.monotonic() > 15:
                    try:
                        value["checkpoint"] = capture_checkpoint(board, files)
                    except Exception as error:
                        value["checkpoint"] = {"saved": False, "reason": str(error)[:512]}
            elif tool == "checkpoint_workspace":
                value = capture_checkpoint(board, files)
            elif tool == "workspace_read":
                value = files({**args, "action": "read_text"})
            elif tool == "workspace_patch":
                value = files({**args, "action": "patch"})
            elif tool == "workspace_search":
                value = files({**args, "action": "search"})
            elif tool == "workspace_write":
                value = files({"action": "write", "path": args["path"],
                               "base64": base64.b64encode(args["text"].encode()).decode()})
            elif tool == "import_artifact":
                value = import_artifact(args, board, files)
            elif tool == "import_artifact_project":
                operation = Operation(board, "import", fingerprint(args), "Import project into " + str(args.get("destination", "workspace")))
                value = operation.replay()
                if value is None:
                    value = import_project(args, board, files, progress=operation.progress)
            elif tool == "integrate_project":
                if set(args) != {"base", "current", "proposal", "destination"}:
                    raise ValueError("Provide exact base, current and proposal revisions and a new destination")
                imported = []
                directory = ".harakiri/integration/" + uuid.uuid4().hex
                for name in ("base", "current", "proposal"):
                    value = import_project({"revision": args[name], "destination": directory + "/" + name}, board, files)
                    imported.append({"directory": value["destination"], "paths": [f["path"] for f in value["files"]]})
                value = files({"action": "integrate_project", "trees": imported, "destination": args["destination"]})
                value["inputs"] = {name: args[name] for name in ("base", "current", "proposal")}
                value["source_directories"] = imported
                if not value.get("error"):
                    saved = files({"action": "write", "path": args["destination"] + "/integration-receipt-" + uuid.uuid4().hex + ".json",
                                   "base64": base64.b64encode(json.dumps(value).encode()).decode()})
                    if saved.get("error"): raise ValueError(saved["error"])
            elif tool == "artifact_browser":
                args = dict(args)
                target = args.pop("screenshotPath")
                if not valid_path(target) or not target.endswith(".jpg") or len(target) > 230:
                    raise ValueError("Choose a relative workspace screenshotPath ending in .jpg")
                value = board(tool, args)
                if value.get("error"):
                    raise BoardError(value)
                image = value.get("image", {})
                if image.get("mimeType") != "image/jpeg" or len(image.get("data", "")) > 1024 * 1024:
                    raise ValueError("Invalid bounded browser image")
                permission = board("check_permission", {})
                if permission.get("error"):
                    raise BoardError(permission)
                if permission.get("allowed") is not True:
                    raise ValueError("Permission ended before evidence transfer")
                for path, content in [(target, image["data"]), (target + ".json", base64.b64encode(json.dumps({k: v for k, v in value.items() if k != "image"}).encode()).decode())]:
                    saved = files({"action": "write", "path": path, "base64": content})
                    if saved.get("error"):
                        raise ValueError(saved["error"])
                value["saved"] = [target, target + ".json"]
            elif tool == "publish_artifact":
                args = publication_context(args, board)
                paths = args["paths"]
                if not isinstance(paths, list) or not 1 <= len(paths) <= 256 or len(set(paths)) != len(paths):
                    raise ValueError("Publish one to 256 distinct project files, excluding caches and credentials")
                sources = []
                total = 0
                for path in paths:
                    file = files({"action": "read", "path": path})
                    if file.get("error"):
                        raise ValueError(file["error"])
                    data = base64.b64decode(file["base64"], validate=True)
                    total += len(data)
                    if total > 32 * 1024 * 1024:
                        raise ValueError("Project publication exceeds 32 MiB")
                    sources.append((path, data))
                operation = Operation(board, "publish", fingerprint({"request": args, "files": [(path, hashlib.sha256(data).hexdigest()) for path, data in sources]}), "Publish " + args["document"]["title"])
                replay = operation.replay()
                if replay is not None:
                    connection.sendall((json.dumps(replay) + "\n").encode())
                    return
                publication_preflight(args, board, check_parents=operation.record["attempts"] == 1)
                uploads = []
                for index, (path, data) in enumerate(sources):
                    operation.progress(index, len(sources), "Uploading " + path)
                    types = {"html": "text/html", "css": "text/css", "js": "text/javascript",
                             "json": "application/json", "md": "text/markdown", "txt": "text/plain",
                             "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "csv": "text/csv"}
                    started = board("board", {"operation": {"type": "artifact_transfer", "transfer": {
                        "type": "begin", "control": args["control"], "conversation": args.get("conversation", "main"),
                        "path": path, "media_type": types.get(path.rsplit(".", 1)[-1], "application/octet-stream"), "size": len(data), "resume_key": hashlib.sha256(data).hexdigest()}}})
                    if "error" in started:
                        raise BoardError(started)
                    upload = started["upload"]
                    for offset in range(started.get("offset", 0), len(data), 32768):
                        operation.progress(index, len(sources), "Uploading " + path)
                        result = board("board", {"operation": {"type": "artifact_transfer", "transfer": {
                            "type": "chunk", "upload": upload, "offset": offset, "hex": data[offset:offset + 32768].hex()}}})
                        if "error" in result:
                            raise BoardError(result)
                    uploads.append(upload)
                value = board("board", {"operation": {"type": "artifact_transfer", "transfer": {
                    "type": "publish", "control": args["control"], "conversation": args.get("conversation", "main"),
                    "artifact": args.get("artifact"), "parents": args.get("parents", []),
                    "document": {**args["document"], "files": []}, "uploads": uploads, "retain": []}}})
                value["conversation"] = args["conversation"]
            elif tool in ("board", "wait_for_work", "record_delivery", "read_briefing", "read_conversation", "reply", "post_message", "inspect_artifact", "guidance", "direct_agent", "review_artifact", "acknowledge_update", "operation_status"):
                if tool == "wait_for_work" and deadline - time.monotonic() > 15:
                    try:
                        capture_checkpoint(board, files)
                    except Exception:
                        pass  # Waiting/Stop must not depend on capture success.
                value = board(tool, args)
            else:
                raise ValueError("Unknown tool")
            if operation:
                if value.get("error"):
                    operation.failed(BoardError(value))
                else:
                    value = operation.finish(value)
            if tool in ("workspace_exec", "workspace_patch", "workspace_write", "publish_artifact", "import_artifact", "import_artifact_project", "artifact_browser", "board"):
                # Persist the result before an optional notification. A failed
                # checkpoint must not turn a committed publication into failure.
                try:
                    notice = board("checkpoint", {})
                    if notice.get("coordination_update"):
                        value["coordination_update"] = notice["coordination_update"]
                except Exception:
                    value["notice"] = "Result saved. Refresh read_briefing before continuing."
        except subprocess.CalledProcessError as error:
            if operation:
                operation.failed(error)
            value = {"exitCode": error.returncode, "error": "Worker command failed",
                     "code": "workspace_command_failed", "output_complete": False,
                     "stdout": (error.stdout or b"")[:65536].decode("utf8", "replace"),
                     "stderr": (error.stderr or b"")[:16384].decode("utf8", "replace")}
        except BoardError as error:
            if operation:
                operation.failed(error)
            value = {"error": str(error), "code": error.code, "retryable": error.retryable}
        except Exception as error:
            if operation:
                operation.failed(error)
            value = {"error": str(error)[:1024]}
        connection.sendall((json.dumps(value) + "\n").encode())


def socket_loop(server):
    # Serial tools keep resource/output bounds predictable. A second caller
    # waits in the small OS backlog; it cannot grow an unbounded thread pool.
    while not stopping.is_set():
        try:
            connection, _ = server.accept()
        except OSError:
            return
        try:
            serve_tool(connection)
        except OSError:
            # A caller may disconnect while a verified transfer is still in
            # progress. Its late response must not kill the listener for all
            # subsequent tools. The operation remains subject to host consent
            # and the guest deadline; a disconnected client implies no rollback.
            continue


def acp_loop():
    while raw := runtime.stdout.readline(MAX_LINE + 1):
        if len(raw) > MAX_LINE:
            stopping.set()
            return
        try:
            emit({"kind": "acp", "message": json.loads(raw)})
        except (ValueError, BrokenPipeError):
            stopping.set()
            return
    stopping.set()
    emit({"kind": "exit"})


def stop(*_):
    stopping.set()
    if runtime:
        runtime.terminate()


def main():
    global runtime
    if os.geteuid() != 0 or not 1 <= int(sys.argv[1]) <= 86400:
        raise ValueError("Invalid host execution lease")
    os.makedirs("/run/harakiri", mode=0o755, exist_ok=True)
    path = "/run/harakiri/mcp.sock"
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    with socket.socket(socket.AF_UNIX) as server:
        server.bind(path)
        os.chown(path, pwd.getpwnam("hb-runtime").pw_uid, -1)
        os.chmod(path, 0o600)
        server.listen(2)
        args = ["systemd-run", "--quiet", "--pipe", "--wait", "--collect", "--unit=hb-runtime",
                "--slice=hb-agent.slice", "--uid=hb-runtime", "--working-directory=/home/hb-runtime/control"]
        properties = runtime_properties(int(sys.argv[1]))
        args += ["--property=" + p for p in properties]
        args += ["--setenv=" + key + "=" + value for key, value in environment().items()]
        args += ["--setenv=HTTPS_PROXY=http://127.0.0.1:18080", "--setenv=HTTP_PROXY=http://127.0.0.1:18080"]
        session = (sys.argv[2] == "resume", sys.argv[3]) if len(sys.argv) == 4 else None
        args += command(session)
        os.makedirs("/var/log/harakiri", mode=0o700, exist_ok=True)
        diagnostics = os.open("/var/log/harakiri/runtime.log", os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        runtime = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=diagnostics, env=ENV)
        os.close(diagnostics)
        threading.Thread(target=socket_loop, args=(server,), daemon=True).start()
        threading.Thread(target=acp_loop, daemon=True).start()
        for raw in sys.stdin.buffer:
            if len(raw) > MAX_LINE or stopping.is_set() or time.monotonic() >= deadline:
                break
            message = json.loads(raw)
            if message["kind"] == "acp":
                runtime.stdin.write((json.dumps(message["message"]) + "\n").encode())
                runtime.stdin.flush()
            elif message["kind"] == "tool_result":
                with pending_lock:
                    future = pending.get(message["id"])
                if future and not future.done():
                    future.set_result(message["result"])
            else:
                raise ValueError("Invalid transport message")
    stop()
    subprocess.run(["systemctl", "stop", "hb-agent.slice"], env=ENV, capture_output=True, timeout=15)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        main()
    finally:
        stop()
