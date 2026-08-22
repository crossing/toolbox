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

## Could not test here (environment limit, not a workerd/Baileys limit)

- **Live WhatsApp handshake.** This session's local `wrangler dev` sandbox
  has **no outbound network egress**: a plain `fetch()` to a normal HTTPS
  host throws `internal error`, and so does the WS upgrade. That is why
  `/connect` ends `connecting → close` with an internal error rather than a
  QR frame — the shim is fine, the network is walled off. Deployed Workers
  do have egress (the gateway makes outbound calls constantly, and the
  reference project rafaelsg-01/whatsapp-cloudflare-workers runs Baileys'
  outbound WS to WhatsApp in production), so the remaining proof needs a
  **deployed** spike, not local dev.

## Decision this sets up

Feasibility is strongly positive: the make-or-break unknown (Rust/WASM
crypto in workerd) works, and the known `ws` gap is solved. One gate is
still open only because of the local sandbox: the live WhatsApp handshake
from deployed workerd. Recommended next step is to **deploy the spike**
(temporarily on a reachable URL) to watch a QR/pairing frame arrive, then —
only after that green — commit to the full build, which is large and
net-new:

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
