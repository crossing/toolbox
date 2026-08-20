"""op-mcp command line.

Subcommands:

- ``serve``                  run the MCP service in the foreground
- ``connect``                the stdio<->socket bridge an MCP client spawns
- ``start`` / ``stop`` / ``status``   drive the systemd user unit (degrades off NixOS)
- ``plan list|show|run|reject``       the human plan workflow

Per docs/conventions.md: JSON on stdout (``--human`` indents), everything else on
stderr. Exit codes: 0 ok; 1 runtime failure; 2 credential problem; 3 usage or
configuration error; 4 service or systemd unavailable; 5 denied or aborted.
"""

from __future__ import annotations

import argparse
import json
import signal
import sys
import time

from op_mcp import config as config_mod
from op_mcp import ipc, systemd
from op_mcp.config import ConfigError
from op_mcp.plans import Plan, PlanError, PlanStore
from op_mcp.secrets import SecretsError


def _emit(payload: dict, human: bool) -> None:
    if human:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(json.dumps(payload, separators=(",", ":"), sort_keys=True))


def _fail(message: str, code: int) -> int:
    print(f"op-mcp: {message}", file=sys.stderr)
    return code


def _socket_path(args) -> str:
    if getattr(args, "socket", None):
        return args.socket
    try:
        return config_mod.load_config(args.config).socket_path
    except ConfigError:
        return config_mod.default_socket_path()


def _plan_store(args) -> PlanStore:
    """Plan store from config when available, XDG defaults otherwise.

    The store must be reachable without a config file (and without the service
    running): `plan list/show/reject` are plain file operations.
    """
    try:
        cfg = config_mod.load_config(args.config)
        return PlanStore(f"{cfg.state_dir}/plans", ttl_days=cfg.plan_ttl_days)
    except ConfigError:
        return PlanStore(
            f"{config_mod.default_state_dir()}/plans",
            ttl_days=config_mod.DEFAULT_PLAN_TTL_DAYS,
        )


# -- subcommands -----------------------------------------------------------------


def _cmd_serve(args) -> int:
    from op_mcp import service as service_mod

    try:
        cfg = config_mod.load_config(args.config)
    except ConfigError as err:
        return _fail(str(err), 3)
    try:
        svc = service_mod.build_service(cfg)
    except SecretsError as err:
        return _fail(f"eager credential load failed: {err}", 2)

    def _stop(_signum, _frame):
        svc.shutdown()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    try:
        svc.serve_forever()
    except (OSError, RuntimeError) as err:
        return _fail(str(err), 1)
    return 0


def _cmd_connect(args) -> int:
    from op_mcp import bridge

    try:
        socket_path = args.socket or config_mod.default_socket_path()
    except ConfigError as err:
        return _fail(str(err), 3)
    return bridge.run_bridge(socket_path)


def _cmd_start(args) -> int:
    code, report = systemd.start()
    _emit(report, args.human)
    return code


def _cmd_stop(args) -> int:
    code, report = systemd.stop()
    _emit(report, args.human)
    return code


def _cmd_status(args) -> int:
    try:
        socket_path = _socket_path(args)
    except ConfigError as err:
        return _fail(str(err), 3)
    code, report = systemd.status(socket_path)
    _emit(report, args.human)
    return code


def _cmd_plan_list(args) -> int:
    from op_mcp.service import plan_summary

    store = _plan_store(args)
    _emit({"plans": [plan_summary(plan) for plan in store.list()]}, args.human)
    return 0


def _cmd_plan_show(args) -> int:
    store = _plan_store(args)
    try:
        _emit(store.get(args.id).to_dict(), args.human)
    except PlanError as err:
        return _fail(str(err), 3)
    return 0


def _cmd_plan_reject(args) -> int:
    store = _plan_store(args)
    try:
        plan = store.reject(args.id)
    except PlanError as err:
        return _fail(str(err), 3)
    _emit({"id": plan.id, "status": plan.status}, args.human)
    return 0


