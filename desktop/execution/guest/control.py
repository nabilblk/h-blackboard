"""Root-owned, host-invoked VM lifecycle and worker confinement primitives."""
import json
import os
import pwd
import stat
import subprocess
import sys
import tempfile
import uuid
from runtimes import authenticated, private_directory, spec

BASE = "/opt/harakiri"
ENV = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": "/workspace"}


def runtime_properties(seconds):
    if not isinstance(seconds, int) or not 1 <= seconds <= 86400:
        raise ValueError("Invalid runtime lease")
    return ["NoNewPrivileges=yes", "CapabilityBoundingSet=", "ProtectSystem=strict",
            "ProtectHome=read-only", "ReadWritePaths=" + private_directory(),
            "InaccessiblePaths=/workspace", "PrivateTmp=yes", "ProtectControlGroups=yes",
            "RestrictNamespaces=yes", "KillMode=control-group", "TimeoutStopSec=2",
            "IPAddressDeny=any", "IPAddressAllow=127.0.0.1/32", "MemoryMax=1G", "TasksMax=128",
            "RuntimeMaxSec=" + str(seconds),
            "ReadOnlyPaths=-/home/hb-runtime/.codex/config.toml"]


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, env=ENV, **kwargs)


def worker(argv, data=b"", timeout=30, network=True):
    unit = "hb-work-" + uuid.uuid4().hex
    args = ["systemd-run", "--quiet", "--pipe", "--wait", "--collect",
            "--unit=" + unit, "--slice=hb-agent.slice", "--uid=hb-worker",
            "--working-directory=/workspace"]
    properties = [
        "RootDirectory=" + BASE + "/rootfs", "MountAPIVFS=yes",
        "BindReadOnlyPaths=/usr /bin /lib -/lib64",
        "BindPaths=/workspace", "PrivateNetwork=yes", "PrivateDevices=yes",
        "PrivateTmp=yes", "ProtectSystem=strict", "ProtectHome=yes",
        "ReadWritePaths=/workspace /tmp", "NoNewPrivileges=yes",
        "CapabilityBoundingSet=", "RestrictNamespaces=yes",
        "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
        "ProtectControlGroups=yes", "ProtectKernelTunables=yes",
        "ProtectKernelModules=yes", "ProtectKernelLogs=yes",
        "RestrictSUIDSGID=yes", "LockPersonality=yes", "ProtectClock=yes",
        "ProtectProc=invisible", "ProcSubset=pid", "KillMode=control-group",
        "MemoryMax=768M", "TasksMax=128", "LimitFSIZE=33554432",
        "RuntimeMaxSec=" + str(timeout), "TimeoutStopSec=2",
        "SystemCallFilter=~@mount @reboot @swap @raw-io @debug @module",
    ]
    mode = spec().get("networkAccess", "restricted")
    if mode not in ("restricted", "internet"):
        raise ValueError("Unknown workspace network policy")
    if network and mode == "internet":
        properties += [
            "BindReadOnlyPaths=/run/harakiri-internet /etc/ssl/certs /usr/share/ca-certificates",
        ]
        argv = ["python3", "-I", "/usr/local/lib/harakiri-worker-network.py", *argv]
    args += ["--property=" + p for p in properties]
    args += ["--setenv=HOME=/workspace", "--setenv=PATH=/usr/bin:/bin", "--", *argv]
    # communicate is bounded by a regular file output quota for shell calls;
    # file transfers are separately bounded by files.py.
    try:
        with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            result = subprocess.run(args, input=data, stdout=out, stderr=err,
                                    env=ENV, timeout=timeout + 10)
            out.seek(0)
            err.seek(0)
            result.stdout = out.read(32 * 1024 * 1024 + 1)
            result.stderr = err.read(16384)
            return result
    finally:
        subprocess.run(["systemctl", "stop", unit], env=ENV, capture_output=True, timeout=10)


def files(request):
    result = worker(["python3", "-I", "/usr/local/lib/harakiri-files.py"], json.dumps(request).encode(), network=False)
    if result.returncode:
        raise ValueError("Workspace transfer failed (exit " + str(result.returncode) + "): " + (result.stdout or result.stderr)[:512].decode("utf8", "replace"))
    return json.loads(result.stdout)


def inspect():
    result = run(["systemctl", "show", "hb-agent.slice", "-p", "ControlGroup", "--value"])
    group = result.stdout.decode().strip()
    populated = False
    if group:
        try:
            with open("/sys/fs/cgroup" + group + "/cgroup.events", encoding="utf8") as f:
                populated = "populated 1" in f.read()
        except FileNotFoundError:
            pass
    bridge = run(["systemctl", "show", "hb-session.service", "-p", "ActiveState", "--value"]).stdout.decode().strip()
    workspace = os.lstat('/workspace')
    return {"stopped": not populated and bridge in ("inactive", "failed"),
            "workspace_ready": stat.S_ISDIR(workspace.st_mode) and workspace.st_uid == pwd.getpwnam('hb-worker').pw_uid,
            "authenticated": authenticated()}


def main():
    if os.geteuid() != 0:
        raise PermissionError("Host control requires root")
    action = sys.argv[1]
    if action == "inspect":
        return inspect()
    if action == "stop":
        for unit in ["hb-session.service", "hb-agent.slice"]:
            subprocess.run(["systemctl", "stop", unit], capture_output=True, timeout=15)
        return inspect()
    if action in ("export", "import"):
        if not inspect()["stopped"]:
            raise ValueError("Stop execution before transferring workspace files")
        request = {"action": action}
        if action == "import":
            request["files"] = json.loads(sys.stdin.buffer.read(48 * 1024 * 1024 + 1))["files"]
        return files(request)
    raise ValueError("Unknown control operation")


if __name__ == "__main__":
    try:
        print(json.dumps(main()))
    except Exception as error:
        print(json.dumps({"error": str(error)[:512]}))
        sys.exit(1)
