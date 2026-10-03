"""Runs as the worker INSIDE its filesystem/network jail, never as root."""
import base64
import json
import os
import stat
import sys

MAX_FILE = 16 * 1024 * 1024
MAX_TOTAL = 16 * 1024 * 1024


def path_parts(path):
    if not isinstance(path, str) or len(path.encode()) > 240 or any(ord(c) < 32 for c in path):
        raise ValueError("Invalid workspace path")
    parts = path.split("/")
    if any(p in ("", ".", "..") or "\\" in p or ":" in p for p in parts):
        raise ValueError("Use a relative workspace path without traversal")
    return parts


def parent(path, create=False):
    parts = path_parts(path)
    fd = os.open("/workspace", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd, parts[-1]
    except BaseException:
        os.close(fd)
        raise


def read(path):
    directory, name = parent(path)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > MAX_FILE:
                raise ValueError("Only bounded regular files without links can be exported")
            data = stream.read(MAX_FILE + 1)
            if len(data) > MAX_FILE:
                raise ValueError("File too large")
            return data
    finally:
        os.close(directory)


def write(path, data):
    if len(data) > MAX_FILE:
        raise ValueError("File too large")
    directory, name = parent(path, create=True)
    # Atomic replacement prevents writing through a hardlink or symlink. The
    # directory descriptors also prevent a concurrent parent-symlink swap.
    temporary = ".hb-import-" + os.urandom(16).hex()
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.rename(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass
        os.close(directory)


def main(request):
    action = request["action"]
    if action == "read":
        data = read(request["path"])
        return {"path": request["path"], "base64": base64.b64encode(data).decode(), "size": len(data)}
    if action == "write":
        data = base64.b64decode(request["base64"], validate=True)
        write(request["path"], data)
        return {"path": request["path"], "size": len(data)}
    if action == "export":
        files, total = [], 0
        for directory, directories, names in os.walk("/workspace", followlinks=False):
            if any(os.path.islink(os.path.join(directory, p)) for p in directories):
                raise ValueError("Remove directory symlinks before export")
            for name in sorted(names):
                path = os.path.relpath(os.path.join(directory, name), "/workspace")
                data = read(path)
                total += len(data)
                if len(files) >= 256 or total > MAX_TOTAL:
                    raise ValueError("Export exceeds 256 files or 16 MiB")
                files.append({"path": path, "base64": base64.b64encode(data).decode()})
        return {"files": files}
    if action == "import":
        files = request["files"]
        if len(files) > 256 or len({f["path"] for f in files}) != len(files):
            raise ValueError("Too many files or duplicate paths")
        decoded = [(f["path"], base64.b64decode(f["base64"], validate=True)) for f in files]
        if sum(len(data) for _, data in decoded) > MAX_TOTAL:
            raise ValueError("Import too large")
        for path, data in decoded:
            path_parts(path)
            if len(data) > MAX_FILE:
                raise ValueError("File too large")
        for path, data in decoded:
            write(path, data)
        return {"imported": len(decoded)}
    raise ValueError("Unknown file operation")


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(48 * 1024 * 1024 + 1)
        if len(raw) > 48 * 1024 * 1024:
            raise ValueError("Request too large")
        print(json.dumps(main(json.loads(raw))))
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(json.dumps({"error": str(error)[:512]}))
        sys.exit(1)
