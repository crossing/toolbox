import { describe, expect, it } from "vitest";
import { signToken as signCookie } from "../src/crypto";
import { FILE_URL_TTL_MS, signToken, verifyToken } from "../src/files/signed";

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

describe("signed file URLs", () => {
  it("round-trips the payload with a 15 minute default expiry", async () => {
    const { token, payload } = await signToken(KEY, request, at(T0));
    expect(payload).toMatchObject({ v: 1, ...request, exp: T0 + 15 * 60 * 1000 });
    expect(payload.jti).toMatch(/^[0-9a-f]{32}$/);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await verifyToken(KEY, token, "PUT", at(T0 + 1000))).toEqual({ ok: true, payload });
  });

  it("gives every token its own jti", async () => {
    const a = await signToken(KEY, request, at(T0));
    const b = await signToken(KEY, request, at(T0));
    expect(a.payload.jti).not.toBe(b.payload.jti);
  });

  it("defaults the account to null", async () => {
    const { payload } = await signToken(KEY, { ...request, account: undefined }, at(T0));
    expect(payload.account).toBeNull();
  });

  it("rejects a tampered payload or signature", async () => {
    const { token } = await signToken(KEY, request, at(T0));
    const [body, mac] = token.split(".") as [string, string];
    const forged = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    forged.maxBytes = 10 ** 9;
    const forgedBody = btoa(JSON.stringify(forged)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifyToken(KEY, `${forgedBody}.${mac}`, "PUT", at(T0))).toEqual({ ok: false, reason: "bad-signature" });
    const flipped = `${body}.${mac.slice(0, -2)}${mac.endsWith("AA") ? "BB" : "AA"}`;
    expect(await verifyToken(KEY, flipped, "PUT", at(T0))).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a token signed with another key", async () => {
    const { token } = await signToken("some-other-key", request, at(T0));
    expect(await verifyToken(KEY, token, "PUT", at(T0))).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("expires at exp, not after", async () => {
    const { token, payload } = await signToken(KEY, request, at(T0));
    expect((await verifyToken(KEY, token, "PUT", at(payload.exp - 1))).ok).toBe(true);
    expect(await verifyToken(KEY, token, "PUT", at(payload.exp))).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses the other method", async () => {
    const { token } = await signToken(KEY, request, at(T0));
    expect(await verifyToken(KEY, token, "GET", at(T0))).toEqual({ ok: false, reason: "wrong-method" });
  });

  it("refuses junk and well-signed non-file payloads", async () => {
    expect(await verifyToken(KEY, "", "GET", at(T0))).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyToken(KEY, "a.b.c", "GET", at(T0))).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyToken(KEY, "not a token", "GET", at(T0))).toEqual({ ok: false, reason: "malformed" });
    const cookie = await signCookie(KEY, { kind: "session", email: "owner@example.com", exp: T0 + 1000 });
    expect(await verifyToken(KEY, cookie, "GET", at(T0))).toEqual({ ok: false, reason: "unsupported-version" });
    const shapeless = await signCookie(KEY, { v: 1, method: "GET" });
    expect(await verifyToken(KEY, shapeless, "GET", at(T0))).toEqual({ ok: false, reason: "malformed" });
  });

  it("caps the TTL and validates the request", async () => {
    await expect(signToken(KEY, { ...request, ttlMs: FILE_URL_TTL_MS + 1 })).rejects.toThrow(/TTL/);
    await expect(signToken(KEY, { ...request, ttlMs: 0 })).rejects.toThrow(/TTL/);
    await expect(signToken(KEY, { ...request, maxBytes: -1 })).rejects.toThrow(/maxBytes/);
    await expect(signToken(KEY, { ...request, target: "" })).rejects.toThrow(/target/);
    const short = await signToken(KEY, { ...request, ttlMs: 60_000 }, at(T0));
    expect(short.payload.exp).toBe(T0 + 60_000);
  });

  it("fails loudly when FILES_URL_KEY is missing", async () => {
    await expect(signToken(undefined, request)).rejects.toThrow(/FILES_URL_KEY/);
    await expect(signToken("", request)).rejects.toThrow(/FILES_URL_KEY/);
  });
});
