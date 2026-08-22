import { beforeEach, describe, expect, it } from "vitest";
import { normalizeJid, phoneOf, Store } from "../src/store";
import { makeFakeSql, type FakeSql } from "./sqlfake";

const ADA = "447700900111@s.whatsapp.net";
const BOB = "447700900222@s.whatsapp.net";
const GROUP = "120363000000000000@g.us";
const ME = "447700900000@s.whatsapp.net";

function at(minute: number): string {
  return new Date(Date.UTC(2026, 7, 20, 12, minute, 0)).toISOString();
}

describe("Store", () => {
  let sql: FakeSql;
  let store: Store;

  beforeEach(() => {
    sql = makeFakeSql();
    store = new Store(sql);
    store.upsertChat({ jid: ADA, name: "Ada", lastMessageTime: at(5) });
    store.upsertChat({ jid: BOB, name: "Bob", lastMessageTime: at(3) });
    store.upsertChat({ jid: GROUP, name: "Book club", lastMessageTime: at(9) });
    store.upsertMessage({
      id: "M1", chatJid: ADA, sender: ADA, senderName: "Ada",
      content: "morning", timestamp: at(1), isFromMe: false,
    });
    store.upsertMessage({
      id: "M2", chatJid: ADA, sender: ME, content: "morning yourself",
      timestamp: at(2), isFromMe: true,
    });
    store.upsertMessage({
      id: "M3", chatJid: ADA, sender: ADA, senderName: "Ada",
      content: "lunch?", timestamp: at(5), isFromMe: false,
    });
    store.upsertMessage({
      id: "M4", chatJid: BOB, sender: BOB, senderName: "Bob",
      content: "invoice attached", timestamp: at(3), isFromMe: false,
      mediaType: "document", filename: "invoice.pdf", mimeType: "application/pdf",
      directPath: "/v/t62/inv", mediaKeyB64: "a2V5", fileLength: 2048,
    });
    store.upsertMessage({
      id: "M5", chatJid: GROUP, sender: BOB, senderName: "Bob",
      content: "see you all there", timestamp: at(9), isFromMe: false,
    });
  });

  it("counts what it holds", () => {
    expect(store.counts()).toEqual({ chats: 3, messages: 5 });
  });

  it("lists chats by recency, then pages", () => {
    expect(store.listChats({}).map((c) => c.name)).toEqual(["Book club", "Ada", "Bob"]);
    expect(store.listChats({ limit: 1, page: 1 }).map((c) => c.name)).toEqual(["Ada"]);
    expect(store.listChats({ sortBy: "name" }).map((c) => c.name)).toEqual(["Ada", "Bob", "Book club"]);
  });

  it("filters chats by name or jid", () => {
    expect(store.listChats({ query: "boo" }).map((c) => c.name)).toEqual(["Book club"]);
    expect(store.listChats({ query: "900222" }).map((c) => c.name)).toEqual(["Bob"]);
  });

  it("lists messages newest first and filters", () => {
    expect(store.listMessages({}).map((m) => m.id)).toEqual(["M5", "M3", "M4", "M2", "M1"]);
    expect(store.listMessages({ chatJid: ADA }).map((m) => m.id)).toEqual(["M3", "M2", "M1"]);
    expect(store.listMessages({ query: "lunch" }).map((m) => m.id)).toEqual(["M3"]);
    expect(store.listMessages({ senderPhoneNumber: "447700900222" }).map((m) => m.id)).toEqual(["M5", "M4"]);
    expect(store.listMessages({ after: at(4) }).map((m) => m.id)).toEqual(["M5", "M3"]);
    expect(store.listMessages({ before: at(2) }).map((m) => m.id)).toEqual(["M1"]);
  });

  it("joins the chat name onto messages", () => {
    const [newest] = store.listMessages({ limit: 1 });
    expect(newest).toMatchObject({ chatName: "Book club", senderName: "Bob", isFromMe: false });
  });

  it("finds the direct chat for a phone number, never a group", () => {
    expect(store.getDirectChatByContact("447700900111")?.name).toBe("Ada");
    expect(store.getDirectChatByContact("120363000000000000")).toBeNull();
  });

  it("searches contacts by name and number, excluding groups", () => {
    expect(store.searchContacts("Ada").map((c) => c.jid)).toEqual([ADA]);
    expect(store.searchContacts("900222").map((c) => c.phoneNumber)).toEqual(["447700900222"]);
    expect(store.searchContacts("Book club")).toEqual([]);
  });

  it("lists every chat a contact appears in, groups included", () => {
    expect(store.getContactChats(BOB).map((c) => c.name).sort()).toEqual(["Bob", "Book club"]);
  });

  it("returns the last interaction across direct and group chats", () => {
    expect(store.getLastInteraction(ADA)?.id).toBe("M3");
    expect(store.getLastInteraction(BOB)?.id).toBe("M5");
    expect(store.getLastInteraction("447700900999@s.whatsapp.net")).toBeNull();
  });

  it("builds message context in reading order", () => {
    const context = store.getMessageContext("M2", 5, 5);
    expect(context.message?.id).toBe("M2");
    expect(context.before.map((m) => m.id)).toEqual(["M1"]);
    expect(context.after.map((m) => m.id)).toEqual(["M3"]);
    expect(store.getMessageContext("nope").message).toBeNull();
  });

  it("keeps media descriptors for the download path", () => {
    expect(store.mediaFor("M4", BOB)).toMatchObject({
      mediaType: "document",
      filename: "invoice.pdf",
      directPath: "/v/t62/inv",
      mediaKeyB64: "a2V5",
      fileLength: 2048,
    });
    expect(store.mediaFor("M1", ADA)?.mediaType).toBeNull();
    expect(store.mediaFor("missing", ADA)).toBeNull();
  });

  it("never erases a known chat name or moves activity backwards", () => {
    store.upsertChat({ jid: ADA, name: null, lastMessageTime: at(1) });
    expect(store.getChat(ADA)).toMatchObject({ name: "Ada", lastMessageTime: at(5) });
    store.upsertChat({ jid: ADA, name: "Ada L", lastMessageTime: at(30) });
    expect(store.getChat(ADA)).toMatchObject({ name: "Ada L", lastMessageTime: at(30) });
  });

  it("upserts a message without losing what a later event omits", () => {
    store.upsertMessage({
      id: "M4", chatJid: BOB, sender: BOB, content: null, timestamp: at(3), isFromMe: false,
    });
    const media = store.mediaFor("M4", BOB);
    expect(media?.filename).toBe("invoice.pdf");
    expect(store.listMessages({ chatJid: BOB })[0]?.content).toBe("invoice attached");
  });

  it("caps runaway limits", () => {
    expect(store.listMessages({ limit: 9999 }).length).toBe(5);
    expect(() => store.listChats({ limit: -5 })).not.toThrow();
  });
});

describe("jid helpers", () => {
  it("drops the device suffix but keeps the server", () => {
    expect(normalizeJid("447700900111:12@s.whatsapp.net")).toBe(ADA);
    expect(normalizeJid("120363000000000000@g.us")).toBe(GROUP);
    expect(normalizeJid("447700900111")).toBe(ADA);
  });

  it("extracts the phone part", () => {
    expect(phoneOf("447700900111:3@s.whatsapp.net")).toBe("447700900111");
  });
});
