import { describe, expect, it } from "vitest";
import { makeSource } from "../src/files/sources";
import { FILE_CAPS, FileError } from "../src/files/types";
import { GoogleApiError } from "../src/googleapi";
import { toBase64Url } from "../src/mime";
import { bytes, fakeContext, fakeGoogle, text } from "./files-fake";

const PDF = "application/pdf";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function readBody(body: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(body).text();
}

describe("drive source", () => {
  it("stats from metadata and streams alt=media, exposing the Drive id", async () => {
    const { client, calls } = fakeGoogle((c) => {
      if (c.op === "getJson") return { id: "FAKEfile01", name: "a.pdf", mimeType: PDF, size: "5", md5Checksum: "FAKEmd5", parents: ["FAKEfolder01"] };
      if (c.op === "getStream") return bytes("%PDF-");
      throw new Error(`unexpected ${c.op}`);
    });
    const source = makeSource({ kind: "drive", fileId: "FAKEfile01", account: "fake@example.test" }, fakeContext({ drive: client }));
    expect(source.driveFileId).toBe("FAKEfile01");
    expect(source.driveAccount).toBe("fake@example.test");
    expect(await source.stat()).toEqual({ name: "a.pdf", mimeType: PDF, size: 5, md5: "FAKEmd5" });
    expect(calls[0]!.query!.fields).toBe("id,name,mimeType,size,md5Checksum,parents");
    const opened = await source.open();
    expect(await readBody(opened.body)).toBe("%PDF-");
    expect(calls.filter((c) => c.op === "getJson")).toHaveLength(1);
    expect(calls[1]!.query).toMatchObject({ alt: "media" });
  });

  it.each([
    ["application/vnd.google-apps.document", PDF, "Notes.pdf"],
    ["application/vnd.google-apps.presentation", PDF, "Notes.pdf"],
    ["application/vnd.google-apps.spreadsheet", XLSX, "Notes.xlsx"],
  ])("exports a native %s as %s, sizing it from the export", async (native, exported, name) => {
    const { client, calls } = fakeGoogle((c) => {
      if (c.op === "getJson") return { id: "FAKEdoc01", name: "Notes", mimeType: native, parents: [] };
      if (c.op === "getStream") return bytes("exported!");
      throw new Error(`unexpected ${c.op}`);
    });
    const source = makeSource({ kind: "drive", fileId: "FAKEdoc01" }, fakeContext({ drive: client }));
    expect(await source.stat()).toEqual({ name, mimeType: exported, size: 9, exportedFrom: native });
    const exportCall = calls.find((c) => c.op === "getStream")!;
    expect(exportCall.url).toMatch(/\/files\/FAKEdoc01\/export$/);
    expect(exportCall.query).toEqual({ mimeType: exported });
    // open() reuses the export; no second download, no alt=media on a native file.
    expect(await readBody((await source.open()).body)).toBe("exported!");
    expect(calls.map((c) => c.op)).toEqual(["getJson", "getStream"]);
  });

  it("stops reading an export at the sink's cap instead of buffering it whole", async () => {
    const big = new Uint8Array(FILE_CAPS.freeagentAttachment + 1);
    const { client } = fakeGoogle((c) => {
      if (c.op === "getJson") return { id: "FAKEdoc01", name: "Notes", mimeType: "application/vnd.google-apps.document", parents: [] };
      if (c.op === "getStream") return big;
      throw new Error(`unexpected ${c.op}`);
    });
    const source = makeSource({ kind: "drive", fileId: "FAKEdoc01" }, fakeContext({ drive: client }), { cap: "freeagentAttachment" });
    await expect(source.stat()).rejects.toMatchObject({ status: 413 });
  });

  it("refuses a folder: nothing to transfer", async () => {
    const { client } = fakeGoogle(() => ({ id: "FAKEdir01", name: "Dir", mimeType: "application/vnd.google-apps.folder" }));
    const source = makeSource({ kind: "drive", fileId: "FAKEdir01" }, fakeContext({ drive: client }));
    await expect(source.stat()).rejects.toMatchObject({ status: 415 });
  });

  it("names the account asked when Drive says not found", async () => {
    const { client } = fakeGoogle(() => {
      throw new GoogleApiError(404, "File not found");
    });
    const source = makeSource({ kind: "drive", fileId: "FAKEfile01", account: "fake@example.test" }, fakeContext({ drive: client }));
    const err = await source.stat().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileError);
    expect((err as FileError).message).toContain('the "fake@example.test" Drive account');
    expect((err as FileError).message).toContain("?account=");
  });
});

