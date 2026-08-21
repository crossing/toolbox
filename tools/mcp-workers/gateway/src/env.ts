import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { UserVault } from "./vault";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  GATEWAY_MCP: DurableObjectNamespace;
  USER_VAULT: DurableObjectNamespace<UserVault>;
  // Secrets (op-cf-secrets):
  GWS_CLIENT_ID: string; // Google web client, shared with gws-mcp until it retires
  GWS_CLIENT_SECRET: string;
  ALLOWED_EMAILS: string; // comma-separated Google account emails
  VAULT_KEY: string; // base64 32-byte AES-GCM key for vault ciphertext
  COOKIE_SECRET: string; // HMAC key for manage sessions and OAuth state
}

// One vault per identity; the DO id is derived from the normalized email.
export function vaultFor(env: Env, email: string) {
  return env.USER_VAULT.get(env.USER_VAULT.idFromName(email.trim().toLowerCase()));
}