def _print_preview(plan: Plan) -> None:
    say = lambda text: print(text, file=sys.stderr)  # noqa: E731
    created = time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime(plan.created))
    say(f"Plan {plan.id}: {plan.name}")
    if plan.area:
        say(f"  area:      {plan.area}")
    if plan.agent:
        say(f"  requested: {plan.agent}")
    say(f"  created:   {created}")
    if plan.rationale:
        say(f"  rationale: {plan.rationale}")
    say("  steps:")
    for index, step in enumerate(plan.steps, start=1):
        origin = step.toolset + (f"/{step.account}" if step.account else "")
        say(f"    {index}. [{origin}] {' '.join(step.argv)}")


def _cmd_plan_run(args) -> int:
    store = _plan_store(args)
    try:
        plan = store.runnable(args.id)
    except PlanError as err:
        return _fail(str(err), 3)

    # Presence is enforced by the medium: this command is for a human in a
    # terminal, deliberately not an MCP tool. The server independently checks
    # that the requester owns a controlling terminal.
    if not sys.stdin.isatty():
        return _fail("plan run is interactive; run it yourself in a terminal", 5)

    _print_preview(plan)
    print(file=sys.stderr)
    print("Execute this action as a whole? Type 'yes' to proceed: ", end="", file=sys.stderr)
    sys.stderr.flush()
    answer = sys.stdin.readline().strip()
    if answer != "yes":
        return _fail("aborted; the plan remains planned (reject it with `op-mcp plan reject`)", 5)

    try:
        socket_path = _socket_path(args)
    except ConfigError as err:
        return _fail(str(err), 3)
    try:
        response = ipc.control_roundtrip(
            socket_path, {"op": "run_plan", "id": plan.id}, timeout=900
        )
    except (OSError, ipc.ProtocolError) as err:
        return _fail(f"cannot reach the service at {socket_path}: {err}", 4)

    _emit(response, args.human)
    if response.get("status") == "executed":
        return 0
    return 5 if response.get("status") == "error" else 1


# -- argument parsing ------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    # The global flags are accepted both before and after the subcommand
    # (`op-mcp --human plan list` and `op-mcp plan list --human`). SUPPRESS keeps
    # a leaf parser from clobbering a value parsed at the root.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--config",
        default=argparse.SUPPRESS,
        help="config file (default: $OP_MCP_CONFIG or XDG)",
    )
    common.add_argument(
        "--human",
        action="store_true",
        default=argparse.SUPPRESS,
        help="indent JSON output",
    )

    # NOTE: no parser.set_defaults(config=..., human=...) here -- set_defaults
    # mutates the *shared* parent actions' SUPPRESS defaults, which would let a
    # leaf parser clobber a value parsed at the root. main() fills the fallbacks.
    parser = argparse.ArgumentParser(
        prog="op-mcp",
        parents=[common],
        description="Presence-scoped MCP service for the 1Password-backed OAuth CLIs.",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    def command(name: str, help_text: str, handler) -> argparse.ArgumentParser:
        sub = commands.add_parser(name, parents=[common], help=help_text)
        sub.set_defaults(handler=handler)
        return sub

    command("serve", "run the MCP service in the foreground", _cmd_serve)

    connect = command("connect", "stdio<->socket bridge for MCP clients", _cmd_connect)
    connect.add_argument("--socket", help="socket path (default: $XDG_RUNTIME_DIR/op-mcp.sock)")

    command("start", "start the systemd user unit", _cmd_start)
    command("stop", "stop the systemd user unit", _cmd_stop)
    status = command("status", "unit state and socket reachability", _cmd_status)
    status.add_argument("--socket", help="socket path override")

    plan = commands.add_parser("plan", help="review and execute write plans")
    plan_commands = plan.add_subparsers(dest="plan_command", required=True)

    def plan_command(name: str, help_text: str, handler) -> argparse.ArgumentParser:
        sub = plan_commands.add_parser(name, parents=[common], help=help_text)
        sub.set_defaults(handler=handler)
        return sub

    plan_command("list", "list plans", _cmd_plan_list)
    plan_command("show", "show one plan in full", _cmd_plan_show).add_argument("id")
    run = plan_command("run", "review and execute a plan (interactive, human only)", _cmd_plan_run)
    run.add_argument("id")
    run.add_argument("--socket", help="socket path override")
    plan_command("reject", "discard a plan", _cmd_plan_reject).add_argument("id")

    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    args.config = getattr(args, "config", None)
    args.human = getattr(args, "human", False)
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
