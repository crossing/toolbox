// The vault's tables and the rules for reading them, with no Durable Object
// around them. `UserVault` is the DO shell; everything that decides *which*
// account a tool call resolves to lives here, where a test can reach it.

/** The slice of SqlStorage this module uses; node:sqlite satisfies it in tests. */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

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
  /** Catalog service id → the linked-account label it is pinned to. */
  serviceAccounts: Record<string, string>;
}

export interface AuditEntry {
  ts: number;
  tool: string;
  summary: string;
  status: string;
}

export const VAULT_SCHEMA = `
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
-- Which linked account a *catalog service* uses, as opposed to which one its
-- account namespace defaults to. Gmail and Drive share the "google" namespace
-- but not the same mailbox: one Google link can be the mail account while
-- another is the Drive account. A row here overrides accounts.is_default for
-- that one service; no row means "whatever the namespace defaults to".
CREATE TABLE IF NOT EXISTS service_accounts (
  service TEXT PRIMARY KEY,
  account_service TEXT NOT NULL,
  label TEXT NOT NULL
);
`;

export class VaultStore {
  constructor(private sql: SqlLike) {
    this.sql.exec(VAULT_SCHEMA);
  }

  // Explicit toggles override the code-side defaults; unknown services in
  // the table (e.g. after a module is removed) are ignored by the caller.
  getCatalogConfig(defaults: Record<string, boolean>): CatalogConfig {
    const services = { ...defaults };
    for (const row of this.sql.exec("SELECT service, enabled FROM services").toArray()) {
      services[row.service as string] = row.enabled === 1;
    }
    return { services, accounts: this.listAccounts(), serviceAccounts: this.getServiceAccounts() };
  }

  isServiceEnabled(service: string, fallback: boolean): boolean {
    const rows = this.sql.exec("SELECT enabled FROM services WHERE service = ?", service).toArray();
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

  getServiceAccounts(): Record<string, string> {
    return Object.fromEntries(
      this.sql
        .exec("SELECT service, label FROM service_accounts")
        .toArray()
        .map((row) => [row.service as string, row.label as string]),
    );
  }

  /** Pin one catalog service to one linked account; an empty label clears it. */
  setServiceAccount(service: string, accountService: string, label: string): void {
    if (label === "") {
      this.sql.exec("DELETE FROM service_accounts WHERE service = ?", service);
      return;
    }
    this.sql.exec(
      `INSERT INTO service_accounts (service, account_service, label) VALUES (?, ?, ?)
       ON CONFLICT(service) DO UPDATE SET account_service = excluded.account_service, label = excluded.label`,
      service,
      accountService,
      label,
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
      .toArray();
    this.sql.exec(
      `INSERT INTO accounts (service, label, ciphertext, scopes, enabled, is_default, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(service, label) DO UPDATE SET ciphertext = excluded.ciphertext, scopes = excluded.scopes`,
      service,
      label,
      ciphertext,
      scopes.join(" "),
      ((existingDefault[0]?.n as number) ?? 0) > 0 ? 0 : 1,
      Date.now(),
    );
  }

  // Returns the labelled account, or the service default when label is
  // omitted. Null when nothing matches. The label comes back so callers can
  // cache per resolved account even when they asked for "the default".
  getAccount(service: string, label?: string): { label: string; ciphertext: string } | null {
    const rows = label
      ? this.sql
          .exec(
            "SELECT label, ciphertext FROM accounts WHERE service = ? AND label = ? AND enabled = 1",
            service,
            label,
          )
          .toArray()
      : this.sql
          .exec(
            "SELECT label, ciphertext FROM accounts WHERE service = ? AND is_default = 1 AND enabled = 1",
            service,
          )
          .toArray();
    if (rows.length === 0) return null;
    return { label: rows[0]!.label as string, ciphertext: rows[0]!.ciphertext as string };
  }

  // What a tool call actually resolves through. Three tiers, most specific
  // first: an explicit `account` argument, then the service's own pin, then
  // the namespace default. A pin whose account has since been unlinked falls
  // through to the default rather than failing — the tool keeps working, and
  // the management page shows the pin is gone.
  getAccountForService(
    accountService: string,
    service: string,
    label?: string,
  ): { label: string; ciphertext: string } | null {
    if (label) return this.getAccount(accountService, label);
    const pinned = this.sql
      .exec(
        "SELECT label FROM service_accounts WHERE service = ? AND account_service = ?",
        service,
        accountService,
      )
      .toArray();
    if (pinned.length > 0) {
      const account = this.getAccount(accountService, pinned[0]!.label as string);
      if (account) return account;
    }
    return this.getAccount(accountService);
  }

  // Token-rotation write-back: replaces only the ciphertext, leaving scopes,
  // enablement, and default flag untouched.
  updateAccountCiphertext(service: string, label: string, ciphertext: string): void {
    this.sql.exec("UPDATE accounts SET ciphertext = ? WHERE service = ? AND label = ?", ciphertext, service, label);
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
    this.sql.exec("DELETE FROM service_accounts WHERE account_service = ? AND label = ?", service, label);
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
