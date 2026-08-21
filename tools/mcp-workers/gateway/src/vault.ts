// UserVault — one Durable Object per allowlisted identity (idFromName on the
// lowercased email). Holds everything the management interface edits: service
// toggles, linked accounts (upstream refresh tokens as AES-GCM ciphertext —
// the key stays in worker env, this DO never sees it), and the audit log.
//
// Accessed over DO RPC from both the session McpAgent (catalog assembly,
// per-call enablement checks) and the /manage handlers (edits).

import { DurableObject } from "cloudflare:workers";

export interface AccountInfo {
  service: string;
  label: string;
  scopes: string[];
  enabled: boolean;
  isDefault: boolean;
}

export interface CatalogConfig {
  services: Record<string, boolean>;
  accounts: AccountInfo[];
}

export interface AuditEntry {
  ts: number;
  tool: string;
  summary: string;
  status: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS services (
  service TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  service TEXT NOT NULL,
  label TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  scopes TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (service, label)
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  tool TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL
);
`;

export class UserVault extends DurableObject<unknown> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  // Explicit toggles override the code-side defaults; unknown services in
  // the table (e.g. after a module is removed) are ignored by the caller.
  getCatalogConfig(defaults: Record<string, boolean>): CatalogConfig {
    const services = { ...defaults };
    for (const row of this.sql.exec("SELECT service, enabled FROM services").toArray()) {
      services[row.service as string] = row.enabled === 1;
    }
    return { services, accounts: this.listAccounts() };
  }

  isServiceEnabled(service: string, fallback: boolean): boolean {
    const rows = this.sql
      .exec("SELECT enabled FROM services WHERE service = ?", service)
      .toArray();
    if (rows.length === 0) return fallback;
    return rows[0]!.enabled === 1;
  }

  setServiceEnabled(service: string, enabled: boolean): void {
    this.sql.exec(
      "INSERT INTO services (service, enabled) VALUES (?, ?) ON CONFLICT(service) DO UPDATE SET enabled = excluded.enabled",
      service,
      enabled ? 1 : 0,
    );
  }

  listAccounts(): AccountInfo[] {
    return this.sql
      .exec("SELECT service, label, scopes, enabled, is_default FROM accounts ORDER BY service, label")
      .toArray()
      .map((row) => ({
        service: row.service as string,
        label: row.label as string,
        scopes: (row.scopes as string).split(" ").filter((s) => s.length > 0),
        enabled: row.enabled === 1,
        isDefault: row.is_default === 1,
      }));
  }

  // Linking flow (G1) stores ciphertext here; first account of a service
  // becomes its default.
  putAccount(service: string, label: string, ciphertext: string, scopes: string[]): void {
    const existingDefault = this.sql
      .exec("SELECT COUNT(*) AS n FROM accounts WHERE service = ? AND is_default = 1", service)
      .one();
    this.sql.exec(
      `INSERT INTO accounts (service, label, ciphertext, scopes, enabled, is_default, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(service, label) DO UPDATE SET ciphertext = excluded.ciphertext, scopes = excluded.scopes`,
      service,
      label,
      ciphertext,
      scopes.join(" "),
      (existingDefault.n as number) > 0 ? 0 : 1,
      Date.now(),
    );
  }

  // Returns the labelled account, or the service default when label is
  // omitted. Null when nothing matches. The label comes back so callers can
  // cache per resolved account even when they asked for "the default".
  getAccount(service: string, label?: string): { label: string; ciphertext: string } | null {
    const rows = label
      ? this.sql.exec(
          "SELECT label, ciphertext FROM accounts WHERE service = ? AND label = ? AND enabled = 1",
          service,
          label,
        ).toArray()
      : this.sql.exec(
          "SELECT label, ciphertext FROM accounts WHERE service = ? AND is_default = 1 AND enabled = 1",
          service,
        ).toArray();
    if (rows.length === 0) return null;
    return { label: rows[0]!.label as string, ciphertext: rows[0]!.ciphertext as string };
  }

  setDefaultAccount(service: string, label: string): void {
    this.sql.exec("UPDATE accounts SET is_default = 0 WHERE service = ?", service);
    this.sql.exec("UPDATE accounts SET is_default = 1 WHERE service = ? AND label = ?", service, label);
  }

  deleteAccount(service: string, label: string): void {
    const wasDefault = this.sql
      .exec("SELECT is_default FROM accounts WHERE service = ? AND label = ?", service, label)
      .toArray();
    this.sql.exec("DELETE FROM accounts WHERE service = ? AND label = ?", service, label);
    // Unlinking the default promotes the oldest remaining account so the
    // no-account-parameter path keeps working.
    if (wasDefault.length > 0 && wasDefault[0]!.is_default === 1) {
      this.sql.exec(
        `UPDATE accounts SET is_default = 1 WHERE service = ? AND label =
           (SELECT label FROM accounts WHERE service = ? ORDER BY created_at, label LIMIT 1)`,
        service,
        service,
      );
    }
  }

  appendAudit(entry: AuditEntry): void {
    this.sql.exec(
      "INSERT INTO audit (ts, tool, summary, status) VALUES (?, ?, ?, ?)",
      entry.ts,
      entry.tool,
      entry.summary,
      entry.status,
    );
  }

  listAudit(limit: number): AuditEntry[] {
    return this.sql
      .exec("SELECT ts, tool, summary, status FROM audit ORDER BY id DESC LIMIT ?", limit)
      .toArray()
      .map((row) => ({
        ts: row.ts as number,
        tool: row.tool as string,
        summary: row.summary as string,
        status: row.status as string,
      }));
  }
}
