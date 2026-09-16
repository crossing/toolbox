// The send path, driven end to end against the real signal store.
//
// The "All encryptions failed" / ERR_OUT_OF_RANGE bug is an encrypt-time
// failure: `signalRepository.encryptMessage` throws for every recipient right
// after a fresh pairing. The bridge opens a *fresh socket per operation*, so
// the keys and creds an encrypt reads were serialised into D1 by an earlier
// socket and revived by BufferJSON. This test reproduces that shape: it
// establishes a libsignal session through `src/auth.ts`, then throws the
// store away, builds a brand-new `makeSqlAuthState` over the same SQL (a new
// socket reading D1 back), and encrypts — asserting the revived session and
// creds still produce a decryptable message. If a key round-tripped as the
// wrong type (Uint8Array vs Buffer, a plain object, a base64 string), the real
// libsignal Buffer reads would throw here, the way they do in production.

import { describe, expect, it } from "vitest";
import { addTransactionCapability, generateSignalPubKey } from "baileys";
import { makeLibSignalRepository } from "baileys/lib/Signal/libsignal.js";
import { Curve } from "baileys/lib/Utils/crypto.js";
import { makeSqlAuthState } from "../src/auth";
import { makeFakeSql, type FakeSql } from "./sqlfake";

const silent: any = {
  level: "silent",
  child: () => silent,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const txOpts = { maxCommitRetries: 10, delayBetweenTriesMs: 1 };

function repoOver(state: any) {
  return makeLibSignalRepository(
    { creds: state.creds, keys: addTransactionCapability(state.keys, silent, txOpts) } as any,
    silent,
  );
}

// A pre-key bundle shaped the way parseAndInjectE2ESessions builds one from the
// server's `get` response: identity/signed-pre-key/pre-key public keys carry
// the version byte, exactly as they arrive on the wire.
async function bundleFor(state: any, preKeyId: number) {
  const preKey = Curve.generateKeyPair();
  await state.keys.set({ "pre-key": { [String(preKeyId)]: preKey } });
  return {
    registrationId: state.creds.registrationId,
    identityKey: generateSignalPubKey(state.creds.signedIdentityKey.public),
    signedPreKey: {
      keyId: state.creds.signedPreKey.keyId,
      publicKey: generateSignalPubKey(state.creds.signedPreKey.keyPair.public),
      signature: state.creds.signedPreKey.signature,
    },
    preKey: { keyId: preKeyId, publicKey: generateSignalPubKey(preKey.public) },
  };
}

describe("send path over a revived store", () => {
  const usJid = "447441148085:5@s.whatsapp.net";
  const phoneJid = "447747642038@s.whatsapp.net";

  it("encrypts to a recipient whose session was written by a previous socket", async () => {
    const usSql: FakeSql = makeFakeSql();
    const phoneSql: FakeSql = makeFakeSql();

    // Recipient lives in its own store for the whole test.
    const phone = makeSqlAuthState(phoneSql).state as any;
    phone.creds.me = { id: phoneJid };
    const repoPhone = repoOver(phone);
    const bundle = await bundleFor(phone, 7);

    // Socket #1: establish the outgoing session and let it persist to D1.
    {
      const s1 = makeSqlAuthState(usSql);
      s1.state.creds.me = { id: usJid } as any;
      s1.saveCreds();
      await repoOver(s1.state).injectE2ESession({ jid: phoneJid, session: bundle as any });
    }

    // Socket #2: brand-new auth state, reading creds + session back from D1.
    const s2 = makeSqlAuthState(usSql);
    expect((s2.state.creds.me as any)?.id).toBe(usJid);
    // The identity key must come back as bytes, not a {type:"Buffer"} object.
    expect((s2.state.creds.signedIdentityKey.public as any).length).toBe(32);

    const repoSend = repoOver(s2.state);
    const { type, ciphertext } = await repoSend.encryptMessage({
      jid: phoneJid,
      data: Buffer.from("hello after reload"),
    });
    expect(type).toBe("pkmsg");
    expect(ciphertext.length).toBeGreaterThan(0);

    // The recipient must be able to read it — proves the revived keys were not
    // merely well-typed but correct.
    const plain = await repoPhone.decryptMessage({ jid: usJid, type, ciphertext });
    expect(Buffer.from(plain).toString()).toBe("hello after reload");

    usSql.close();
    phoneSql.close();
  });

  it("encrypts a ratcheted session (type msg) after a reload", async () => {
    const usSql: FakeSql = makeFakeSql();
    const phoneSql: FakeSql = makeFakeSql();

    const phone = makeSqlAuthState(phoneSql).state as any;
    phone.creds.me = { id: phoneJid };
    const repoPhone = repoOver(phone);
    const phoneBundle = await bundleFor(phone, 7);

    const s1 = makeSqlAuthState(usSql);
    s1.state.creds.me = { id: usJid } as any;
    s1.saveCreds();
    const usBundle = await bundleFor(s1.state as any, 9);
    const repoUs1 = repoOver(s1.state);

    // us -> phone (pkmsg), phone replies (establishes), us decrypts and ratchets.
    await repoUs1.injectE2ESession({ jid: phoneJid, session: phoneBundle as any });
    const m1 = await repoUs1.encryptMessage({ jid: phoneJid, data: Buffer.from("m1") });
    await repoPhone.decryptMessage({ jid: usJid, type: m1.type, ciphertext: m1.ciphertext });
    await repoPhone.injectE2ESession({ jid: usJid, session: usBundle as any });
    const r1 = await repoPhone.encryptMessage({ jid: usJid, data: Buffer.from("r1") });
    const d1 = await repoUs1.decryptMessage({ jid: phoneJid, type: r1.type, ciphertext: r1.ciphertext });
    expect(Buffer.from(d1).toString()).toBe("r1");

    // Reload us from D1 and send again: this is a normal `msg`, encrypted over a
    // revived chain (chainKey.key + messageKeys round-tripped through BufferJSON).
    const s2 = makeSqlAuthState(usSql);
    const m2 = await repoOver(s2.state).encryptMessage({ jid: phoneJid, data: Buffer.from("m2 after reload") });
    expect(m2.type).toBe("msg");
    const d2 = await repoPhone.decryptMessage({ jid: usJid, type: m2.type, ciphertext: m2.ciphertext });
    expect(Buffer.from(d2).toString()).toBe("m2 after reload");

    usSql.close();
    phoneSql.close();
  });
});
