import { afterEach, describe, expect, it } from "vitest";
import { signToken as signCookie } from "../src/crypto";
import { claimGrant, FILE_URL_TTL_MS, getGrant, putGrant, signToken, verifyToken } from "../src/files/signed";
import { makeGrantStore, type FakeGrantStore } from "./grantfake";
import { makeFakeSql } from "./sqlfake";

const KEY = "fake-files-url-key-for-tests";
const T0 = 1_800_000_000_000;
const at = (ms: number) => () => ms;

const request = {
  userId: "owner@example.com",
  account: "work@example.com",
  method: "PUT" as const,
  target: "FAKEtransitfile01",
  maxBytes: 1024,
};

let stores: FakeGrantStore[] = [];
function store(): FakeGrantStore {
  const s = makeGrantStore();
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores) s.sql.close();
  stores = [];
});

function b64urlDecode(text: string): string {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

describe("opaque file URL tokens", () => {
  it("stores the grant server-side with a 15 minute default expiry and verifies back to it", async () => {
    const s = store();
    const { token, jti, grant } = await signToken(KEY, s, request, at(T0));
    expect(grant).toEqual({ v: 2, ...request, exp: T0 + 15 * 60 * 1000 });
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(token.startsWith(`${jti}.`)).toBe(true);
    expect(await verifyToken(KEY, s, token, "PUT", at(T0 + 1000))).toEqual({ ok: true, jti, grant, used: false });
  });

  it("reveals nothing about the grant: no email, account, target, size or expiry", async () => {
    const s = store();
    const { token, grant } = await signToken(KEY, s, request, at(T0));
    const [idPart = "", macPart = ""] = token.split(".");
    // Every way someone might read the URL: raw, and each half decoded.
    const views = [token, b64urlDecode(idPart), b64urlDecode(macPart), decodeURIComponent(token)];
    for (const view of views) {
      for (const secret of [request.userId, "owner", "example.com", request.account, request.target, String(grant.exp)]) {
        expect(view).not.toContain(secret);
      }
    }
    // Two fixed-length random/MAC blobs, nothing else: no JSON hiding in there.
    expect(b64urlDecode(idPart)).toHaveLength(16);
    expect(b64urlDecode(macPart)).toHaveLength(32);
  });

  it("gives every token its own jti and grant", async () => {
    const s = store();
    const a = await signToken(KEY, s, request, at(T0));
    const b = await signToken(KEY, s, request, at(T0));
    expect(a.jti).not.toBe(b.jti);
    expect(a.token).not.toBe(b.token);
  });

  it("defaults the account to null", async () => {
    const { grant } = await signToken(KEY, store(), { ...request, account: undefined }, at(T0));
    expect(grant.account).toBeNull();
  });

  it("rejects a tampered id or MAC without consulting the store", async () => {
    const s = store();
    const { token } = await signToken(KEY, s, request, at(T0));
    const [id = "", mac = ""] = token.split(".");
    let lookups = 0;
    const counting = { ...s, get: async (jti: string, now: number) => (lookups++, s.get(jti, now)) };
    const otherId = `${id.slice(0, -2)}${id.endsWith("AA") ? "BB" : "AA"}`;
    expect(await verifyToken(KEY, counting, `${otherId}.${mac}`, "PUT", at(T0))).toEqual({ ok: false, reason: "bad-signature" });
    const flipped = `${id}.${mac.slice(0, -2)}${mac.endsWith("AA") ? "BB" : "AA"}`;
    expect(await verifyToken(KEY, counting, flipped, "PUT", at(T0))).toEqual({ ok: false, reason: "bad-signature" });
    expect(lookups).toBe(0);
  });

  it("rejects a token signed with another key, even when its grant is in the store", async () => {
    const s = store();
    const { token } = await signToken("some-other-key", s, request, at(T0));
    expect(await verifyToken(KEY, s, token, "PUT", at(T0))).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("expires at exp, not after, and never returns an expired grant", async () => {
    const s = store();
    const { token, jti, grant } = await signToken(KEY, s, request, at(T0));
    expect((await verifyToken(KEY, s, token, "PUT", at(grant.exp - 1))).ok).toBe(true);
    expect(await verifyToken(KEY, s, token, "PUT", at(grant.exp))).toEqual({ ok: false, reason: "expired" });
    // The expired read deleted the row: even a clock moved back finds nothing.
    expect(await s.get(jti, T0)).toBeNull();
    expect(await verifyToken(KEY, s, token, "PUT", at(T0))).toEqual({ ok: false, reason: "expired" });
  });

  it("treats a well-signed token with no grant as expired", async () => {
    const issuing = store();
    const { token } = await signToken(KEY, issuing, request, at(T0));
    expect(await verifyToken(KEY, store(), token, "PUT", at(T0))).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses the other method", async () => {
    const s = store();
    const { token } = await signToken(KEY, s, request, at(T0));
    expect(await verifyToken(KEY, s, token, "GET", at(T0))).toEqual({ ok: false, reason: "wrong-method" });
  });

  it("reports a claimed grant as used", async () => {
    const s = store();
    const { token, jti } = await signToken(KEY, s, request, at(T0));
    expect(await s.claim(jti, T0)).toBe(true);
    expect(await verifyToken(KEY, s, token, "PUT", at(T0))).toMatchObject({ ok: true, used: true });
  });

  it("refuses junk, round-1 self-describing tokens and cookies as malformed", async () => {
    const s = store();
    expect(await verifyToken(KEY, s, "", "GET", at(T0))).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyToken(KEY, s, "a.b.c", "GET", at(T0))).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyToken(KEY, s, "not a token", "GET", at(T0))).toEqual({ ok: false, reason: "malformed" });
    const cookie = await signCookie(KEY, { kind: "session", email: "owner@example.com", exp: T0 + 1000 });
    expect(await verifyToken(KEY, s, cookie, "GET", at(T0))).toEqual({ ok: false, reason: "malformed" });
    const roundOne = await signCookie(KEY, { v: 1, ...request, exp: T0 + 1000, jti: "0".repeat(32) });
    expect(await verifyToken(KEY, s, roundOne, "PUT", at(T0))).toEqual({ ok: false, reason: "malformed" });
  });

  it("caps the TTL and validates the request, storing nothing on refusal", async () => {
    const s = store();
    await expect(signToken(KEY, s, { ...request, ttlMs: FILE_URL_TTL_MS + 1 })).rejects.toThrow(/TTL/);
    await expect(signToken(KEY, s, { ...request, ttlMs: 0 })).rejects.toThrow(/TTL/);
    await expect(signToken(KEY, s, { ...request, maxBytes: -1 })).rejects.toThrow(/maxBytes/);
    await expect(signToken(KEY, s, { ...request, target: "" })).rejects.toThrow(/target/);
    expect(s.sql.exec("SELECT name FROM sqlite_master WHERE name = 'file_url_grants'").toArray()).toEqual([]);
    const short = await signToken(KEY, s, { ...request, ttlMs: 60_000 }, at(T0));
    expect(short.grant.exp).toBe(T0 + 60_000);
  });

  it("fails loudly when FILES_URL_KEY is missing", async () => {
    await expect(signToken(undefined, store(), request)).rejects.toThrow(/FILES_URL_KEY/);
    await expect(signToken("", store(), request)).rejects.toThrow(/FILES_URL_KEY/);
    await expect(verifyToken("", store(), "x.y", "GET")).rejects.toThrow(/FILES_URL_KEY/);
  });
});

describe("the grant table", () => {
  const grant = { v: 2 as const, ...request, exp: 1000 };

  it("claims a live grant exactly once, and never after expiry", () => {
    const sql = makeFakeSql();
    try {
      putGrant(sql, "j1", grant, 0);
      putGrant(sql, "j2", grant, 0);
      expect(claimGrant(sql, "j1", 10)).toBe(true);
      expect(claimGrant(sql, "j1", 20)).toBe(false);
      expect(getGrant(sql, "j1", 30)).toEqual({ grant, used: true });
      expect(claimGrant(sql, "j2", 1000)).toBe(false);
      expect(claimGrant(sql, "missing", 10)).toBe(false);
    } finally {
      sql.close();
    }
  });

  it("prunes expired grants on every write and refuses a duplicate jti", () => {
    const sql = makeFakeSql();
    try {
      putGrant(sql, "old", grant, 0);
      putGrant(sql, "new", { ...grant, exp: 5000 }, 2000);
      expect(sql.exec("SELECT jti FROM file_url_grants").toArray()).toEqual([{ jti: "new" }]);
      expect(() => putGrant(sql, "new", grant, 2000)).toThrow();
    } finally {
      sql.close();
    }
  });
});
