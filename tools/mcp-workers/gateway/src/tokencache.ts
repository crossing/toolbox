// Upstream access tokens, owned by the vault.
//
// FreeAgent access tokens live one hour and FreeAgent rotates the refresh
// token on every refresh: the moment one holder refreshes, every other copy
// of the old refresh token is dead. So there is exactly one writer, the
// user's UserVault Durable Object, and two halves here:
//
// - TokenBroker runs inside the vault. It answers "an access token for this
//   account", serving the stored one while it has more than the refresh
//   margin left, otherwise refreshing against the provider and writing the
//   whole set (access token, refresh token — rotated or not —, expiry, issue
//   time) back as the account's ciphertext. Concurrent asks for one account
//   share one in-flight resolve: the DO serialises storage, but RPCs
//   interleave across every await, so without the promise map two calls
//   would both spend the same refresh token.
// - VaultTokenSource runs in a session (or a one-shot request). It keeps only
//   {accessToken, expiresAt} in memory and asks the vault when the token
//   nears its margin, or once after an API 401 — passing the token that
//   failed, so a burst of 401s on one dead token costs one refresh, not one
//   each.
//
// Tokens cross the RPC boundary between the two and nowhere else: they are
// never logged, and failures come back as sanitized messages.

import { boundFetch, type Fetcher } from "@toolbox/mcp-shared";
import { decryptJson, encryptJson, importVaultKey } from "./crypto";
import { FreeAgentApiError, FreeAgentRateLimitError, FreeAgentUpstreamError, refreshFreeagent } from "./freeagentapi";
import { refreshUpstream, UpstreamError } from "./google";
import type { VaultBlob } from "./manage";
import { NoLinkedAccountError } from "./toolutil";

/** Account namespaces whose tokens the vault refreshes (registry.ts *_ACCOUNT_SERVICE). */
export type TokenService = "freeagent" | "google";

export interface AccessToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

/**
 * The vault's answer. A union rather than a throw: an error crossing DO RPC
 * keeps its message but loses its class, and the tool layer (toolutil.ts
 * asError) needs the class to show the message at all.
 */
export type AccessTokenResult =
  | ({ ok: true } & AccessToken)
  | { ok: false; kind: "no_account" | "upstream"; message: string }
  | { ok: false; kind: "rate_limited"; message: string; retryAfterS: number };

export interface AccessTokenOptions {
  /** Refresh unless the token has at least this long left (capped at half its lifetime). */
  minValidMs?: number;
  /**
   * The token an API call just refused with a 401. Refresh only if the stored
   * token is still this one; if another caller already replaced it, the
   * replacement is the answer.
   */
  staleToken?: string;
}

/** The ceiling on the refresh margin; shorter-lived tokens get a quarter of their lifetime. */
export const MAX_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Refresh once less than this remains: min(5 minutes, lifetime / 4), so the
 * margin is always well under the token's lifetime and a fresh token is never
 * "due" on arrival. An unknown lifetime gets the 5-minute ceiling.
 */
export function refreshMarginMs(lifetimeMs?: number): number {
  if (lifetimeMs === undefined || !Number.isFinite(lifetimeMs) || lifetimeMs <= 0) return MAX_REFRESH_MARGIN_MS;
  return Math.min(MAX_REFRESH_MARGIN_MS, lifetimeMs / 4);
}

/** The env the broker needs: the vault key and the two OAuth clients. */
export interface TokenEnv {
  VAULT_KEY: string;
  FREEAGENT_CLIENT_ID: string;
  FREEAGENT_CLIENT_SECRET: string;
  GWS_CLIENT_ID: string;
  GWS_CLIENT_SECRET: string;
}

/** The slice of VaultStore the broker reads and writes. */
export interface TokenAccountStore {
  getAccount(service: string, label?: string): { label: string; ciphertext: string } | null;
  replaceAccountCiphertext(service: string, label: string, expected: string, next: string): boolean;
}

export class TokenBroker {
  private inflight = new Map<string, Promise<AccessTokenResult>>();
  private key?: Promise<CryptoKey>;

  constructor(
    private store: TokenAccountStore,
    private env: TokenEnv,
    private fetcher: Fetcher = boundFetch,
    private now: () => number = () => Date.now(),
  ) {}

