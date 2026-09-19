// Group creation against recorded-shape stanzas and a fake socket. Nothing here
// opens a connection: the reply shapes are taken from Baileys' own parser
// (Socket/groups.js extractGroupMetadata) and from the per-participant `error`
// attribute groupParticipantsUpdate reads, not from a live capture.

import { describe, expect, it } from "vitest";
import type { BinaryNode } from "baileys";
import {
  createGroupOnSocket,
  groupCreateNode,
  MAX_GROUP_PARTICIPANTS,
  parseGroupCreateResult,
  prepareGroupRequest,
  type GroupSocket,
} from "../src/groups";
import { Store } from "../src/store";
import { makeFakeSql } from "./sqlfake";

const ME = "447700900000:12@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";

function participant(attrs: Record<string, string>, content?: BinaryNode[]): BinaryNode {
  return { tag: "participant", attrs, content };
}

function reply(participants: BinaryNode[], attrs: Record<string, string> = {}): BinaryNode {
  return {
    tag: "iq",
    attrs: { type: "result", from: "@g.us" },
    content: [
      {
        tag: "group",
        attrs: { id: "120363000000000001", subject: "Roof repair", creation: "1789000000", ...attrs },
        content: participants,
      },
    ],
  };
}

function fakeSocket(result: BinaryNode, invite: string | undefined | Error = "AbCdEfGh") {
  const queries: BinaryNode[] = [];
  const inviteCalls: string[] = [];
  const sock: GroupSocket = {
    async query(node) {
      queries.push(node);
      return result;
    },
    async groupInviteCode(jid) {
      inviteCalls.push(jid);
      if (invite instanceof Error) throw invite;
      return invite;
    },
  };
  return { sock, queries, inviteCalls };
}

describe("prepareGroupRequest", () => {
  it("turns bare international digits into user JIDs, the way the send path does", () => {
    const request = prepareGroupRequest("  Roof   repair ", ["447700900111", "+44 7700 900222"], ME);
    expect(request.subject).toBe("Roof repair");
    expect(request.participants).toEqual([
      { requested: "447700900111", jid: "447700900111@s.whatsapp.net" },
      { requested: "+44 7700 900222", jid: "447700900222@s.whatsapp.net" },
    ]);
  });

  it("accepts JIDs, drops the device suffix, and keeps a LID as a LID", () => {
    const request = prepareGroupRequest("x", ["447700900111:4@s.whatsapp.net", "199900000000001@lid"], ME);
    expect(request.participants.map((p) => p.jid)).toEqual([
      "447700900111@s.whatsapp.net",
      "199900000000001@lid",
    ]);
  });

  it("drops duplicates and this account itself", () => {
    const request = prepareGroupRequest("x", ["447700900111", "447700900111@s.whatsapp.net", "447700900000"], ME);
    expect(request.participants.map((p) => p.jid)).toEqual(["447700900111@s.whatsapp.net"]);
  });

  it("refuses a national-format number instead of adding whoever owns it abroad", () => {
    expect(() => prepareGroupRequest("x", ["07700 900111"], ME)).toThrow(/international format/);
    expect(() => prepareGroupRequest("x", ["+44 (0)7700 900111"], ME)).toThrow(/international format/);
  });

  it("refuses a group or broadcast JID as a member", () => {
    expect(() => prepareGroupRequest("x", ["120363000000000000@g.us"], ME)).toThrow(/not a person/);
    expect(() => prepareGroupRequest("x", ["status@broadcast"], ME)).toThrow(/not a person/);
  });

  it("refuses an empty subject, an over-long one, and an empty or oversized member list", () => {
    expect(() => prepareGroupRequest("   ", ["447700900111"], ME)).toThrow(/subject/);
    expect(() => prepareGroupRequest("s".repeat(101), ["447700900111"], ME)).toThrow(/100/);
    expect(() => prepareGroupRequest("x", [], ME)).toThrow(/at least one participant/);
    expect(() => prepareGroupRequest("x", ["447700900000"], ME)).toThrow(/at least one participant/);
    const many = Array.from({ length: MAX_GROUP_PARTICIPANTS + 1 }, (_, i) => `4477009${String(i + 1).padStart(5, "0")}`);
    expect(() => prepareGroupRequest("x", many, ME)).toThrow(/limit/);
  });

  it("rejects something that is neither a JID nor a number", () => {
    expect(() => prepareGroupRequest("x", ["Ada"], ME)).toThrow(/not a chat JID/);
  });
});

describe("groupCreateNode", () => {
  it("builds the stanza Baileys' own groupCreate sends", () => {
    expect(groupCreateNode("Roof repair", ["447700900111@s.whatsapp.net"], "KEY1")).toEqual({
      tag: "iq",
      attrs: { type: "set", xmlns: "w:g2", to: "@g.us" },
      content: [
        {
          tag: "create",
          attrs: { subject: "Roof repair", key: "KEY1" },
          content: [{ tag: "participant", attrs: { jid: "447700900111@s.whatsapp.net" } }],
        },
      ],
    });
  });
});

