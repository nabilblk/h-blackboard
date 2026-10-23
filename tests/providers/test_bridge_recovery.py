"""A disconnected MCP caller must not disable the remaining execution lease."""
import importlib
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "desktop/execution/guest"))
with patch.object(sys, "argv", ["bridge.py", "60"]):
    bridge = importlib.import_module("bridge")
import mcp


class BridgeRecoveryTests(unittest.TestCase):
    def test_disconnected_caller_does_not_end_serial_tool_listener(self):
        disconnected = threading.Event()
        stop = threading.Event()
        requests = []

        def serve(connection):
            with connection:
                request = connection.recv(16)
                requests.append(request)
                if request == b"abandoned":
                    # The client has already closed, as after an MCP timeout.
                    connection.sendall(b"late result")
                else:
                    connection.sendall(b"still available")
                    stop.set()

        def handle(connection):
            try:
                serve(connection)
            finally:
                if len(requests) == 1:
                    disconnected.set()

        with tempfile.TemporaryDirectory(prefix="hb-bridge-") as directory:
            path = str(Path(directory) / "mcp.sock")
            with socket.socket(socket.AF_UNIX) as server:
                server.bind(path)
                server.listen(2)
                server.settimeout(2)
                with patch.object(bridge, "stopping", stop), patch.object(bridge, "serve_tool", handle):
                    thread = threading.Thread(target=bridge.socket_loop, args=(server,), daemon=True)
                    with socket.socket(socket.AF_UNIX) as first:
                        first.connect(path)
                        first.sendall(b"abandoned")
                    thread.start()
                    self.assertTrue(disconnected.wait(2))
                    try:
                        with socket.socket(socket.AF_UNIX) as second:
                            second.settimeout(2)
                            second.connect(path)
                            second.sendall(b"next")
                            self.assertEqual(second.recv(32), b"still available")
                    finally:
                        stop.set()
                        thread.join(3)
                    self.assertFalse(thread.is_alive())
        self.assertEqual(requests, [b"abandoned", b"next"])

    def test_bulk_transfers_have_a_bounded_larger_response_window(self):
        class Connection:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def settimeout(self, value): self.timeout = value
            def connect(self, _): pass
            def sendall(self, value): self.request = json.loads(value)
            def makefile(self, _):
                import io
                return io.BytesIO(b'{"ok":true}\n')

        for tool in ("publish_artifact", "import_artifact_project", "read_briefing"):
            connection = Connection()
            with patch.object(mcp.socket, "socket", return_value=connection):
                self.assertEqual(mcp.call(tool, {}), {"ok": True})
            self.assertEqual(connection.timeout, 600 if tool != "read_briefing" else 160)

    def test_timeout_reports_uncertain_outcome_without_claiming_rollback(self):
        server = mcp.Server([{"name": "publish_artifact"}])
        server.version = "2025-11-25"
        with patch.object(mcp, "call", side_effect=TimeoutError("timed out")):
            response = server.handle("tools/call", {"name": "publish_artifact", "arguments": {}})
        value = response["structuredContent"]
        self.assertTrue(response["isError"])
        self.assertEqual(value["code"], "tool_outcome_unknown")
        self.assertIn("before retrying", value["error"])


if __name__ == "__main__":
    unittest.main()
