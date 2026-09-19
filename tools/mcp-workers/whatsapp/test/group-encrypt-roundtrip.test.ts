// The group send path, driven against the real signal store.
//
// A send to a …@g.us JID takes a different road through Baileys from a 1:1
// send (Socket/messages-send.js): the message is encrypted once with a *sender
// key* (`signalRepository.encryptGroupMessage`), the sender key itself is
// fanned out to each member device over ordinary pairwise sessions, and which
// devices already hold it is remembered under `sender-key-memory`. The pairwise
// half is covered by encrypt-roundtrip.test.ts. What is specific to groups is
// two more key types living in `src/auth.ts`'s SQL store — `sender-key` (a
// Buffer of JSON) and `sender-key-memory` (a plain map) — and, because the
// bridge opens a fresh socket per operation, both are always read back from
// SQL by a socket that did not write them. If either revived as the wrong type,
// the second message to any group would fail, or re-send the key every time.

import { describe, expect, it } from "vitest";
import { addTransactionCapability, proto } from "baileys";
import { makeLibSignalRepository } from "baileys/lib/Signal/libsignal.js";
import { makeSqlAuthState } from "../src/auth";
import "../src/protobuf-workerd-fix";
import { makeFakeSql } from "./sqlfake";

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

const GROUP = "120363000000000001@g.us";
const US = "447700900000:5@s.whatsapp.net";

describe("group send over a revived store", () => {
  it("encrypts with a sender key written by a previous socket, and a member can read both messages", async () => {
    const usSql = makeFakeSql();
    const memberSql = makeFakeSql();
    const member = repoOver(makeSqlAuthState(memberSql).state);

    // The plaintext is what relayMessage encrypts: an encoded WAMessage, with
    // the multi-byte characters the workerd protobuf fix exists for.
    const encode = (text: string) => proto.Message.encode({ conversation: text }).finish();

    // Socket #1: first send to the group mints the sender key.
    const first = await repoOver(makeSqlAuthState(usSql).state).encryptGroupMessage({
      group: GROUP,
      meId: US,
      data: encode("Roof repair — quote is £1,240"),
    });
    expect(first.senderKeyDistributionMessage.length).toBeGreaterThan(0);

    // The member learns the key from the distribution message, as it would
    // from the pairwise-encrypted fan-out.
    await member.processSenderKeyDistributionMessage({
      authorJid: US,
      item: { groupId: GROUP, axolotlSenderKeyDistributionMessage: first.senderKeyDistributionMessage },
    });
    const plain1 = await member.decryptGroupMessage({ group: GROUP, authorJid: US, msg: first.ciphertext });
    expect(proto.Message.decode(plain1).conversation).toBe("Roof repair — quote is £1,240");

    // Socket #2: a brand-new auth state over the same SQL. The sender key must
    // come back usable and *advanced* — the member decrypts without being sent
    // the key again, which only works if the chain continued where it left off.
    const second = await repoOver(makeSqlAuthState(usSql).state).encryptGroupMessage({
      group: GROUP,
      meId: US,
      data: encode("second message, after a reload"),
    });
    const plain2 = await member.decryptGroupMessage({ group: GROUP, authorJid: US, msg: second.ciphertext });
    expect(proto.Message.decode(plain2).conversation).toBe("second message, after a reload");

    usSql.close();
    memberSql.close();
  });

  it("round-trips sender-key-memory, so known devices are not re-sent the key on every send", async () => {
    const sql = makeFakeSql();
    const memory = { "447700900111:0@s.whatsapp.net": true, "199900000000001:3@lid": true };
    await makeSqlAuthState(sql).state.keys.set({ "sender-key-memory": { [GROUP]: memory } });

    const revived = await makeSqlAuthState(sql).state.keys.get("sender-key-memory", [GROUP]);
    expect(revived[GROUP]).toEqual(memory);
    sql.close();
  });
});