describe("gmail source", () => {
  const message = (size: number, attachmentId = "FAKEatt01") => ({
    payload: {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: toBase64Url("hi") } },
        { mimeType: PDF, filename: "invoice.pdf", body: { attachmentId, size } },
      ],
    },
  });

  it("stats from the message and decodes the base64url attachment", async () => {
    const payload = new Uint8Array([0xfb, 0xff, 0x00, 0x41]);
    const { client, calls } = fakeGoogle((c) =>
      c.url.includes("/attachments/") ? { size: 4, data: toBase64Url(payload) } : message(4),
    );
    const source = makeSource({ kind: "gmail", messageId: "FAKEmsg01", attachmentId: "FAKEatt01" }, fakeContext({ gmail: client }));
    expect(source.driveFileId).toBeUndefined();
    expect(await source.stat()).toEqual({ name: "invoice.pdf", mimeType: PDF, size: 4 });
    const opened = await source.open();
    expect(new Uint8Array(await new Response(opened.body).arrayBuffer())).toEqual(payload);
    expect(calls[1]!.url).toMatch(/\/messages\/FAKEmsg01\/attachments\/FAKEatt01$/);
  });

  it("refuses an attachment over the cap before downloading it", async () => {
    const { client, calls } = fakeGoogle(() => message(FILE_CAPS.gmailAttachmentRead + 1));
    const source = makeSource({ kind: "gmail", messageId: "FAKEmsg01", attachmentId: "FAKEatt01" }, fakeContext({ gmail: client }));
    await expect(source.open()).rejects.toMatchObject({ status: 413 });
    expect(calls.some((c) => c.url.includes("/attachments/"))).toBe(false);
  });

  it("accepts a re-issued id when the message has one attachment", async () => {
    const { client } = fakeGoogle(() => message(10, "FAKEattNEW"));
    const source = makeSource({ kind: "gmail", messageId: "FAKEmsg01", attachmentId: "FAKEattOLD" }, fakeContext({ gmail: client }));
    expect((await source.stat()).name).toBe("invoice.pdf");
  });

  it("fetches a stale id directly when several attachments make the match ambiguous, as the old relay did", async () => {
    const two = message(10);
    two.payload.parts.push({ mimeType: "image/png", filename: "other.png", body: { attachmentId: "FAKEatt02", size: 3 } });
    const { client, calls } = fakeGoogle((c) =>
      c.url.includes("/attachments/") ? { size: 3, data: toBase64Url("png") } : two,
    );
    const source = makeSource({ kind: "gmail", messageId: "FAKEmsg01", attachmentId: "FAKEattOLD" }, fakeContext({ gmail: client }));
    // Named from the one part whose size matches what Gmail served.
    expect(await source.stat()).toEqual({ name: "other.png", mimeType: "image/png", size: 3 });
    expect(text(new Uint8Array(await new Response((await source.open()).body).arrayBuffer()))).toBe("png");
    // Downloaded once, by the ref's own id; open() reused it.
    const downloads = calls.filter((c) => c.url.includes("/attachments/"));
    expect(downloads.map((c) => c.url.split("/").pop())).toEqual(["FAKEattOLD"]);
  });

  it("refuses a stale id Gmail no longer serves", async () => {
    const two = message(10);
    two.payload.parts.push({ mimeType: PDF, filename: "other.pdf", body: { attachmentId: "FAKEatt02", size: 3 } });
    const { client } = fakeGoogle((c) => {
      if (c.url.includes("/attachments/")) throw new GoogleApiError(400, "Invalid attachment token");
      return two;
    });
    const source = makeSource({ kind: "gmail", messageId: "FAKEmsg01", attachmentId: "FAKEatt09" }, fakeContext({ gmail: client }));
    await expect(source.stat()).rejects.toMatchObject({ status: 404, message: expect.stringContaining("gmail_get_message") });
  });

  it("caps a directly fetched stale id on the size Gmail reports", async () => {
    const two = message(10);
    two.payload.parts.push({ mimeType: PDF, filename: "other.pdf", body: { attachmentId: "FAKEatt02", size: 3 } });
    const { client } = fakeGoogle((c) =>
      c.url.includes("/attachments/") ? { size: FILE_CAPS.gmailAttachmentRead + 1, data: "AAAA" } : two,
    );
    const source = makeSource({ kind: "gmail", messageId: "FAKEmsg01", attachmentId: "FAKEatt09" }, fakeContext({ gmail: client }));
    await expect(source.stat()).rejects.toMatchObject({ status: 413 });
  });
});

