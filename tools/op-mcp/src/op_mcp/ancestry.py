"""Server-side origin enforcement for socket peers.

At accept, the peer's pid/uid/gid come from ``SO_PEERCRED`` (kernel ground truth).
Any UID but the server's own is rejected outright. For MCP sessions, the peer must
then have an *allowlisted agent binary* in its ``/proc`` ancestry, compared via
``/proc/<pid>/exe`` -- the kernel's record of the running binary, immune to argv
games. The bridge is a direct child of the agent, so the walk is typically one hop.

Pid-reuse races during the walk are narrow but real; they are mitigated (not
eliminated) by re-reading the peer's exe after the walk and requiring it unchanged.
This is a bar-raiser against arbitrary local processes, not a wall against a
determined same-UID attacker -- see the plan's "Honest limits".

Every function takes ``proc_root`` so tests exercise the walk against a fake /proc
tree.
"""

from __future__ import annotations

import os
import socket
import struct

SO_PEERCRED = getattr(socket, "SO_PEERCRED", 17)
_MAX_DEPTH = 64


class OriginDenied(Exception):
    """The peer failed origin enforcement; str(err) says why."""


def peer_credentials(conn: socket.socket) -> tuple[int, int, int]:
    """Return (pid, uid, gid) of the connected Unix-socket peer."""
    data = conn.getsockopt(socket.SOL_SOCKET, SO_PEERCRED, struct.calcsize("3i"))
    pid, uid, gid = struct.unpack("3i", data)
    return pid, uid, gid


def _read_exe(pid: int, proc_root: str) -> str | None:
    try:
        target = os.readlink(os.path.join(proc_root, str(pid), "exe"))
    except OSError:
        return None
    if target.endswith(" (deleted)"):
        return None
    return os.path.realpath(target)


def _parent_pid(pid: int, proc_root: str) -> int | None:
    try:
        with open(os.path.join(proc_root, str(pid), "status"), encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("PPid:"):
                    return int(line.split()[1])
    except (OSError, ValueError, IndexError):
        return None
    return None


def verify_agent_ancestry(
    pid: int, allowed_clients: list[str], proc_root: str = "/proc"
) -> str:
    """Require an allowlisted agent binary among the peer's ancestors.

    Returns the matched agent exe path. Raises OriginDenied otherwise.
    """
    allowed = {os.path.realpath(path) for path in allowed_clients}
    if not allowed:
        raise OriginDenied("no allowedClients configured; refusing all MCP sessions")

    first_exe = _read_exe(pid, proc_root)
    if first_exe is None:
        raise OriginDenied(f"cannot identify peer binary for pid {pid}")

    matched = None
    current = pid
    for _ in range(_MAX_DEPTH):
        exe = _read_exe(current, proc_root)
        if exe is not None and exe in allowed:
            matched = exe
            break
        parent = _parent_pid(current, proc_root)
        if parent is None or parent == 0 or parent == current:
            break
        current = parent

    if matched is None:
        raise OriginDenied("no allowlisted agent binary in peer ancestry")

    # Narrow the pid-reuse window: the peer must still be the binary the walk
    # started from.
    if _read_exe(pid, proc_root) != first_exe:
        raise OriginDenied("peer binary changed during ancestry walk")
    return matched


def has_controlling_tty(pid: int, proc_root: str = "/proc") -> bool:
    """True when the process has a controlling terminal (tty_nr != 0).

    Used as a presence proxy for control connections: `plan run` comes from a
    human in a terminal, agent-spawned subprocesses typically have no ctty.
    """
    try:
        with open(os.path.join(proc_root, str(pid), "stat"), encoding="utf-8") as handle:
            stat = handle.read()
        # comm may contain spaces/parens; fields resume after the last ')'.
        rest = stat.rsplit(")", 1)[1].split()
        return int(rest[4]) != 0
    except (OSError, ValueError, IndexError):
        return False
