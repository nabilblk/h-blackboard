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


def valid_path(path):
    return (isinstance(path, str) and 0 < len(path.encode()) <= 240
            and not any(ord(c) < 32 or ord(c) == 127 for c in path)
            and all(p not in ("", ".", "..") and "\\" not in p and ":" not in p
                    for p in path.split("/")))


def import_artifact(args, board, files):
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
            raise ValueError(result["error"])
        return result

    revision, path = args["revision"], args["path"]
    detail = request("board", {"operation": {"type": "artifact_detail", "revision": revision}})
    if detail.get("revision") != revision:
        raise ValueError("Artifact revision changed")
    matches = [f for f in detail["document"]["files"] if f["path"] == path]
    if len(matches) != 1:
        raise ValueError("File is absent from the authorized artifact manifest")
    manifest = matches[0]
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
