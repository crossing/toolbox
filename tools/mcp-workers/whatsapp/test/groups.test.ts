// Group creation against recorded-shape stanzas and a fake socket. Nothing here
// opens a connection: the reply shapes are taken from Baileys' own parser
// (Socket/groups.js extractGroupMetadata) and from the per-participant `error`
// attribute groupParticipantsUpdate reads, not from a live capture.

import { describe, expect, it } from "vitest";
import type { BinaryNode } from "baileys";
import {
  createGroupOnSocket,
  groupCreateNode,
  groupInfoOnSocket,
  isMember,
  leaveGroupOnSocket,
  leaveNode,
  MAX_GROUP_PARTICIPANTS,
  parseGroupCreateResult,
  participantsUpdateNode,
  prepareGroupRequest,
  prepareParticipants,
  requireGroupJid,
  updateParticipantsOnSocket,
  type GroupMetadataLike,
  type GroupSocket,
} from "../src/groups";
import { Store } from "../src/store";
import { makeFakeSql } from "./sqlfake";

const ME = "447700900000:12@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
/** A chat nothing has happened to. */
const NO_FLAGS = { archived: false, leftAt: null, deletedAt: null };

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
      ...NO_FLAGS,
    });
    expect(store.listChats({ query: "roof" }).map((c) => c.jid)).toEqual([GROUP]);
    // sendMessage upserts { jid, lastMessageTime } with no name.
    store.upsertChat({ jid: GROUP, lastMessageTime: "2026-09-19T09:05:00.000Z" });
    expect(store.getChat(GROUP)).toEqual({
      jid: GROUP,
      name: "Roof repair",
      lastMessageTime: "2026-09-19T09:05:00.000Z",
      ...NO_FLAGS,
    });
  });
});

// --- after creation ----------------------------------------------------------

describe("requireGroupJid", () => {
  it("takes a group JID and nothing else", () => {
    expect(requireGroupJid(` ${GROUP} `)).toBe(GROUP);
    expect(requireGroupJid("447700900000-1600000000@g.us")).toBe("447700900000-1600000000@g.us");
    for (const wrong of ["447700900111", "447700900111@s.whatsapp.net", "199900000000001@lid", "", "@g.us"]) {
      expect(() => requireGroupJid(wrong), wrong).toThrow(/not a group JID/);
    }
  });
});

