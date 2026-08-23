# G4 WhatsApp spike — feasibility findings

Status as of 2026-08-22. This records what the first slice of the G4 spike
proved, what it could not test here, and the go/no-go it sets up. Context:
[mcp-gateway.md](mcp-gateway.md) G4, which scoped WhatsApp as a
spike-first phase with a documented plan B (home sidecar + tunnel).

## What the spike is

`tools/mcp-workers/whatsapp/` — a throwaway probe worker (`whatsapp-spike`,
`src/spike.ts`), not a product. It imports **Baileys 7.0.0-rc14** (the
current WhatsApp-Web library) and pokes the two runtime unknowns that decide
whether the full-cloud approach is viable at all before any bridge-DO,
pairing page, or history import gets built.

The scary dependency is Baileys' crypto: rc14 moved md5/hkdf, the LT-hash
anti-tampering, and app-state key expansion into `whatsapp-rust-bridge`, a
**Rust→WASM** package that instantiates its 1.9 MB module with a
**synchronous `new WebAssembly.Module(bytes)` at module top-level**. If
workerd rejected that, the whole vendored-Baileys-in-a-DO plan was dead.

## Proven (local `wrangler dev`, real workerd)

- **WASM crypto bridge runs under workerd.** The worker module loads (the
  top-level WASM compile is permitted at startup), and `GET /crypto`
  executes the WASM-backed `md5` + `hkdf` and returns correct values
  (`md5("gateway-g4-spike") = e648a97c…`, hkdf 32 bytes). This was the
  single biggest risk and it is cleared.
- **Bundle builds within limits.** Baileys + the doubled (SIMD + non-SIMD)
  inlined WASM base64 + the shim bundle and start with no size rejection.
- **The `ws` incompatibility has a working shim.** Baileys does
  `import WebSocket from 'ws'` and hardcodes `new WebSocketClient(url,
  config)` with no injection point, so the fix is `src/ws-shim.ts` — a
  node-`ws`-API-compatible class over workerd's native outbound WebSocket
  (`fetch(url, { headers: { Upgrade: "websocket" } })` → `response.webSocket`
  → `accept()`), aliased as `ws` in wrangler.jsonc. With it wired, Baileys
  progresses from the old `ws` throw all the way to
  `connection.update: connecting` and drives the socket — i.e. the shim's
  code path executes end-to-end.

- **Live WhatsApp handshake — PROVEN on deployed workerd.** Local
  `wrangler dev` in this session has no outbound egress (a plain `fetch()`
  also throws `internal error`), so the handshake was proven by deploying
  the spike to a temporary `*.workers.dev` URL and then deleting it. On the
  deployed worker the full Noise handshake round-trips and WhatsApp emits a
  QR frame — `reachedQR: true`. The shim trace:

  ```
  fetch status=101 hasWS=true   (outbound WS upgrade to wss://web.whatsapp.com/ws/chat)
  open
  send bin 43                   (Baileys ClientHello)
  recv blob 350                 (server hello)
  send bin 368                  (client finish)
  recv blob 698                 (server response)
  send bin 37
  connection.update:+qr         (QR pairing frame received)
  ```

## workerd gotchas the deployed run exposed (keepers for the real bridge)

- **Binary frames arrive as `Blob`, not `ArrayBuffer`.** Setting
  `binaryType = "arraybuffer"` on an accepted outbound socket is ignored, so
  the shim reads `await blob.arrayBuffer()` and — because that is async —
  funnels every message through an ordered promise chain to preserve
  handshake frame order. Without this the first server frame throws
  `Buffer.from(Blob)` and the connection dies immediately.
- **A bare upgrade to WhatsApp sits idle** (no unsolicited server frame);
  WhatsApp speaks only after the client's ClientHello, so an idle raw
  upgrade still confirms the upgrade itself succeeded.
- Deployed bundle is **1.68 MB gzipped** — comfortably inside the 3 MB
  free-plan script limit even with the doubled inlined WASM.

## Decision this sets up

Feasibility is now fully positive: the make-or-break unknown (Rust/WASM
crypto in workerd) works, the `ws` gap is solved, and the **live WhatsApp
handshake reaches QR on deployed workerd**. Nothing runtime-level remains
unproven. What's left is the full build, which is large and net-new:

- Baileys `AuthenticationState` ⇄ DO SQLite adapter (replacing the
  file-based store — the main port work).
- The intermittent-connection bridge DO: alarm every 5–15 min → connect →
  drain WhatsApp's offline queue into SQLite → disconnect; survives DO
  eviction.
- Pairing web page under `/manage` (phone-number pairing code, no QR TTY).
- Media decrypt via WebCrypto → R2; message store + one-off `messages.db`
  import.
- The gateway's `whatsapp` service module (read tools, then send) over a DO
  binding to the bridge.

Accepted, eyes-open, per the plan: this lands full message history + Signal
session keys at rest in Cloudflare, and the connection-churn fingerprint
carries some ban risk. Those are why the full build is a deliberate go/no-go
rather than an automatic continuation.
