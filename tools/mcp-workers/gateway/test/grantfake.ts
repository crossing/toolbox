// A FileGrantStore over node:sqlite running the real grant SQL from
// files/signed.ts — the same functions the UserVault shard instances call —
// so tests exercise the claim's check-and-set rather than a hand-rolled Map.

import { claimGrant, getGrant, putGrant, type FileGrantStore } from "../src/files/signed";
import { makeFakeSql, type FakeSql } from "./sqlfake";

export interface FakeGrantStore extends FileGrantStore {
  sql: FakeSql;
}

export function makeGrantStore(): FakeGrantStore {
  const sql = makeFakeSql();
  return {
    sql,
    put: async (jti, grant, now) => putGrant(sql, jti, grant, now),
    get: async (jti, now) => getGrant(sql, jti, now),
    claim: async (jti, now) => claimGrant(sql, jti, now),
  };
}
