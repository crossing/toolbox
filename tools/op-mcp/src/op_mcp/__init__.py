"""op-mcp: presence-scoped MCP service for the 1Password-backed OAuth CLIs.

One long-lived server reads every configured 1Password item eagerly at start (the
single moment a human is present to authorize the desktop app), then serves MCP
tool calls over a Unix socket. Steady state never touches `op`; access tokens are
refreshed in-process and live only in server memory.
"""

__version__ = "0.1.0"
