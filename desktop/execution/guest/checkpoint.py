"""Incremental source capture over the authenticated bridge, not model text."""
import base64
import hashlib
from artifact_io import BoardError


def capture(board, files):
    def request(tool, args):
        value = board(tool, args)
        if value.get("error"):
            raise BoardError(value)
        return value
    manifest = files({"action": "manifest"})
    if manifest.get("error"):
        raise ValueError(manifest["error"])
    start = request("checkpoint_begin", {"manifest": manifest})
    missing = set(start["missing"])
    for entry in manifest["files"]:
        if entry["path"] not in missing:
            continue
        value = files({"action": "read", "path": entry["path"]})
        if value.get("error"):
            raise ValueError(value["error"])
        data = base64.b64decode(value["base64"], validate=True)
        if len(data) != entry["size"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise ValueError("Source changed during checkpoint; retry after the writer stops")
        for offset in range(0, max(1, len(data)), 32768):
            request("checkpoint_chunk", {"id": start["id"], "path": entry["path"], "offset": offset,
                    "base64": base64.b64encode(data[offset:offset + 32768]).decode()})
    return request("checkpoint_finish", {"id": start["id"]})
