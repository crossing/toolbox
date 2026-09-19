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
| `whatsapp/src/store.ts` | chats/messages schema, its additive migrations, the nine read queries, and the lifecycle flags |
| `whatsapp/src/normalize.ts` | `WAMessage` → row; inbound revokes; undecryptable placeholders; rebuilding our own sends for a retry |
| `whatsapp/src/groups.ts` | groups: request validation, the create / participants / leave stanzas and their per-item replies, group info |
| `whatsapp/src/chatops.ts` | archive, delete-chat (app-state patches) and revoke; the message range they carry |
| `whatsapp/src/profile.ts` | live, unstored profile lookup; every field fails soft |
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
  afternoon of "couldn't link device" turned out to be; QR registration accepts
  a custom name. It goes in `browser[0]`, not `browser[1]`: the registration
  node is `{ os: browser[0], platformType: getPlatformType(browser[1]) }`, the
  phone renders "<platform label> (<os>)", and `browser[1]` is only an enum
  lookup that falls back to CHROME. `["Xing's Assistant", "Chrome", …]` shows
  as **Google Chrome (Xing's Assistant)**; the name in the second slot shows as
  nothing at all. So the QR flow sends `["Mac OS", <device name>, "14.4.1"]` and the
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
- **Group creation bypasses `groupCreate`.** Baileys' helper runs the reply
  through `extractGroupMetadata`, which keeps each participant's JID and admin
  flag and drops the `error` attribute — so a member WhatsApp refused to add
  (403, their privacy settings) is indistinguishable from one it added.
  `groups.ts` sends the identical stanza with `sock.query` and reads the reply
  itself. A refusal is a per-participant status, never a failed call: the group
  exists by then, and the caller needs its JID and its invite link. The
  per-person `add_request` code in a 403 is deliberately not surfaced; the
  group's ordinary `chat.whatsapp.com` link is, and only when someone needs it.
- **A created group is filed by the bridge, not by WhatsApp's notification.**
  The `w:gp2 create` notification that would produce `chats.upsert` usually
  arrives after the on-demand socket has closed, so `createGroup` writes the
  chat row itself, dated with the group's creation time so it lists first.
- **Group senders are filed by phone number.** New groups are LID-addressed:
  `key.participant` is an opaque `…@lid` and the number is in
  `key.participantAlt`. `normalize.ts` prefers the number, because every sender
  query in the store keys on it; the LID is kept only when it is all there is.
- **A national-format number is refused for group members.** `toJid` strips
  non-digits and appends the server, so `07700 900111` would become a valid JID
  for a stranger. A send to a stranger is a nuisance; adding one to a group is
  not recoverable, so `prepareGroupRequest` rejects a leading 0 or a `(0)`.
- **The drain marker means "delivered", not "processed" — and every socket
  receives the offline queue.** Found 2026-09-19, when a group member's replies
  never reached the store while forced syncs reported `offline queue: 2,
  messages: 0`. Baileys (7.0.0-rc14) puts offline stanzas in a sequential queue of
  its own (`Utils/offline-node-processor.js`) and works through it
  asynchronously: decrypt, send the receipt, and only then emit
  `messages.upsert`. `<ib><offline count=N/>` fires when the N stanzas have
  arrived on the wire. A cycle closed a fixed 3 s after it, and — worse — a send,
  a group create, any on-demand socket closed the moment its own job was done,
  having been handed the same offline queue on connect. Closing mid-queue loses
  messages in two ways: a stanza still queued behind a slow one is never
  processed or acked, so it is redelivered next time behind the same slow one;
  and a stanza cut off *between decrypt and upsert* has advanced the Signal
  ratchet in SQL with nothing in the store and no ack, so its redelivery cannot
  be decrypted. For a group `skmsg` that redelivery fails with "old counter", a
  retry receipt goes out and a stub is upserted; for a one-to-one message
  libsignal says "Key used already or never filled", which is the one error
  `handleMessage` answers with a NACK and a bare `return` — no retry, no upsert,
  no trace. (`test/group-inbound.test.ts` reproduces both.) So `Session` counts
  offline message stanzas off the raw socket and watches them come out as
  upserts (`InboundTracker`), and **every** `close()` first waits for them —
  bounded at 30 s, because a stanza Baileys drops on purpose never comes out —
  flushing the event buffer as it polls, since that is where an upsert sits
  until something releases it. Only messages can be tracked; receipts and
  notifications leave no event to count, share the queue, and are redelivered
  harmlessly. The cycle's detail line now says what the queue was made of and
  what, if anything, never came out.
- **A message that could not be decrypted is a row, not a gap.** Baileys upserts
  a `CIPHERTEXT` stub after sending the retry receipt. It used to be filed as an
  empty message, indistinguishable from one with no text; it is now a
  placeholder (`undecryptable: true`, with Baileys' reason), overwritten under
  the same id when the sender's resend arrives and never allowed to overwrite a
  readable row. A close waits a further 10 s for that resend; one that misses it
  is queued for the next connection like anything else.
- **`getMessage` is answered from the store.** A recipient device that cannot
  decrypt one of our sends asks again with a retry receipt. Baileys answers from
  an in-memory cache of recent sends — which belongs to the socket that sent,
  closed seconds later — and then from `getMessage`, which defaulted to
  "nothing". Every retry request for a bridge send was therefore dropped, and
  that device never got the message; group sends, one sender key to many
  devices, are where it bites. The store keeps rows rather than protos, so the
  answer is rebuilt: a text as a plain conversation, an attachment from the
  descriptors kept for downloads (same CDN object, same key, nothing
  re-uploaded). Revoked messages are not resent.
- **Archive and delete are app-state patches, and need a key only the phone can
  give.** `chatModify` does not address the chat: it encrypts a mutation to the
  account's synced state (`appPatch`, `Socket/chats.js`). That needs
  `creds.myAppStateKeyId` and the `app-state-sync-key` it names, which arrive
  once, in an `APP_STATE_SYNC_KEY_SHARE` from the phone shortly after pairing.
  `auth.ts` persists both — key rows through the same generic `(type, id)` table
  as every Signal key, revived as protos; the id inside the creds blob — so
  nothing had to be added for that. The collection's version
  (`app-state-sync-version`) is persisted too but is *not* a precondition:
  `appPatch` resyncs the collection before encoding, from a snapshot when there
  is no stored version, so it does not matter that the connect-drain-close
  cycle has probably never let a full initial app-state sync complete
  (`accountSyncCounter` only advances after one, or after a 20 s wait no cycle
  stays for). What cannot be fixed from here is a device that was not connected
  when the key share went out: `auth.appStateProblem()` checks for the key
  before a socket is opened, the two tools fail with its explanation, and
  `whatsapp_bridge_status` reports it as `appStateProblem`. A patch the server
  rejects makes `chatModify` throw; the store's flag is written only after it
  returns, so there is no path on which the tool reports an archive that did not
  happen. **Whether the live device holds the key is not known** — it could not
  be checked without calling the live bridge; read `appStateProblem` after the
  deploy, before relying on either tool.
- **The message range is built here, not by Baileys.** Archive and delete carry
  the chat's newest message by key and time. Handed a `MinimalMessage[]`,
  `chatModificationToAppPatch` returns each message as it is, leaving the
  proto's `timestamp` unset; handed a range it passes it through. So
  `chatops.ts` builds the `SyncActionMessageRange` itself, with the participant
  exactly as WhatsApp addressed it (`messages.participant`, a LID in newer
  groups — `sender` holds the number instead). An empty chat sends an empty
  range dated by the chat.
- **Nothing is ever deleted from the store.** Leaving a group, archiving,
  deleting a chat and revoking a message each set a flag — `left_at`,
  `archived`, `deleted_at`, `revoked_at` — and keep every row. Flagged chats
  stay in `whatsapp_list_chats`. A chat deleted on the phone (`chats.delete`)
  is flagged the same way. `deleted_at` lifts when something newer is said in
  the chat, as WhatsApp itself re-creates it; `left_at` when there is activity
  well after the leave.
- **An inbound revoke lands on the row it withdraws.** It arrives as an ordinary
  message whose content is a `protocolMessage` of type `REVOKE`. It used to be
  stored as an empty row under the revoke's own id, the original untouched. Two
  cases: the original is already stored — it is flagged, content kept; or
  original and revoke sit in the same event buffer (sent and withdrawn while the
  bridge was offline), where Baileys folds the revoke into the original
  (`Object.assign(existing, update)`), nulling its content and *replacing its
  key* — that husk is dropped and a tombstone filed under the original id, which
  the revoke's own upsert still carries. No protocol message is stored as a row
  any more; none of them is something anyone said.
- **`groupLeave` is bypassed for the same reason as `groupCreate`.** It awaits
  the reply and discards it, and a leave is answered per group
  (`<leave><group id=… error=…/>`). `groupParticipantsUpdate` keeps the
  per-participant status but keys it by whatever JID the server answered with,
  so that reply is read here too, with create's three-spelling matcher and
  create's vocabulary (`invite_required` for a 403 on an add). `groupMetadata`,
  `groupUpdateSubject` and `groupRevokeInvite` lose nothing and are called as
  they are.
- **Deleting a group chat asks WhatsApp whether we are still in it**, rather
  than trusting `left_at`: a group left from the phone never told the bridge.
  Still a member without `leave_first` is a refusal; with it, leave then delete,
  and a delete that fails after the leave says that the leave happened.
- **Revoke is refused past 48 hours.** WhatsApp's "about two days" is enforced
  by the recipients' clients, not the server: a late revoke is accepted and
  ignored, and flagging the row would record a withdrawal that did not happen.
- **Schema changes are additive columns, applied at start-up.** `store.ts`
  `MIGRATIONS`: `chats.archived INTEGER NOT NULL DEFAULT 0`, `chats.left_at`,
  `chats.deleted_at`, `messages.revoked_at`, `messages.revoked_by`,
  `messages.participant`, `messages.decrypt_error` (all nullable `TEXT` but the
  first). A nullable column or one with a constant default is the one `ALTER`
  SQLite applies without rewriting the table. Each is probed with a `SELECT` of
  the column and added only if that fails to prepare, so it is idempotent and
  needs no `PRAGMA`. The `CREATE TABLE`s are left as they were, so a fresh store
  and the live one reach the schema by the same path — and the test runs the
  migration over the legacy schema with rows in it.
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
| B6 send | text and files done, to people and to `…@g.us`; audio must arrive pre-encoded |
| B8 groups | `whatsapp_create_group` built and unit-tested 2026-09-19; **not yet exercised against a live socket** |
| B9 chat & group lifecycle | built and unit-tested 2026-09-19: `whatsapp_leave_group`, `whatsapp_archive_chat`, `whatsapp_delete_chat`, `whatsapp_revoke_message`, `whatsapp_group_info`, `whatsapp_group_update_participants`, `whatsapp_group_update_subject`, `whatsapp_group_revoke_invite`; inbound revokes. **None exercised against a live socket**; archive/delete additionally depend on an app-state key the live device may or may not hold |
| B10 inbound reliability | built and unit-tested 2026-09-19: close waits for offline messages to come out of Baileys, undecryptable placeholders, `getMessage` from the store, per-kind cycle detail. The cause of the live 2026-09-19 loss is **inferred from Baileys' source and reproduced in part offline, not confirmed** — the next live sync's detail line is what confirms or refutes it |
| B11 profiles | `whatsapp_get_profile` built and unit-tested 2026-09-19, live fetch, nothing stored; **not exercised against a live socket** |
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
  metadata query. Groups are named from `chats.upsert`, `groups.upsert` and
  `groups.update` (renames), and a group the bridge created is named at
  creation; a group we have never seen named appears as its JID.
- **Group administration beyond the small surface.** Members, subject, leaving
  and the invite link are exposed (B9), each mutating tool confirm-gated.
  Description, announce/locked settings, disappearing messages, join approval
  and membership requests are in Baileys and deliberately not: none has come up,
  and each is another outward-facing tool to gate.
- **Recovering a message lost before this fix.** A stanza whose ratchet step was
  spent by a socket that then closed cannot be decrypted again locally. A group
  message gets a retry receipt and comes back if the sender's phone answers; a
  one-to-one message hits the error Baileys NACKs without a retry, and changing
  that means patching Baileys.
- **Tracking offline receipts and notifications to completion.** They leave no
  event to count. One that is slow at the head of the queue can still be cut off
  when no message sits behind it; it is redelivered, and gets the full bound the
  next time a message does.
- **Storing profiles, or verified business names.** `whatsapp_get_profile` is a
  live read and writes nothing. `name` in its result is the store's own chat name
  or pushName; `verifiedBizName` is on inbound messages and is not kept.
- **Clear-chat, pin, mute, mark-read.** The same `chatModify` road as archive and
  equally easy; not asked for.
- **Sending the invite for you.** When a direct add is refused the tool returns
  the invite link and stops. Messaging someone who has just declined to be
  added is a decision, so it is left to a separate, explicit
  `whatsapp_send_message`.
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
