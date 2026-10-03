---
name: gateway-files
description: Move files between Drive, Gmail, WhatsApp and FreeAgent through the MCP gateway by ref, without bytes in the conversation; and upload or download files from a sandbox with signed curl URLs. Use whenever a file has to go from one service or surface to another.
---

# Gateway files

The gateway's `files` service moves files **by ref**. A ref is a short string naming
where a file is; the gateway fetches and delivers the bytes itself. Nothing passes
through the conversation, so a 20 MB PDF costs the same few tokens as a 2 KB one.

Use it instead of base64 round-trips (`gmail_get_attachment` → `drive_create_file`,
`whatsapp_download_media` → `whatsapp_send_file`) whenever nobody needs to *read* the file.

## Refs

| Kind | Syntax | Where ids come from |
|---|---|---|
| Drive file | `drive:<fileId>` | `drive_search`, `drive_get_file` |
| Gmail attachment | `gmail:<messageId>/<attachmentId>` | `gmail_get_message` |
| WhatsApp media | `wa:<chatJid>/<messageId>` | `whatsapp_list_messages` |

Sinks (only valid as `to`):

| Sink | Syntax |
|---|---|
| Drive folder | `drive:folder/<folderId>`; also `drive:folder/_Transit`, `drive:folder/root` |
| Existing Gmail draft | `gmail:draft/<draftId>` (from `gmail_list_drafts`, not a message id) |
| WhatsApp send | `wa:send/<phone in international format, or JID>` |
| FreeAgent attachment | `freeagent:bill/<id>`, `freeagent:explanation/<id>`, `freeagent:expense/<id>` |

**Accounts.** Append `?account=<label>` to a `drive:` or `gmail:` ref (or sink) to pick a
linked account; labels come from `gateway_list_accounts`. Without it each service uses its
own default from the management page. A "not found" error naming an account usually
means the file lives in a different one, so retry with `?account=`.

## Tools

| Tool | Use |
|---|---|
| `file_stat(ref)` | Name, type, size, md5. Check a file against a cap before sending it. |
| `file_transfer(from, to, name?, …)` | Any source to any sink, server-side. |
| `file_upload_url(name, mime_type, size)` | Signed PUT URL into `_Transit` for a sandbox. |
| `file_download_url(ref)` | Signed GET URL for any ref, for a sandbox. |

### Routing with `file_transfer`

```
file_transfer from=gmail:<msg>/<att>       to=drive:folder/<PARA folder id>  name="2026-10-03 Invoice.pdf"
file_transfer from=drive:<fileId>          to=gmail:draft/<draftId>
file_transfer from=wa:<chatJid>/<msgId>    to=drive:folder/<folderId>
file_transfer from=drive:<fileId>          to=wa:send/447700900111  confirm=true
file_transfer from=gmail:<msg>/<att>       to=freeagent:bill/<billId>  description="Receipt"
```

- **Drive to Drive in the same account is free.** Out of `_Transit` the file is *moved*
  (same id). Anything else is *copied*. No bytes go through the Worker either way.
- **Google Docs, Sheets and Slides are exported** when the sink is not Drive: Docs, Slides
  and Drawings to PDF, Sheets to xlsx. Pass `export_mime_type` for another format. A
  `name` without the export's extension gets it appended.
- **`wa:send/` needs `confirm: true`.** A send cannot be undone. Confirm only when the
  person asked for that send to that recipient.
- The result reports `mode` (`moved`, `copied` or `streamed`). When the file landed in
  Drive, it also gives the new `ref`.

The older pair tools (`drive_save_gmail_attachment`, `drive_save_whatsapp_media`,
`gmail_attach_drive_file`, `whatsapp_send_drive_file`) are now wrappers over
`file_transfer`. They are deprecated, so use `file_transfer` in new work.

## Sandbox recipe: upload and download with curl

Use this when the code runs somewhere that holds bytes on disk but can only reach the
gateway over HTTPS: a cloud Code session, a routine, or the claude.ai code sandbox.

**Upload a local file into Drive:**

1. Get the size: `stat -c %s report.pdf` (or `wc -c < report.pdf`).
2. Call `file_upload_url` with `name="2026-10-03 Report.pdf"`, `mime_type="application/pdf"`
   and `size=<bytes>`. It returns `{ref, url, method: "PUT", expires_at, curl}`.
3. Run the `curl` line with `<path>` replaced:

   ```bash
   curl -sS --fail-with-body -T report.pdf "<url>"
   ```

   The response is JSON `{ref, name, mimeType, size, md5}`. Compare `md5` with
   `md5sum report.pdf` when integrity matters.
4. `ref` is now an ordinary `drive:` ref. File it with `file_transfer` into a PARA folder.
   That is a move, so the id stays the same. Or send it on to Gmail, WhatsApp or FreeAgent.

**Download any ref to local disk:**

1. Call `file_download_url` with the ref. Drive files are served directly. Gmail and
   WhatsApp refs are first copied into `_Transit`, which needs the write grant. In that
   case the returned `ref` is the copy.
2. Run the `curl` line it returns:

   ```bash
   curl -sS --fail-with-body -o report.pdf "<url>"
   ```

**URL rules:**

| Rule | Detail |
|---|---|
| Lifetime | 15 minutes. |
| Credential | A URL is a bearer credential. Never put it in a note, a commit or a message. |
| PUT is single-use | A failed upload burns the URL; ask for a new one. |
| PUT size | Content-Length is required, and `curl -T` sends it. The body may not exceed `size`. |
| Expired or reused URL | Returns 410. Ask for a fresh URL. |

**Egress:** the sandbox must be allowed to reach the gateway host. Probe it first:

```bash
curl -sI https://mcp.xing.works/files/healthcheck | head -1   # expect: HTTP/2 204
```

If the probe returns a proxy block or a connection error instead of a status line, the
host is missing from that surface's egress allowlist. Allowlists live in claude.ai
settings: code-execution network egress for chat, and the environment's network access
for cloud Code and routines. Tell the person which surface is blocked rather than
working around it.

## `_Transit`

`_Transit` is a folder at the root of the default Drive account and the gateway's staging
area. Signed uploads land there, and so do the staged copies behind `file_download_url`.
There is only the one: `drive:folder/_Transit?account=...` is refused.

- **Ingesting means moving.** `file_transfer` from a `_Transit` file into its PARA
  folder keeps the file id. Do this as soon as the file's home is known.
- **Seven days, then trash.** A daily sweep trashes `_Transit` files older than 7 days.
  It never deletes them, so Drive keeps a trashed file for 30 more days. A swept file
  can still be ingested by its ref within those 30 days: the move restores it.
- Never treat `_Transit` as storage. A file still there is a file nobody filed.

## Size ceilings

A transfer over a cap is refused before any bytes move, with both numbers in the error.

| Path | Ceiling | Why |
|---|---|---|
| Drive → Drive folder (same account) | none | server-side move or copy |
| Any source → Drive folder | streamed | resumable upload |
| Gmail attachment as a source | 25 MB | one base64 JSON field |
| Google-native export | 10 MB | Drive's export limit |
| WhatsApp media as a source | 100 MB (32 MB if the message has no size) | bridge streaming ceiling |
| → Gmail draft | 18 MB total, less what the draft already holds | 25 MB message after encoding |
| → WhatsApp send | 5 MB | bridge send limit |
| → FreeAgent attachment | 5 MB | conservative; base64 in JSON |
| Signed PUT upload | 100 MB | Workers request body limit |

For anything larger than a sink takes, put it in Drive and send a Drive link instead.
