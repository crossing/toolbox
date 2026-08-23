// Hand-written crypto is only worth it if it is exactly right, so every case
// here is checked against Node's own implementation rather than against a
// remembered vector.

import { createHash, pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { installHighIterationPbkdf2, pbkdf2Sha256, sha256, WORKERD_PBKDF2_LIMIT } from "../src/pbkdf2";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("sha256", () => {
  it.each([
    "",
    "a",
    "abc",
    "message digest",
    "x".repeat(55), // one byte under the single-block padding boundary
    "x".repeat(56), // forces a second block
    "x".repeat(64),
    "x".repeat(1000),
  ])("matches node for %j-length input", (input) => {
    const expected = Buffer.from(createHash("sha256").update(input).digest()).toString("hex");
    expect(Buffer.from(sha256(bytes(input))).toString("hex")).toBe(expected);
  });
});

describe("pbkdf2Sha256", () => {
  it.each([
    ["password", "salt", 1, 32],
    ["password", "salt", 2, 32],
    ["password", "salt", 4096, 32],
    ["", "", 100, 32],
    ["pw", "s", 1000, 16],
    ["pw", "s", 1000, 64], // more than one output block
    ["a".repeat(100), "saltsaltsalt", 500, 32], // key longer than the block size
  ])("matches node for (%j, %j, %i, %i)", (password, salt, iterations, length) => {
    const expected = Buffer.from(pbkdf2Sync(password, salt, iterations, length, "sha256")).toString("hex");
    expect(Buffer.from(pbkdf2Sha256(bytes(password), bytes(salt), iterations, length)).toString("hex")).toBe(
      expected,
    );
  });

  it("matches node at WhatsApp's 131,072 iterations", () => {
    const salt = new Uint8Array(32).map((_, i) => (i * 11) % 256);
    const expected = Buffer.from(pbkdf2Sync("ABCD1234", Buffer.from(salt), 2 << 16, 32, "sha256")).toString("hex");
    expect(Buffer.from(pbkdf2Sha256(bytes("ABCD1234"), salt, 2 << 16, 32)).toString("hex")).toBe(expected);
  });
});

describe("pbkdf2 guards", () => {
  it("refuses a salt too long for its single-block HMAC rather than answering wrongly", () => {
    // 52-byte salt + the 4-byte block counter is past the one-block limit.
    expect(() => pbkdf2Sha256(bytes("pw"), new Uint8Array(52), 2, 32)).toThrow(/55 bytes/);
    // 51 is still fine, and still matches node.
    const salt = new Uint8Array(51).map((_, i) => i);
    expect(Buffer.from(pbkdf2Sha256(bytes("pw"), salt, 2, 32)).toString("hex")).toBe(
      Buffer.from(pbkdf2Sync("pw", Buffer.from(salt), 2, 32, "sha256")).toString("hex"),
    );
  });
});

describe("installHighIterationPbkdf2", () => {
  // A stand-in for workerd, which throws above 100,000 rather than computing.
  function cappedSubtle(): { subtle: SubtleCrypto; delegated: string[] } {
    const delegated: string[] = [];
    const real = crypto.subtle;
    const subtle = {
      importKey: async (...args: unknown[]) => {
        delegated.push("importKey");
        return (real.importKey as (...a: unknown[]) => Promise<CryptoKey>)(...args);
      },
      deriveBits: async (algorithm: { iterations?: number }, ...rest: unknown[]) => {
        if ((algorithm.iterations ?? 0) > WORKERD_PBKDF2_LIMIT) {
          throw new Error(
            `Pbkdf2 failed: iteration counts above 100000 are not supported (requested ${algorithm.iterations})`,
          );
        }
        delegated.push("deriveBits");
        return (real.deriveBits as (...a: unknown[]) => Promise<ArrayBuffer>)(algorithm, ...rest);
      },
    } as unknown as SubtleCrypto;
    return { subtle, delegated };
  }

  it("answers the derivation workerd refuses, with the right bytes", async () => {
    const { subtle } = cappedSubtle();
    expect(installHighIterationPbkdf2(subtle)).toBe(true);

    const salt = new Uint8Array(16).map((_, i) => i);
    const password = bytes("PAIR1234");
    const key = await subtle.importKey("raw", password, { name: "PBKDF2" }, false, ["deriveBits"]);
    const derived = await subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: 2 << 16, hash: "SHA-256" },
      key,
      32 * 8,
    );
    const expected = Buffer.from(pbkdf2Sync(Buffer.from(password), Buffer.from(salt), 2 << 16, 32, "sha256"));
    expect(Buffer.from(derived).toString("hex")).toBe(expected.toString("hex"));
  });

  it("leaves everything under the limit to the platform", async () => {
    const { subtle, delegated } = cappedSubtle();
    installHighIterationPbkdf2(subtle);
    const key = await subtle.importKey("raw", bytes("pw"), { name: "PBKDF2" }, false, ["deriveBits"]);
    const derived = await subtle.deriveBits(
      { name: "PBKDF2", salt: bytes("salt"), iterations: 1000, hash: "SHA-256" },
      key,
      256,
    );
    expect(delegated).toContain("deriveBits");
    expect(Buffer.from(derived).toString("hex")).toBe(
      Buffer.from(pbkdf2Sync("pw", "salt", 1000, 32, "sha256")).toString("hex"),
    );
  });

  it("does not intercept other algorithms", async () => {
    const { subtle, delegated } = cappedSubtle();
    installHighIterationPbkdf2(subtle);
    const key = await subtle.importKey("raw", new Uint8Array(32), "HKDF", false, ["deriveBits"]);
    await subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new Uint8Array(0) },
      key,
      256,
    );
    expect(delegated.filter((call) => call === "deriveBits")).toHaveLength(1);
  });
});
