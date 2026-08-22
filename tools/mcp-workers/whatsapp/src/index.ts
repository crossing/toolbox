// whatsapp-bridge — the Worker script that hosts the WhatsApp bridge Durable
// Object. It deliberately has no HTTP surface of its own (`workers_dev` off,
// no custom domain): the only way in is the gateway's cross-script Durable
// Object binding, so the bridge inherits the gateway's Google sign-in and
// allowlist instead of growing an auth story of its own.

export { WhatsAppBridge, SYNC_INTERVAL_MS } from "./bridge";
export type { BridgeEnv } from "./bridge";

export default {
  async fetch(): Promise<Response> {
    return new Response("this worker has no HTTP surface; use the gateway", { status: 404 });
  },
};
