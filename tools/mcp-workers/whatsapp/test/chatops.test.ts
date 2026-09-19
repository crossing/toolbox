// Archive, delete-chat and revoke against a fake socket and the real store.
// The invariant under test throughout: WhatsApp is asked first, the flag is
// written only if it said yes, and no row is ever removed.

import { beforeEach, describe, expect, it } from "vitest";
import {
  archiveChatOnSocket,
  checkRevocable,
  deleteChatOnSocket,
  messageRangeFor,
  REVOKE_WINDOW_MS,
  revokeMessageOnSocket,
  type ChatOpsSocket,
} from "../src/chatops";
import { Store } from "../src/store";
import { makeFakeSql } from "./sqlfake";

const ME = "447700900000:3@s.whatsapp.net";
const ME_BARE = "447700900000@s.whatsapp.net";
const ADA = "447700900111@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const TOM_LID = "199900000000777@lid";
const TOM = "447700900222@s.whatsapp.net";

const NOW = new Date("2026-09-19T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
const seconds = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

function fakeSocket(fail?: Error) {
  const modified: { mod: Record<string, unknown>; jid: string }[] = [];
  const sent: { jid: string; content: unknown }[] = [];
  const sock: ChatOpsSocket = {
    async chatModify(mod, jid) {
      if (fail) throw fail;
      modified.push({ mod: mod as Record<string, unknown>, jid });
    },
    async sendMessage(jid, content) {
      if (fail) throw fail;
      sent.push({ jid, content });
      return { key: { id: "REVOKE-STANZA" } };
    },
  };
  return { sock, modified, sent };
}

describe("chat lifecycle operations", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(makeFakeSql());
    store.upsertChat({ jid: ADA, name: "Ada", lastMessageTime: at(10) });
    store.upsertChat({ jid: GROUP, name: "Roof repair", lastMessageTime: at(5) });
    store.upsertMessage({ id: "A1", chatJid: ADA, sender: ADA, content: "hello", timestamp: at(30), isFromMe: false });
    store.upsertMessage({ id: "A2", chatJid: ADA, sender: ME_BARE, content: "hi Ada", timestamp: at(10), isFromMe: true });
    store.upsertMessage({ id: "G1", chatJid: GROUP, sender: ME_BARE, content: "welcome", timestamp: at(20), isFromMe: true });
    store.upsertMessage({
      id: "G2", chatJid: GROUP, sender: TOM, senderName: "Tom", content: "thanks",
      timestamp: at(5), isFromMe: false, participant: TOM_LID,
    });
  });

  describe("messageRangeFor", () => {
    it("names the chat's newest message by key and time", () => {
      expect(messageRangeFor(store, ADA)).toEqual({
        empty: false,
        range: {
          lastMessageTimestamp: seconds(at(10)),
          messages: [{ key: { remoteJid: ADA, fromMe: true, id: "A2" }, timestamp: seconds(at(10)) }],
        },
      });
    });

    it("quotes a group member by the participant WhatsApp addressed them with, not the number they are filed under", () => {
      const { range } = messageRangeFor(store, GROUP);
      expect(range.messages![0]!.key).toEqual({ remoteJid: GROUP, fromMe: false, id: "G2", participant: TOM_LID });
    });

    it("falls back to the sender for a group row stored before the participant column existed", () => {
      store.upsertMessage({ id: "G3", chatJid: GROUP, sender: TOM, content: "old row", timestamp: at(1), isFromMe: false });
      expect(messageRangeFor(store, GROUP).range.messages![0]!.key!.participant).toBe(TOM);
    });

    it("sends an empty range, dated by the chat, for a chat with nothing in it", () => {
      const fresh = "120363000000000009@g.us";
      store.upsertChat({ jid: fresh, name: "Just created", lastMessageTime: at(2) });
      expect(messageRangeFor(store, fresh)).toEqual({
        empty: true,
        range: { lastMessageTimestamp: seconds(at(2)), messages: [] },
      });
    });
  });

  describe("archiveChatOnSocket", () => {
    it("sends the archive patch and only then flags the chat, which stays listed", async () => {
      const { sock, modified } = fakeSocket();
      const result = await archiveChatOnSocket(sock, store, ADA, true);
      expect(result).toEqual({ ok: true, chatJid: ADA, archived: true });
      expect(modified).toHaveLength(1);
      expect(modified[0]!.jid).toBe(ADA);
      expect(modified[0]!.mod.archive).toBe(true);
      expect(store.getChat(ADA)?.archived).toBe(true);
      expect(store.listChats({}).map((c) => c.jid)).toContain(ADA);
    });

    it("unarchives", async () => {
      store.setArchived(ADA, true);
      const { sock, modified } = fakeSocket();
      expect((await archiveChatOnSocket(sock, store, ADA, false)).archived).toBe(false);
      expect(modified[0]!.mod.archive).toBe(false);
      expect(store.getChat(ADA)?.archived).toBe(false);
    });

    it("says when it archived a chat with no messages", async () => {
      const fresh = "120363000000000009@g.us";
      store.upsertChat({ jid: fresh, name: "Just created", lastMessageTime: at(2) });
      const { sock } = fakeSocket();
      expect(await archiveChatOnSocket(sock, store, fresh, true)).toMatchObject({ ok: true, emptyChat: true });
    });

    it("leaves the flag alone when WhatsApp refuses the patch", async () => {
      const { sock } = fakeSocket(new Error("App state key not present!"));
      await expect(archiveChatOnSocket(sock, store, ADA, true)).rejects.toThrow("App state key not present!");
      expect(store.getChat(ADA)?.archived).toBe(false);
    });
  });

  describe("deleteChatOnSocket", () => {
    it("deletes on WhatsApp, flags the chat, and keeps every stored message", async () => {
      const { sock, modified } = fakeSocket();
      const result = await deleteChatOnSocket(sock, store, GROUP, () => NOW);
      expect(result).toEqual({ ok: true, chatJid: GROUP, deletedAt: NOW.toISOString(), messagesKept: 2 });
      expect(modified[0]!.mod.delete).toBe(true);
      expect(store.getChat(GROUP)?.deletedAt).toBe(NOW.toISOString());
      expect(store.listChats({}).map((c) => c.jid)).toContain(GROUP);
      expect(store.listMessages({ chatJid: GROUP }).map((m) => m.content)).toEqual(["thanks", "welcome"]);
    });

    it("flags nothing when WhatsApp refuses", async () => {
      const { sock } = fakeSocket(new Error("conflict"));
      await expect(deleteChatOnSocket(sock, store, GROUP, () => NOW)).rejects.toThrow("conflict");
      expect(store.getChat(GROUP)?.deletedAt).toBeNull();
    });
  });

  describe("revoke", () => {
    it("refuses someone else's message, clearly", () => {
      expect(() => checkRevocable(store, ADA, "A1", NOW.getTime())).toThrow(/written by someone else/);
    });

    it("refuses a message the store does not hold", () => {
      expect(() => checkRevocable(store, ADA, "NOPE", NOW.getTime())).toThrow(/no message NOPE/);
    });

    it("refuses a message too old for WhatsApp to honour, instead of reporting a delete that changed nothing", () => {
      const late = NOW.getTime() + REVOKE_WINDOW_MS;
      expect(() => checkRevocable(store, ADA, "A2", late)).toThrow(/about two days/);
    });

    it("sends the delete for our own message and flags the row without touching its content", async () => {
      const { sock, sent } = fakeSocket();
      const result = await revokeMessageOnSocket(sock, store, ADA, "A2", ME, () => NOW);
      expect(result).toEqual({ ok: true, chatJid: ADA, messageId: "A2", revokedAt: NOW.toISOString() });
      expect(sent).toEqual([{ jid: ADA, content: { delete: { remoteJid: ADA, fromMe: true, id: "A2" } } }]);
      const row = store.listMessages({ chatJid: ADA }).find((m) => m.id === "A2")!;
      expect(row).toMatchObject({ revoked: true, revokedAt: NOW.toISOString(), content: "hi Ada" });
    });

    it("names this account as participant when the message is in a group", async () => {
      const { sock, sent } = fakeSocket();
      await revokeMessageOnSocket(sock, store, GROUP, "G1", ME, () => NOW);
      expect(sent[0]!.content).toEqual({ delete: { remoteJid: GROUP, fromMe: true, id: "G1", participant: ME_BARE } });
    });

    it("refuses a second revoke of the same message", async () => {
      const { sock, sent } = fakeSocket();
      await revokeMessageOnSocket(sock, store, ADA, "A2", ME, () => NOW);
      await expect(revokeMessageOnSocket(sock, store, ADA, "A2", ME, () => NOW)).rejects.toThrow(/already deleted/);
      expect(sent).toHaveLength(1);
    });

    it("does not flag the row when the send fails", async () => {
      const { sock } = fakeSocket(new Error("connection closed"));
      await expect(revokeMessageOnSocket(sock, store, ADA, "A2", ME, () => NOW)).rejects.toThrow("connection closed");
      expect(store.listMessages({ chatJid: ADA }).find((m) => m.id === "A2")?.revoked).toBe(false);
    });
  });
});
