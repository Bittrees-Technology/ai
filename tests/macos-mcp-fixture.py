"""Exercise the native client over loopback with synthetic tools and a one-use fixture token."""
import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        assert self.headers["Authorization"] == "Bearer fixture-token"
        msg = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        method = msg["method"]
        if self.path == "/redirect":
            self.send_response(307)
            self.send_header("Location", "/unexpected")
            self.end_headers()
            return
        if self.path == "/denied":
            self.send_error(403)
            return
        if self.path == "/unexpected":
            raise AssertionError("followed redirect")
        if method != "initialize":
            assert self.headers["Mcp-Session-Id"] == "fixture-session"
            assert self.headers["MCP-Protocol-Version"] == "2025-06-18"
        if method == "notifications/initialized":
            assert "id" not in msg
            self.send_response(202)
            self.end_headers()
            return
        if method == "initialize":
            result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                      "serverInfo": {"name": "fixture", "version": "1"}}
        elif method == "tools/list":
            second = msg["params"].get("cursor") == "next"
            result = {"tools": [{"name": "fail" if second else "echo", "inputSchema": {"type": "object"}}]}
            if not second:
                result["nextCursor"] = "next"
        else:
            assert method == "tools/call"
            name = msg["params"]["name"]
            assert name in ("echo", "fail")
            result = {"content": [{"type": "text", "text": msg["params"]["arguments"].get("message", "error")}],
                      "isError": name == "fail"}
        rpc = json.dumps({"jsonrpc": "2.0", "id": "wrong" if self.path == "/wrong-id" else msg["id"],
                          "result": result}).encode()
        self.send_response(200)
        if method == "initialize":
            self.send_header("Mcp-Session-Id", "fixture-session")
        stream = self.path == "/stream"
        self.send_header("Content-Type", "text/event-stream" if stream else "application/json")
        self.end_headers()
        if stream:
            self.wfile.write(b': comment\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n')
            rpc = b"event: message\r\ndata: " + rpc + b"\r\n\r\n"
        self.wfile.write(rpc)


if __name__ == "__main__":
    with ThreadingHTTPServer(("127.0.0.1", 0), Fixture) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        subprocess.run([sys.argv[1], "http://127.0.0.1:" + str(server.server_port)], check=True, timeout=45)
