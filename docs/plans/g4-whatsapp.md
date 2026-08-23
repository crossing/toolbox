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
| `whatsapp/src/pbkdf2.ts` | PBKDF2-HMAC-SHA256, for the iteration count workerd refuses |
| `shared/src/whatsapp-api.ts` | the gateway ↔ bridge contract |
| `gateway/src/whatsapp.ts` | the MCP tools |
| `gateway/src/manage-whatsapp.ts` | `/manage/whatsapp`: QR pairing, health, store preview, import |
| `gateway/src/qr.ts` | ISO 18004 byte-mode level-L encoder → inline SVG, no dependency |
| `scripts/wa-import.py` | one-off history copy from the local bridge |

## Things that are load-bearing and non-obvious

- **`import "baileys"` must stay statically reachable from the Worker entry.**
  workerd only allows `new WebAssembly.Module()` during startup, and Baileys'
  crypto bridge compiles its WASM synchronously at module scope. The chain is
  `index.ts → bridge.ts → auth.ts → "baileys"`. A lazy `await import()` there
  would fail only in production.
- **workerd refuses PBKDF2 above 100,000 iterations**, and WhatsApp's pairing
  derivation asks for 131,072. `whatsapp/src/pbkdf2.ts` computes that one
  derivation in JS and shims it into `crypto.subtle`; without it pairing fails
  outright. `preflight()` exercises it.
- **`auth.reset()` must clear the creds object, not merge over it.** Baileys
  picks the login path over the registration path purely on `creds.me` being
  set, so a leftover `me` from an abandoned pairing makes the next connect ask
  to log in as a device that was never registered — the socket opens, no
  pairing stanza ever arrives, and it times out looking healthy.
- **Pre-key reads must stay chunked.** The first login after pairing uploads
  812 pre-keys and asks the key store for all of them in one `get`; DO SQLite
  caps a statement at 100 bound parameters. `preflight()` exercises exactly
  this against the real object.
- **The drain marker is not the end of the drain.** Baileys re-buffers events
  immediately after `receivedPendingNotifications`, so a cycle waits a beat
  past the marker before closing.
- **515 after pairing is success.** WhatsApp confirms the pair, then tears the
  stream down with "restart required"; the session only becomes usable on the
  reconnect that follows. Both pairing paths share that tail.
- **The client identity is negotiable on the QR path and not on the code
  path.** `link_code_companion_reg` answers an unrecognised `browser` tuple
  with `<error code="400" text="bad-request"/>`, which is what a whole
  afternoon of "couldn't link device" turned out to be; QR registration
  accepts a custom name, and that name is what WhatsApp → Linked devices then
  displays. So the QR flow sends `["Mac OS", <device name>, "14.4.1"]` and the
  code flow sends Baileys' stock tuple. Only the *registration* socket matters
  — ordinary reconnects log in as the device that already exists.
- **`creds.registered` is a phone-code artefact, not a pairing flag.** Baileys
  sets it in exactly one place, the `link_code_companion_reg` notification
  handler in `Socket/messages-recv.js`. A QR pairing never sets it, so a
  `isPaired()` resting on it reports a perfectly good device as unpaired — and
  because `alarm()` and every write tool consult that predicate, the bridge
  then skips every scheduled cycle in silence while looking healthy. The honest
  signal is `creds.account`, the signed ADV device identity that
  `configureSuccessfulPairing` returns on `pair-success` for both paths and
  never writes speculatively. `creds.me` alone is not enough either:
  `requestPairingCode` writes it from the phone number before anything is
  confirmed. Found by pairing over QR for the first time — the failure is
  invisible until then.
- **QR refs run out.** Baileys asks WhatsApp for five, rotates one every
  `qrTimeout`, and then closes with 408 "QR refs attempts ended". At 50 s a ref
  that is a little over four minutes, which is what sets the length of the
  pairing window.
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

## Logging

