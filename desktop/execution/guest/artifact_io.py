"""Copy authorized artifact bytes into the jailed workspace, outside model text.

The host protocol verifies the signed manifest and BLAKE3 content hash before
returning any bytes. This guest checks the exact revision, manifest metadata
and contiguous transfer over the host-owned SSH channel. It never opens a
runtime file or accepts a host path. Only the jailed file helper writes bytes.
"""
import base64
import hashlib
import re

MAX_FILE = 16 * 1024 * 1024
CHUNK = 48 * 1024


class BoardError(ValueError):
    """Keep a host-sanitized native failure actionable through convenience tools."""
    def __init__(self, value):
        super().__init__(str(value.get("error", "Board operation failed"))[:1024])
        code = value.get("code", "operation_rejected")
        self.code = code if isinstance(code, str) and re.fullmatch(r"[a-z][a-z0-9_]{1,79}", code) else "operation_rejected"
        self.retryable = value.get("retryable") is True


def publication_context(args, board):
    """Default new publication context, never guess revision lineage."""
    value = {"artifact": None, "parents": [], **args}
    if "control" not in value or "conversation" not in value:
        context = board("board", {"operation": {"type": "context"}})
        if context.get("error"):
            raise BoardError(context)
        value.setdefault("control", context["lifecycle"]["revision"])
        if "conversation" not in value:
            if value["artifact"]:
                detail = board("board", {"operation":{"type":"artifact_detail","revision":value["artifact"]}})
                if detail.get("error"):
                    raise BoardError(detail)
                value["conversation"] = detail["artifact"]["conversation"]
            else:
                stream = (context["agent"].get("assignment") or {}).get("workstream")
                value["conversation"] = "workstream:" + stream if stream and stream != "main" else "main"
    # Updating an existing artifact still requires explicit exact parents.
    if value["artifact"] and not value["parents"]:
        raise ValueError("Provide all expected current parent revisions when updating an artifact")
    return value


def publication_preflight(args, board, check_parents=True):
    """Reject lineage mistakes before reading or uploading any workspace bytes."""
    parents = args.get("parents", [])
    artifact = args.get("artifact")
    document = args["document"]
    if bool(artifact) != bool(parents):
        raise ValueError("New artifact: artifact=null and parents=[]. Update: artifact ID and all its current heads.")
    if document.get("entrypoint") is not None and document["entrypoint"] not in args["paths"]:
        raise ValueError("Entrypoint must be one of the published file paths")
    if len(document.get("inputs", [])) + len(document.get("references", [])) > 16:
        raise ValueError("Use at most 16 input references")
    if artifact:
        detail = board("board", {"operation": {"type": "artifact_detail", "revision": artifact}})
        if detail.get("error"):
            raise BoardError(detail)
        if detail["artifact"]["id"] != artifact or (check_parents and set(parents) != set(detail["artifact"]["heads"])):
            raise ValueError("Parents must be all current revisions of this artifact, not input artifacts. Refresh artifact_detail.")
    live = document.get("inputs", [])
    refs = [r["revision"] for r in document.get("references", []) if r["relation"] != "citation"]
    for revision in live + refs:
        detail = board("board", {"operation": {"type": "artifact_detail", "revision": revision}})
        if detail.get("error"):
            raise BoardError(detail)
        if detail["artifact"]["id"] == artifact:
            raise ValueError("An artifact's own earlier version belongs in parents, not inputs or live/pinned references")


def valid_path(path):
    return (isinstance(path, str) and 0 < len(path.encode()) <= 240
            and not any(ord(c) < 32 or ord(c) == 127 for c in path)
            and all(p not in ("", ".", "..") and "\\" not in p and ":" not in p
                    for p in path.split("/")))


