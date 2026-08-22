# G4 — WhatsApp in the cloud

The gateway's WhatsApp service: a Baileys session living in a Durable Object,
paired as a **second linked device** alongside the home whatsmeow bridge, which
keeps running untouched. The feasibility findings are in
[g4-whatsapp-spike.md](g4-whatsapp-spike.md), the surrounding architecture in
[mcp-gateway.md](mcp-gateway.md) §G4.

## Shape

```
gateway-mcp (mcp.xing.works)          whatsapp-bridge (no HTTP surface)
  /mcp    → whatsapp tool module ──┐
  /manage → pairing + health    ───┴─ DO binding ─→ WhatsAppBridge (DO)
                                                     ├── SQLite: auth, chats,
                                                     │   messages, meta
                                                     └── alarm every 10 min:
                                                         connect → drain →
                                                         disconnect
```

Two Workers, on purpose. Deploying a Worker restarts every Durable Object it
owns and disconnects every WebSocket; the gateway is edited often and the
WhatsApp session should not churn with it. The bridge has `workers_dev` off, no
custom domain and no route: its only door is the gateway's cross-script Durable
Object binding, so it inherits the gateway's Google sign-in and allowlist
instead of growing an auth story of its own.

## Why intermittent

An always-on socket costs ~83% of the free 13,000 GB-s/day Durable Object
budget and dies on every deploy anyway. A ten-minute alarm that connects,
drains WhatsApp's offline queue and disconnects costs roughly 8%. Sends connect
on demand, which is why the first send in a while takes a few seconds.

## Files

| Path | What |
|---|---|
| `whatsapp/src/auth.ts` | Baileys `AuthenticationState` over DO SQLite |
| `whatsapp/src/session.ts` | one connection: config, waiters, clean shutdown |
| `whatsapp/src/bridge.ts` | the Durable Object: cycles, pairing, RPC surface |
| `whatsapp/src/store.ts` | chats/messages schema and the nine read queries |
| `whatsapp/src/normalize.ts` | `WAMessage` → row |
| `whatsapp/src/media.ts` | fetch/verify/decrypt and encrypt/upload, WebCrypto only |
| `whatsapp/src/ws-shim.ts` | node-`ws` API over workerd's outbound WebSocket |
| `shared/src/whatsapp-api.ts` | the gateway ↔ bridge contract |
| `gateway/src/whatsapp.ts` | the MCP tools |
| `gateway/src/manage-whatsapp.ts` | `/manage/whatsapp` |
| `scripts/wa-import.py` | one-off history copy from the local bridge |

## Things that are load-bearing and non-obvious

- **`import "baileys"` must stay statically reachable from the Worker entry.**
  workerd only allows `new WebAssembly.Module()` during startup, and Baileys'
  crypto bridge compiles its WASM synchronously at module scope. The chain is
  `index.ts → bridge.ts → auth.ts → "baileys"`. A lazy `await import()` there
  would fail only in production.
- **Pre-key reads must stay chunked.** The first login after pairing uploads
  812 pre-keys and asks the key store for all of them in one `get`; DO SQLite
  caps a statement at 100 bound parameters. `preflight()` exercises exactly
  this against the real object.
- **The drain marker is not the end of the drain.** Baileys re-buffers events
  immediately after `receivedPendingNotifications`, so a cycle waits a beat
  past the marker before closing.
- **515 after pairing is success.** WhatsApp confirms the pair, then tears the
  stream down with "restart required"; the session only becomes usable on the
  reconnect that follows.
- **`sock.end(undefined)`, never `logout()`.** The latter unlinks the device
  server-side. Consequently `unpair()` only wipes local state — the device also
  has to be removed on the phone, or orphan "linked device" entries accumulate.
- **Media send bypasses `sendMessage`.** Baileys' path writes the encrypted
  file to `os.tmpdir()` and uploads it with `node:https`; the bridge encrypts
  in memory, POSTs to a host from `refreshMediaConn`, and calls `relayMessage`
  with a proto it builds itself.
- **Timestamps are ISO-8601 UTC.** The Go bridge writes `time.Time` with a
  local offset, which does not sort correctly across offsets; the importer
  converts.

## State

| Step | State |
|---|---|
| B1 auth state ⇄ DO SQLite | done; `preflight()` proves the 812-key path on the deployed object |
| B2 bridge DO lifecycle | done — pairing, alarm-driven drain, fatal-disconnect handling |
| B3 store + read tools | done; nine tools plus `whatsapp_bridge_status` |
| B4 media | download done (WebCrypto, integrity-checked); R2 offload not built |
| B5 history import | done; ran against production |
| B6 send | text and files done; audio must arrive pre-encoded |

Waiting on a human with the phone: request a code on `/manage/whatsapp`, type
it into WhatsApp → Linked devices → Link with phone number. Everything up to
that point is verified in production; nothing past it can be.

## Not built, deliberately

- **`send_audio_message`.** No ffmpeg to transcode with; send pre-encoded
  Ogg/Opus through `send_file` instead, which is what the local tool's
  workaround was anyway.
- **R2 offload for large media.** Images inline up to 2 MB as image blocks,
  other types up to 32 KB. Anything larger reports its size and type. The R2
  bucket and a signed `/media/:token` route on the gateway are the shape if it
  is wanted.
- **Group metadata.** `cachedGroupMetadata` is unset, so group sends pay a
  metadata query. Groups are named from `chats.upsert`; a group we have never
  seen named appears as its JID.

## Accepted risks

Message history and Signal session keys come to rest in Cloudflare. The
connect-churn fingerprint is not normal linked-device behaviour, so the ban
risk is somewhat above a steady client's; the account is treated as expendable
and the home bridge stays live. If the cloud bridge proves unreliable, plan B
remains the home sidecar behind a tunnel described in
[mcp-workers.md](mcp-workers.md).
