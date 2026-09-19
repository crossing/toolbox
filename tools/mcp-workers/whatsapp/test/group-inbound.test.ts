// Receiving a group message, driven through Baileys' own decoder against the
// real signal store — the inbound twin of group-encrypt-roundtrip.test.ts.
//
// What arrives for a group message is one <message> stanza from the group,
// naming the author as `participant` (a …@lid in any recent group), with up to
// two <enc> children: a pairwise `pkmsg`/`msg` addressed to this device, which
// carries the author's SenderKeyDistributionMessage the first time they write,
// and the `skmsg` everyone gets, which only that sender key opens. The bridge
// adds two things of its own to that picture: every connection is a fresh
// socket reading keys back from SQL, and a socket may be closed while a stanza
// is part-way through Baileys.
//
// Nothing here touches a network or a live session; the stanzas are built with
// the same libsignal code a real member's client runs.

import { describe, expect, it } from "vitest";
import { addTransactionCapability, encodeWAMessage, generateSignalPubKey, proto } from "baileys";
import type { BinaryNode } from "baileys";
import { makeLibSignalRepository } from "baileys/lib/Signal/libsignal.js";
import { Curve } from "baileys/lib/Utils/crypto.js";
import { decryptMessageNode, MISSING_KEYS_ERROR_TEXT } from "baileys/lib/Utils/decode-wa-message.js";
import { makeSqlAuthState } from "../src/auth";
import { toStoredMessage } from "../src/normalize";
import "../src/protobuf-workerd-fix";
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

function repoOver(state: any) {
  return makeLibSignalRepository(
    {
      creds: state.creds,
      keys: addTransactionCapability(state.keys, silent, { maxCommitRetries: 10, delayBetweenTriesMs: 1 }),
    } as any,
    silent,
  );
}

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

const GROUP = "120363000000000001@g.us";
const BRIDGE = "447700900000:3@s.whatsapp.net";
const BRIDGE_LID = "199900000000000:3@lid";
// The member as a LID-addressed group presents him: an opaque LID as the
// author, the phone number alongside.
const MEMBER_LID = "199900000000777@lid";
const MEMBER_PN = "447700900111@s.whatsapp.net";

/** A fresh auth state over the bridge's SQL — what each new socket starts from. */
function bridgeSocket(sql: FakeSql) {
  const auth = makeSqlAuthState(sql);
  return repoOver(auth.state);
}

function stanza(id: string, children: BinaryNode[]): BinaryNode {
  return {
    tag: "message",
    attrs: {
      id,
      from: GROUP,
      participant: MEMBER_LID,
      participant_pn: MEMBER_PN,
      addressing_mode: "lid",
      notify: "Tom",
      t: "1789810000",
      offline: "1",
    },
    content: children,
  };
}

async function setUp() {
  const bridgeSql = makeFakeSql();
  const memberSql = makeFakeSql();
  const bridgeAuth = makeSqlAuthState(bridgeSql);
  bridgeAuth.state.creds.me = { id: BRIDGE, lid: BRIDGE_LID } as any;
  bridgeAuth.saveCreds();
  const bundle = await bundleFor(bridgeAuth.state, 11);

  const member = repoOver(makeSqlAuthState(memberSql).state);
  await member.injectE2ESession({ jid: BRIDGE, session: bundle as any });

  /** The member writes to the group; `withKey` fans his sender key out to the bridge first. */
  const write = async (id: string, text: string, withKey: boolean): Promise<BinaryNode> => {
    const group = await member.encryptGroupMessage({
      group: GROUP,
      meId: MEMBER_LID,
      data: encodeWAMessage({ conversation: text }),
    });
    const children: BinaryNode[] = [];
    if (withKey) {
      const pairwise = await member.encryptMessage({
        jid: BRIDGE,
        data: encodeWAMessage({
          senderKeyDistributionMessage: {
            groupId: GROUP,
            axolotlSenderKeyDistributionMessage: group.senderKeyDistributionMessage,
          },
        }),
      });
      children.push({ tag: "enc", attrs: { v: "2", type: pairwise.type }, content: pairwise.ciphertext });
    }
    children.push({ tag: "enc", attrs: { v: "2", type: "skmsg" }, content: group.ciphertext });
    return stanza(id, children);
  };

  const receive = async (node: BinaryNode) => {
    const { fullMessage, decrypt } = decryptMessageNode(node, BRIDGE, BRIDGE_LID, bridgeSocket(bridgeSql), silent);
    await decrypt();
    return fullMessage;
  };

  /** A one-to-one message from the same person, for the pairwise case. */
  const writeDirect = async (id: string, text: string): Promise<BinaryNode> => {
    const pairwise = await member.encryptMessage({ jid: BRIDGE, data: encodeWAMessage({ conversation: text }) });
    return {
      tag: "message",
      attrs: { id, from: MEMBER_LID, sender_pn: MEMBER_PN, addressing_mode: "lid", notify: "Tom", t: "1789810000", offline: "1" },
      content: [{ tag: "enc", attrs: { v: "2", type: pairwise.type }, content: pairwise.ciphertext }],
    };
  };

  return { bridgeSql, memberSql, write, writeDirect, receive };
}

