"""Lifecycle driver: a thin wrapper over a systemd *user* unit.

The service is manually started, never boot-enabled -- a boot-time 1Password
unlock prompt with nobody committed to it defeats the purpose. On NixOS the
Phase 2 home-ops module provides the unit; here we only drive it. Off NixOS (or
anywhere without a reachable user manager) start/stop degrade to a clear
instruction to run ``op-mcp serve`` in a terminal, and status falls back to
probing the socket directly.
"""

from __future__ import annotations

import os
import shutil
import subprocess

from op_mcp import ipc

DEFAULT_UNIT = "op-mcp.service"


def _unit() -> str:
    return os.environ.get("OP_MCP_UNIT", DEFAULT_UNIT)


def _systemctl(args: list[str], run=subprocess.run):
    """Run `systemctl --user ...`; None when no user manager is reachable."""
    if shutil.which("systemctl") is None:
        return None
    try:
        result = run(
            ["systemctl", "--user", *args], capture_output=True, text=True, check=False
        )
    except OSError:
        return None
    if result.returncode != 0 and "Failed to connect to bus" in result.stderr:
        return None
    return result


def _socket_probe(socket_path: str) -> dict:
    try:
        response = ipc.control_roundtrip(socket_path, {"op": "ping"}, timeout=5)
        return {"reachable": True, "info": response}
    except (OSError, ipc.ProtocolError) as err:
        return {"reachable": False, "error": str(err)}


_DEGRADED_HINT = (
    "no systemd user manager reachable; run `op-mcp serve` in a terminal instead"
)


def start(run=subprocess.run) -> tuple[int, dict]:
    result = _systemctl(["start", _unit()], run=run)
    if result is None:
        return 4, {"ok": False, "unit": _unit(), "error": _DEGRADED_HINT}
    if result.returncode != 0:
        return 1, {
            "ok": False,
            "unit": _unit(),
            "error": result.stderr.strip() or f"systemctl exited {result.returncode}",
        }
    return 0, {"ok": True, "unit": _unit(), "started": True}


def stop(run=subprocess.run) -> tuple[int, dict]:
    result = _systemctl(["stop", _unit()], run=run)
    if result is None:
        return 4, {"ok": False, "unit": _unit(), "error": _DEGRADED_HINT}
    if result.returncode != 0:
        return 1, {
            "ok": False,
            "unit": _unit(),
            "error": result.stderr.strip() or f"systemctl exited {result.returncode}",
        }
    return 0, {"ok": True, "unit": _unit(), "stopped": True}


def status(socket_path: str, run=subprocess.run) -> tuple[int, dict]:
    report: dict = {"unit": _unit(), "socket": socket_path}
    result = _systemctl(["is-active", _unit()], run=run)
    if result is None:
        report["systemd"] = "unavailable"
    else:
        report["systemd"] = result.stdout.strip() or "unknown"
    report.update(_socket_probe(socket_path))
    report["ok"] = report["reachable"]
    return (0 if report["ok"] else 4), report
