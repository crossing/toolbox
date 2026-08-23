// Baileys' AuthenticationState over Durable Object SQLite.
//
// Baileys ships `useMultiFileAuthState`, which is a directory of JSON files —
// no use in a Worker. This is the same contract backed by the DO's SQLite:
// the creds blob in one row, and the Signal key store (pre-keys, sessions,
// sender-keys, app-state-sync keys, …) as (type, id) rows.
//
// Two details are load-bearing and easy to get wrong:
//   - Values are full of Buffers. Baileys' own BufferJSON replacer/reviver is
//     the only serializer that round-trips them, so use it on both sides.
//   - `app-state-sync-key` values must come back as proto messages, not plain
//     objects, or app-state sync throws when it calls their methods. The
//     multi-file store does the same revival (Utils/use-multi-file-auth-state.js).
//
// The store is synchronous: DO SQLite is sync, and SignalKeyStore's methods are
// declared `Awaitable`, so returning plain values satisfies the interface with
// no microtask hop. Baileys wraps this store in its own transaction layer
// (Socket/socket.js applies addTransactionCapability), so no locking here.

import { BufferJSON, initAuthCreds, proto } from "baileys";
import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataSet,
  SignalDataTypeMap,
} from "baileys";

export const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_creds (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_keys (
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (type, id)
);
`;

// The DO SQLite surface this module needs. Narrower than the platform's
// SqlStorage so the unit tests can drive it against node:sqlite.
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

// Durable Object SQLite allows at most 100 bound parameters per statement, and
// Baileys asks for its whole pre-key range in a single `get`: the first login
// after pairing uploads INITIAL_PREKEY_COUNT = 812 of them, so an unchunked
// `IN (?, ?, …)` throws on the one connection that matters most.
const MAX_IDS_PER_QUERY = 90;

function encode(value: unknown): string {
  return JSON.stringify(value, BufferJSON.replacer);
}

function decode<T>(text: string): T {
  return JSON.parse(text, BufferJSON.reviver) as T;
}

export interface SqlAuthState {
  state: AuthenticationState;
  /** Persist the creds blob. Call on every `creds.update`. */
  saveCreds(): void;
  /** True once pairing has completed and a device identity exists. */
  isPaired(): boolean;
  /** Forget the device entirely — next connect starts a fresh pairing. */
  reset(): void;
}

/**
 * @param runInTransaction wraps a batch of writes atomically. Durable Object
 * SQLite rejects BEGIN/SAVEPOINT statements, so the caller passes
 * `ctx.storage.transactionSync`; tests and other callers can omit it.
 */
export function makeSqlAuthState(
  sql: SqlLike,
  runInTransaction: <T>(fn: () => T) => T = (fn) => fn(),
): SqlAuthState {
  sql.exec(AUTH_SCHEMA);

  const stored = sql.exec("SELECT value FROM auth_creds WHERE id = 1").toArray();
  const creds: AuthenticationCreds =
    stored.length > 0 ? decode<AuthenticationCreds>(stored[0]!.value as string) : initAuthCreds();

  const saveCreds = () => {
    sql.exec(
      "INSERT INTO auth_creds (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value",
      encode(creds),
    );
  };

  // A never-persisted creds object would be regenerated on the next wake and
  // invalidate a half-finished pairing, so write it out immediately.
  if (stored.length === 0) saveCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        for (let offset = 0; offset < ids.length; offset += MAX_IDS_PER_QUERY) {
          const batch = ids.slice(offset, offset + MAX_IDS_PER_QUERY);
          const placeholders = batch.map(() => "?").join(",");
          const rows = sql
            .exec(`SELECT id, value FROM auth_keys WHERE type = ? AND id IN (${placeholders})`, type, ...batch)
            .toArray();
          for (const row of rows) {
            let value = decode<SignalDataTypeMap[T]>(row.value as string);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(
                value as object,
              ) as unknown as SignalDataTypeMap[T];
            }
            out[row.id as string] = value;
          }
        }
        return out;
      },
      set: (data: SignalDataSet) => {
        // One post-pairing call writes 812 pre-keys; a half-written batch would
        // leave the server holding keys we cannot answer with.
        runInTransaction(() => writeKeys(sql, data));
      },
      clear: () => {
        sql.exec("DELETE FROM auth_keys");
      },
    },
  };

  return {
    state,
    saveCreds,
    // What "paired" means, precisely, because getting it wrong is silent.
    //
    // `me` alone will not do: `requestPairingCode` writes it from the phone
    // number *before* anything is confirmed (Socket/socket.js), so an
    // abandoned code attempt would look paired forever.
    //
    // `registered` will not do either, and this is the trap: Baileys sets it
    // in exactly one place — the `link_code_companion_reg` notification
    // handler (Socket/messages-recv.js) — so it is true after a phone-code
    // pairing and false after a QR pairing, which is otherwise identical and
    // just as usable. A predicate resting on it reports a perfectly good
    // QR-linked device as unpaired, and then the alarm skips every cycle.
    //
    // `account` is the honest signal. It is the signed ADV device identity
    // that `configureSuccessfulPairing` returns on `pair-success`
    // (Utils/validate-connection.js) — the same stanza on both paths, and
    // never written speculatively. `registered` stays in the disjunction only
    // so a session paired before this was understood keeps working.
    isPaired: () => Boolean(creds.me?.id && (creds.account || creds.registered)),
    reset: () => {
      sql.exec("DELETE FROM auth_keys");
      sql.exec("DELETE FROM auth_creds");
      const fresh = initAuthCreds();
      // The live socket holds this exact object, so it is mutated in place —
      // but a plain Object.assign would leave behind every key the fresh creds
      // do not have. `me` is the one that matters: Baileys chooses the login
      // path over the registration path purely on `creds.me` being set
      // (Utils/validate-connection.js), so a stale one from an abandoned
      // pairing makes the next connect ask to log in as a device that was
      // never registered, and no pairing stanza ever arrives.
      for (const key of Object.keys(creds)) {
        delete (creds as unknown as Record<string, unknown>)[key];
      }
      Object.assign(creds, fresh);
      sql.exec("INSERT INTO auth_creds (id, value) VALUES (1, ?)", encode(creds));
    },
  };
}

// Durable Object SQLite caps a single value at 2 MB. The one store entry that
// grows without bound is `app-state-sync-version`, whose indexValueMap gains an
// entry per app-state mutation — fail loudly rather than at the SQLite layer.
const MAX_VALUE_BYTES = 1_500_000;

function writeKeys(sql: SqlLike, data: SignalDataSet): void {
  for (const type of Object.keys(data) as (keyof SignalDataSet)[]) {
    const entries = data[type];
    if (!entries) continue;
    for (const id of Object.keys(entries)) {
      const value = entries[id];
      if (value === null || value === undefined) {
        sql.exec("DELETE FROM auth_keys WHERE type = ? AND id = ?", type, id);
        continue;
      }
      const encoded = encode(value);
      if (encoded.length > MAX_VALUE_BYTES) {
        throw new Error(`signal key ${type}/${id} is ${encoded.length} bytes, over the SQLite value limit`);
      }
      sql.exec(
        `INSERT INTO auth_keys (type, id, value) VALUES (?, ?, ?)
         ON CONFLICT(type, id) DO UPDATE SET value = excluded.value`,
        type,
        id,
        encoded,
      );
    }
  }
}
