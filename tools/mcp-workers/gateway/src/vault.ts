// UserVault — one Durable Object per allowlisted identity (idFromName on the
// lowercased email). Holds everything the management interface edits: service
// toggles, linked accounts (upstream tokens as AES-GCM ciphertext), and the
// audit log.
//
// It is also the single writer of upstream tokens: accessToken() serves the
// cached access token or refreshes it (tokencache.ts TokenBroker), so it
// holds VAULT_KEY and the OAuth client secrets from the Worker env. Sessions
// never see a refresh token.
//
// Accessed over DO RPC from both the session McpAgent (catalog assembly,
// per-call enablement checks, access tokens) and the /manage handlers
// (edits). The methods are one-line delegations on purpose: RPC needs them
// declared on the class, and the logic they forward to lives in
// vaultstore.ts and tokencache.ts, where it can be tested without a Durable
// Object runtime.

import { DurableObject } from "cloudflare:workers";
import { claimGrant, getGrant, putGrant, type FileUrlGrant, type StoredGrant } from "./files/signed";
import type { Env } from "./env";
import { TokenBroker, type AccessTokenOptions, type AccessTokenResult, type TokenService } from "./tokencache";
import { VaultStore, type AccountInfo, type AuditEntry, type CatalogConfig } from "./vaultstore";

export type { AccountInfo, AuditEntry, CatalogConfig } from "./vaultstore";

export class UserVault extends DurableObject<Env> {
  private store: VaultStore;
  // Instance memory: its in-flight map is what makes concurrent asks for one
  // account share a single refresh. Eviction loses nothing but that map.
  private tokens: TokenBroker;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new VaultStore(ctx.storage.sql);
    this.tokens = new TokenBroker(this.store, env);
  }

  /** An access token for one linked account, refreshed here and only here when due. */
  accessToken(service: TokenService, label: string, opts?: AccessTokenOptions): Promise<AccessTokenResult> {
    return this.tokens.accessToken(service, label, opts);
  }

  getCatalogConfig(defaults: Record<string, boolean>): CatalogConfig {
    return this.store.getCatalogConfig(defaults);
  }

  isServiceEnabled(service: string, fallback: boolean): boolean {
    return this.store.isServiceEnabled(service, fallback);
  }

  setServiceEnabled(service: string, enabled: boolean): void {
    this.store.setServiceEnabled(service, enabled);
  }

  getServiceAccounts(): Record<string, string> {
    return this.store.getServiceAccounts();
  }

  setServiceAccount(service: string, accountService: string, label: string): void {
    this.store.setServiceAccount(service, accountService, label);
  }

  listAccounts(): AccountInfo[] {
    return this.store.listAccounts();
  }

  putAccount(service: string, label: string, ciphertext: string, scopes: string[]): void {
    this.store.putAccount(service, label, ciphertext, scopes);
  }

  getAccount(service: string, label?: string): { label: string; ciphertext: string } | null {
    return this.store.getAccount(service, label);
  }

  getAccountForService(
    accountService: string,
    service: string,
    label?: string,
  ): { label: string; ciphertext: string } | null {
    return this.store.getAccountForService(accountService, service, label);
  }

  setDefaultAccount(service: string, label: string): void {
    this.store.setDefaultAccount(service, label);
  }

  deleteAccount(service: string, label: string): void {
    this.store.deleteAccount(service, label);
  }

  getSetting(key: string): string | null {
    return this.store.getSetting(key);
  }

  setSetting(key: string, value: string): void {
    this.store.setSetting(key, value);
  }

  // Signed file URL grants (files/signed.ts). These are called only on the
  // "files-url-grants/<shard>" instances (files/http.ts grantStoreFor), never
  // on a user's own vault: the route must find a grant before it knows whose
  // it is.

  putFileGrant(jti: string, grant: FileUrlGrant, now: number): void {
    putGrant(this.ctx.storage.sql, jti, grant, now);
  }

  getFileGrant(jti: string, now: number): StoredGrant | null {
    return getGrant(this.ctx.storage.sql, jti, now);
  }

  /** Single use for a PUT URL: true for exactly one caller, never after expiry. */
  claimFileGrant(jti: string, now: number): boolean {
    return claimGrant(this.ctx.storage.sql, jti, now);
  }

  appendAudit(entry: AuditEntry): void {
    this.store.appendAudit(entry);
  }

  listAudit(limit: number): AuditEntry[] {
    return this.store.listAudit(limit);
  }
}
