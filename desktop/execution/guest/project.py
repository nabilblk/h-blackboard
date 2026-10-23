"""Bounded source manifests. Shared by export, checkpoints and command receipts.

No traversal through links and no credential/caches by default. Exclusions are
part of the manifest: a digest describes the selected tree, never the whole VM.
"""
import hashlib
import json
import os
import stat

MAX_FILES = 256
MAX_TOTAL = 32 * 1024 * 1024
MAX_FILE = 16 * 1024 * 1024
CACHES = {"node_modules", ".git", ".cache", "__pycache__", ".venv", "venv", ".next", "coverage", ".harakiri", "dist", "build", ".turbo"}
PRIVATE = {".ssh", ".aws", ".config", ".claude", ".codex", ".grok", ".npmrc", ".netrc", "credentials.json", "auth.json", "id_rsa", "id_ed25519"}


def excluded(name):
    if name in CACHES or name.startswith((".hb-project-", ".hb-import-")):
        return "generated files, dependency cache or internal evidence"
    if name in PRIVATE or name == ".env" or name.startswith(".env.") and name not in {".env.example", ".env.sample"} or name.endswith((".pem", ".key", ".p12", ".pfx")):
        return "credential or private configuration pattern"
    return None


def manifest(root="/workspace", read=None):
    info = os.lstat(root)
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise ValueError("Source root must be an existing directory")
    entries, exclusions, total, visited = [], [], 0, 0
    def omit(path, reason):
        if len(exclusions) >= 256:
            raise ValueError("Too many excluded paths; select a smaller project")
        exclusions.append({"path": path, "reason": reason})
    for folder, dirs, names in os.walk(root, followlinks=False):
        dirs.sort(); names.sort()
        for name in list(dirs) + names:
            visited += 1
            if visited > 4096:
                raise ValueError("Project enumeration exceeds 4096 entries")
            path = os.path.relpath(os.path.join(folder, name), root)
            reason = excluded(name)
            info = os.lstat(os.path.join(folder, name))
            if stat.S_ISLNK(info.st_mode) or (not stat.S_ISDIR(info.st_mode) and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1)):
                reason = "link or special file"
            if reason:
                omit(path, reason)
                if name in dirs: dirs.remove(name)
                continue
            if name in dirs: continue
            if len(path.encode()) > 240 or any(ord(c) < 32 or c in "\\:" or ord(c) == 127 for c in path):
                raise ValueError("Invalid project path")
            if info.st_size > MAX_FILE or total + info.st_size > MAX_TOTAL or len(entries) >= MAX_FILES:
                raise ValueError("Source exceeds 256 files, 16 MiB per file or 32 MiB total")
            if read is None:
                directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    for part in path.split("/")[:-1]:
                        child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                        os.close(directory)
                        directory = child
                    fd = os.open(path.split("/")[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                finally:
                    os.close(directory)
                with os.fdopen(fd, "rb") as stream:
                    current = os.fstat(stream.fileno())
                    if (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) != (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns):
                        raise ValueError("Project changed during capture")
                    data = stream.read(MAX_FILE + 1)
            else:
                data = read(path)
            after = os.lstat(os.path.join(folder, name))
            if len(data) != info.st_size or after.st_mtime_ns != info.st_mtime_ns or after.st_ino != info.st_ino:
                raise ValueError("Project changed during capture")
            total += len(data)
            entries.append({"path": path, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    entries.sort(key=lambda f: f["path"])
    canonical = json.dumps(entries, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    if len(canonical) > 48 * 1024:
        raise ValueError("Source manifest exceeds 48 KiB")
    return {"version": 1, "algorithm": "sha256", "digest": hashlib.sha256(canonical).hexdigest(),
            "files": entries, "bytes": total, "exclusions": exclusions,
            "scope": "Selected source tree; excluded/generated files and external services are not covered"}
