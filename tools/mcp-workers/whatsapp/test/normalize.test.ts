import { describe, expect, it } from "vitest";
import type { WAMessage } from "baileys";
import { chatNameFor, mediaKindOf, textOf, toStoredMessage } from "../src/normalize";

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
