"""Run inside the worker jail. Preserve bounded logs, never credentials."""
import hashlib
import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import uuid
import importlib.util
from pathlib import Path
_project = Path(__file__).with_name("project.py" if Path(__file__).name in ("files.py", "command.py") else "harakiri-project.py")
_spec = importlib.util.spec_from_file_location("harakiri_project", _project)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
manifest = _module.manifest

CAPTURE = 8 * 1024 * 1024


def execute(request, save):
    command, seconds = request.get("command"), request.get("timeout_seconds", 60)
    if (not isinstance(command, str) or not command or "\0" in command
            or len(command.encode()) > 16384 or type(seconds) is not int
            or not 1 <= seconds <= 120):
        raise ValueError("Use a command up to 16384 bytes and timeout_seconds 1..120")
    timed_out = False
    run = uuid.uuid4().hex
    began = time.monotonic()
    created = int(time.time() * 1000)
    def capture():
        try:
            return manifest()
        except (ValueError, OSError) as error:
            return {"unavailable": str(error)[:512]}
    before = capture()
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        child = subprocess.Popen(["/bin/sh", "-c", command], stdout=out, stderr=err,
                                 start_new_session=True)
        try:
            child.wait(timeout=seconds)
        except subprocess.TimeoutExpired:
            timed_out = True
        finally:
            # The surrounding systemd unit additionally kills detached children.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
        result = {"exitCode": child.returncode, "timed_out": timed_out, "logs": {}}
        for name, stream in (("stdout", out), ("stderr", err)):
            size = os.fstat(stream.fileno()).st_size
            stream.seek(0)
            data = stream.read(CAPTURE)
            path = ".harakiri/logs/" + run + "." + name + ".txt"
            # Text logs are UTF-8, with explicit binary replacement. Hash is
            # over the saved bytes so subsequent reads can detect changes.
            saved = data.decode("utf8", "replace").encode("utf8")
            encoding_truncated = len(saved) > CAPTURE
            if encoding_truncated:
                saved = saved[:CAPTURE].decode("utf8", "ignore").encode("utf8")
            save(path, saved)
            result[name] = saved.decode("utf8")[:4000]
            result["logs"][name] = {"path": path, "sha256": hashlib.sha256(saved).hexdigest(),
                "captured_bytes": len(data), "output_bytes": size,
                "saved_bytes": len(saved), "encoding_truncated": encoding_truncated,
                "capture_truncated": size > CAPTURE or encoding_truncated, "preview_truncated": len(saved.decode("utf8")) > 4000,
                "encoding": "utf-8 with replacement"}
    after = capture()
    versions = {"python": sys.version.split()[0]}
    for name in ("node", "npm", "git"):
        try:
            probe = subprocess.run([name, "--version"], capture_output=True, timeout=2)
            versions[name] = probe.stdout[:120].decode("utf8", "replace").strip() if probe.returncode == 0 else "unavailable"
        except (OSError, subprocess.TimeoutExpired):
            versions[name] = "unavailable"
    receipt = {"version":2,"tool":"workspace_exec","tool_version":"2026-10-23.1",
               "scope":"local worker execution bound to selected source manifests; not independent verification",
               "source_before":before,"source_after":after,"versions":versions,"command":command,
               "source_unchanged":bool(before.get("digest") and before.get("digest") == after.get("digest")),
               "command_sha256":hashlib.sha256(command.encode()).hexdigest(),"at":created,
               "timeout_seconds":seconds,"elapsed_ms":int((time.monotonic()-began)*1000),
               "exitCode":result["exitCode"],"timed_out":timed_out,"logs":result["logs"]}
    result["receipt"] = ".harakiri/logs/" + run + ".json"
    result["source"] = {"before": before.get("digest"), "after": after.get("digest"),
                        "unchanged": receipt["source_unchanged"], "scope": receipt["scope"]}
    save(result["receipt"], (json.dumps(receipt)+"\n").encode())
    return result


if __name__ == "__main__":
    spec = importlib.util.spec_from_file_location("files", "/usr/local/lib/harakiri-files.py")
    files = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(files)
    try:
        raw = sys.stdin.buffer.read(32769)
        if len(raw) > 32768:
            raise ValueError("Command request too large")
        print(json.dumps(execute(json.loads(raw), files.write)))
    except Exception as error:
        print(json.dumps({"error": str(error)[:512], "code": "workspace_command_failed"}))
        sys.exit(1)
