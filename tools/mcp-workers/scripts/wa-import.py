#!/usr/bin/env python3
"""One-off import of the local WhatsApp bridge's messages.db into the cloud
bridge's Durable Object store.

The local Go bridge (tools/whatsapp-bridge) and the cloud one are separate
linked devices with separate histories; this copies what the local one has
already seen so the cloud store does not start empty. It is idempotent — rows
upsert on (id, chat_jid) — so re-running after a few more local messages is
fine.

Auth: a short-lived code issued by the "Issue import code" button on
https://mcp.xing.works/manage/whatsapp. Nothing here needs a Cloudflare or
1Password credential.

Timestamps: the Go driver writes time.Time as "2026-08-20 23:32:04+01:00";
the cloud store is ISO-8601 UTC so ordering is lexical. Converted here.

Usage:
  wa-import.py --code CODE [--db PATH] [--endpoint URL] [--batch N] [--dry-run]
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

DEFAULT_DB = "~/.local/share/whatsapp-mcp/messages.db"
DEFAULT_ENDPOINT = "https://mcp.xing.works/manage/whatsapp/import"
# mcp.xing.works has a Cloudflare rule that 403s python-urllib's default
# user-agent ("banned user-agent"); send something curl-shaped instead.
USER_AGENT = "curl/8.9.0"


def to_iso_utc(value: str | None) -> str | None:
    """Normalize the Go bridge's timestamp layout to ISO-8601 UTC."""
    if not value:
        return None
    text = value.strip()
    # "2026-08-20 23:32:04+01:00" and "2026-08-20 23:32:04.123456789+01:00"
    candidate = text.replace(" ", "T", 1)
    # Python's fromisoformat rejects more than 6 fractional digits.
    if "." in candidate:
        head, _, tail = candidate.partition(".")
        digits = ""
        rest = ""
        for i, ch in enumerate(tail):
            if ch.isdigit():
                digits += ch
            else:
                rest = tail[i:]
                break
        candidate = f"{head}.{digits[:6]}{rest}"
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def b64(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        value = value.encode()
    if not value:
        return None
    return base64.b64encode(value).decode()


def nonempty(value):
    return value if value not in ("", None) else None


def read_rows(db_path: str):
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    chats = [
        {
            "jid": row["jid"],
            "name": nonempty(row["name"]),
            "lastMessageTime": to_iso_utc(row["last_message_time"]),
        }
        for row in conn.execute("SELECT jid, name, last_message_time FROM chats")
    ]
    messages = []
    for row in conn.execute(
        """SELECT id, chat_jid, sender, content, timestamp, is_from_me, media_type,
                  filename, url, media_key, file_sha256, file_enc_sha256, file_length
           FROM messages ORDER BY timestamp"""
    ):
        timestamp = to_iso_utc(row["timestamp"])
        if not timestamp:
            continue
        messages.append(
            {
                "id": row["id"],
                "chatJid": row["chat_jid"],
                "sender": row["sender"],
                "content": nonempty(row["content"]),
                "timestamp": timestamp,
                "isFromMe": bool(row["is_from_me"]),
                "mediaType": nonempty(row["media_type"]),
                "filename": nonempty(row["filename"]),
                "url": nonempty(row["url"]),
                "mediaKeyB64": b64(row["media_key"]),
                "fileSha256B64": b64(row["file_sha256"]),
                "fileEncSha256B64": b64(row["file_enc_sha256"]),
                "fileLength": row["file_length"],
            }
        )
    conn.close()
    return chats, messages


def post(endpoint: str, code: str, payload: dict) -> dict:
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode(),
        headers={
            "content-type": "application/json",
            "x-import-code": code,
            "user-agent": USER_AGENT,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as err:
        body = err.read().decode(errors="replace")[:400]
        raise SystemExit(f"import failed: HTTP {err.code} {body}") from err


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--code", help="import code from /manage/whatsapp")
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--batch", type=int, default=250, help="messages per request")
    parser.add_argument("--dry-run", action="store_true", help="print the payload summary and stop")
    args = parser.parse_args()

    db_path = os.path.expanduser(args.db)
    chats, messages = read_rows(db_path)
    if args.dry_run:
        print(json.dumps({"chats": len(chats), "messages": len(messages)}, indent=2))
        return 0
    if not args.code:
        parser.error("--code is required unless --dry-run")

    totals = {"chatsWritten": 0, "messagesWritten": 0, "skipped": 0}
    # Chats ride along with the first batch; messages are chunked so a large
    # history does not hit the Worker's request size limit.
    batches = [messages[i : i + args.batch] for i in range(0, len(messages), args.batch)] or [[]]
    for index, batch in enumerate(batches):
        result = post(
            args.endpoint,
            args.code,
            {"chats": chats if index == 0 else [], "messages": batch},
        )
        for key in totals:
            totals[key] += result.get(key, 0)
    print(json.dumps(totals, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