describe("an inbound group message from a LID-addressed member", () => {
  it("decrypts, is filed under his phone number, and the next socket reads his next message without a new key", async () => {
    const { bridgeSql, memberSql, write, receive } = await setUp();

    const first = await receive(await write("A1", "Is the flat still available? — Tom", true));
    expect(first.messageStubType).toBeUndefined();
    expect(first.message?.conversation).toBe("Is the flat still available? — Tom");
    expect(first.key.participant).toBe(MEMBER_LID);
    expect(first.key.participantAlt).toBe(MEMBER_PN);

    const row = toStoredMessage(first as any, BRIDGE)!;
    expect(row).toMatchObject({
      id: "A1",
      chatJid: GROUP,
      sender: MEMBER_PN,
      senderName: "Tom",
      content: "Is the flat still available? — Tom",
      isFromMe: false,
      participant: MEMBER_LID,
      decryptError: null,
    });

    // The sender key was learnt by one socket and is needed by the next: it has
    // to have reached SQL under the LID the group addresses him by.
    const keys = bridgeSql.exec("SELECT id FROM auth_keys WHERE type = 'sender-key'").toArray();
    expect(keys.map((k) => String(k.id))).toEqual([expect.stringContaining("199900000000777")]);

    const second = await receive(await write("A2", "I can view on Saturday", false));
    expect(second.messageStubType).toBeUndefined();
    expect(second.message?.conversation).toBe("I can view on Saturday");

    bridgeSql.close();
    memberSql.close();
  });

  it("files a message it cannot decrypt as a visible placeholder, not as an empty message", async () => {
    const { bridgeSql, memberSql, write, receive } = await setUp();

    // His sender key never reached this device: the skmsg alone is unreadable.
    const orphan = await receive(await write("B1", "anyone there?", false));
    expect(orphan.messageStubType).toBe(proto.WebMessageInfo.StubType.CIPHERTEXT);

    const row = toStoredMessage(orphan as any, BRIDGE)!;
    expect(row.content).toBeNull();
    expect(row.sender).toBe(MEMBER_PN);
    expect(row.decryptError).toBeTruthy();

    bridgeSql.close();
    memberSql.close();
  });

  // The failure the bridge's connection model invites. A socket that closes
  // after Baileys has decrypted a stanza but before it has emitted the upsert
  // leaves the ratchet advanced in SQL, the store empty and the stanza unacked.
  // WhatsApp delivers it again — and this is what the next socket makes of it.
  it("cannot read a stanza a second time: a redelivery after a lost upsert is unrecoverable locally", async () => {
    const { bridgeSql, memberSql, write, receive } = await setUp();
    const node = await write("C1", "sent while the bridge was closing", true);

    const once = await receive(node);
    expect(once.message?.conversation).toBe("sent while the bridge was closing");

    const again = await receive(node);
    expect(again.messageStubType).toBe(proto.WebMessageInfo.StubType.CIPHERTEXT);
    expect(again.message?.conversation).toBeUndefined();
    // The skmsg's failure is the one reported, and it is not
    // MISSING_KEYS_ERROR_TEXT — so Baileys sends a retry receipt and upserts
    // the stub, which the bridge files as a placeholder. The content is gone
    // locally all the same; only the sender's resend can bring it back.
    expect(again.messageStubParameters?.[0]).toMatch(/old counter/);
    expect(again.messageStubParameters?.[0]).not.toBe(MISSING_KEYS_ERROR_TEXT);
    expect(toStoredMessage(again as any, BRIDGE)?.decryptError).toMatch(/old counter/);

    bridgeSql.close();
    memberSql.close();
  });

  // The pairwise case is worse, and is the one road in Baileys that leaves no
  // trace at all: libsignal words a spent message key as
  // MISSING_KEYS_ERROR_TEXT, and handleMessage (Socket/messages-recv.js) answers
  // exactly that text with a NACK and a bare `return` — no retry receipt, no
  // upsert, nothing for the bridge to file. A one-to-one message cut off between
  // decrypt and upsert is therefore lost without a row to say so, which is why
  // the socket must not close while one is in flight.
  it("a redelivered one-to-one message fails with the one error Baileys drops silently", async () => {
    const { bridgeSql, memberSql, writeDirect, receive } = await setUp();
    const node = await writeDirect("D1", "ok, 2pm works");

    expect((await receive(node)).message?.conversation).toBe("ok, 2pm works");

    const again = await receive(node);
    expect(again.messageStubType).toBe(proto.WebMessageInfo.StubType.CIPHERTEXT);
    expect(again.messageStubParameters?.[0]).toBe(MISSING_KEYS_ERROR_TEXT);

    bridgeSql.close();
    memberSql.close();
  });
});
