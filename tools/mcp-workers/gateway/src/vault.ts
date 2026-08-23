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

  appendAudit(entry: AuditEntry): void {
    this.store.appendAudit(entry);
  }

  listAudit(limit: number): AuditEntry[] {
    return this.store.listAudit(limit);
  }
}
