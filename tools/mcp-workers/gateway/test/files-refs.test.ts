import { describe, expect, it } from "vitest";
import { formatRef, parseSinkRef, parseSourceRef } from "../src/files/refs";
import { enforceCap, FILE_CAPS, FileError, readAll } from "../src/files/types";

describe("parseSourceRef", () => {
  it("parses each source kind", () => {
    expect(parseSourceRef("drive:FAKE_file-id_0001")).toEqual({ kind: "drive", fileId: "FAKE_file-id_0001" });
    expect(parseSourceRef("drive:FAKEfile01?account=work@example.com")).toEqual({
      kind: "drive",
      fileId: "FAKEfile01",
      account: "work@example.com",
    });
    expect(parseSourceRef("gmail:fakemsg0001/FAKE_att-01?account=me@example.org")).toEqual({
      kind: "gmail",
      messageId: "fakemsg0001",
      attachmentId: "FAKE_att-01",
      account: "me@example.org",
    });
    expect(parseSourceRef("wa:447700900000@s.whatsapp.net/FAKEMSG0001")).toEqual({
      kind: "wa",
      chatJid: "447700900000@s.whatsapp.net",
      messageId: "FAKEMSG0001",
    });
    expect(parseSourceRef("wa:120363000000000000@g.us/FAKEMSG0002").kind).toBe("wa");
  });

  it("keeps a + in an account label rather than reading it as a space", () => {
    expect(parseSourceRef("drive:FAKEfile01?account=me+tag@example.com")).toMatchObject({ account: "me+tag@example.com" });
    expect(parseSourceRef("drive:FAKEfile01?account=me%2Btag%40example.com")).toMatchObject({
      account: "me+tag@example.com",
    });
  });

  it.each([
    ["", /empty/],
    [" drive:FAKEfile01", /padded/],
    ["FAKEfile01", /not a source ref/],
    ["s3:bucket/key", /unknown scheme "s3"/],
    ["drive:", /expected drive:<fileId>/],
    ["drive:has/slash", /expected drive:<fileId>/],
    ["drive:folder/FAKEfolder01", /is a sink/],
    ["drive:FAKEfile01?acct=x", /only query parameter/],
    ["drive:FAKEfile01?account=", /non-empty label/],
    ["drive:FAKEfile01?account=a&account=b", /only query parameter/],
    ["drive:FAKEfile01?account=%E0%A4%A", /percent-encoding/],
    ["gmail:fakemsg0001", /gmail:<messageId>\/<attachmentId>/],
    ["gmail:fakemsg0001/att/extra", /gmail:<messageId>\/<attachmentId>/],
    ["gmail:draft/FAKEdraft01", /is a sink/],
    ["wa:not-a-jid/FAKEMSG0001", /not a chat JID/],
    ["wa:447700900000@s.whatsapp.net/bad id", /not a WhatsApp message id/],
    ["wa:447700900000@s.whatsapp.net/FAKEMSG0001?account=x", /take no \?account=/],
    ["wa:send/447700900000", /is a sink/],
    ["freeagent:bill/123", /destination only/],
  ])("rejects %j", (ref, message) => {
    expect(() => parseSourceRef(ref)).toThrow(message);
    expect(() => parseSourceRef(ref)).toThrow(FileError);
  });
});

