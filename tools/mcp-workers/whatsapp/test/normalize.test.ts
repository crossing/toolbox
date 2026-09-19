import { describe, expect, it } from "vitest";
import { proto } from "baileys";
import type { WAMessage } from "baileys";
import { chatNameFor, mediaKindOf, messageForRetry, revokeOf, textOf, toStoredMessage } from "../src/normalize";

const ME = "447700900000:12@s.whatsapp.net";

function message(partial: Partial<WAMessage>): WAMessage {
  return {
    key: { remoteJid: "447700900111@s.whatsapp.net", fromMe: false, id: "MSG1" },
    messageTimestamp: 1755730000,
    ...partial,
  } as WAMessage;
}

describe("toStoredMessage", () => {
  it("maps a plain text message", () => {
    const row = toStoredMessage(
      message({ pushName: "Ada", message: { conversation: "hello there" } }),
      ME,
    );
    expect(row).toMatchObject({
      id: "MSG1",
      chatJid: "447700900111@s.whatsapp.net",
      sender: "447700900111@s.whatsapp.net",
      senderName: "Ada",
      content: "hello there",
      isFromMe: false,
      mediaType: null,
    });
    expect(row!.timestamp).toBe(new Date(1755730000 * 1000).toISOString());
  });

  it("unwraps ephemeral and extended text", () => {
    const row = toStoredMessage(
      message({
        message: {
          ephemeralMessage: { message: { extendedTextMessage: { text: "wrapped" } } },
        },
      }),
      ME,
    );
    expect(row!.content).toBe("wrapped");
  });

  it("takes the participant as sender in a group", () => {
    const row = toStoredMessage(
      message({
        key: {
          remoteJid: "120363000000000000@g.us",
          fromMe: false,
          id: "G1",
          participant: "447700900222:5@s.whatsapp.net",
        },
        message: { conversation: "in the group" },
      }),
      ME,
    );
    // The device suffix is dropped so the sender matches the contact's JID.
    expect(row!.sender).toBe("447700900222@s.whatsapp.net");
    expect(row!.chatJid).toBe("120363000000000000@g.us");
  });

  it("files a LID-addressed group message under the sender's phone number when WhatsApp gives one", () => {
    const row = toStoredMessage(
      message({
        key: {
          remoteJid: "120363000000000000@g.us",
          fromMe: false,
          id: "G2",
          participant: "199900000000001:2@lid",
          participantAlt: "447700900222:2@s.whatsapp.net",
        } as never,
        pushName: "Bea",
        message: { conversation: "from a lid group" },
      }),
      ME,
    );
    expect(row!.sender).toBe("447700900222@s.whatsapp.net");
    expect(row!.senderName).toBe("Bea");
    expect(row!.chatJid).toBe("120363000000000000@g.us");
  });

  it("keeps the LID as the group sender when that is all WhatsApp sent", () => {
    const row = toStoredMessage(
      message({
        key: { remoteJid: "120363000000000000@g.us", fromMe: false, id: "G3", participant: "199900000000001:2@lid" },
        message: { conversation: "lid only" },
      }),
      ME,
    );
    expect(row!.sender).toBe("199900000000001@lid");
  });

  it("never files a group message under the group itself when the participant sits on the message", () => {
    const row = toStoredMessage(
      message({
        key: { remoteJid: "120363000000000000@g.us", fromMe: false, id: "G4" },
        participant: "447700900333@s.whatsapp.net",
        message: { conversation: "participant outside the key" },
      }),
      ME,
    );
    expect(row!.sender).toBe("447700900333@s.whatsapp.net");
  });

  it("files our own send to a group under the group, from us", () => {
    const row = toStoredMessage(
      message({
        key: { remoteJid: "120363000000000000@g.us", fromMe: true, id: "G5" },
        message: { conversation: "hello group" },
      }),
      ME,
    );
    expect(row).toMatchObject({
      chatJid: "120363000000000000@g.us",
      sender: "447700900000@s.whatsapp.net",
      isFromMe: true,
      content: "hello group",
    });
  });

  it("carries media descriptors and the caption", () => {
    const row = toStoredMessage(
      message({
        message: {
          imageMessage: {
            caption: "a photo",
            mimetype: "image/jpeg",
            url: "https://mmg.whatsapp.net/x",
            directPath: "/v/t62.7118-24/x",
            mediaKey: new Uint8Array([1, 2, 3]),
            fileSha256: new Uint8Array([4, 5]),
            fileEncSha256: new Uint8Array([6, 7]),
            fileLength: 4096,
          },
        },
      }),
      ME,
    );
    expect(row).toMatchObject({
      content: "a photo",
      mediaType: "image",
      mimeType: "image/jpeg",
      directPath: "/v/t62.7118-24/x",
      fileLength: 4096,
    });
    expect(row!.mediaKeyB64).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });

  it("handles a Long fileLength and a Long timestamp", () => {
    const row = toStoredMessage(
      message({
        messageTimestamp: { toNumber: () => 1755730001, low: 1755730001 } as never,
        message: {
          documentMessage: {
            fileName: "notes.pdf",
            mimetype: "application/pdf",
            fileLength: { toNumber: () => 12345 } as never,
          },
        },
      }),
      ME,
    );
    expect(row!.fileLength).toBe(12345);
    expect(row!.filename).toBe("notes.pdf");
    expect(row!.mediaType).toBe("document");
    expect(row!.timestamp).toBe(new Date(1755730001 * 1000).toISOString());
  });

  it("marks our own messages and files them under our JID", () => {
    const row = toStoredMessage(
      message({
        key: { remoteJid: "447700900111@s.whatsapp.net", fromMe: true, id: "OUT1" },
        message: { conversation: "sent" },
      }),
      ME,
    );
    expect(row!.isFromMe).toBe(true);
    expect(row!.sender).toBe("447700900000@s.whatsapp.net");
  });

  it("refuses messages without a chat or id", () => {
    expect(toStoredMessage(message({ key: { remoteJid: null, id: null } }), ME)).toBeNull();
  });

  it("stores an attachment with no caption as null content", () => {
    const row = toStoredMessage(
      message({ message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", seconds: 3 } } }),
      ME,
    );
    expect(row!.content).toBeNull();
    expect(row!.mediaType).toBe("audio");
  });
});

// "Delete for everyone", as it reaches a linked device: an ordinary message
// stanza whose content is a protocolMessage naming the message withdrawn.
describe("inbound revoke", () => {
  const REVOKE = proto.Message.ProtocolMessage.Type.REVOKE;
  const GROUP = "120363000000000001@g.us";

  it("points at the message withdrawn, in the chat the revoke arrived in", () => {
    const revoke = revokeOf(
      message({
        key: { remoteJid: "447700900111@s.whatsapp.net", fromMe: false, id: "REVOKE-STANZA" },
        messageTimestamp: 1755730060,
        // The inner key is written from the sender's side: their `fromMe`, and a
        // remoteJid that is *us*. Neither is where the message lives here.
        message: { protocolMessage: { type: REVOKE, key: { remoteJid: ME, fromMe: true, id: "ORIGINAL" } } },
      }),
      ME,
    );
    expect(revoke).toEqual({
      chatJid: "447700900111@s.whatsapp.net",
      messageId: "ORIGINAL",
      revokedBy: "447700900111@s.whatsapp.net",
      revokedAt: new Date(1755730060 * 1000).toISOString(),
    });
  });

  it("names a group member by phone number when WhatsApp supplied it, like any group sender", () => {
    const revoke = revokeOf(
      message({
        key: {
          remoteJid: GROUP, fromMe: false, id: "R2",
          participant: "199900000000777@lid", participantAlt: "447700900222@s.whatsapp.net",
        } as never,
        message: { protocolMessage: { type: REVOKE, key: { remoteJid: GROUP, fromMe: false, id: "G-ORIGINAL" } } },
      }),
      ME,
    );
    expect(revoke).toMatchObject({ chatJid: GROUP, messageId: "G-ORIGINAL", revokedBy: "447700900222@s.whatsapp.net" });
  });

  it("recognises our own revoke made from the phone", () => {
    const revoke = revokeOf(
      message({
        key: { remoteJid: "447700900111@s.whatsapp.net", fromMe: true, id: "R3" },
        message: { protocolMessage: { type: REVOKE, key: { remoteJid: "447700900111@s.whatsapp.net", fromMe: true, id: "MINE" } } },
      }),
      ME,
    );
    expect(revoke).toMatchObject({ messageId: "MINE", revokedBy: "447700900000@s.whatsapp.net" });
  });

  it("sees through a disappearing-messages wrapper", () => {
    const revoke = revokeOf(
      message({ message: { ephemeralMessage: { message: { protocolMessage: { type: REVOKE, key: { id: "WRAPPED" } } } } } }),
      ME,
    );
    expect(revoke?.messageId).toBe("WRAPPED");
  });

  it("is not fooled by other protocol messages or by ordinary ones", () => {
    const EDIT = proto.Message.ProtocolMessage.Type.MESSAGE_EDIT;
    expect(revokeOf(message({ message: { protocolMessage: { type: EDIT, key: { id: "X" } } } }), ME)).toBeNull();
    expect(revokeOf(message({ message: { conversation: "delete this" } }), ME)).toBeNull();
    expect(revokeOf(message({ message: { protocolMessage: { type: REVOKE } } }), ME)).toBeNull();
  });

  it("is never stored as a message of its own — that was an empty row under the revoke's id", () => {
    const stanza = message({
      key: { remoteJid: "447700900111@s.whatsapp.net", fromMe: false, id: "REVOKE-STANZA" },
      message: { protocolMessage: { type: REVOKE, key: { id: "ORIGINAL" } } },
    });
    expect(toStoredMessage(stanza, ME)).toBeNull();
  });

  it("drops the husk Baileys leaves when it merges a revoke into a buffered original", () => {
    // Utils/event-buffer.js: Object.assign(original, { message: null,
    // messageStubType: REVOKE, key: <the revoke's key> }).
    const husk = message({
      key: { remoteJid: "447700900111@s.whatsapp.net", fromMe: false, id: "REVOKE-STANZA" },
      message: null,
      messageStubType: proto.WebMessageInfo.StubType.REVOKE,
    });
    expect(toStoredMessage(husk, ME)).toBeNull();
  });

  it("stores no row for any protocol message", () => {
    const KEY_SHARE = proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE;
    expect(toStoredMessage(message({ message: { protocolMessage: { type: KEY_SHARE } } }), ME)).toBeNull();
  });
});

describe("undecryptable messages", () => {
  it("become a placeholder carrying Baileys' reason, not an anonymous empty row", () => {
    const row = toStoredMessage(
      message({
        key: {
          remoteJid: "120363000000000001@g.us", fromMe: false, id: "CIPHER1",
          participant: "199900000000777@lid", participantAlt: "447700900222@s.whatsapp.net",
        } as never,
        pushName: "Tom",
        messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT,
        messageStubParameters: ["No SenderKeyRecord found for decryption"],
      }),
      ME,
    );
    expect(row).toMatchObject({
      id: "CIPHER1",
      sender: "447700900222@s.whatsapp.net",
      senderName: "Tom",
      content: null,
      decryptError: "No SenderKeyRecord found for decryption",
      participant: "199900000000777@lid",
    });
  });

  it("leaves decryptError null on everything that was read", () => {
    expect(toStoredMessage(message({ message: { conversation: "fine" } }), ME)?.decryptError).toBeNull();
    // A system stub (group created, member added) is not a decryption failure.
    const stub = message({ messageStubType: proto.WebMessageInfo.StubType.GROUP_CREATE, messageStubParameters: ["Roof repair"] });
    expect(toStoredMessage(stub, ME)?.decryptError).toBeNull();
  });
});

// A recipient's device that could not decrypt one of our sends asks again, and
// by then the socket that sent it is long closed. The answer has to come out of
// the store.
describe("messageForRetry", () => {
  const base = { id: "S1", chatJid: "120363000000000001@g.us", sender: ME, timestamp: "2026-09-19T10:00:00.000Z", isFromMe: true };

  it("rebuilds a text", () => {
    expect(messageForRetry({ ...base, content: "viewing at 2pm — flat 3" })).toEqual({ conversation: "viewing at 2pm — flat 3" });
  });

  it("rebuilds a document from the descriptors kept for downloads, re-uploading nothing", () => {
    const rebuilt = messageForRetry({
      ...base, content: "the inventory", mediaType: "document", filename: "inventory.pdf", mimeType: "application/pdf",
      url: "https://mmg.whatsapp.net/v/x", directPath: "/v/x", mediaKeyB64: "a2V5", fileSha256B64: "c2hh", fileEncSha256B64: "ZW5j", fileLength: 2048,
    });
    expect(rebuilt?.documentMessage).toMatchObject({
      fileName: "inventory.pdf", mimetype: "application/pdf", caption: "the inventory", directPath: "/v/x", fileLength: 2048,
    });
    expect(Buffer.from(rebuilt!.documentMessage!.mediaKey!).toString()).toBe("key");
  });

  it("answers nothing for someone else's message, a revoked one, or one it cannot rebuild whole", () => {
    expect(messageForRetry(null)).toBeUndefined();
    expect(messageForRetry({ ...base, isFromMe: false, content: "not ours" })).toBeUndefined();
    expect(messageForRetry({ ...base, content: "withdrawn", revokedAt: "2026-09-19T10:05:00.000Z" })).toBeUndefined();
    expect(messageForRetry({ ...base, mediaType: "image", content: null })).toBeUndefined();
    expect(messageForRetry({ ...base, content: null })).toBeUndefined();
  });
});

describe("helpers", () => {
  it("reads text out of several shapes", () => {
    expect(textOf(message({ message: { conversation: "a" } }))).toBe("a");
    expect(textOf(message({ message: { extendedTextMessage: { text: "b" } } }))).toBe("b");
    expect(textOf(message({ message: { videoMessage: { caption: "c" } } }))).toBe("c");
    expect(textOf(message({ message: undefined }))).toBeNull();
  });

  it("classifies media", () => {
    expect(mediaKindOf(message({ message: { stickerMessage: {} } }))).toBe("sticker");
    expect(mediaKindOf(message({ message: { conversation: "x" } }))).toBeNull();
  });

  it("names a direct chat after the other party only", () => {
    expect(chatNameFor(message({ pushName: "Ada" }))).toBe("Ada");
    expect(
      chatNameFor(message({ pushName: "Ada", key: { remoteJid: "1@g.us", fromMe: false, id: "x" } })),
    ).toBeNull();
    expect(
      chatNameFor(
        message({ pushName: "Me", key: { remoteJid: "1@s.whatsapp.net", fromMe: true, id: "x" } }),
      ),
    ).toBeNull();
  });
});
