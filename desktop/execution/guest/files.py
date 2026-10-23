"""Runs as the worker INSIDE its filesystem/network jail, never as root."""
import base64
import hashlib
import json
import os
import stat
import sys
import importlib.util
from pathlib import Path
_project = Path(__file__).with_name("project.py" if Path(__file__).name in ("files.py", "command.py") else "harakiri-project.py")
_spec = importlib.util.spec_from_file_location("harakiri_project", _project)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
manifest = _module.manifest

WORKSPACE = "/workspace"
MAX_FILE = 16 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024


def path_parts(path):
    if not isinstance(path, str) or len(path.encode()) > 240 or any(ord(c) < 32 for c in path):
        raise ValueError("Invalid workspace path")
    parts = path.split("/")
    if any(p in ("", ".", "..") or "\\" in p or ":" in p for p in parts):
        raise ValueError("Use a relative workspace path without traversal")
    return parts


def parent(path, create=False):
    parts = path_parts(path)
    fd = os.open(WORKSPACE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
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


def remove_staging(directory, name):
    """Descriptor-relative cleanup, without following a concurrent link swap."""
    try:
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
    except FileNotFoundError:
        return
    try:
        for entry in os.listdir(fd):
            info = os.stat(entry, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                remove_staging(fd, entry)
            else:
                os.unlink(entry, dir_fd=fd)
    finally:
        os.close(fd)
    os.rmdir(name, dir_fd=directory)


def main(request):
    action = request["action"]
    if action == "manifest":
        return manifest(read=read)
    if action == "integrate_project":
        # A conservative three-way merge over exact imported file manifests.
        # Both sides changing the same file is a conflict; never guess a winner.
        trees = request["trees"]
        if len(trees) != 3:
            raise ValueError("Integration needs base, current and proposal")
        contents = []
        for tree in trees:
            path_parts(tree["directory"])
            if len(tree["paths"]) > 256:
                raise ValueError("Project file limit")
            values = {p: read(tree["directory"] + "/" + p) for p in tree["paths"]}
            if sum(map(len, values.values())) > MAX_TOTAL:
                raise ValueError("Project size limit")
            contents.append(values)
        base, current, proposal = contents
        merged, conflicts, changed = {}, [], []
        for path in sorted(set(base) | set(current) | set(proposal)):
            a, b, c = base.get(path), current.get(path), proposal.get(path)
            if b == c or c == a:
                chosen = b
            elif b == a:
                chosen = c
                changed.append(path)
            else:
                chosen = b
                conflicts.append(path)
            if chosen is not None: merged[path] = chosen
        result = main({"action": "import_project", "destination": request["destination"],
                       "files": [{"path": p, "base64": base64.b64encode(b).decode()} for p,b in merged.items()]})
        return {**result, "conflicts": conflicts, "changed": changed, "resolved": not conflicts,
                "meaning": "Current files retained for conflicts; inspect both inputs and resolve before publication"}
    if action == "search":
        paths, query = request.get("paths"), request.get("query")
        if (not isinstance(paths, list) or not 1 <= len(paths) <= 32
                or not isinstance(query, str) or not 1 <= len(query) <= 256):
            raise ValueError("Choose 1..32 file paths and a literal query up to 256 characters")
        matches, count = [], 0
        for path in paths:
            data = read(path)
            digest = hashlib.sha256(data).hexdigest()
            for number, line in enumerate(data.decode("utf8").splitlines(), 1):
                if query in line:
                    count += 1
                    if len(matches) < 40:
                        index = line.index(query)
                        preview = line[max(0,index-80):index+len(query)+80]
                        matches.append({"path": path, "sha256": digest, "line": number, "preview": preview})
        return {"matches": matches, "matching_lines": count, "truncated": count > len(matches),
                "retrieve": "Read the matching path with workspace_read and its sha256. Narrow paths/query if search is truncated."}
    if action == "read_text":
        data = read(request["path"])
        digest = hashlib.sha256(data).hexdigest()
        if request.get("sha256") and request["sha256"] != digest:
            raise ValueError("File changed; restart reading from offset 0")
        offset, limit = request.get("offset", 0), request.get("limit", 8000)
        if type(offset) is not int or type(limit) is not int or offset < 0 or not 1 <= limit <= 32000:
            raise ValueError("Use a nonnegative character offset and limit 1..32000")
        text = data.decode("utf8")
        if offset > len(text):
            raise ValueError("Offset is beyond the file")
        end = min(len(text), offset + limit)
        return {"path": request["path"], "sha256": digest, "size": len(data),
                "text": text[offset:end], "offset": offset, "characters": len(text),
                "next_offset": end if end < len(text) else None}
    if action == "patch":
        data = read(request["path"])
        if request.get("sha256") != hashlib.sha256(data).hexdigest():
            raise ValueError("File changed; read the current file before patching")
        edits = request.get("edits")
        if not isinstance(edits, list) or not 1 <= len(edits) <= 32:
            raise ValueError("Supply one to thirty-two exact replacements")
        text = data.decode("utf8")
        for edit in edits:
            if (not isinstance(edit, dict) or set(edit) != {"old", "new"}
                    or not isinstance(edit["old"], str) or not edit["old"]
                    or not isinstance(edit["new"], str) or text.count(edit["old"]) != 1):
                raise ValueError("Each old text must match exactly once; include surrounding context")
            text = text.replace(edit["old"], edit["new"], 1)
        changed = text.encode("utf8")
        write(request["path"], changed)
        return {"path": request["path"], "size": len(changed),
                "sha256": hashlib.sha256(changed).hexdigest(), "edits": len(edits)}
    if action == "read":
        data = read(request["path"])
        return {"path": request["path"], "base64": base64.b64encode(data).decode(), "size": len(data)}
    if action == "write":
        data = base64.b64decode(request["base64"], validate=True)
        write(request["path"], data)
        return {"path": request["path"], "size": len(data)}
    if action == "export":
        snapshot = manifest(read=read)
        output = []
        for entry in snapshot["files"]:
            data = read(entry["path"])
            if hashlib.sha256(data).hexdigest() != entry["sha256"]:
                raise ValueError("Source changed during export; retry after the writer stops")
            output.append({"path": entry["path"], "base64": base64.b64encode(data).decode()})
        return {"files": output, "manifest": snapshot}
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
    if action == "import_project":
        destination = request["destination"]
        if not isinstance(request["files"], list) or len(request["files"]) > 256:
            raise ValueError("Project file limit")
        for entry in request["files"]:
            path_parts(entry["path"])
        path_parts(destination)
        directory, name = parent(destination, create=True)
        staging = ".hb-project-" + os.urandom(16).hex()
        prefix = "/".join(destination.split("/")[:-1] + [staging])
        try:
            try:
                info = os.stat(name, dir_fd=directory, follow_symlinks=False)
                if not stat.S_ISDIR(info.st_mode):
                    raise ValueError("Choose a new project directory; existing work is never overwritten")
                # Retry reconciliation is exact: no extra files, links or edits.
                expected = {f["path"]: base64.b64decode(f["base64"], validate=True) for f in request["files"]}
                if len(expected) != len(request["files"]) or sum(map(len, expected.values())) > MAX_TOTAL:
                    raise ValueError("Invalid project manifest")
                actual = set()
                inspected = 0
                for folder, dirs, names in os.walk(WORKSPACE + "/" + destination, followlinks=False):
                    inspected += 1 + len(dirs) + len(names)
                    if inspected > 4096:
                        raise ValueError("Existing project enumeration limit")
                    if any(os.path.islink(os.path.join(folder, d)) for d in dirs):
                        raise ValueError("Existing project has links; choose a new directory")
                    for entry in names:
                        relative = os.path.relpath(os.path.join(folder, entry), WORKSPACE + "/" + destination)
                        if relative not in expected or read(destination + "/" + relative) != expected[relative]:
                            raise ValueError("Existing project differs; choose a new directory to preserve edits")
                        actual.add(relative)
                if actual != set(expected):
                    raise ValueError("Existing project is incomplete; choose a new directory")
                return {"imported": len(actual), "destination": destination, "replayed": True}
            except FileNotFoundError:
                pass
            os.mkdir(staging, 0o700, dir_fd=directory)
            result = main({"action": "import", "files": [
                {"path": prefix + "/" + f["path"], "base64": f["base64"]} for f in request["files"]]})
            os.rename(staging, name, src_dir_fd=directory, dst_dir_fd=directory)
            os.fsync(directory)
            return {**result, "destination": destination}
        finally:
            remove_staging(directory, staging)
            os.close(directory)
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