def import_artifact(args, board, files, known_manifest=None, progress=None):
    if (not isinstance(args, dict) or set(args) != {"revision", "path", "destination"}
            or not isinstance(args["revision"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", args["revision"])
            or not valid_path(args["path"]) or not valid_path(args["destination"])):
        raise ValueError("Use an exact artifact revision and relative workspace paths")

    def request(tool, arguments):
        result = board(tool, arguments)
        if not isinstance(result, dict):
            raise ValueError("Invalid artifact response")
        if "error" in result:
            raise BoardError(result)
        return result

    revision, path = args["revision"], args["path"]
    if known_manifest is None:
        detail = request("board", {"operation": {"type": "artifact_detail", "revision": revision}})
        if detail.get("revision") != revision:
            raise ValueError("Artifact revision changed")
        matches = [f for f in detail["document"]["files"] if f["path"] == path]
        if len(matches) != 1:
            raise ValueError("File is absent from the authorized artifact manifest")
        manifest = matches[0]
    else:
        manifest = known_manifest
        if manifest["path"] != path:
            raise ValueError("Manifest path mismatch")
    size, digest = manifest["size"], manifest["hash"]
    if (type(size) is not int or not 0 <= size <= MAX_FILE
            or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)):
        raise ValueError("Invalid artifact manifest")
    data = bytearray()
    while True:
        result = request("board", {"operation": {"type": "artifact_transfer", "transfer": {
            "type": "read", "revision": revision, "path": path, "offset": len(data)}}})
        encoded = result.get("hex")
        if (not isinstance(encoded, str) or len(encoded) > CHUNK * 2
                or not re.fullmatch(r"(?:[a-f0-9]{2})*", encoded)):
            raise ValueError("Invalid artifact bytes")
        chunk = bytes.fromhex(encoded)
        end = len(data) + len(chunk)
        if (result.get("hash") != digest or type(result.get("size")) is not int
                or result["size"] != size or type(result.get("offset")) is not int
                or result["offset"] != end or end > size
                or type(result.get("complete")) is not bool
                or result["complete"] != (end == size)
                or (not chunk and end != size)):
            raise ValueError("Artifact transfer differs from its manifest")
        data.extend(chunk)
        if progress:
            progress(len(data), size)
        if result["complete"]:
            break
    # Recheck after downloading. Revocation/deadline prevents the final write.
    permission = request("check_permission", {})
    if permission.get("allowed") is not True:
        raise ValueError("Execution permission is unavailable")
    written = files({"action": "write", "path": args["destination"],
                     "base64": base64.b64encode(data).decode()})
    if written.get("error"):
        raise ValueError(written["error"])
    return {"revision": revision, "path": path, "destination": args["destination"],
            "size": size, "blake3": digest, "sha256": hashlib.sha256(data).hexdigest()}


def import_project(args, board, files, progress=None):
    if (set(args) != {"revision", "destination"} or not valid_path(args["destination"])
            or not isinstance(args["revision"], str) or not re.fullmatch(r"[a-f0-9]{64}", args["revision"])):
        raise ValueError("Use an exact revision and a new relative project directory")
    detail = board("board", {"operation": {"type": "artifact_detail", "revision": args["revision"]}})
    if detail.get("error"):
        raise BoardError(detail)
    if detail.get("revision") != args["revision"]:
        raise ValueError("Exact artifact revision unavailable")
    manifest = detail["document"]["files"]
    if not 1 <= len(manifest) <= 256 or sum(f["size"] for f in manifest) > 32 * 1024 * 1024:
        raise ValueError("Project import supports at most 256 files and 32 MiB")
    captured, receipts = [], []
    def capture(request):
        if request["action"] != "write":
            raise ValueError("Unexpected project operation")
        captured.append({"path": request["path"], "base64": request["base64"]})
        return {"saved": True}
    for index, item in enumerate(manifest):
        if progress:
            progress(index, len(manifest), "Importing " + item["path"])
        receipts.append(import_artifact({"revision": args["revision"], "path": item["path"], "destination": item["path"]}, board, capture, known_manifest=item))
    permission = board("check_permission", {})
    if permission.get("error"):
        raise BoardError(permission)
    if permission.get("allowed") is not True:
        raise ValueError("Execution permission is unavailable")
    result = files({"action": "import_project", "destination": args["destination"], "files": captured})
    if result.get("error"):
        raise ValueError(result["error"])
    return {"revision": args["revision"], "destination": args["destination"], "files": receipts}