describe("whatsapp source", () => {
  const ref = { kind: "wa" as const, chatJid: "447700900000@s.whatsapp.net", messageId: "FAKEWAMSG01" };

  it("streams through openMedia, opening once for stat and open", async () => {
    let opens = 0;
    const whatsapp = {
      async openMedia(messageId: string, chatJid: string) {
        opens++;
        expect([messageId, chatJid]).toEqual([ref.messageId, ref.chatJid]);
        return { filename: "scan.pdf", mimeType: PDF, size: 3, body: new Response("abc").body! };
      },
      downloadMedia() {
        throw new Error("should not fall back");
      },
    };
    const source = makeSource(ref, fakeContext({ whatsapp }));
    expect(await source.stat()).toEqual({ name: "scan.pdf", mimeType: PDF, size: 3 });
    expect(await readBody((await source.open()).body)).toBe("abc");
    expect(opens).toBe(1);
  });

  it("falls back to downloadMedia on a bridge without openMedia", async () => {
    const whatsapp = {
      async downloadMedia() {
        return { ok: true, base64: btoa("img"), mimeType: "image/jpeg", filename: null, size: 3 };
      },
    };
    const source = makeSource(ref, fakeContext({ whatsapp }));
    const opened = await source.open();
    expect(opened.meta).toEqual({ name: "whatsapp-FAKEWAMSG01", mimeType: "image/jpeg", size: 3 });
    expect(text(new Uint8Array(await new Response(opened.body).arrayBuffer()))).toBe("img");
  });

  it("falls back when a Durable Object stub's openMedia exists but the bridge lacks the method", async () => {
    const whatsapp = {
      // A DO stub answers every property; the RPC itself is what refuses.
      async openMedia() {
        throw new TypeError('The RPC receiver does not implement the method "openMedia".');
      },
      async downloadMedia() {
        return { ok: true, base64: btoa("img"), mimeType: "image/jpeg", filename: "a.jpg", size: 3 };
      },
    };
    expect(await makeSource(ref, fakeContext({ whatsapp })).stat()).toEqual({ name: "a.jpg", mimeType: "image/jpeg", size: 3 });
  });

  it("does not fall back when openMedia ran and failed", async () => {
    const whatsapp = {
      async openMedia() {
        throw new Error("media key expired");
      },
      downloadMedia() {
        throw new Error("should not fall back");
      },
    };
    await expect(makeSource(ref, fakeContext({ whatsapp })).stat()).rejects.toThrow("media key expired");
  });

  it("dispose() cancels the stream stat() opened", async () => {
    let cancelled = false;
    const whatsapp = {
      async openMedia() {
        const body = new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        });
        return { filename: "big.pdf", mimeType: PDF, size: 3, body };
      },
    };
    const source = makeSource(ref, fakeContext({ whatsapp }));
    await source.stat();
    await source.dispose!();
    expect(cancelled).toBe(true);
  });

  it("surfaces the bridge's reason when the fallback has no bytes", async () => {
    const whatsapp = { downloadMedia: async () => ({ ok: false, detail: "document is 3 MB; inline cap is 32 KB" }) };
    await expect(makeSource(ref, fakeContext({ whatsapp })).stat()).rejects.toThrow("inline cap is 32 KB");
  });
});

describe("freeagent attachment source", () => {
  function fakeFreeagent(content: Uint8Array, statedSize: number) {
    const calls: string[] = [];
    let cancelled = false;
    const attachment = { id: "901", url: "https://api.freeagent.com/v2/attachments/901", file_name: "bill.pdf", content_type: PDF, file_size: statedSize };
    const client = {
      async getAttachment(id: string) {
        calls.push(`get ${id}`);
        return attachment;
      },
      async openAttachment(id: string) {
        calls.push(`open ${id}`);
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            // Two chunks, so a cap can bite mid-stream.
            const half = Math.ceil(content.byteLength / 2);
            controller.enqueue(content.slice(0, half));
            controller.enqueue(content.slice(half));
            controller.close();
          },
          cancel() {
            cancelled = true;
          },
        });
        return { attachment, body };
      },
    };
    return { client, calls, wasCancelled: () => cancelled };
  }

  it("stats from metadata and streams a fresh download on open", async () => {
    const fa = fakeFreeagent(bytes("%PDF-"), 5);
    const source = makeSource({ kind: "freeagent-attachment", id: "901" }, fakeContext({ freeagent: fa.client }));
    expect(await source.stat()).toEqual({ name: "bill.pdf", mimeType: PDF, size: 5 });
    expect(fa.calls).toEqual(["get 901"]);
    const opened = await source.open();
    expect(await readBody(opened.body)).toBe("%PDF-");
    expect(fa.calls).toEqual(["get 901", "open 901"]);
  });

  it("cuts the stream at the sink's cap when the stated size was too small", async () => {
    const fa = fakeFreeagent(new Uint8Array(FILE_CAPS.whatsappSend + 10), 3);
    const source = makeSource({ kind: "freeagent-attachment", id: "901" }, fakeContext({ freeagent: fa.client }), { cap: "whatsappSend" });
    const opened = await source.open();
    const err = await new Response(opened.body).arrayBuffer().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileError);
    expect(err).toMatchObject({ status: 413 });
  });

  it("refuses at open, releasing the download, when the fresh size is over the cap", async () => {
    const fa = fakeFreeagent(bytes("x"), FILE_CAPS.whatsappSend + 1);
    const source = makeSource({ kind: "freeagent-attachment", id: "901" }, fakeContext({ freeagent: fa.client }), { cap: "whatsappSend" });
    await expect(source.open()).rejects.toMatchObject({ status: 413 });
    expect(fa.wasCancelled()).toBe(true);
  });
});
