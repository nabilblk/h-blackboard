"""Pinned stdio MCP transport. Only the protected runtime user can reach it."""
import json
import socket
import sys

MAX_LINE = 2 * 1024 * 1024


def call(tool, arguments):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(100)
        connection.connect("/run/harakiri/mcp.sock")
        connection.sendall((json.dumps({"tool": tool, "arguments": arguments}) + "\n").encode())
        with connection.makefile("rb") as stream:
            response = stream.readline(MAX_LINE + 1)
        if len(response) > MAX_LINE:
            raise ValueError("Tool response too large")
        return json.loads(response)


def main():
    with open("/opt/harakiri/tools.json", encoding="utf8") as f:
        tools = json.load(f)
    while raw := sys.stdin.buffer.readline(MAX_LINE + 1):
        if len(raw) > MAX_LINE:
            return
        request = json.loads(raw)
        if "id" not in request:
            continue
        response = {"jsonrpc": "2.0", "id": request["id"]}
        try:
            method = request["method"]
            if method == "initialize":
                result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                          "serverInfo": {"name": "harakiri", "version": "2.0.0"}}
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": tools}
            elif method == "tools/call":
                params = request["params"]
                value = call(params["name"], params.get("arguments", {}))
                result = {"content": [{"type": "text", "text": json.dumps(value)}], "isError": "error" in value}
            else:
                raise ValueError("Unsupported MCP method")
            response["result"] = result
        except Exception as error:
            response["error"] = {"code": -32602, "message": str(error)[:512]}
        print(json.dumps(response), flush=True)


if __name__ == "__main__":
    main()
