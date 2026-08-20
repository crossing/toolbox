---
name: whatsapp-mcp-server
description: Stdio MCP server exposing WhatsApp chats/messages from the whatsapp-bridge store. Read-only unless WHATSAPP_MCP_ALLOW_SEND=1.
---

# whatsapp-mcp-server

A stdio MCP server (vendored fork of lharries/whatsapp-mcp) that reads the SQLite
message store maintained by `whatsapp-bridge` and calls the bridge's REST API.
Register it in an MCP client; it is not a CLI to script against.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `WHATSAPP_STATE_DIR` | `./store` | Bridge state dir; `messages.db` is read from here |
| `WHATSAPP_DB_PATH` | `$WHATSAPP_STATE_DIR/messages.db` | Explicit message-DB override |
| `WHATSAPP_API_URL` | `http://localhost:8080/api` | Bridge REST endpoint |
| `WHATSAPP_MCP_ALLOW_SEND` | unset | Set to `1` to register the three send tools |

## Tools

Read (always): `search_contacts`, `list_messages`, `list_chats`, `get_chat`,
`get_direct_chat_by_contact`, `get_contact_chats`, `get_last_interaction`,
`get_message_context`, `download_media`.

Send (only with `WHATSAPP_MCP_ALLOW_SEND=1`): `send_message`, `send_file`,
`send_audio_message`. Leave sending off unless a human explicitly asked for it.
`send_audio_message` needs `ffmpeg` on PATH for conversion; without it, use
`send_file` with an already-encoded `.ogg` opus file.

## Caveats

- Requires a running, paired `whatsapp-bridge`; an empty tool result usually means
  the bridge is down or not yet synced, not that there are no messages.
- The paired account is a low-volume throwaway: sending should stay rare and
  human-reviewed even when enabled.
