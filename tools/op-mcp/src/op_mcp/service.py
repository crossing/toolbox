"""The op-mcp service: a Unix-socket server with origin enforcement.

One listener at ``$XDG_RUNTIME_DIR/op-mcp.sock`` (0600). Each connection opens
with a banner (see ipc.py) declaring itself an MCP session or a control session;
enforcement happens at accept, before any payload:

- every peer must share the server's UID (SO_PEERCRED);
- MCP sessions additionally need an allowlisted agent binary in their /proc
  ancestry (see ancestry.py) -- the bridge itself is deliberately untrusted;
- control ``run_plan`` requests additionally need the peer to own a controlling
  terminal: presence is enforced by the medium.

The MCP protocol layer lives in mcp_session.py and is imported lazily so this
module (and the socket tests) stay importable with the standard library alone.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import threading
import time

from op_mcp import ancestry, classify, ipc
from op_mcp.config import Config
from op_mcp.plans import Plan, PlanError, PlanStore, Step
from op_mcp.secrets import SecretsError, TokenStore

_ACCEPT_POLL_SECONDS = 1.0
_BANNER_TIMEOUT = 5.0
_STEP_TIMEOUT = 600


def _log(message: str) -> None:
    timestamp = time.strftime("%H:%M:%S")
    print(f"op-mcp[{timestamp}] {message}", file=sys.stderr, flush=True)


def plan_summary(plan: Plan) -> dict:
    return {
        "id": plan.id,
        "name": plan.name,
        "area": plan.area,
        "status": plan.status,
        "agent": plan.agent,
        "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(plan.created)),
        "steps": len(plan.steps),
    }


class Service:
    def __init__(
        self,
        config: Config,
        token_store: TokenStore,
        plan_store: PlanStore,
        proc_root: str = "/proc",
        peer_credentials_fn=ancestry.peer_credentials,
        run=subprocess.run,
    ):
        self.config = config
        self.tokens = token_store
        self.plans = plan_store
        self.proc_root = proc_root
        self.peer_credentials = peer_credentials_fn
        self.run = run
        self.started_at = time.time()
        self._listener: socket.socket | None = None
        self._shutdown = threading.Event()
        self._active_connections = 0
        self._last_activity = time.time()
        self._activity_lock = threading.Lock()

    # -- execution ---------------------------------------------------------------

    def _run_command(self, argv: list[str], env_extra: dict[str, str]) -> dict:
        env = {**os.environ, **env_extra}
        try:
            result = self.run(
                argv, capture_output=True, text=True, env=env, timeout=_STEP_TIMEOUT, check=False
            )
        except FileNotFoundError:
            return {"exit_code": 127, "stdout": "", "stderr": f"command not found: {argv[0]}"}
        except subprocess.TimeoutExpired:
            return {"exit_code": 124, "stdout": "", "stderr": f"timed out after {_STEP_TIMEOUT}s"}
        return {
            "exit_code": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
        }

    def execute_step(self, step: Step) -> dict:
        """Run one toolset invocation with the token injected via env."""
        toolset = self.config.toolsets.get(step.toolset)
        if toolset is None:
            return {"exit_code": 3, "stdout": "", "stderr": f"toolset '{step.toolset}' not configured"}
        argv = [*toolset.command, *step.argv]
        if step.toolset == "gws":
            token = self.tokens.gws_token(step.account)
            return self._run_command(argv, {"GOOGLE_WORKSPACE_CLI_TOKEN": token})
        # freeagent: run, and on a 401 refresh in-process and retry once, exactly
        # as op-freeagent.sh does.
        token = self.tokens.freeagent_token()
        result = self._run_command(argv, {"FREEAGENT_ACCESS_TOKEN": token})
        if result["exit_code"] != 0 and "status 401" in result["stderr"]:
            token = self.tokens.refresh_freeagent()
            result = self._run_command(argv, {"FREEAGENT_ACCESS_TOKEN": token})
        return result

    # -- MCP tool calls ----------------------------------------------------------

    def handle_tool_call(self, name: str, arguments: dict, agent: str) -> dict:
        """Dispatch one MCP tool call. Returns a JSON-safe result dict."""
        self.touch()
        try:
            if name == "plan_list":
                return {"status": "ok", "plans": [plan_summary(p) for p in self.plans.list()]}
            if name == "plan_status":
                plan = self.plans.get(str(arguments.get("id", "")))
                return {"status": "ok", "plan": plan.to_dict()}
            if name in ("gws", "freeagent"):
                return self._toolset_call(name, arguments, agent)
        except (PlanError, SecretsError) as err:
            return {"status": "error", "error": str(err)}
        return {"status": "error", "error": f"unknown tool: {name}"}

    def _toolset_call(self, name: str, arguments: dict, agent: str) -> dict:
        toolset = self.config.toolsets.get(name)
        if toolset is None:
            return {"status": "error", "error": f"toolset '{name}' is not configured"}
        args = arguments.get("args")
        if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
            return {"status": "error", "error": "'args' must be a list of strings"}

        account = ""
        if name == "gws":
            account = str(arguments.get("account") or toolset.default_account)
            if account not in toolset.accounts:
                known = ", ".join(sorted(toolset.accounts)) or "none"
                return {
                    "status": "error",
                    "error": f"unknown gws account '{account}' (configured: {known})",
                }

        step = Step(toolset=name, argv=list(args), account=account)
        if classify.is_read(args, toolset.read_allowlist):
            result = self.execute_step(step)
            return {"status": "ok", **result}

        # Not in the read allowlist: default-deny. The call becomes (part of) a
        # plan a human must review and run in a terminal.
        plan_id = str(arguments.get("plan_id", ""))
        rationale = str(arguments.get("rationale", ""))
        if plan_id:
            plan = self.plans.append_steps(plan_id, [step])
        else:
            plan_name = str(arguments.get("plan_name", "")) or f"{name}: {' '.join(args[:4])}"
            plan = self.plans.create(
                name=plan_name,
                steps=[step],
                area=str(arguments.get("plan_area", "")),
                rationale=rationale,
                agent=agent,
            )
        return {
            "status": "planned",
            "plan": plan_summary(plan),
            "message": (
                "This call is not in the read allowlist, so it was recorded as a plan "
                f"instead of executed. Tell the user: review with `op-mcp plan show {plan.id}` "
                f"and execute with `op-mcp plan run {plan.id}` in a terminal. If this was a "
                "read, ask the user to extend the toolset's read allowlist. "
                "Never attempt to run the plan yourself."
            ),
        }

    # -- plan execution (control path) -------------------------------------------

    def run_plan(self, plan_id: str) -> dict:
        self.touch()
        try:
            plan = self.plans.runnable(plan_id)
        except PlanError as err:
            return {"status": "error", "error": str(err)}
        results = []
        completed = True
        try:
            for step in plan.steps:
                result = self.execute_step(step)
                results.append({"toolset": step.toolset, "account": step.account,
                                "argv": step.argv, **result})
                if result["exit_code"] != 0:
                    completed = False
                    break
        except SecretsError as err:
            results.append({"exit_code": 1, "stdout": "", "stderr": str(err)})
            completed = False
        self.plans.mark_executed(plan_id, results)
        return {
            "status": "executed" if completed else "failed",
            "plan": plan_summary(self.plans.get(plan_id)),
            "results": results,
        }

    # -- status / idle tracking --------------------------------------------------

    def touch(self) -> None:
        with self._activity_lock:
            self._last_activity = time.time()

    def status_info(self) -> dict:
        gws = self.config.toolsets.get("gws")
        return {
            "ok": True,
            "socket": self.config.socket_path,
            "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.started_at)),
            "toolsets": sorted(self.config.toolsets),
            "gws_accounts": sorted(gws.accounts) if gws else [],
            "allowed_clients": len(self.config.allowed_clients),
        }

    # -- socket serving ----------------------------------------------------------

    def _bind(self) -> socket.socket:
        path = self.config.socket_path
        if os.path.exists(path):
            probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                probe.connect(path)
            except OSError:
                os.unlink(path)  # stale socket from a dead server
            else:
                raise RuntimeError(f"another op-mcp server is already listening on {path}")
            finally:
                probe.close()
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(path)
        os.chmod(path, 0o600)
        listener.listen(16)
        listener.settimeout(_ACCEPT_POLL_SECONDS)
        return listener

    def serve_forever(self) -> None:
        self._listener = self._bind()
        _log(f"listening on {self.config.socket_path}")
        watchdog = None
        if self.config.idle_timeout_minutes > 0:
            watchdog = threading.Thread(target=self._idle_watchdog, daemon=True)
            watchdog.start()
        try:
            while not self._shutdown.is_set():
                try:
                    conn, _ = self._listener.accept()
                except socket.timeout:
                    continue
                except OSError:
                    break
                thread = threading.Thread(
                    target=self._connection_thread, args=(conn,), daemon=True
                )
                thread.start()
        finally:
            self._cleanup()

    def shutdown(self) -> None:
        self._shutdown.set()

    def _cleanup(self) -> None:
        if self._listener is not None:
            try:
                self._listener.close()
            except OSError:
                pass
        try:
            os.unlink(self.config.socket_path)
        except OSError:
            pass
        _log("stopped; in-memory tokens are gone")

    def _idle_watchdog(self) -> None:
        limit = self.config.idle_timeout_minutes * 60
        while not self._shutdown.wait(timeout=min(60.0, limit / 4 + 1)):
            with self._activity_lock:
                idle = time.time() - self._last_activity
                busy = self._active_connections > 0
            if not busy and idle > limit:
                _log(f"idle for {int(idle)}s (> {int(limit)}s); shutting down")
                self.shutdown()
                return

    def _connection_thread(self, conn: socket.socket) -> None:
        with self._activity_lock:
            self._active_connections += 1
        try:
            self._handle_connection(conn)
        except Exception as err:  # never let one connection kill the server
            _log(f"connection error: {err}")
        finally:
            with self._activity_lock:
                self._active_connections -= 1
                self._last_activity = time.time()
            try:
                conn.close()
            except OSError:
                pass

    def _handle_connection(self, conn: socket.socket) -> None:
        self.touch()
        try:
            pid, uid, _gid = self.peer_credentials(conn)
        except OSError as err:
            _log(f"rejecting peer: cannot read credentials ({err})")
            return
        if uid != os.getuid():
            _log(f"rejecting peer pid {pid}: uid {uid} != {os.getuid()}")
            return

        conn.settimeout(_BANNER_TIMEOUT)
        handle = conn.makefile("rb")
        try:
            kind = ipc.read_banner(handle)
        except (ipc.ProtocolError, OSError) as err:
            _log(f"rejecting peer pid {pid}: {err}")
            return

        if kind == ipc.KIND_MCP:
            try:
                agent = ancestry.verify_agent_ancestry(
                    pid, self.config.allowed_clients, proc_root=self.proc_root
                )
            except ancestry.OriginDenied as err:
                _log(f"denying MCP session from pid {pid}: {err}")
                return
            _log(f"MCP session from pid {pid} (agent: {agent})")
            conn.settimeout(None)
            from op_mcp import mcp_session  # lazy: needs the mcp SDK

            mcp_session.serve_connection(conn, handle, self, agent)
            return

        # Control session: one JSON request, one JSON response.
        try:
            request = ipc.read_control_request(handle)
        except (ipc.ProtocolError, OSError) as err:
            _log(f"control error from pid {pid}: {err}")
            return
        conn.settimeout(None)
        ipc.send_json_line(conn, self._handle_control(request, pid))

    def _handle_control(self, request: dict, pid: int) -> dict:
        op = request["op"]
        if op == "ping":
            return self.status_info()
        if op == "run_plan":
            # Presence is enforced by the medium: the requester must own a
            # controlling terminal. Agent-spawned subprocesses do not.
            if not ancestry.has_controlling_tty(pid, proc_root=self.proc_root):
                _log(f"denying run_plan from pid {pid}: no controlling terminal")
                return {
                    "status": "error",
                    "error": "plan execution requires a terminal (run `op-mcp plan run` yourself)",
                }
            return self.run_plan(str(request.get("id", "")))
        return {"status": "error", "error": f"unknown control op: {op}"}


def build_service(config: Config, progress=_log) -> Service:
    """Load tokens eagerly and construct the service (no socket yet)."""
    tokens = TokenStore(config)
    tokens.load(progress=progress)
    plans = PlanStore(
        os.path.join(config.state_dir, "plans"), ttl_days=config.plan_ttl_days
    )
    return Service(config, tokens, plans)
