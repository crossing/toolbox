"""Configuration for op-mcp.

The config file is JSON, rendered by the consumer (a home-ops module in Phase 2;
written by hand until then). Nothing in it is secret: it *names* 1Password items,
it never holds their values.

Resolution order for the path: ``--config`` flag, then ``$OP_MCP_CONFIG``, then
``$XDG_CONFIG_HOME/op-mcp/config.json``. Environment variables override individual
fields where noted below; that is also how tests stub the op commands.
"""

from __future__ import annotations

import json
import os
import shlex
from dataclasses import dataclass, field
from typing import Any

DEFAULT_PLAN_TTL_DAYS = 7.0
# Idle timeout default is OFF (0 = disabled): the plan's open item stays open, and
# until it is decided the service runs until stopped, like ibgateway.
DEFAULT_IDLE_TIMEOUT_MINUTES = 0.0

GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
FREEAGENT_TOKEN_ENDPOINT = "https://api.freeagent.com/v2/token_endpoint"

# Default read allowlists, per toolset. Default-deny: anything not matching one of
# these argv shapes is a write and becomes a plan. Grow these on demand (config
# `extraReads`) rather than ever adding a write blocklist.
DEFAULT_READ_ALLOWLISTS: dict[str, list[list[str]]] = {
    "gws": [
        # Gmail: search, get, attachment fetch. Fetching an attachment writes bytes
        # locally but is a *read* of the account.
        ["gmail", "users", "messages", "list"],
        ["gmail", "users", "messages", "get"],
        ["gmail", "users", "messages", "attachments", "get"],
        ["gmail", "users", "threads", "list"],
        ["gmail", "users", "threads", "get"],
        ["gmail", "users", "labels", "list"],
        # Drive: list and download.
        ["drive", "files", "list"],
        ["drive", "files", "get"],
        ["drive", "files", "download"],
        # Calendar: list.
        ["calendar", "events", "list"],
        ["calendar", "calendarList", "list"],
    ],
    "freeagent": [
        # The freeagent CLI's read surface is `<resource> list|get` plus the
        # top-level accounting report commands; everything else
        # (create/delete/approve/attach) is a write.
        ["*", "list"],
        ["*", "get"],
        ["balance-sheet"],
        ["profit-and-loss"],
        ["trial-balance"],
    ],
}

KNOWN_TOOLSETS = ("gws", "freeagent")


class ConfigError(Exception):
    """The configuration is missing, unreadable, or invalid."""


@dataclass(frozen=True)
class GwsAccount:
    item: str
    note: str = ""


@dataclass
class ToolsetConfig:
    name: str
    command: list[str]
    read_allowlist: list[list[str]]
    token_endpoint: str
    # gws only:
    accounts: dict[str, GwsAccount] = field(default_factory=dict)
    default_account: str = ""
    # freeagent only:
    item: str = ""


@dataclass
class Config:
    socket_path: str
    state_dir: str
    vault: str = ""
    allowed_clients: list[str] = field(default_factory=list)
    plan_ttl_days: float = DEFAULT_PLAN_TTL_DAYS
    idle_timeout_minutes: float = DEFAULT_IDLE_TIMEOUT_MINUTES
    toolsets: dict[str, ToolsetConfig] = field(default_factory=dict)
    # Reads go through safe-op (blocks secret egress to a TTY); writes -- the rare
    # refresh-token rotation -- use bare `op item edit`, which must resolve to the
    # ambient 1Password wrapper. Overridable so tests never touch the real thing.
    safe_op_cmd: list[str] = field(default_factory=lambda: ["safe-op"])
    op_cmd: list[str] = field(default_factory=lambda: ["op"])


def default_config_path() -> str:
    if os.environ.get("OP_MCP_CONFIG"):
        return os.environ["OP_MCP_CONFIG"]
    xdg = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.path.join(xdg, "op-mcp", "config.json")


def default_socket_path() -> str:
    if os.environ.get("OP_MCP_SOCKET"):
        return os.environ["OP_MCP_SOCKET"]
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR")
    if not runtime_dir:
        raise ConfigError(
            "XDG_RUNTIME_DIR is not set; set OP_MCP_SOCKET or the `socket` config key"
        )
    return os.path.join(runtime_dir, "op-mcp.sock")


def default_state_dir() -> str:
    if os.environ.get("OP_MCP_STATE_DIR"):
        return os.environ["OP_MCP_STATE_DIR"]
    xdg = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
    return os.path.join(xdg, "op-mcp")


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ConfigError(message)


def _string_list(value: Any, what: str) -> list[str]:
    _require(
        isinstance(value, list) and all(isinstance(v, str) for v in value),
        f"{what} must be a list of strings",
    )
    return list(value)


def _allowlist(value: Any, what: str) -> list[list[str]]:
    _require(isinstance(value, list), f"{what} must be a list of argv patterns")
    patterns = []
    for entry in value:
        pattern = _string_list(entry, f"each entry of {what}")
        _require(bool(pattern), f"{what} entries must be non-empty")
        patterns.append(pattern)
    return patterns


