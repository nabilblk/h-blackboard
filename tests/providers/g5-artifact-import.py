"""Opt-in test INSIDE a prepared VM: real jailed writes, synthetic board replies.

No model call or production mission. Protocol authorization/hash verification
is covered separately; this fixture exercises the guest transfer/file boundary.
"""
import base64
import hashlib
import sys
sys.path.insert(0, "/opt/harakiri")
from artifact_io import import_artifact, CHUNK
from control import files, worker, inspect

assert inspect()["stopped"], "Never test in an active execution"
data = bytes(range(256)) * 400
revision, digest = "a" * 64, "b" * 64


def board(tool, arguments):
    if tool == "check_permission":
        return {"allowed": True}
    op = arguments["operation"]
    if op["type"] == "artifact_detail":
        return {"revision": revision, "document": {"files": [
            {"path": "fixture.bin", "hash": digest, "size": len(data)}]}}
    offset = op["transfer"]["offset"]
    chunk = data[offset:offset + CHUNK]
    end = offset + len(chunk)
    return {"hex": chunk.hex(), "offset": end, "complete": end == len(data),
            "size": len(data), "hash": digest}


args = {"revision": revision, "path": "fixture.bin", "destination": "import-proof/fixture.bin"}
receipt = import_artifact(args, board, files)
assert receipt["sha256"] == hashlib.sha256(data).hexdigest()
assert base64.b64decode(files({"action": "read", "path": args["destination"]})["base64"]) == data
print("PASS exact multi-chunk binary import through the real jailed file helper")

# The final destination may be atomically replaced, but a linked parent must
# never redirect the broker out of /workspace or into the credential account.
r = worker(["sh", "-c", "mkdir -p import-proof && ln -s /home/hb-runtime import-proof/outside"], timeout=10)
assert r.returncode == 0, r.stderr
try:
    import_artifact({**args, "destination": "import-proof/outside/credentials"}, board, files)
except Exception:
    pass
else:
    raise AssertionError("Symlink destination accepted")
assert inspect()["stopped"]
print("PASS parent-link escape denied and worker termination confirmed")
