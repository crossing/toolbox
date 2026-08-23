import { describe, expect, it } from "vitest";
import { proto } from "baileys";
import { makeSqlAuthState } from "../src/auth";
import { makeFakeSql } from "./sqlfake";

describe("makeSqlAuthState", () => {
  it("persists creds across instances, Buffers intact", () => {
    const sql = makeFakeSql();
    const first = makeSqlAuthState(sql);
    first.state.creds.advSecretKey = "secret-key";
    first.state.creds.nextPreKeyId = 42;
    first.saveCreds();

    const second = makeSqlAuthState(sql);
    expect(second.state.creds.advSecretKey).toBe("secret-key");
    expect(second.state.creds.nextPreKeyId).toBe(42);
    // The keypairs are Buffers/Uint8Arrays; BufferJSON must round-trip them as
    // bytes, not as {type:"Buffer",data:[…]} objects.
    expect(Buffer.isBuffer(second.state.creds.noiseKey.private)).toBe(true);
    expect(Buffer.from(second.state.creds.noiseKey.private)).toEqual(
      Buffer.from(first.state.creds.noiseKey.private),
    );
    expect(second.state.creds.signedPreKey.keyId).toBe(first.state.creds.signedPreKey.keyId);
    sql.close();
  });

  it("stores creds on first construction so a half-finished pairing survives", () => {
    const sql = makeFakeSql();
    const first = makeSqlAuthState(sql);
    const second = makeSqlAuthState(sql);
    expect(Buffer.from(second.state.creds.noiseKey.private)).toEqual(
      Buffer.from(first.state.creds.noiseKey.private),
    );
    sql.close();
  });

  it("round-trips signal keys and deletes on null", async () => {
    const sql = makeFakeSql();
    const auth = makeSqlAuthState(sql);
    const keyPair = { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) };
    await auth.state.keys.set({
      "pre-key": { "1": keyPair },
      session: { "sess-a": Buffer.from("session-bytes") },
    });

    const got = await auth.state.keys.get("pre-key", ["1", "missing"]);
    expect(Buffer.from(got["1"]!.private)).toEqual(Buffer.from([4, 5, 6]));
    expect(got.missing).toBeUndefined();

    const sessions = await auth.state.keys.get("session", ["sess-a"]);
    expect(Buffer.from(sessions["sess-a"]!).toString()).toBe("session-bytes");

    await auth.state.keys.set({ "pre-key": { "1": null } });
    expect(await auth.state.keys.get("pre-key", ["1"])).toEqual({});
    sql.close();
  });

  it("revives app-state-sync-key values as proto messages", async () => {
    const sql = makeFakeSql();
    const auth = makeSqlAuthState(sql);
    await auth.state.keys.set({
      "app-state-sync-key": {
        "key-1": {
          keyData: Buffer.from("kd"),
          fingerprint: { rawId: 7, currentIndex: 1, deviceIndexes: [0, 1] },
          timestamp: 1700000000,
        },
      },
    });
    const got = await auth.state.keys.get("app-state-sync-key", ["key-1"]);
    const value = got["key-1"]!;
    expect(value).toBeInstanceOf(proto.Message.AppStateSyncKeyData);
    expect(Buffer.from(value.keyData!).toString()).toBe("kd");
    expect(value.fingerprint!.rawId).toBe(7);
    sql.close();
  });

  it("chunks large id lists under the 100 bound-parameter cap", async () => {
    const sql = makeFakeSql();
    const auth = makeSqlAuthState(sql);
    // Baileys asks for all 812 pre-keys in one call after pairing.
    const entries: Record<string, { public: Buffer; private: Buffer }> = {};
    for (let id = 1; id <= 812; id++) {
      entries[String(id)] = { public: Buffer.from([id % 256]), private: Buffer.from([(id * 3) % 256]) };
    }
    await auth.state.keys.set({ "pre-key": entries });
    const ids = Object.keys(entries);
    const got = await auth.state.keys.get("pre-key", ids);
    expect(Object.keys(got)).toHaveLength(812);
    expect(Buffer.from(got["812"]!.private)).toEqual(Buffer.from([(812 * 3) % 256]));
    sql.close();
  });

  it("empty id lists never hit the database", async () => {
    const sql = makeFakeSql();
    const auth = makeSqlAuthState(sql);
    expect(await auth.state.keys.get("session", [])).toEqual({});
    sql.close();
  });

  it("counts a QR pairing as paired, and an abandoned code attempt as not", () => {
    // Baileys sets `registered` in exactly one place — the
    // link_code_companion_reg handler — so a QR-linked device never has it,
    // and is every bit as paired. A predicate resting on it reports a working
    // device as unpaired, and the sync alarm then skips every cycle in silence.
    const qr = makeSqlAuthState(makeFakeSql());
    qr.state.creds.me = { id: "44700000000:1@s.whatsapp.net", name: "test" };
    qr.state.creds.account = { details: new Uint8Array([1]) };
    expect(qr.state.creds.registered).toBe(false);
    expect(qr.isPaired()).toBe(true);

    // What `me` on its own cannot distinguish: requestPairingCode writes it
    // from the phone number before WhatsApp has confirmed anything, so an
    // attempt nobody completed must not read as paired.
    const abandoned = makeSqlAuthState(makeFakeSql());
    abandoned.state.creds.me = { id: "44700000000@s.whatsapp.net", name: "~" };
    abandoned.state.creds.pairingCode = "ABCD1234";
    expect(abandoned.isPaired()).toBe(false);
  });

  it("reports pairing state and resets to a fresh identity", () => {
    const sql = makeFakeSql();
    const auth = makeSqlAuthState(sql);
    expect(auth.isPaired()).toBe(false);

    auth.state.creds.registered = true;
    auth.state.creds.me = { id: "44700000000:1@s.whatsapp.net", name: "test" };
    auth.saveCreds();
    expect(auth.isPaired()).toBe(true);
    expect(makeSqlAuthState(sql).isPaired()).toBe(true);

    const beforeReset = Buffer.from(auth.state.creds.noiseKey.private);
    auth.reset();
    expect(auth.isPaired()).toBe(false);
    // Not just "not paired": every trace of the old identity has to go, or
    // Baileys takes the login path on the next connect and pairing never
    // starts.
    expect(auth.state.creds.me).toBeUndefined();
    expect(auth.state.creds.registered).toBe(false);
    expect(auth.state.creds.account).toBeUndefined();
    expect(auth.state.creds.signalIdentities).toBeUndefined();
    expect(auth.state.creds.pairingCode).toBeUndefined();
    expect(makeSqlAuthState(sql).state.creds.me).toBeUndefined();
    expect(Buffer.from(auth.state.creds.noiseKey.private)).not.toEqual(beforeReset);
    // The same creds object stays live for an already-running socket.
    expect(makeSqlAuthState(sql).state.creds.noiseKey.private).toEqual(
      auth.state.creds.noiseKey.private,
    );
    sql.close();
  });

  it("reset() clears a half-finished pairing left by requestPairingCode", () => {
    const sql = makeFakeSql();
    const auth = makeSqlAuthState(sql);
    // What Baileys writes when a pairing code is requested and then abandoned:
    // `me` is set, `registered` is still false.
    auth.state.creds.me = { id: "447700900000:1@s.whatsapp.net", name: "~" };
    auth.state.creds.pairingCode = "ABCD1234";
    auth.saveCreds();
    expect(makeSqlAuthState(sql).state.creds.me).toBeDefined();

    auth.reset();
    expect(auth.state.creds.me).toBeUndefined();
    expect(auth.state.creds.pairingCode).toBeUndefined();
    sql.close();
  });

  it("clear() wipes the key store but keeps creds", async () => {
    const sql = makeFakeSql();
    const auth = makeSqlAuthState(sql);
    await auth.state.keys.set({ session: { a: Buffer.from("x") } });
    await auth.state.keys.clear!();
    expect(await auth.state.keys.get("session", ["a"])).toEqual({});
    expect(makeSqlAuthState(sql).state.creds.registrationId).toBe(auth.state.creds.registrationId);
    sql.close();
  });
});
