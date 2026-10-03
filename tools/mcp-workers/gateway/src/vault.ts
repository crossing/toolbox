// UserVault — one Durable Object per allowlisted identity (idFromName on the
// lowercased email). Holds everything the management interface edits: service
// toggles, linked accounts (upstream refresh tokens as AES-GCM ciphertext —
// the key stays in worker env, this DO never sees it), and the audit log.
//
// Accessed over DO RPC from both the session McpAgent (catalog assembly,
// per-call enablement checks) and the /manage handlers (edits). The methods
// are one-line delegations on purpose: RPC needs them declared on the class,
// and the logic they forward to is plain SQL in vaultstore.ts, where it can
// be tested without a Durable Object runtime.

import { DurableObject } from "cloudflare:workers";
import { claimGrant, getGrant, putGrant, type FileUrlGrant, type StoredGrant } from "./files/signed";
import { VaultStore, type AccountInfo, type AuditEntry, type CatalogConfig } from "./vaultstore";

export type { AccountInfo, AuditEntry, CatalogConfig } from "./vaultstore";

export class UserVault extends DurableObject<unknown> {
  private store: VaultStore;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.store = new VaultStore(ctx.storage.sql);
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

  updateAccountCiphertext(service: string, label: string, ciphertext: string): void {
    this.store.updateAccountCiphertext(service, label, ciphertext);
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