describe("parseSinkRef", () => {
  it("parses each sink kind", () => {
    expect(parseSinkRef("drive:folder/FAKEfolder01")).toEqual({ kind: "drive-folder", parentId: "FAKEfolder01" });
    expect(parseSinkRef("drive:folder/_Transit")).toEqual({ kind: "drive-folder", parentId: "_Transit" });
    // _Transit is the default account's alone: a labelled one would never be swept.
    expect(() => parseSinkRef("drive:folder/_Transit?account=home@example.com")).toThrow(/default Drive account/);
    expect(parseSinkRef("drive:folder/root?account=home@example.com")).toEqual({
      kind: "drive-folder",
      parentId: "root",
      account: "home@example.com",
    });
    expect(parseSinkRef("gmail:draft/r-0000000000000000001")).toEqual({
      kind: "gmail-draft",
      draftId: "r-0000000000000000001",
    });
    expect(parseSinkRef("wa:send/+447700900000")).toEqual({ kind: "wa-send", recipient: "+447700900000" });
    expect(parseSinkRef("wa:send/447700900000@s.whatsapp.net")).toEqual({
      kind: "wa-send",
      recipient: "447700900000@s.whatsapp.net",
    });
    expect(parseSinkRef("freeagent:bill/101")).toEqual({ kind: "freeagent", target: "bill", id: "101" });
    expect(parseSinkRef("freeagent:explanation/202").kind).toBe("freeagent");
    expect(parseSinkRef("freeagent:expense/303")).toMatchObject({ target: "expense" });
  });

  it.each([
    ["drive:FAKEfile01", /drive:folder\/<parentId>/],
    ["drive:file/FAKEfile01", /drive:folder\/<parentId>/],
    ["drive:folder/bad.id", /not a Drive folder id/],
    ["gmail:fakemsg0001/FAKE_att-01", /gmail:draft\/<draftId>/],
    ["gmail:draft/", /gmail:draft\/<draftId>/],
    ["wa:send/12", /neither an international phone number nor a JID/],
    ["wa:447700900000@s.whatsapp.net/FAKEMSG0001", /wa:send\/<recipient>/],
    ["freeagent:invoice/1", /bill, explanation or expense/],
    ["freeagent:bill/abc", /not a FreeAgent id/],
    ["freeagent:bill/1?account=x", /take no \?account=/],
    ["dropbox:folder/x", /unknown scheme/],
  ])("rejects %j", (ref, message) => {
    expect(() => parseSinkRef(ref)).toThrow(message);
  });
});

describe("formatRef", () => {
  it.each([
    "drive:FAKEfile01",
    "drive:FAKEfile01?account=work@example.com",
    "gmail:fakemsg0001/FAKE_att-01?account=me@example.org",
    "wa:447700900000@s.whatsapp.net/FAKEMSG0001",
  ])("round-trips source %s", (ref) => {
    expect(formatRef(parseSourceRef(ref))).toBe(ref);
  });

  it.each([
    "drive:folder/FAKEfolder01?account=home@example.com",
    "drive:folder/_Transit",
    "gmail:draft/r-0000000000000000001",
    "wa:send/+447700900000",
    "freeagent:explanation/202",
  ])("round-trips sink %s", (ref) => {
    expect(formatRef(parseSinkRef(ref))).toBe(ref);
  });

  it("escapes awkward account labels so they parse back", () => {
    const ref = { kind: "drive" as const, fileId: "FAKEfile01", account: "a+b&c=d@example.com" };
    const text = formatRef(ref);
    expect(text).toBe("drive:FAKEfile01?account=a%2Bb%26c%3Dd@example.com");
    expect(parseSourceRef(text)).toEqual(ref);
  });
});

describe("caps", () => {
  it("names the cap when refusing", () => {
    expect(() => enforceCap(FILE_CAPS.whatsappSend + 1, "whatsappSend", "photo.jpg")).toThrow(/photo.jpg is 5242881 bytes.*5 MB/);
    expect(() => enforceCap(FILE_CAPS.whatsappSend, "whatsappSend")).not.toThrow();
  });

  it("buffers a stream and stops reading once it passes the cap", async () => {
    let pulled = 0;
    const big = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    await expect(readAll(big, "freeagentAttachment")).rejects.toThrow(/cap is \d+ bytes/);
    expect(pulled).toBeLessThan(10);

    const small = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });
    expect(Array.from(await readAll(small, "freeagentAttachment"))).toEqual([1, 2, 3]);
    await expect(readAll(new Uint8Array(FILE_CAPS.freeagentAttachment + 1), "freeagentAttachment")).rejects.toThrow(
      FileError,
    );
  });
});
