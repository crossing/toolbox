"""Socket wire protocol shared by the server, the bridge, and the plan CLI.

Every connection starts with a one-line banner declaring its kind:

- ``OP-MCP MCP 1``      -- an MCP session (the stdio bridge). After the banner the
  connection carries newline-delimited JSON-RPC both ways, exactly as the MCP
  stdio transport does.
- ``OP-MCP CONTROL 1``  -- a control session (the human plan CLI). After the
  banner: one JSON request line in, one JSON response line out.

The banner exists so the server can apply the right origin enforcement *at
connect time* (agent-ancestry for MCP, controlling-tty for plan execution) before
any payload is processed.
"""

from __future__ import annotations

import json
import socket

BANNER_MCP = b"OP-MCP MCP 1\n"
BANNER_CONTROL = b"OP-MCP CONTROL 1\n"
_MAX_BANNER = max(len(BANNER_MCP), len(BANNER_CONTROL))
_MAX_CONTROL_LINE = 1 << 20

KIND_MCP = "mcp"
KIND_CONTROL = "control"


class ProtocolError(Exception):
    pass


def read_banner(handle) -> str:
    """Read and classify the connection banner from a file-like object."""
    line = handle.readline(_MAX_BANNER + 1)
    if line == BANNER_MCP:
        return KIND_MCP
    if line == BANNER_CONTROL:
        return KIND_CONTROL
    raise ProtocolError("unrecognized connection banner")


def read_control_request(handle) -> dict:
    line = handle.readline(_MAX_CONTROL_LINE)
    try:
        request = json.loads(line)
    except json.JSONDecodeError:
        raise ProtocolError("control request is not valid JSON") from None
    if not isinstance(request, dict) or not isinstance(request.get("op"), str):
        raise ProtocolError("control request must be an object with an 'op' string")
    return request


def send_json_line(conn: socket.socket, payload: dict) -> None:
    conn.sendall(json.dumps(payload, separators=(",", ":")).encode() + b"\n")


def control_roundtrip(socket_path: str, request: dict, timeout: float | None = None) -> dict:
    """Client side: connect, send one control request, read one response."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(timeout)
        conn.connect(socket_path)
        conn.sendall(BANNER_CONTROL)
        send_json_line(conn, request)
        try:
            with conn.makefile("rb") as handle:
                line = handle.readline(_MAX_CONTROL_LINE)
        except ConnectionResetError:
            line = b""  # a reset is a denial: same as closing without a response
    if not line:
        raise ProtocolError("server closed the control connection without a response")
    try:
        response = json.loads(line)
    except json.JSONDecodeError:
        raise ProtocolError("malformed control response") from None
    if not isinstance(response, dict):
        raise ProtocolError("control response must be an object")
    return response
