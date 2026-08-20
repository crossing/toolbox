"""Socket round-trip through the real server loop, with peer creds stubbed.

Runs the actual Unix-socket listener in a thread; peer credentials and the /proc
tree are stubbed so origin decisions are deterministic. Nothing here touches op,
safe-op, the mcp SDK, or the network.
"""

import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_ancestry import FakeProc  # noqa: E402

from op_mcp import ipc  # noqa: E402
from op_mcp.config import Config, ToolsetConfig  # noqa: E402
from op_mcp.plans import PlanStore, Step  # noqa: E402
from op_mcp.service import Service  # noqa: E402

AGENT_PID = 100
BRIDGE_PID = 101
STRANGER_PID = 200
TTY_CLI_PID = 300
NO_TTY_PID = 301

# The fake toolset command: a Python one-liner standing in for the freeagent CLI.
# It proves env-token injection without any real binary.
STUB_TOOL = [
    sys.executable,
    "-c",
    (
        "import json, os, sys; "
        "print(json.dumps({'ran': True, 'token': os.environ.get('FREEAGENT_ACCESS_TOKEN'),"
        " 'argv': sys.argv[1:]}))"
    ),
]


class FakeTokens:
    """Duck-typed TokenStore: fixed fake tokens, never any op or network."""

    def freeagent_token(self):
        return "fake-access-token"

    def refresh_freeagent(self):
        return "fake-access-token-2"

    def gws_token(self, account):
        return f"fake-gws-token-{account}"


class ServerFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fake = FakeProc(self.tmp.name)
        agent = self.fake.binary("fake-agent")
        bridge = self.fake.binary("fake-bridge")
        shell = self.fake.binary("fake-shell")
        self.fake.process(1, self.fake.binary("fake-init"), 0)
        self.fake.process(50, shell, 1, tty_nr=34816)
        self.fake.process(AGENT_PID, agent, 50)
        self.fake.process(BRIDGE_PID, bridge, AGENT_PID)
        self.fake.process(STRANGER_PID, bridge, 50)
        self.fake.process(TTY_CLI_PID, self.fake.binary("fake-cli"), 50, tty_nr=34816)
        self.fake.process(NO_TTY_PID, self.fake.binary("fake-cli"), 50, tty_nr=0)

        self.socket_path = os.path.join(self.tmp.name, "op-mcp.sock")
        config = Config(
            socket_path=self.socket_path,
            state_dir=os.path.join(self.tmp.name, "state"),
            allowed_clients=[agent],
            toolsets={
                "freeagent": ToolsetConfig(
                    name="freeagent",
                    command=list(STUB_TOOL),
                    read_allowlist=[["*", "list"], ["*", "get"]],
                    token_endpoint="http://token.invalid",
                    item="Fake FreeAgent Item",
                )
            },
        )
        self.plans = PlanStore(os.path.join(config.state_dir, "plans"), ttl_days=7)
        # The stubbed peer: tests set self.peer to choose who "connects".
        self.peer = {"pid": TTY_CLI_PID, "uid": os.getuid()}
        self.service = Service(
            config,
            FakeTokens(),
            self.plans,
            proc_root=self.fake.proc,
            peer_credentials_fn=lambda conn: (self.peer["pid"], self.peer["uid"], 0),
        )
        self.thread = threading.Thread(target=self.service.serve_forever, daemon=True)
        self.thread.start()
        deadline = time.time() + 10
        while not os.path.exists(self.socket_path):
            if time.time() > deadline:
                self.fail("server socket never appeared")
            time.sleep(0.02)
        self.addCleanup(self._stop)

    def _stop(self):
        self.service.shutdown()
        self.thread.join(timeout=5)

    # -- raw client helpers ------------------------------------------------------

    def raw_session(self, banner: bytes, payload: bytes = b"") -> bytes:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(10)
            conn.connect(self.socket_path)
            conn.sendall(banner + payload)
            chunks = []
            try:
                while True:
                    chunk = conn.recv(65536)
                    if not chunk:
                        break
                    chunks.append(chunk)
            except socket.timeout:
                self.fail("server neither responded nor closed the connection")
        return b"".join(chunks)


class ControlChannelTest(ServerFixture):
    def test_ping_roundtrip(self):
        response = ipc.control_roundtrip(self.socket_path, {"op": "ping"}, timeout=10)
        self.assertTrue(response["ok"])
        self.assertEqual(response["toolsets"], ["freeagent"])

    def test_foreign_uid_is_dropped_without_a_response(self):
        self.peer["uid"] = os.getuid() + 1
        with self.assertRaises(ipc.ProtocolError):
            ipc.control_roundtrip(self.socket_path, {"op": "ping"}, timeout=10)

    def test_garbage_banner_is_dropped(self):
        self.assertEqual(self.raw_session(b"GET / HTTP/1.1\r\n\r\n"), b"")

    def test_unknown_control_op_is_an_error(self):
        response = ipc.control_roundtrip(self.socket_path, {"op": "frobnicate"}, timeout=10)
        self.assertEqual(response["status"], "error")


