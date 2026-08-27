import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

import type { UserVault } from "./vault";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  GATEWAY_MCP: DurableObjectNamespace;
  USER_VAULT: DurableObjectNamespace<UserVault>;
  // The WhatsApp bridge Durable Object lives in its own Worker script so that
  // gateway deploys never evict a live WhatsApp session; cross-script stubs
  // are untyped, and gateway/src/whatsapp.ts casts to the shared contract.
  WHATSAPP_BRIDGE: DurableObjectNamespace;
  // The SMS store, by contrast, lives in this script: it holds no session and
  // no socket, so a deploy evicting it costs nothing.
  SMS_INBOX: DurableObjectNamespace;
  // Secrets (op-cf-secrets):
  GWS_CLIENT_ID: string; // Google web client, shared with gws-mcp until it retires
  GWS_CLIENT_SECRET: string;
  ALLOWED_EMAILS: string; // comma-separated Google account emails
  FREEAGENT_CLIENT_ID: string; // FreeAgent app, shared with freeagent-mcp until it retires
  FREEAGENT_CLIENT_SECRET: string;
  ALLOWED_COMPANY: string; // FreeAgent company subdomain of the owner
  VAULT_KEY: string; // base64 32-byte AES-GCM key for vault ciphertext
  COOKIE_SECRET: string; // HMAC key for manage sessions and OAuth state
  // AAISP does not authenticate its inbound POST, so the hook path *is* the
  // credential: 32 random characters, typed once into their control page.
  SMS_HOOK_SECRET: string;
  SMS_OWN_NUMBERS: string; // comma-separated; a delivery to anything else is refused
  // Sending credentials. Absent until phase 4 is provisioned, so both are
  // optional: a gateway with no way to send should stage requests and say so
  // plainly, not fail to boot.
  AAISP_SMS_USERNAME?: string; // the number in full international format
  AAISP_SMS_PASSWORD?: string; // the outgoing password; the control pages never show it
}

// One vault per identity; the DO id is derived from the normalized email.
export function vaultFor(env: Env, email: string) {
  return env.USER_VAULT.get(env.USER_VAULT.idFromName(email.trim().toLowerCase()));
}