describe("prepareParticipants for an update", () => {
  it("applies the same national-format refusal and cap as create", () => {
    expect(() => prepareParticipants(["07700 900111"], ME, "refuse")).toThrow(/national-format 0/);
    const tooMany = Array.from({ length: MAX_GROUP_PARTICIPANTS + 1 }, (_, i) => `4477009${String(i + 100).padStart(5, "0")}`);
    expect(() => prepareParticipants(tooMany, ME, "refuse")).toThrow(/over this tool's limit/);
  });

  it("refuses this account itself instead of quietly dropping it", () => {
    expect(() => prepareParticipants(["447700900000"], ME, "refuse")).toThrow(/whatsapp_leave_group/);
    // …which is exactly what create does do, and must keep doing.
    expect(prepareParticipants(["447700900000", "447700900111"], ME, "skip").map((p) => p.jid)).toEqual([
      "447700900111@s.whatsapp.net",
    ]);
  });
});

describe("updateParticipantsOnSocket", () => {
  function updateReply(action: string, participants: BinaryNode[]): BinaryNode {
    return { tag: "iq", attrs: { type: "result", from: GROUP }, content: [{ tag: action, attrs: {}, content: participants }] };
  }

  it("sends the stanza Baileys' groupParticipantsUpdate sends", () => {
    expect(participantsUpdateNode(GROUP, "remove", ["447700900111@s.whatsapp.net"])).toEqual({
      tag: "iq",
      attrs: { type: "set", xmlns: "w:g2", to: GROUP },
      content: [{ tag: "remove", attrs: {}, content: [{ tag: "participant", attrs: { jid: "447700900111@s.whatsapp.net" } }] }],
    });
  });

  it("reports an add per participant, with invite_required and the link for a 403 — the vocabulary create uses", async () => {
    const wanted = prepareParticipants(["447700900111", "447700900222", "447700900333"], ME, "refuse");
    const { sock, queries, inviteCalls } = fakeSocket(
      updateReply("add", [
        // LID-addressed reply: the number we asked for is in phone_number.
        participant({ jid: "199900000000001@lid", phone_number: "447700900111@s.whatsapp.net" }),
        participant({ jid: "447700900222@s.whatsapp.net", error: "403" }, [
          { tag: "add_request", attrs: { code: "SECRET-PER-PERSON-CODE", expiration: "1789999999" } },
        ]),
        participant({ jid: "447700900333@s.whatsapp.net", error: "409" }),
      ]),
    );
    const result = await updateParticipantsOnSocket(sock, GROUP, "add", wanted);
    expect(queries[0]!.content).toEqual([expect.objectContaining({ tag: "add" })]);
    expect(result.participants).toEqual([
      { requested: "447700900111", jid: "447700900111@s.whatsapp.net", status: "added", code: 200 },
      expect.objectContaining({ requested: "447700900222", status: "invite_required", code: 403 }),
      expect.objectContaining({ requested: "447700900333", status: "failed", code: 409, detail: expect.stringMatching(/already a member/) }),
    ]);
    expect(result).toMatchObject({ ok: true, groupJid: GROUP, action: "add", inviteLink: "https://chat.whatsapp.com/AbCdEfGh" });
    expect(inviteCalls).toEqual([GROUP]);
    expect(JSON.stringify(result)).not.toContain("SECRET-PER-PERSON-CODE");
  });

  it.each([
    ["remove", "removed"],
    ["promote", "promoted"],
    ["demote", "demoted"],
  ] as const)("reports %s as %s, a refusal as failed, and never fetches an invite link", async (action, status) => {
    const wanted = prepareParticipants(["447700900111", "447700900222"], ME, "refuse");
    const { sock, inviteCalls } = fakeSocket(
      updateReply(action, [
        participant({ jid: "447700900111@s.whatsapp.net" }),
        participant({ jid: "447700900222@s.whatsapp.net", error: "404" }),
      ]),
    );
    const result = await updateParticipantsOnSocket(sock, GROUP, action, wanted);
    expect(result.participants).toEqual([
      { requested: "447700900111", jid: "447700900111@s.whatsapp.net", status, code: 200 },
      expect.objectContaining({ status: "failed", code: 404, detail: expect.stringMatching(/not a member/) }),
    ]);
    // A 403 on anything but an add is a refusal, not an invitation to invite.
    expect(result.inviteLink).toBeNull();
    expect(inviteCalls).toEqual([]);
  });

  it("says unknown, not success, for a participant the reply leaves out", async () => {
    const wanted = prepareParticipants(["447700900111"], ME, "refuse");
    const { sock } = fakeSocket(updateReply("remove", []));
    const result = await updateParticipantsOnSocket(sock, GROUP, "remove", wanted);
    expect(result.participants![0]).toMatchObject({ status: "unknown", code: null });
  });
});

describe("leaveGroupOnSocket", () => {
  const leaveReply = (attrs: Record<string, string>): BinaryNode => ({
    tag: "iq",
    attrs: { type: "result" },
    content: [{ tag: "leave", attrs: {}, content: [{ tag: "group", attrs }] }],
  });

  it("sends the stanza Baileys' groupLeave sends", async () => {
    const { sock, queries } = fakeSocket(leaveReply({ id: GROUP }));
    await leaveGroupOnSocket(sock, GROUP);
    expect(queries).toEqual([leaveNode(GROUP)]);
    expect(leaveNode(GROUP)).toEqual({
      tag: "iq",
      attrs: { type: "set", xmlns: "w:g2", to: "@g.us" },
      content: [{ tag: "leave", attrs: {}, content: [{ tag: "group", attrs: { id: GROUP } }] }],
    });
  });

  it("reads the per-group error Baileys' helper throws away, so a refused leave is not recorded as done", async () => {
    const { sock } = fakeSocket(leaveReply({ id: GROUP, error: "404" }));
    await expect(leaveGroupOnSocket(sock, GROUP)).rejects.toThrow(/not a member/);
    const other = fakeSocket(leaveReply({ id: GROUP, error: "500" }));
    await expect(leaveGroupOnSocket(other.sock, GROUP)).rejects.toThrow(/refused the leave \(code 500\)/);
  });

  it("accepts a bare acknowledgement", async () => {
    const { sock } = fakeSocket({ tag: "iq", attrs: { type: "result" } });
    await expect(leaveGroupOnSocket(sock, GROUP)).resolves.toBeUndefined();
  });
});

describe("groupInfoOnSocket", () => {
  const META: GroupMetadataLike = {
    id: GROUP,
    subject: "Roof repair",
    desc: "Quotes and dates",
    owner: "199900000000000@lid",
    ownerPn: "447700900000@s.whatsapp.net",
    creation: 1789000000,
    size: 3,
    addressingMode: "lid",
    announce: false,
    restrict: true,
    participants: [
      { id: "199900000000000@lid", phoneNumber: "447700900000@s.whatsapp.net", admin: "superadmin" },
      { id: "199900000000001@lid", phoneNumber: "447700900111@s.whatsapp.net", admin: "admin" },
      // WhatsApp gave no number for this one: the LID is all there is.
      { id: "199900000000777@lid", admin: null },
    ],
  };

  function infoSocket(meta: GroupMetadataLike | Error, invite: string | Error = "AbCdEfGh") {
    const inviteCalls: string[] = [];
    return {
      inviteCalls,
      sock: {
        async groupMetadata() {
          if (meta instanceof Error) throw meta;
          return meta;
        },
        async groupInviteCode(jid: string) {
          inviteCalls.push(jid);
          if (invite instanceof Error) throw invite;
          return invite;
        },
      },
    };
  }

  const names = (jid: string) => ({ "447700900111@s.whatsapp.net": "Ada", "199900000000777@lid": "Tom" })[jid] ?? null;

  it("lists members with number, role and known name, recognises this account by its LID, and includes the link for an admin", async () => {
    const { sock } = infoSocket(META);
    const info = await groupInfoOnSocket(sock, GROUP, { id: ME, lid: "199900000000000:12@lid" }, names);
    expect(info).toMatchObject({
      ok: true,
      groupJid: GROUP,
      subject: "Roof repair",
      description: "Quotes and dates",
      owner: "447700900000@s.whatsapp.net",
      createdAt: new Date(1789000000 * 1000).toISOString(),
      addressingMode: "lid",
      restrict: true,
      iAmAdmin: true,
      admins: ["447700900000@s.whatsapp.net", "447700900111@s.whatsapp.net"],
      inviteLink: "https://chat.whatsapp.com/AbCdEfGh",
    });
    expect(info.participants).toEqual([
      { jid: "199900000000000@lid", phoneNumber: "447700900000@s.whatsapp.net", lid: "199900000000000@lid", admin: "superadmin", isMe: true, name: null },
      { jid: "199900000000001@lid", phoneNumber: "447700900111@s.whatsapp.net", lid: "199900000000001@lid", admin: "admin", isMe: false, name: "Ada" },
      { jid: "199900000000777@lid", phoneNumber: null, lid: "199900000000777@lid", admin: null, isMe: false, name: "Tom" },
    ]);
  });

  it("does not ask for the invite link when this account is not an admin", async () => {
    const meta = { ...META, participants: META.participants.map((p, i) => (i === 0 ? { ...p, admin: null } : p)) };
    const { sock, inviteCalls } = infoSocket(meta);
    const info = await groupInfoOnSocket(sock, GROUP, { id: ME, lid: "199900000000000@lid" });
    expect(info).toMatchObject({ iAmAdmin: false, inviteLink: null });
    expect(inviteCalls).toEqual([]);
  });

  it("still returns the group when only the invite link fails", async () => {
    const { sock } = infoSocket(META, new Error("not-authorized"));
    const info = await groupInfoOnSocket(sock, GROUP, { id: ME, lid: "199900000000000@lid" });
    expect(info).toMatchObject({ ok: true, inviteLink: null, detail: expect.stringMatching(/not-authorized/) });
  });
});

describe("isMember", () => {
  const meta = (ids: string[]): GroupMetadataLike => ({ id: GROUP, participants: ids.map((id) => ({ id })) });
  const sockFor = (result: GroupMetadataLike | Error) => ({
    async groupMetadata() {
      if (result instanceof Error) throw result;
      return result;
    },
  });
  const boom = (code: number) => Object.assign(new Error("refused"), { output: { statusCode: code } });

  it("finds this account under either of its names", async () => {
    expect(await isMember(sockFor(meta(["447700900000@s.whatsapp.net"])), GROUP, { id: ME })).toBe(true);
    expect(await isMember(sockFor(meta(["199900000000000@lid"])), GROUP, { id: ME, lid: "199900000000000:12@lid" })).toBe(true);
    expect(await isMember(sockFor(meta(["447700900111@s.whatsapp.net"])), GROUP, { id: ME })).toBe(false);
  });

  it("reads WhatsApp's refusal to a non-member as 'not a member', and lets any other failure through", async () => {
    for (const code of [401, 403, 404]) expect(await isMember(sockFor(boom(code)), GROUP, { id: ME })).toBe(false);
    await expect(isMember(sockFor(boom(500)), GROUP, { id: ME })).rejects.toThrow("refused");
    await expect(isMember(sockFor(new Error("timed out")), GROUP, { id: ME })).rejects.toThrow("timed out");
  });
});
