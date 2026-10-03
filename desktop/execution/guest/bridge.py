"""Multiplex ACP and scoped board tools over a host-owned SSH stdio channel.

No listening host port, bearer token, signing key or host path enters the VM.
The guest Unix socket authenticates its peer with kernel SO_PEERCRED.
"""
import base64
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
        connection.settimeout(90)
        _, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != pwd.getpwnam("hb-runtime").pw_uid:
            return
        try:
            with connection.makefile("rb") as stream:
                raw = stream.readline(MAX_LINE + 1)
            if len(raw) > MAX_LINE or stopping.is_set() or time.monotonic() >= deadline:
                raise ValueError("Permission expired or request too large")
            message = json.loads(raw)
            tool, args = message["tool"], message["arguments"]
            # Every side effect first rechecks host consent, exact mission
            # control and lease. A compromised worker has no socket access.
            checked = board("check_permission", {})
            if checked.get("error"):
                raise ValueError(checked["error"])
            if tool == "workspace_exec":
                command = args["command"]
                if not isinstance(command, str) or len(command.encode()) > 16384 or "\0" in command:
                    raise ValueError("Invalid command")
                result = worker(["/bin/sh", "-c", command], timeout=min(60, max(1, int(deadline - time.monotonic()))))
                value = {"exitCode": result.returncode,
                         "stdout": result.stdout[:65536].decode("utf8", "replace"),
                         "stderr": result.stderr[:16384].decode("utf8", "replace")}
            elif tool == "workspace_read":
                result = files({"action": "read", "path": args["path"]})
                data = base64.b64decode(result["base64"])
                if len(data) > 512 * 1024:
                    raise ValueError("Read at most 512 KiB through a tool; publish larger files directly")
                value = {"path": args["path"], "text": data.decode("utf8")}
            elif tool == "workspace_write":
                value = files({"action": "write", "path": args["path"],
                               "base64": base64.b64encode(args["text"].encode()).decode()})
            elif tool == "publish_artifact":
                paths = args["paths"]
                if not isinstance(paths, list) or not 1 <= len(paths) <= 32 or len(set(paths)) != len(paths):
                    raise ValueError("Publish one to thirty-two distinct files")
                uploads = []
                for path in paths:
                    file = files({"action": "read", "path": path})
                    data = base64.b64decode(file["base64"])
                    types = {"html": "text/html", "css": "text/css", "js": "text/javascript",
                             "json": "application/json", "md": "text/markdown", "txt": "text/plain",
                             "svg": "image/svg+xml", "png": "image/png", "csv": "text/csv"}
                    started = board("board", {"operation": {"type": "artifact_transfer", "transfer": {
                        "type": "begin", "control": args["control"], "conversation": args.get("conversation", "main"),
                        "path": path, "media_type": types.get(path.rsplit(".", 1)[-1], "application/octet-stream"), "size": len(data)}}})
                    if "error" in started:
                        raise ValueError(started["error"])
                    upload = started["upload"]
                    for offset in range(0, len(data), 32768):
                        result = board("board", {"operation": {"type": "artifact_transfer", "transfer": {
                            "type": "chunk", "upload": upload, "offset": offset, "hex": data[offset:offset + 32768].hex()}}})
                        if "error" in result:
                            raise ValueError(result["error"])
                    uploads.append(upload)
                value = board("board", {"operation": {"type": "artifact_transfer", "transfer": {
                    "type": "publish", "control": args["control"], "conversation": args.get("conversation", "main"),
                    "artifact": args.get("artifact"), "parents": args.get("parents", []),
                    "document": {**args["document"], "files": []}, "uploads": uploads, "retain": []}}})
            elif tool == "board":
                value = board(tool, args)
            else:
                raise ValueError("Unknown tool")
        except subprocess.CalledProcessError as error:
            value = {"exitCode": error.returncode, "error": "Worker command failed",
                     "stdout": (error.stdout or b"")[:65536].decode("utf8", "replace"),
                     "stderr": (error.stderr or b"")[:16384].decode("utf8", "replace")}
        except Exception as error:
            value = {"error": str(error)[:1024]}
        connection.sendall((json.dumps(value) + "\n").encode())


def socket_loop(server):
    # Serial tools keep resource/output bounds predictable. A second caller
    # waits in the small OS backlog; it cannot grow an unbounded thread pool.
    while not stopping.is_set():
        try:
            connection, _ = server.accept()
            serve_tool(connection)
        except OSError:
            return


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
