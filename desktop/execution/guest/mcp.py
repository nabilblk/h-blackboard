"""Pinned stdio MCP transport. Only the protected runtime user can reach it."""
import json
import socket
import sys
from mcp_results import ResultCache

MAX_LINE = 2 * 1024 * 1024
DELIVERIES = []
TRANSFER_TOOLS = frozenset(("publish_artifact", "import_artifact_project", "integrate_project", "checkpoint_workspace"))
TOOL_TIMEOUT_SECONDS = 160
TRANSFER_TIMEOUT_SECONDS = 600


def queue_delivery(token, paths):
    if len(DELIVERIES) < 64:
        DELIVERIES.append({"token": token, "paths": paths})


RESULTS = ResultCache(delivered=queue_delivery)


def call(tool, arguments):
    with socket.socket(socket.AF_UNIX) as connection:
        # Multi-file transfers perform independently authorized, bounded chunks.
        # Their response window must cover the whole batch, not one command.
        # This is a client wait only: host consent and the guest lease still
        # terminate work independently of this timeout.
        connection.settimeout(TRANSFER_TIMEOUT_SECONDS if tool in TRANSFER_TOOLS else TOOL_TIMEOUT_SECONDS)
        connection.connect("/run/harakiri/mcp.sock")
        connection.sendall((json.dumps({"tool": tool, "arguments": arguments}) + "\n").encode())
        with connection.makefile("rb") as stream:
            response = stream.readline(MAX_LINE + 1)
        if len(response) > MAX_LINE:
            raise ValueError("Tool response too large")
        return json.loads(response)


def tool_result(name, value, structured=True):
    value = dict(value)
    picture = value.pop("image", None) if name == "artifact_browser" else None
    if name != "read_tool_result":
        value = RESULTS.present(value)
    content = [{"type": "text", "text": json.dumps(value)}]
    if isinstance(picture, dict) and picture.get("mimeType") == "image/jpeg" and isinstance(picture.get("data"), str) and len(picture["data"]) <= 1024 * 1024:
        content.append({"type": "image", "mimeType": "image/jpeg", "data": picture["data"]})
    result = {"content": content, "isError": "error" in value}
    if structured:
        result["structuredContent"] = value
    return result


def read_tool_result(arguments):
    # Cached data is still scoped to this execution. Revocation/expiry must
    # block cached reads just as it blocks fresh board queries.
    permission = call("check_permission", {})
    if permission.get("allowed") is not True or permission.get("error"):
        raise ValueError("Execution permission is unavailable")
    return RESULTS.read(arguments)


SUPPORTED = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
MODULES = ("conversation", "coordination", "artifacts", "visual-design", "review", "recovery")


class ProtocolError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


class Server:
    def __init__(self, tools):
        self.tools = tools
        self.names = {tool["name"] for tool in tools}
        self.version = None

    def dispatch(self, request):
        request_id = request.get("id") if isinstance(request, dict) else None
        response = {"jsonrpc": "2.0", "id": request_id}
        try:
            if (not isinstance(request, dict) or request.get("jsonrpc") != "2.0"
                    or not isinstance(request.get("method"), str)
                    or ("id" in request and (type(request_id) not in (int, str)))):
                raise ProtocolError(-32600, "Invalid JSON-RPC request")
            if "id" not in request:
                return None
            params = request.get("params", {})
            if not isinstance(params, dict):
                raise ProtocolError(-32602, "Parameters must be an object")
            response["result"] = self.handle(request["method"], params)
        except ProtocolError as error:
            response["error"] = {"code": error.code, "message": error.message}
        except Exception:
            response["error"] = {"code": -32603, "message": "Internal MCP error"}
        return response

    def handle(self, method, params):
        if method == "initialize":
            if self.version is not None:
                raise ProtocolError(-32600, "Already initialized")
            if not isinstance(params.get("protocolVersion"), str):
                raise ProtocolError(-32602, "protocolVersion is required")
            self.version = params["protocolVersion"] if params["protocolVersion"] in SUPPORTED else SUPPORTED[0]
            return {"protocolVersion": self.version,
                    "capabilities": {"tools": {}, "resources": {}},
                    "serverInfo": {"name": "harakiri", "version": "3.0.1"},
                    "instructions": "Use focused briefings and contextual replies. Approved guidance is available as tools and resources. Native permissions remain authoritative."}
        if method == "ping":
            return {}
        if self.version is None:
            raise ProtocolError(-32600, "Initialize before using tools or resources")
        modern = self.version in SUPPORTED[:2]
        if method == "tools/list":
            if params.get("cursor"):
                raise ProtocolError(-32602, "Unknown tool cursor")
            return {"tools": [{k:v for k,v in t.items() if modern or k != "outputSchema"} for t in self.tools]}
        if method == "tools/call":
            name, args = params.get("name"), params.get("arguments", {})
            if not isinstance(name, str) or name not in self.names or not isinstance(args, dict):
                raise ProtocolError(-32602, "Choose an advertised tool with object arguments")
            try:
                value = read_tool_result(args) if name == "read_tool_result" else call(name, args)
                return tool_result(name, value, structured=modern)
            except TimeoutError:
                return tool_result(name, {
                    "error": "The response timed out. The operation may still finish; inspect the artifact history or workspace destination before retrying. A timeout does not mean the operation was rolled back.",
                    "code": "tool_outcome_unknown",
                }, structured=modern)
            except Exception as error:
                # Tool execution failures are useful model-visible results,
                # distinct from malformed protocol requests.
                return tool_result(name, {"error": str(error)[:512], "code": "tool_execution_failed"}, structured=modern)
        if method == "resources/list":
            if params.get("cursor"):
                raise ProtocolError(-32602, "Unknown resource cursor")
            return {"resources": [{"uri": "harakiri://guidance/" + name, "name": name,
                                   "mimeType": "text/markdown"} for name in MODULES]}
        if method == "resources/read":
            uri = params.get("uri", "")
            prefix = "harakiri://guidance/"
            if not isinstance(uri, str) or not uri.startswith(prefix) or uri[len(prefix):] not in MODULES:
                raise ProtocolError(-32002, "Unknown approved guidance resource")
            value = call("guidance", {"module": uri[len(prefix):]})
            if "error" in value:
                raise ProtocolError(-32000, str(value["error"])[:512])
            return {"contents": [{"uri": uri, "mimeType": "text/markdown", "text": value["content"]}]}
        raise ProtocolError(-32601, "Method not found")


def serve(stream, output, tools):
    DELIVERIES.clear()
    server = Server(tools)
    while raw := stream.readline(MAX_LINE + 1):
        if len(raw) > MAX_LINE:
            # Fail closed instead of parsing the tail as a second request.
            return
        try:
            request = json.loads(raw)
            response = server.dispatch(request)
        except (ValueError, UnicodeError):
            response = {"jsonrpc": "2.0", "id": None,
                        "error": {"code": -32700, "message": "Parse error"}}
        if response is not None:
            print(json.dumps(response), file=output, flush=True)
            # A failed serialization/write must never consume instructions.
            # A lost acknowledgment can redeliver, which is safer than loss.
            while DELIVERIES:
                receipt = DELIVERIES.pop(0)
                try:
                    call("record_delivery", receipt)
                except Exception:
                    pass


def main():
    with open("/opt/harakiri/tools.json", encoding="utf8") as f:
        serve(sys.stdin.buffer, sys.stdout, json.load(f))


if __name__ == "__main__":
    main()