Workers Logs is the log of record — `observability` is enabled on the Worker, so
every console call is indexed and queryable for three days. The bridge writes
**structured** entries (`console.log({ service, level, msg, … })`), because
Workers Logs indexes an object's fields but can only match a formatted string
by substring. A cycle emits one summary event worth querying across days:

```json
{"level":"info","service":"whatsapp-bridge","msg":"sync cycle ok",
 "event":"cycle","ok":true,"messages":0,"chats":0,"ms":4172}
```

Read it with `POST /accounts/<id>/workers/observability/telemetry/query`
filtering `$metadata.service = whatsapp-bridge`. **Not** with `wrangler tail`,
which withholds logs from WebSocket-upgraded invocations until the socket
closes — which, for this Worker, is always.

The SQLite ring the management page renders is a *mirror*, not the log: a Worker
cannot query Workers Logs without an API token, and the page has to show
something without one.

Three things respect the Workers Free budget of **200,000 log events per day,
account-wide** (3-day retention):

- **Verbose logging expires after 30 minutes.** It forwards Baileys' own output
  and every inbound stanza — hundreds of events per cycle instead of a dozen —
  so a flag left on by someone who got distracted is the one realistic way to
  spend the budget.
- **The management page stops polling when its tab is hidden.** Each poll is a
  gateway request *and* a bridge RPC, both of which produce an invocation
  event; at eight seconds that is over twenty thousand events a day from a tab
  nobody is looking at.
- **The sync cycle is intermittent anyway** — 144 wake-ups a day, about a dozen
  events each, which is under 1% of the budget.

## State

| Step | State |
|---|---|
| B1 auth state ⇄ DO SQLite | done; `preflight()` proves the 812-key path on the deployed object |
| B2 bridge DO lifecycle | done — pairing, alarm-driven drain, fatal-disconnect handling |
| B3 store + read tools | done; nine tools plus `whatsapp_bridge_status` |
| B4 media | download done (WebCrypto, integrity-checked); R2 offload not built |
| B5 history import | done; ran against production |
| B6 send | text and files done; audio must arrive pre-encoded |
| B7 pairing UX | QR-first, phone code as fallback, named device, auto-refreshing status |

Paired over **QR** 2026-08-23 (device `…:3@s.whatsapp.net`) and syncing on the
ten-minute alarm: scan, 515, reconnect, drain of 9 queued messages, then a
manual cycle with an empty queue and no error. The encoder is checked against
`qrencode` and decoded back by zbar in the test suite. That first real QR
pairing is what turned up the `creds.registered` trap above.

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
- **Member tags.** WhatsApp's per-group self-assigned label ("Share your role,
  title or how you're known in this group", 30 characters, shown under your
  name to everyone in that group) cannot be set from here. Baileys 7.0.0-rc14
  has no API for it: `Socket/groups.js` exposes subject, description, settings,
  ephemeral, invites and participants, and nothing else. The WAProto knows the
  feature exists but only as a capability flag
  (`DeviceCapabilities.MemberNameTagPrimarySupport`), which is a receiver-side
  advertisement, not a setter. The operation is almost certainly a `w:mex`
  GraphQL mutation, and MEX mutations are addressed by numeric query IDs minted
  by WhatsApp and published only inside the WhatsApp Web JS bundle — so
  supporting it means lifting an ID out of that bundle and re-lifting it every
  time they rebuild. Not worth it for a 30-character label. The bridge's own
  name in **Linked devices** is the supported equivalent, and it is
  configurable on `/manage/whatsapp`.

## Accepted risks

Message history and Signal session keys come to rest in Cloudflare. The
connect-churn fingerprint is not normal linked-device behaviour, so the ban
risk is somewhat above a steady client's; the account is treated as expendable
and the home bridge stays live. If the cloud bridge proves unreliable, plan B
remains the home sidecar behind a tunnel described in
[mcp-workers.md](mcp-workers.md).
