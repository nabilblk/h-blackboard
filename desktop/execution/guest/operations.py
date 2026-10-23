"""Durable host receipts for guest work. These records confer no authority."""
import hashlib
import json
from artifact_io import BoardError


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


class Operation:
    def __init__(self, board, kind, key, label):
        self.board = board
        self.record = self.call("operation_start", {"kind": kind, "fingerprint": key, "label": label[:160]})
        self.id = self.record["id"]

    def call(self, tool, arguments):
        value = self.board(tool, arguments)
        if value.get("error") and "state" not in value:
            raise BoardError(value)
        return value

    def replay(self):
        if self.record["state"] == "complete":
            return {**self.record["result"], "operation": self.id, "replayed": True}
        if self.record["state"] not in ("running",):
            return {"operation": self.id, "state": self.record["state"],
                    "error": "Inspect operation_status and saved output before retrying.", "code": "operation_uncertain"}
        return None

    def progress(self, completed, total, detail):
        value = self.call("operation_progress", {"id": self.id, "completed": completed, "total": total, "detail": detail[:240]})
        if value["state"] in ("cancel_requested", "cancelled"):
            self.call("operation_failed", {"id": self.id, "error": "Cancelled at a safe transfer boundary.", "state": "cancelled"})
            raise BoardError({"error": "Operation cancelled. Already saved output is retained.", "code": "operation_cancelled", "retryable": True})

    def finish(self, result):
        self.call("operation_finish", {"id": self.id, "result": result})
        return {**result, "operation": self.id}

    def failed(self, error):
        # A lost response may hide a committed publication; never claim rollback.
        try:
            self.board("operation_failed", {"id": self.id, "error": str(error)[:1024],
                       "state": "cancelled" if getattr(error, "code", None) == "operation_cancelled" else "uncertain"})
        except Exception:
            pass