  async accessToken(service: TokenService, label: string, opts: AccessTokenOptions = {}): Promise<AccessTokenResult> {
    const key = `${service}\n${label}`;
    // A caller that joins someone else's resolve may have asked a stronger
    // question (a stale token to replace, a longer validity), so it checks
    // the shared answer and, at most twice, resolves again for itself.
    let result: AccessTokenResult | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const running = this.inflight.get(key);
      if (!running) {
        const mine = this.resolve(service, label, opts).finally(() => {
          if (this.inflight.get(key) === mine) this.inflight.delete(key);
        });
        this.inflight.set(key, mine);
        return mine;
      }
      result = await running;
      if (!result.ok || this.satisfies(result, opts)) return result;
    }
    return result!;
  }

  private satisfies(token: AccessToken, opts: AccessTokenOptions): boolean {
    if (opts.staleToken !== undefined && token.accessToken === opts.staleToken) return false;
    if (opts.minValidMs !== undefined && token.expiresAt - this.now() < opts.minValidMs) return false;
    return token.expiresAt - this.now() > 0;
  }

  private cryptoKey(): Promise<CryptoKey> {
    this.key ??= importVaultKey(this.env.VAULT_KEY);
    return this.key;
  }

  private async resolve(service: TokenService, label: string, opts: AccessTokenOptions): Promise<AccessTokenResult> {
    const acct = this.store.getAccount(service, label);
    if (!acct) {
      return { ok: false, kind: "no_account", message: new NoLinkedAccountError(service, label).message };
    }
    let key: CryptoKey;
    let blob: VaultBlob;
    try {
      key = await this.cryptoKey();
      blob = await decryptJson<VaultBlob>(key, acct.ciphertext);
    } catch {
      return { ok: false, kind: "upstream", message: `the stored ${service} link is unreadable; link it again on the management page` };
    }

    const now = this.now();
    const stored = blob.accessToken ?? "";
    const expiresAt = blob.expiresAt ?? 0;
    const lifetime = blob.issuedAt !== undefined ? expiresAt - blob.issuedAt : undefined;
    let margin = refreshMarginMs(lifetime);
    if (opts.minValidMs !== undefined) {
      margin = Math.max(margin, Math.min(opts.minValidMs, (lifetime ?? 2 * MAX_REFRESH_MARGIN_MS) / 2));
    }
    const failed = opts.staleToken !== undefined && stored === opts.staleToken;
    if (stored !== "" && !failed && expiresAt - now > margin) {
      return { ok: true, accessToken: stored, expiresAt };
    }

    let next: { accessToken: string; refreshToken: string; expiresAt: number };
    try {
      next =
        service === "freeagent"
          ? await refreshFreeagent({
              clientId: this.env.FREEAGENT_CLIENT_ID,
              clientSecret: this.env.FREEAGENT_CLIENT_SECRET,
              refreshToken: blob.refreshToken,
              now,
              fetcher: this.fetcher,
            })
          : await refreshUpstream({
              clientId: this.env.GWS_CLIENT_ID,
              clientSecret: this.env.GWS_CLIENT_SECRET,
              refreshToken: blob.refreshToken,
              now,
              fetcher: this.fetcher,
            });
    } catch (err) {
      // Nothing is written on failure: a 429 or a network error leaves the
      // stored set exactly as it was.
      if (err instanceof FreeAgentRateLimitError) {
        return { ok: false, kind: "rate_limited", message: err.message, retryAfterS: err.retryAfterS };
      }
      if (err instanceof FreeAgentUpstreamError || err instanceof UpstreamError) {
        return { ok: false, kind: "upstream", message: err.message };
      }
      return { ok: false, kind: "upstream", message: `${service} token refresh failed` };
    }

    const ciphertext = await encryptJson(key, {
      refreshToken: next.refreshToken,
      accessToken: next.accessToken,
      expiresAt: next.expiresAt,
      issuedAt: now,
    } satisfies VaultBlob);
    // Compare-and-swap against what was read: a relink that landed while the
    // refresh was in flight wins, and this (still valid) token is just served.
    this.store.replaceAccountCiphertext(service, label, acct.ciphertext, ciphertext);
    return { ok: true, accessToken: next.accessToken, expiresAt: next.expiresAt };
  }
}

/** The session-side ask: the vault RPC, bound to one account. */
export type AccessTokenFetch = (opts: AccessTokenOptions) => Promise<AccessTokenResult>;

/**
 * Session-side token source for one linked account: an in-memory access
 * token and nothing else. Satisfies both GoogleTokenProvider and
 * FreeAgentTokenProvider.
 */
export class VaultTokenSource {
  private current?: AccessToken & { receivedAt: number };
  private pending?: Promise<string>;

  constructor(
    private service: TokenService,
    private label: string,
    private fetchToken: AccessTokenFetch,
    private now: () => number = () => Date.now(),
  ) {}

  async token(): Promise<string> {
    const c = this.current;
    if (c && c.expiresAt - this.now() > refreshMarginMs(c.expiresAt - c.receivedAt)) return c.accessToken;
    return this.ask({});
  }

  /** A fresh token after `failed` drew a 401. One vault ask per dead token, however many calls saw it die. */
  async invalidate(failed: string): Promise<string> {
    if (this.pending) await this.pending.catch(() => undefined);
    if (this.current && this.current.accessToken !== failed) return this.token();
    return this.ask({ staleToken: failed });
  }

  private ask(opts: AccessTokenOptions): Promise<string> {
    this.pending ??= this.fetch(opts).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async fetch(opts: AccessTokenOptions): Promise<string> {
    const receivedAt = this.now();
    const result = await this.fetchToken(opts);
    if (!result.ok) throw toError(this.service, this.label, result);
    this.current = { accessToken: result.accessToken, expiresAt: result.expiresAt, receivedAt };
    return result.accessToken;
  }
}

/** The vault RPC surface a VaultTokenSource needs: UserVault's stub, or a fake. */
export interface AccessTokenVault {
  accessToken(service: TokenService, label: string, opts?: AccessTokenOptions): Promise<AccessTokenResult>;
}

export function vaultTokenSource(vault: AccessTokenVault, service: TokenService, label: string): VaultTokenSource {
  return new VaultTokenSource(service, label, (opts) => vault.accessToken(service, label, opts));
}

function toError(service: TokenService, label: string, result: Exclude<AccessTokenResult, { ok: true }>): Error {
  if (result.kind === "no_account") return new NoLinkedAccountError(service, label);
  if (result.kind === "rate_limited") return new FreeAgentApiError(429, result.message);
  return service === "freeagent" ? new FreeAgentUpstreamError(result.message) : new UpstreamError(result.message);
}
