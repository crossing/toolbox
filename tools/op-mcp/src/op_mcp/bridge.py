"""The stdio<->socket bridge: what an MCP client actually spawns.

The bridge connects *immediately* at spawn -- while its agent parent is alive and
therefore visible in the server's ancestry walk -- and holds the connection for
its whole life. It never reconnects lazily, because origin enforcement happens at
connect time. It is deliberately untrusted: all enforcement is server-side.
"""

from __future__ import annotations

import os
import socket
import sys
import threading

from op_mcp import ipc

_CHUNK = 65536


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def run_bridge(socket_path: str) -> int:
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        conn.connect(socket_path)
        conn.sendall(ipc.BANNER_MCP)
    except OSError as err:
        print(f"op-mcp connect: cannot reach {socket_path}: {err}", file=sys.stderr)
        print("Is the service running? Start it with `op-mcp start`.", file=sys.stderr)
        return 4

    done = threading.Event()
    received_any = False

    def stdin_to_socket() -> None:
        try:
            while True:
                chunk = os.read(0, _CHUNK)
                if not chunk:
                    break
                conn.sendall(chunk)
        except OSError:
            pass
        finally:
            try:
                conn.shutdown(socket.SHUT_WR)
            except OSError:
                pass
            done.set()  # parent closed stdin: the session is over

    def socket_to_stdout() -> None:
        nonlocal received_any
        try:
            while True:
                chunk = conn.recv(_CHUNK)
                if not chunk:
                    break
                received_any = True
                _write_all(1, chunk)
        except OSError:
            pass
        finally:
            done.set()

    for target in (stdin_to_socket, socket_to_stdout):
        threading.Thread(target=target, daemon=True).start()
    done.wait()
    conn.close()
    if not received_any:
        print(
            "op-mcp connect: server closed the connection without responding "
            "(origin check failed? check the service log)",
            file=sys.stderr,
        )
        return 1
    return 0
