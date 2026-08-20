---
name: whatsapp-bridge
description: WhatsApp linked-device bridge daemon — syncs messages to SQLite and serves a localhost REST API for whatsapp-mcp-server. Operate it via systemd; run interactively only to (re)pair.
---

# whatsapp-bridge

A Go daemon (vendored fork of lharries/whatsapp-mcp, whatsmeow-based) that connects
to WhatsApp as a **linked device**, mirrors message history into SQLite, and exposes
a REST API on localhost for the companion `whatsapp-mcp-server`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `WHATSAPP_STATE_DIR` | `./store` | Where `whatsapp.db` (session), `messages.db` (history) and downloaded media live |
| `WHATSAPP_BRIDGE_PORT` | `8080` | REST API port (localhost only) |

## Running

Normally a systemd user service owns the process. Do not start a second instance
against the same state dir — two whatsmeow clients on one session DB corrupt it.

## Pairing / re-pairing

Pairing requires an interactive terminal: on first run (or after WhatsApp drops the
session) the bridge prints a QR code to stdout and waits. A systemd unit cannot do
this. Procedure:

1. Stop the unit.
2. Run `WHATSAPP_STATE_DIR=<state dir> whatsapp-bridge` in a terminal.
3. Scan the QR from the phone: WhatsApp → Settings → Linked devices → Link a device.
4. Ctrl-C after "Connected to WhatsApp", restart the unit.

## Caveats

- The bridge sees only chats the paired account is in.
- Unofficial client: WhatsApp can ban the account. Keep traffic modest and
  human-plausible; never pair a primary account.