class McpOriginTest(ServerFixture):
    def test_peer_without_agent_ancestry_is_closed_silently(self):
        self.peer["pid"] = STRANGER_PID
        self.assertEqual(self.raw_session(ipc.BANNER_MCP), b"")

    def test_run_plan_without_tty_is_denied(self):
        plan = self.plans.create("Example action", [Step("freeagent", ["bills", "create"])])
        self.peer["pid"] = NO_TTY_PID
        response = ipc.control_roundtrip(
            self.socket_path, {"op": "run_plan", "id": plan.id}, timeout=10
        )
        self.assertEqual(response["status"], "error")
        self.assertIn("terminal", response["error"])
        # The plan must remain planned: denial is not consumption.
        self.assertEqual(self.plans.get(plan.id).status, "planned")


class PlanExecutionTest(ServerFixture):
    def test_run_plan_executes_with_injected_token(self):
        plan = self.plans.create(
            "Example action",
            [Step("freeagent", ["bills", "create", "--contact", "fake"])],
        )
        self.peer["pid"] = TTY_CLI_PID
        response = ipc.control_roundtrip(
            self.socket_path, {"op": "run_plan", "id": plan.id}, timeout=30
        )
        self.assertEqual(response["status"], "executed")
        payload = json.loads(response["results"][0]["stdout"])
        self.assertTrue(payload["ran"])
        self.assertEqual(payload["token"], "fake-access-token")
        self.assertEqual(payload["argv"], ["bills", "create", "--contact", "fake"])
        self.assertEqual(self.plans.get(plan.id).status, "executed")

    def test_executed_plan_cannot_run_twice(self):
        plan = self.plans.create("Example action", [Step("freeagent", ["bills", "create"])])
        self.peer["pid"] = TTY_CLI_PID
        first = ipc.control_roundtrip(
            self.socket_path, {"op": "run_plan", "id": plan.id}, timeout=30
        )
        self.assertEqual(first["status"], "executed")
        second = ipc.control_roundtrip(
            self.socket_path, {"op": "run_plan", "id": plan.id}, timeout=30
        )
        self.assertEqual(second["status"], "error")


class ToolCallClassificationTest(ServerFixture):
    """service.handle_tool_call is what MCP sessions dispatch into."""

    def test_allowlisted_read_executes(self):
        result = self.service.handle_tool_call(
            "freeagent", {"args": ["bills", "list"]}, agent="/fake/agent"
        )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["exit_code"], 0)
        self.assertTrue(json.loads(result["stdout"])["ran"])

    def test_write_becomes_a_plan_not_an_execution(self):
        result = self.service.handle_tool_call(
            "freeagent",
            {
                "args": ["bills", "create", "--contact", "fake"],
                "plan_name": "Create example bill",
                "rationale": "test",
            },
            agent="/fake/agent",
        )
        self.assertEqual(result["status"], "planned")
        plan = self.plans.get(result["plan"]["id"])
        self.assertEqual(plan.status, "planned")
        self.assertEqual(plan.agent, "/fake/agent")
        self.assertIn("read allowlist", result["message"])

    def test_write_can_append_to_an_existing_plan(self):
        first = self.service.handle_tool_call(
            "freeagent",
            {"args": ["bills", "create"], "plan_name": "Two-step action"},
            agent="/fake/agent",
        )
        second = self.service.handle_tool_call(
            "freeagent",
            {"args": ["explanations", "approve", "1"], "plan_id": first["plan"]["id"]},
            agent="/fake/agent",
        )
        self.assertEqual(second["status"], "planned")
        self.assertEqual(second["plan"]["steps"], 2)

    def test_unknown_tool_is_an_error(self):
        result = self.service.handle_tool_call("op_read", {}, agent="/fake/agent")
        self.assertEqual(result["status"], "error")

    def test_plan_tools_are_read_only_views(self):
        created = self.service.handle_tool_call(
            "freeagent", {"args": ["bills", "create"], "plan_name": "P"}, agent="/fake/agent"
        )
        listing = self.service.handle_tool_call("plan_list", {}, agent="/fake/agent")
        self.assertEqual(listing["status"], "ok")
        self.assertIn(created["plan"]["id"], [p["id"] for p in listing["plans"]])
        status = self.service.handle_tool_call(
            "plan_status", {"id": created["plan"]["id"]}, agent="/fake/agent"
        )
        self.assertEqual(status["plan"]["status"], "planned")


if __name__ == "__main__":
    sys.exit(unittest.main())