describe("parseGroupCreateResult", () => {
  const request = prepareGroupRequest("Roof repair", ["447700900111", "447700900222", "447700900333"], ME);

  it("reports each participant: added, invite required on 403, failed otherwise", () => {
    const parsed = parseGroupCreateResult(
      reply([
        participant({ jid: "447700900000@s.whatsapp.net", type: "superadmin" }),
        participant({ jid: "447700900111@s.whatsapp.net" }),
        participant({ jid: "447700900222@s.whatsapp.net", error: "403" }, [
          { tag: "add_request", attrs: { code: "SECRETCODE", expiration: "1789600000" } },
        ]),
        participant({ jid: "447700900333@s.whatsapp.net", error: "404" }),
      ]),
      request,
    );
    expect(parsed.groupJid).toBe(GROUP);
    expect(parsed.subject).toBe("Roof repair");
    expect(parsed.creation).toBe(1789000000);
    expect(parsed.participants).toEqual([
      { requested: "447700900111", jid: "447700900111@s.whatsapp.net", status: "added", code: 200 },
      {
        requested: "447700900222",
        jid: "447700900222@s.whatsapp.net",
        status: "invite_required",
        code: 403,
        detail: expect.stringContaining("invite link"),
      },
      {
        requested: "447700900333",
        jid: "447700900333@s.whatsapp.net",
        status: "failed",
        code: 404,
        detail: expect.stringContaining("404"),
      },
    ]);
    // The per-person add_request code is a join credential nobody here can use.
    expect(JSON.stringify(parsed)).not.toContain("SECRETCODE");
  });

  it("matches a LID-addressed reply back to the number that was asked for", () => {
    const parsed = parseGroupCreateResult(
      reply(
        [
          participant({ jid: "199900000000001@lid", phone_number: "447700900111@s.whatsapp.net" }),
          participant({ jid: "199900000000002@lid", phone_number: "447700900222@s.whatsapp.net", error: "403" }),
        ],
        { addressing_mode: "lid" },
      ),
      request,
    );
    expect(parsed.participants.map((p) => p.status)).toEqual(["added", "invite_required", "unknown"]);
    expect(parsed.participants[2]!.code).toBeNull();
  });

  it("keeps a fully-qualified group id as it came", () => {
    const parsed = parseGroupCreateResult(reply([], { id: GROUP }), request);
    expect(parsed.groupJid).toBe(GROUP);
  });

  it("throws rather than invent a group when the reply has none", () => {
    expect(() => parseGroupCreateResult({ tag: "iq", attrs: {}, content: [] }, request)).toThrow(/no group/);
    expect(() =>
      parseGroupCreateResult(
        { tag: "iq", attrs: { type: "error" }, content: [{ tag: "error", attrs: { code: "406", text: "not-acceptable" } }] },
        request,
      ),
    ).toThrow(/406: not-acceptable/);
  });
});

describe("createGroupOnSocket", () => {
  const request = prepareGroupRequest("Roof repair", ["447700900111", "447700900222"], ME);

  it("sends one create and asks for no invite link when everyone was added", async () => {
    const { sock, queries, inviteCalls } = fakeSocket(
      reply([participant({ jid: "447700900111@s.whatsapp.net" }), participant({ jid: "447700900222@s.whatsapp.net" })]),
    );
    const created = await createGroupOnSocket(sock, request, () => "KEY1");
    expect(queries).toEqual([
      groupCreateNode("Roof repair", ["447700900111@s.whatsapp.net", "447700900222@s.whatsapp.net"], "KEY1"),
    ]);
    expect(inviteCalls).toEqual([]);
    expect(created).toMatchObject({ ok: true, groupJid: GROUP, subject: "Roof repair", inviteLink: null });
    expect(created.detail).toBeUndefined();
  });

  it("returns the invite link when a direct add was refused, without failing the call", async () => {
    const { sock, inviteCalls } = fakeSocket(
      reply([
        participant({ jid: "447700900111@s.whatsapp.net" }),
        participant({ jid: "447700900222@s.whatsapp.net", error: "403" }),
      ]),
    );
    const created = await createGroupOnSocket(sock, request);
    expect(inviteCalls).toEqual([GROUP]);
    expect(created.ok).toBe(true);
    expect(created.inviteLink).toBe("https://chat.whatsapp.com/AbCdEfGh");
    expect(created.participants!.map((p) => p.status)).toEqual(["added", "invite_required"]);
  });

  it("still reports the group when the invite link cannot be fetched", async () => {
    const { sock } = fakeSocket(
      reply([participant({ jid: "447700900111@s.whatsapp.net" }), participant({ jid: "447700900222@s.whatsapp.net", error: "403" })]),
      new Error("not-authorized"),
    );
    const created = await createGroupOnSocket(sock, request);
    expect(created).toMatchObject({ ok: true, groupJid: GROUP, inviteLink: null });
    expect(created.detail).toContain("not-authorized");
  });

  it("lets a refused create throw, so the bridge reports ok: false", async () => {
    const { sock } = fakeSocket({ tag: "iq", attrs: {}, content: [{ tag: "error", attrs: { code: "429", text: "rate-overlimit" } }] });
    await expect(createGroupOnSocket(sock, request)).rejects.toThrow(/429: rate-overlimit/);
  });
});

// What the bridge does with a created group: file it, so the very next
// whatsapp_list_chats shows it and a send to the JID has a chat row to update.
describe("a created group in the chat store", () => {
  it("lists first, by name, and survives the nameless upsert a later send makes", () => {
    const store = new Store(makeFakeSql());
    store.upsertChat({ jid: "447700900111@s.whatsapp.net", name: "Ada", lastMessageTime: "2026-09-01T10:00:00.000Z" });
    store.upsertChat({ jid: GROUP, name: "Roof repair", lastMessageTime: "2026-09-19T09:00:00.000Z" });
    expect(store.listChats({})[0]).toEqual({
      jid: GROUP,
      name: "Roof repair",
      lastMessageTime: "2026-09-19T09:00:00.000Z",
    });
    expect(store.listChats({ query: "roof" }).map((c) => c.jid)).toEqual([GROUP]);
    // sendMessage upserts { jid, lastMessageTime } with no name.
    store.upsertChat({ jid: GROUP, lastMessageTime: "2026-09-19T09:05:00.000Z" });
    expect(store.getChat(GROUP)).toEqual({ jid: GROUP, name: "Roof repair", lastMessageTime: "2026-09-19T09:05:00.000Z" });
  });
});
