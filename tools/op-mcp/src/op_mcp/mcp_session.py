"""One MCP session over an accepted, origin-verified socket connection.

The wire format matches the MCP stdio transport (newline-delimited JSON-RPC), so
the bridge can pipe bytes verbatim. This module is the only place the mcp SDK is
imported; everything else in op_mcp stays standard-library so the tests run
without the SDK installed.
"""

from __future__ import annotations

import json
import socket

import anyio
import mcp.types as types
from mcp.server.lowlevel import Server
from mcp.shared.message import SessionMessage
from pydantic import ValidationError

_ARGS_SCHEMA = {"type": "array", "items": {"type": "string"}}
_PLAN_PROPERTIES = {
    "plan_name": {
        "type": "string",
        "description": "Name of the business action if this call becomes a plan.",
    },
    "plan_area": {
        "type": "string",
        "description": "Optional area for the plan (accounting, correspondence, ...).",
    },
    "plan_id": {
        "type": "string",
        "description": "Append this call as a step to an existing planned plan.",
    },
    "rationale": {
        "type": "string",
        "description": "Why this action is needed; shown to the human at plan review.",
    },
}
_WRITE_NOTE = (
    "Calls matching the read allowlist execute immediately. Anything else is "
    "recorded as a plan (status 'planned') for a human to review and run in a "
    "terminal with `op-mcp plan run`; never attempt to execute a plan yourself."
)


def _tool_definitions(service) -> list[types.Tool]:
    tools = []
    if "gws" in service.config.toolsets:
        accounts = ", ".join(sorted(service.config.toolsets["gws"].accounts)) or "none"
        tools.append(
            types.Tool(
                name="gws",
                description=(
                    "Run the gws (Google Workspace) CLI with a server-held token. "
                    f"Configured accounts: {accounts}. " + _WRITE_NOTE
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "account": {
                            "type": "string",
                            "description": "Configured account name; omit for the default.",
                        },
                        "args": {**_ARGS_SCHEMA, "description": "argv passed to gws."},
                        **_PLAN_PROPERTIES,
                    },
                    "required": ["args"],
                },
            )
        )
    if "freeagent" in service.config.toolsets:
        tools.append(
            types.Tool(
                name="freeagent",
                description=(
                    "Run the freeagent CLI with a server-held token. " + _WRITE_NOTE
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "args": {**_ARGS_SCHEMA, "description": "argv passed to freeagent."},
                        **_PLAN_PROPERTIES,
                    },
                    "required": ["args"],
                },
            )
        )
    tools.append(
        types.Tool(
            name="plan_list",
            description="List pending and past plans (read-only).",
            inputSchema={"type": "object", "properties": {}},
        )
    )
    tools.append(
        types.Tool(
            name="plan_status",
            description="Show one plan in full, including its steps (read-only).",
            inputSchema={
                "type": "object",
                "properties": {"id": {"type": "string"}},
                "required": ["id"],
            },
        )
    )
    return tools


def _build_server(service, agent: str) -> Server:
    server = Server("op-mcp")

    @server.list_tools()
    async def list_tools() -> list[types.Tool]:
        return _tool_definitions(service)

    @server.call_tool()
    async def call_tool(name: str, arguments: dict) -> list[types.TextContent]:
        result = await anyio.to_thread.run_sync(
            service.handle_tool_call, name, arguments or {}, agent
        )
        return [types.TextContent(type="text", text=json.dumps(result))]

    return server


async def _run_session(conn: socket.socket, handle, service, agent: str) -> None:
    server = _build_server(service, agent)
    read_writer, read_stream = anyio.create_memory_object_stream(0)
    write_stream, write_reader = anyio.create_memory_object_stream(0)

    async def socket_to_session():
        try:
            while True:
                line = await anyio.to_thread.run_sync(handle.readline, abandon_on_cancel=True)
                if not line:
                    break
                try:
                    message = types.JSONRPCMessage.model_validate_json(line)
                except ValidationError as err:
                    await read_writer.send(err)
                    continue
                await read_writer.send(SessionMessage(message))
        except (OSError, anyio.ClosedResourceError, anyio.BrokenResourceError):
            pass
        finally:
            await read_writer.aclose()

    async def session_to_socket():
        try:
            async with write_reader:
                async for session_message in write_reader:
                    data = session_message.message.model_dump_json(
                        by_alias=True, exclude_none=True
                    )
                    await anyio.to_thread.run_sync(conn.sendall, (data + "\n").encode())
        except (OSError, anyio.ClosedResourceError, anyio.BrokenResourceError):
            pass

    async with anyio.create_task_group() as task_group:
        task_group.start_soon(socket_to_session)
        task_group.start_soon(session_to_socket)
        try:
            await server.run(
                read_stream, write_stream, server.create_initialization_options()
            )
        except (anyio.ClosedResourceError, anyio.BrokenResourceError):
            pass
        finally:
            task_group.cancel_scope.cancel()


def serve_connection(conn: socket.socket, handle, service, agent: str) -> None:
    """Run one MCP session to completion (blocking; called from its own thread)."""
    anyio.run(_run_session, conn, handle, service, agent)