def _parse_toolset(name: str, raw: dict[str, Any]) -> ToolsetConfig:
    _require(name in KNOWN_TOOLSETS, f"unknown toolset '{name}' (known: {KNOWN_TOOLSETS})")
    command = _string_list(raw.get("command", [name]), f"toolsets.{name}.command")
    _require(bool(command), f"toolsets.{name}.command must be non-empty")

    if "readAllowlist" in raw:
        allowlist = _allowlist(raw["readAllowlist"], f"toolsets.{name}.readAllowlist")
    else:
        allowlist = [list(p) for p in DEFAULT_READ_ALLOWLISTS[name]]
    if "extraReads" in raw:
        allowlist += _allowlist(raw["extraReads"], f"toolsets.{name}.extraReads")

    default_endpoint = (
        GOOGLE_TOKEN_ENDPOINT if name == "gws" else FREEAGENT_TOKEN_ENDPOINT
    )
    token_endpoint = raw.get("tokenEndpoint", default_endpoint)
    _require(isinstance(token_endpoint, str), f"toolsets.{name}.tokenEndpoint must be a string")

    toolset = ToolsetConfig(
        name=name,
        command=command,
        read_allowlist=allowlist,
        token_endpoint=token_endpoint,
    )

    if name == "gws":
        raw_accounts = raw.get("accounts", {})
        _require(isinstance(raw_accounts, dict), "toolsets.gws.accounts must be an object")
        _require(bool(raw_accounts), "toolsets.gws.accounts must configure at least one account")
        for account, spec in raw_accounts.items():
            _require(isinstance(spec, dict), f"toolsets.gws.accounts.{account} must be an object")
            item = spec.get("item", "")
            _require(
                isinstance(item, str) and bool(item),
                f"toolsets.gws.accounts.{account}.item is required",
            )
            toolset.accounts[account] = GwsAccount(item=item, note=str(spec.get("note", "")))
        toolset.default_account = raw.get("defaultAccount", "")
        _require(
            not toolset.default_account or toolset.default_account in toolset.accounts,
            "toolsets.gws.defaultAccount must name a configured account",
        )
    else:
        item = raw.get("item", "")
        _require(isinstance(item, str) and bool(item), "toolsets.freeagent.item is required")
        toolset.item = item

    return toolset


def _env_cmd(var: str, fallback: list[str]) -> list[str]:
    value = os.environ.get(var)
    return shlex.split(value) if value else fallback


def load_config(path: str | None = None) -> Config:
    """Load and validate the JSON config file."""
    resolved = path or default_config_path()
    try:
        with open(resolved, encoding="utf-8") as handle:
            raw = json.load(handle)
    except FileNotFoundError:
        raise ConfigError(f"config file not found: {resolved}") from None
    except (OSError, json.JSONDecodeError) as err:
        raise ConfigError(f"cannot read config file {resolved}: {err}") from None
    _require(isinstance(raw, dict), "config root must be a JSON object")

    socket_path = raw.get("socket") or default_socket_path()
    if os.environ.get("OP_MCP_SOCKET"):
        socket_path = os.environ["OP_MCP_SOCKET"]
    state_dir = raw.get("stateDir") or default_state_dir()
    if os.environ.get("OP_MCP_STATE_DIR"):
        state_dir = os.environ["OP_MCP_STATE_DIR"]

    config = Config(
        socket_path=socket_path,
        state_dir=state_dir,
        vault=str(raw.get("vault", "")),
        allowed_clients=_string_list(raw.get("allowedClients", []), "allowedClients"),
        plan_ttl_days=float(raw.get("planTtlDays", DEFAULT_PLAN_TTL_DAYS)),
        idle_timeout_minutes=float(
            raw.get("idleTimeoutMinutes", DEFAULT_IDLE_TIMEOUT_MINUTES)
        ),
        safe_op_cmd=_env_cmd(
            "OP_MCP_SAFE_OP", _string_list(raw.get("safeOpCommand", ["safe-op"]), "safeOpCommand")
        ),
        op_cmd=_env_cmd("OP_MCP_OP", _string_list(raw.get("opCommand", ["op"]), "opCommand")),
    )

    raw_toolsets = raw.get("toolsets", {})
    _require(isinstance(raw_toolsets, dict), "toolsets must be an object")
    _require(bool(raw_toolsets), "at least one toolset must be configured")
    for name, spec in raw_toolsets.items():
        _require(isinstance(spec, dict), f"toolsets.{name} must be an object")
        config.toolsets[name] = _parse_toolset(name, spec)

    _require(
        config.plan_ttl_days > 0,
        "planTtlDays must be positive (plans must not linger executable forever)",
    )
    _require(config.idle_timeout_minutes >= 0, "idleTimeoutMinutes must be >= 0")
    return config
