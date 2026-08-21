import { describe, expect, it } from "vitest";
import { decryptJson, encryptJson, importVaultKey, randomToken, signToken, verifyToken } from "../src/crypto";

const KEY_B64 = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));

describe("vault encryption", () => {
  it("round-trips JSON values", async () => {
    const key = await importVaultKey(KEY_B64);
    const value = { refreshToken: "secret-token", scopes: ["a", "b"] };
    const blob = await encryptJson(key, value);
    expect(blob).not.toContain("secret-token");
    expect(await decryptJson(key, blob)).toEqual(value);
  });

  it("rejects tampered ciphertext", async () => {
    const key = await importVaultKey(KEY_B64);
    const blob = await encryptJson(key, { x: 1 });
    const [iv, ct] = blob.split(".") as [string, string];
    const flipped = `${iv}.${ct.slice(0, -2)}${ct.endsWith("AA") ? "BB" : "AA"}`;
    await expect(decryptJson(key, flipped)).rejects.toThrow();
  });

  it("rejects keys that are not 32 bytes", async () => {
    await expect(importVaultKey(btoa("short"))).rejects.toThrow(/32 bytes/);
  });
});

describe("signed tokens", () => {
  it("round-trips payloads", async () => {
    const token = await signToken("secret", { kind: "session", email: "a@b.c", exp: 123 });
    expect(await verifyToken("secret", token)).toEqual({ kind: "session", email: "a@b.c", exp: 123 });
  });

  it("rejects tampered payloads", async () => {
    const token = await signToken("secret", { email: "a@b.c" });
    const forged = await signToken("secret", { email: "evil@b.c" });
    const [, mac] = token.split(".") as [string, string];
    const [forgedBody] = forged.split(".") as [string, string];
    expect(await verifyToken("secret", `${forgedBody}.${mac}`)).toBeNull();
  });

  it("rejects the wrong secret and malformed tokens", async () => {
    const token = await signToken("secret", { x: 1 });
    expect(await verifyToken("other", token)).toBeNull();
    expect(await verifyToken("secret", "garbage")).toBeNull();
    expect(await verifyToken("secret", "")).toBeNull();
  });
});

describe("randomToken", () => {
  it("is url-safe and unique", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toEqual(randomToken());
  });
});
