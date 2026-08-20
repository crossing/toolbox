"""Asserts which tools the server registers, depending on WHATSAPP_MCP_ALLOW_SEND.

Run as: python3 test_gating.py {readonly|sendable}
The env var must be set (or unset) by the caller BEFORE import, because the
gate runs at module import time.
"""

import asyncio
import sys

from whatsapp_mcp_server import main as server

SEND_TOOLS = {"send_message", "send_file", "send_audio_message"}
READ_TOOLS = {"search_contacts", "list_messages", "list_chats", "download_media"}


def tool_names():
    return {tool.name for tool in asyncio.run(server.mcp.list_tools())}


def main():
    mode = sys.argv[1]
    names = tool_names()

    missing_reads = READ_TOOLS - names
    assert not missing_reads, f"read tools missing: {missing_reads}"

    registered_sends = SEND_TOOLS & names
    if mode == "readonly":
        assert not registered_sends, f"send tools leaked into read-only mode: {registered_sends}"
    elif mode == "sendable":
        assert registered_sends == SEND_TOOLS, f"send tools incomplete: {names & SEND_TOOLS}"
    else:
        raise SystemExit(f"unknown mode {mode!r}")

    print(f"{mode}: OK ({len(names)} tools)")


if __name__ == "__main__":
    main()
