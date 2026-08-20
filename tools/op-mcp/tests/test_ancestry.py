"""Ancestry-walk origin enforcement against a fake /proc tree."""

import os
import sys
import tempfile
import unittest
from unittest import mock

from op_mcp import ancestry
from op_mcp.ancestry import OriginDenied, has_controlling_tty, verify_agent_ancestry


class FakeProc:
    """Builds a fake /proc tree with exe symlinks and status/stat files."""

    def __init__(self, root):
        self.root = root
        self.bin_dir = os.path.join(root, "bin")
        os.makedirs(self.bin_dir, exist_ok=True)
        self.proc = os.path.join(root, "proc")
        os.makedirs(self.proc, exist_ok=True)

    def binary(self, name):
        path = os.path.join(self.bin_dir, name)
        if not os.path.exists(path):
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("#fake\n")
        return path

    def process(self, pid, exe, ppid, tty_nr=0, comm="proc"):
        pid_dir = os.path.join(self.proc, str(pid))
        os.makedirs(pid_dir, exist_ok=True)
        if exe is not None:
            os.symlink(exe, os.path.join(pid_dir, "exe"))
        with open(os.path.join(pid_dir, "status"), "w", encoding="utf-8") as handle:
            handle.write(f"Name:\t{comm}\nPPid:\t{ppid}\n")
        with open(os.path.join(pid_dir, "stat"), "w", encoding="utf-8") as handle:
            handle.write(f"{pid} ({comm}) S {ppid} {pid} {pid} {tty_nr} -1 0\n")


class AncestryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fake = FakeProc(self.tmp.name)
        self.agent = self.fake.binary("fake-agent")
        self.bridge = self.fake.binary("fake-bridge")
        self.shell = self.fake.binary("fake-shell")
        # pid 1 (init) <- 50 (shell) <- 100 (agent) <- 101 (bridge)
        self.fake.process(1, self.fake.binary("fake-init"), 0)
        self.fake.process(50, self.shell, 1, tty_nr=34816)
        self.fake.process(100, self.agent, 50)
        self.fake.process(101, self.bridge, 100)
        # pid 200: same bridge binary but spawned outside any agent
        self.fake.process(200, self.bridge, 50)

    def verify(self, pid, allowed):
        return verify_agent_ancestry(pid, allowed, proc_root=self.fake.proc)

    def test_bridge_under_allowlisted_agent_is_accepted(self):
        matched = self.verify(101, [self.agent])
        self.assertEqual(matched, os.path.realpath(self.agent))

    def test_peer_that_is_itself_the_agent_is_accepted(self):
        self.assertEqual(self.verify(100, [self.agent]), os.path.realpath(self.agent))

    def test_bridge_outside_agent_ancestry_is_denied(self):
        # The bridge binary itself earns nothing: it is world-readable and
        # untrusted. Only an allowlisted *agent* ancestor admits a peer.
        with self.assertRaises(OriginDenied):
            self.verify(200, [self.agent])

    def test_empty_allowlist_denies(self):
        with self.assertRaises(OriginDenied):
            self.verify(101, [])

    def test_unreadable_peer_exe_denies(self):
        self.fake.process(300, None, 50)
        with self.assertRaises(OriginDenied):
            self.verify(300, [self.agent])

    def test_deleted_exe_denies(self):
        deleted = os.path.join(self.fake.bin_dir, "gone")
        pid_dir = os.path.join(self.fake.proc, "301")
        os.makedirs(pid_dir)
        os.symlink(deleted + " (deleted)", os.path.join(pid_dir, "exe"))
        with open(os.path.join(pid_dir, "status"), "w", encoding="utf-8") as handle:
            handle.write("PPid:\t50\n")
        with self.assertRaises(OriginDenied):
            self.verify(301, [self.agent])

    def test_ppid_loop_terminates_and_denies(self):
        self.fake.process(400, self.shell, 401)
        self.fake.process(401, self.shell, 400)
        with self.assertRaises(OriginDenied):
            self.verify(400, [self.agent])

    def test_peer_exe_swap_during_walk_is_denied(self):
        """Pid-reuse race: the peer's exe must be identical before and after."""
        real_read_exe = ancestry._read_exe
        calls = {"count": 0}

        def racy_read_exe(pid, proc_root):
            result = real_read_exe(pid, proc_root)
            calls["count"] += 1
            if pid == 101 and calls["count"] > 1:
                return os.path.realpath(self.shell)  # pid got reused mid-walk
            return result

        with mock.patch.object(ancestry, "_read_exe", racy_read_exe):
            with self.assertRaises(OriginDenied) as ctx:
                self.verify(101, [self.agent])
        self.assertIn("changed", str(ctx.exception))


class ControllingTtyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fake = FakeProc(self.tmp.name)

    def test_tty_owner_detected(self):
        self.fake.process(10, self.fake.binary("cli"), 1, tty_nr=34816)
        self.assertTrue(has_controlling_tty(10, proc_root=self.fake.proc))

    def test_no_tty_detected(self):
        self.fake.process(11, self.fake.binary("daemon"), 1, tty_nr=0)
        self.assertFalse(has_controlling_tty(11, proc_root=self.fake.proc))

    def test_comm_with_spaces_and_parens(self):
        self.fake.process(12, self.fake.binary("odd"), 1, tty_nr=34816, comm="a) b (c")
        self.assertTrue(has_controlling_tty(12, proc_root=self.fake.proc))

    def test_missing_process_is_not_a_tty_owner(self):
        self.assertFalse(has_controlling_tty(999, proc_root=self.fake.proc))


if __name__ == "__main__":
    sys.exit(unittest.main())
