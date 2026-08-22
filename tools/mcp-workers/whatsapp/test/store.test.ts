import { beforeEach, describe, expect, it } from "vitest";
import { normalizeJid, phoneOf, phoneOrJidToPhone, Store, toStoredTimestamp } from "../src/store";
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

describe("inputs that arrive in more than one shape", () => {
  let sql: FakeSql;
  let store: Store;

  beforeEach(() => {
    sql = makeFakeSql();
    store = new Store(sql);
    store.upsertChat({ jid: ADA, name: "Ada", lastMessageTime: at(5) });
    // What the importer produces from the Go bridge: a bare user part.
    store.upsertMessage({
      id: "I1", chatJid: "447700900111", sender: "447700900111",
      content: "imported", timestamp: at(4), isFromMe: false,
    });
  });

  it("canonicalises an imported bare sender so sender queries still match", () => {
    expect(store.listMessages({ senderPhoneNumber: "447700900111" }).map((m) => m.id)).toEqual(["I1"]);
    expect(store.listMessages({ chatJid: ADA }).map((m) => m.id)).toEqual(["I1"]);
    expect(store.searchContacts("447700900111").map((c) => c.jid)).toEqual([ADA]);
  });

  it("accepts a JID where a phone number is asked for", () => {
    expect(store.getDirectChatByContact(ADA)?.name).toBe("Ada");
    expect(store.getDirectChatByContact("447700900111:3@s.whatsapp.net")?.name).toBe("Ada");
    expect(store.listMessages({ senderPhoneNumber: ADA }).map((m) => m.id)).toEqual(["I1"]);
    expect(phoneOrJidToPhone(" +44 7700 900111 ")).toBe("447700900111");
  });

  it("normalises timestamp bounds to UTC instead of comparing them lexically", () => {
    // at(4) is 12:04Z. An hour-ahead local time for 13:04+01:00 is the same
    // instant, and must not exclude the row.
    expect(store.listMessages({ after: "2026-08-20T13:03:00+01:00" }).map((m) => m.id)).toEqual(["I1"]);
    expect(store.listMessages({ after: "2026-08-20T13:05:00+01:00" })).toEqual([]);
    expect(() => store.listMessages({ after: "not a date" })).toThrow(/ISO-8601/);
    expect(toStoredTimestamp("2026-08-20")).toBe("2026-08-20T00:00:00.000Z");
  });

  it("treats LIKE metacharacters as text, not wildcards", () => {
    store.upsertChat({ jid: "44100@s.whatsapp.net", name: "100% Cotton" });
    store.upsertChat({ jid: "44101@s.whatsapp.net", name: "100 Cotton" });
    expect(store.listChats({ query: "100%" }).map((c) => c.name)).toEqual(["100% Cotton"]);
    expect(store.searchContacts("100%").map((c) => c.name)).toEqual(["100% Cotton"]);
    store.upsertMessage({ id: "P1", chatJid: ADA, sender: ADA, content: "50% off", timestamp: at(6), isFromMe: false });
    store.upsertMessage({ id: "P2", chatJid: ADA, sender: ADA, content: "50p off", timestamp: at(7), isFromMe: false });
    expect(store.listMessages({ query: "50%" }).map((m) => m.id)).toEqual(["P1"]);
  });

  it("returns one row per contact even when pushNames differ", () => {
    store.upsertMessage({ id: "N1", chatJid: ADA, sender: ADA, senderName: "Ada L", content: "x", timestamp: at(8), isFromMe: false });
    store.upsertMessage({ id: "N2", chatJid: ADA, sender: ADA, senderName: "Ada Lovelace", content: "y", timestamp: at(9), isFromMe: false });
    expect(store.searchContacts("Ada").map((c) => c.jid)).toEqual([ADA]);
  });

  it("caps contact search the way the ported tool did", () => {
    for (let i = 0; i < 60; i++) {
      store.upsertChat({ jid: `4477009${String(i).padStart(5, "0")}@s.whatsapp.net`, name: `Person ${i}` });
    }
    expect(store.searchContacts("Person").length).toBe(50);
    expect(store.searchContacts("Person", 10).length).toBe(10);
    expect(store.searchContacts("Person", 10, 1)[0]!.name).not.toBe(store.searchContacts("Person", 10)[0]!.name);
  });

  it("keeps same-second neighbours in message context", () => {
    const t = at(20);
    for (const id of ["C1", "C2", "C3"]) {
      store.upsertMessage({ id, chatJid: ADA, sender: ADA, content: id, timestamp: t, isFromMe: false });
    }
    const context = store.getMessageContext("C2");
    // Strict < / > on the timestamp alone would drop both neighbours.
    expect(context.before.map((m) => m.id).at(-1)).toBe("C1");
    expect(context.after.map((m) => m.id)).toEqual(["C3"]);
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
