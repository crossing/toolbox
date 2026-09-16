// whatsapp-bridge — the Worker script that hosts the WhatsApp bridge Durable
// Object. It deliberately has no HTTP surface of its own (`workers_dev` off,
// no custom domain): the only way in is the gateway's cross-script Durable
// Object binding, so the bridge inherits the gateway's Google sign-in and
// allowlist instead of growing an auth story of its own.

import { installHighIterationPbkdf2 } from "./pbkdf2";
import { applyProtobufWorkerdFix } from "./protobuf-workerd-fix";

// WhatsApp's pairing-code derivation asks WebCrypto for 131,072 PBKDF2
// iterations and workerd refuses anything over 100,000, so the one derivation
// it rejects is computed in JS instead. Installed here, at the entry module,
// before any request or alarm can reach the bridge. Baileys reads
// `crypto.subtle`'s methods at call time, so patching the object is enough.
export const PBKDF2_SHIM_INSTALLED = installHighIterationPbkdf2();

// protobufjs' Node-Buffer writer sizes a string field with Buffer.byteLength but
// writes it with Buffer.utf8Write, and on edge workerd those disagree for any
// multi-byte character — under-allocating the buffer so encodeWAMessage throws
// ERR_OUT_OF_RANGE, which surfaced as "All encryptions failed" on every send
// whose text held a £, dash or accented letter. Patch protobufjs to use its own
// consistent pure-JS utf8 for strings. Installed at the entry module, before the
// bridge (and its Baileys import) loads, so every encode uses the fixed writer.
export const PROTOBUF_WORKERD_FIX_APPLIED = applyProtobufWorkerdFix();

// Keep this a static import: workerd only compiles WebAssembly during startup,
// and the chain index → bridge → auth → "baileys" is what gets the crypto
// bridge's module compiled at the one moment it is allowed.
export { WhatsAppBridge, SYNC_INTERVAL_MS } from "./bridge";
export type { BridgeEnv } from "./bridge";

export default {
  async fetch(): Promise<Response> {
    return new Response("this worker has no HTTP surface; use the gateway", { status: 404 });
  },
};
