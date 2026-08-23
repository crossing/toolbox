// A SqlStorage stand-in backed by node:sqlite, so the vault can be tested
// against real SQL instead of a hand-rolled mock. Twin of
// whatsapp/test/sqlfake.ts — the two packages do not share a test helper, and
// forty lines of duplication beats a dependency between their test suites.
//
// Durable Object SQLite accepts several statements in one exec() call (the
// schema strings rely on it); node:sqlite only allows that through exec(),
// which returns no rows — hence the split below.

import { DatabaseSync } from "node:sqlite";

export interface FakeSql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
  close(): void;
}

export function makeFakeSql(): FakeSql {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...bindings: unknown[]) {
      const isMulti = bindings.length === 0 && query.trim().split(";").filter((s) => s.trim()).length > 1;
      if (isMulti) {
        db.exec(query);
        return { toArray: () => [] };
      }
      const stmt = db.prepare(query);
      // node:sqlite rejects `all()` on non-returning statements, and `run()`
      // on returning ones; the leading keyword is a reliable discriminator
      // for the SQL these modules write.
      const returning = /^\s*(SELECT|WITH|PRAGMA)/i.test(query) || /RETURNING/i.test(query);
      if (returning) {
        const rows = stmt.all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows.map((r) => ({ ...r })) };
      }
      stmt.run(...(bindings as never[]));
      return { toArray: () => [] };
    },
    close() {
      db.close();
    },
  };
}
