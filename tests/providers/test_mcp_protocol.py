import io
import json
import pathlib
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "desktop/execution/guest"))
import mcp


class ProtocolTests(unittest.TestCase):
    def test_delivery_is_acknowledged_only_after_successful_transport_flush(self):
        requests = [
            {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}},
            {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_briefing"}},
        ]
        raw = ("\n".join(json.dumps(r) for r in requests) + "\n").encode()
        for broken in (False, True):
            delivered = []
            class Output(io.StringIO):
                flushed = 0
                def flush(self):
                    if broken and self.flushed == 1:
                        raise BrokenPipeError("Runtime disconnected")
                    self.flushed += 1
            output = Output()
            def call(name, args):
                if name == "record_delivery":
                    self.assertEqual(output.flushed, 2)
                    delivered.append(args)
                    return {"recorded":True}
                return {"message":"Read the new human instruction", "_delivery":{"token":"test-ticket"}}
            with patch.object(mcp,"RESULTS",mcp.ResultCache(delivered=mcp.queue_delivery)),patch.object(mcp,"call",side_effect=call):
                if broken:
                    with self.assertRaises(BrokenPipeError): mcp.serve(io.BytesIO(raw),output,[{"name":"read_briefing"}])
                else:
                    mcp.serve(io.BytesIO(raw),output,[{"name":"read_briefing"}])
            self.assertEqual(len(delivered), 0 if broken else 1)

    def server(self, version="2025-11-25"):
        server = mcp.Server([{"name":"read_briefing", "inputSchema":{"type":"object"}, "outputSchema":{"type":"object"}}])
        result = server.dispatch({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":version}})
        self.assertEqual(result["result"]["protocolVersion"], version if version in mcp.SUPPORTED else mcp.SUPPORTED[0])
        return server

    def test_negotiation_and_structured_results_preserve_old_clients(self):
        for version in mcp.SUPPORTED + ("unknown-future-version",):
            server = self.server(version)
            with patch.object(mcp, "call", return_value={"status":"ready"}):
                response = server.dispatch({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_briefing"}})
            value=response["result"]
            self.assertEqual(json.loads(value["content"][0]["text"]),{"status":"ready"})
            self.assertEqual("structuredContent" in value, server.version in mcp.SUPPORTED[:2])

    def test_malformed_input_recovers_and_internal_tools_are_not_callable(self):
        stream=io.BytesIO(b'{broken\n{"jsonrpc":"2.0","id":3,"method":"ping"}\n')
        output=io.StringIO()
        mcp.serve(stream,output,[])
        replies=[json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(replies[0]["error"]["code"],-32700)
        self.assertEqual(replies[1]["result"],{})
        server=self.server()
        self.assertEqual(server.dispatch([])["error"]["code"],-32600)
        self.assertEqual(server.dispatch({"jsonrpc":"2.0","id":2,"method":"unknown"})["error"]["code"],-32601)
        for name in ("record_delivery","check_permission","checkpoint"):
            self.assertEqual(server.dispatch({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":name}})["error"]["code"],-32602)
        with patch.object(mcp,"call",side_effect=ValueError("Permission expired")):
            response=server.dispatch({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"read_briefing"}})
        self.assertTrue(response["result"]["isError"])
        self.assertNotIn("error",response)

    def test_resources_are_only_approved_permission_checked_modules(self):
        server=self.server()
        with patch.object(mcp,"call",return_value={"content":"Approved instructions"}) as call:
            value=server.handle("resources/read",{"uri":"harakiri://guidance/artifacts"})
            self.assertEqual(value["contents"][0]["text"],"Approved instructions")
            call.assert_called_once_with("guidance",{"module":"artifacts"})
        for uri in ("file:///etc/passwd","harakiri://guidance/../auth"):
            with self.assertRaises(mcp.ProtocolError):
                server.handle("resources/read",{"uri":uri})

    def test_text_envelope_stays_bounded_with_structured_duplication(self):
        for text in ('x'*5000,'\\"\n'*1500,'🌍'*10000):
            result=mcp.tool_result("read_briefing",{"text":text})
            self.assertLess(len(json.dumps(result).encode()),19500)
