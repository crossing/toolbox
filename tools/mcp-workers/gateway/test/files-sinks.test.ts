import { describe, expect, it } from "vitest";
import { freeagentAttachmentBody, makeSink } from "../src/files/sinks";
import { transfer } from "../src/files/transfer";
import { transitCacheKey, FOLDER_MIME } from "../src/files/transit";
import { FILE_CAPS } from "../src/files/types";
import { toBase64Url } from "../src/mime";
import { bytes, fakeContext, fakeGoogle, fakeVault, text, type GCall } from "./files-fake";

const PDF = "application/pdf";
const TRANSIT = "FAKEtransit01";
const DEST = "FAKEfolder01";

/** A Drive that knows one file, the _Transit folder, and answers writes with a file JSON. */
function drive(file: { id: string; parents: string[]; size?: string; mimeType?: string }) {
  return fakeGoogle((c: GCall) => {
    if (c.op === "getJson" && c.url.endsWith(`/files/${TRANSIT}`)) {
      return { id: TRANSIT, name: "_Transit", mimeType: FOLDER_MIME, trashed: false };
    }
    if (c.op === "getJson" && c.url.endsWith(`/files/${file.id}`)) {
      return { name: "scan.pdf", mimeType: file.mimeType ?? PDF, size: file.size ?? "3", md5Checksum: "FAKEmd5", ...file };
    }
    if (c.op === "getStream") return bytes("abc");
    if (c.op === "sendJson" && c.method === "PATCH") return { id: file.id, name: "2026-10-03 scan.pdf", size: "3" };
    if (c.op === "sendJson" && c.url.endsWith("/copy")) return { id: "FAKEcopy01", name: "2026-10-03 scan.pdf", size: "3" };
    if (c.op === "startResumableUpload") return "https://upload.example.test/session/FAKE";
    if (c.op === "uploadToSession") return { id: "FAKEup01", name: "scan.pdf", size: String(c.bytes!.byteLength) };
    throw new Error(`unexpected ${c.op} ${c.method} ${c.url}`);
  });
}

function vaultWithTransit() {
  const vault = fakeVault();
  vault.setSetting(transitCacheKey(), TRANSIT);
  return vault;
}

describe("transfer into a Drive folder: move vs copy", () => {
  it("moves a file out of _Transit, keeping its id", async () => {
    const { client, calls } = drive({ id: "FAKEfile01", parents: [TRANSIT] });
    const ctx = fakeContext({ drive: client, vault: vaultWithTransit() });
    const result = await transfer(
      { kind: "drive", fileId: "FAKEfile01" },
      { kind: "drive-folder", parentId: DEST },
      ctx,
      { name: "2026-10-03 scan.pdf" },
    );
    expect(result.mode).toBe("moved");
    expect(result.ref).toBe("drive:FAKEfile01");
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toMatch(/\/files\/FAKEfile01$/);
    expect(patch.query).toMatchObject({ addParents: DEST, removeParents: TRANSIT });
    // trashed: false so a file the sweep already trashed comes back with the move.
    expect(patch.body).toEqual({ name: "2026-10-03 scan.pdf", trashed: false });
    expect(calls.some((c) => c.url.endsWith("/copy") || c.op === "getStream")).toBe(false);
  });

  it("copies a file that is not in _Transit, server-side", async () => {
    const { client, calls } = drive({ id: "FAKEfile01", parents: ["FAKEelsewhere"] });
    const ctx = fakeContext({ drive: client, vault: vaultWithTransit() });
    const result = await transfer({ kind: "drive", fileId: "FAKEfile01" }, { kind: "drive-folder", parentId: DEST }, ctx);
    expect(result.mode).toBe("copied");
    expect(result.ref).toBe("drive:FAKEcopy01");
    const copy = calls.find((c) => c.url.endsWith("/copy"))!;
    expect(copy.body).toEqual({ name: "scan.pdf", parents: [DEST] });
    expect(calls.some((c) => c.method === "PATCH" || c.op === "getStream")).toBe(false);
  });

  it("copies into _Transit itself, resolving the sentinel to the folder id", async () => {
    const { client, calls } = drive({ id: "FAKEfile01", parents: ["FAKEelsewhere"] });
    const ctx = fakeContext({ drive: client, vault: vaultWithTransit() });
    await transfer({ kind: "drive", fileId: "FAKEfile01" }, { kind: "drive-folder", parentId: "_Transit" }, ctx);
    expect(calls.find((c) => c.url.endsWith("/copy"))!.body).toMatchObject({ parents: [TRANSIT] });
  });

  it("streams across Drive accounts rather than copying", async () => {
    const src = drive({ id: "FAKEfile01", parents: [TRANSIT] });
    const dst = drive({ id: "FAKEnone", parents: [] });
    const ctx = fakeContext({ drives: { "": src.client, "other@example.test": dst.client }, vault: vaultWithTransit() });
    const result = await transfer(
      { kind: "drive", fileId: "FAKEfile01" },
      { kind: "drive-folder", parentId: DEST, account: "other@example.test" },
      ctx,
    );
    expect(result.mode).toBe("streamed");
    expect(result.ref).toBe("drive:FAKEup01?account=other@example.test");
    expect(src.calls.some((c) => c.op === "getStream")).toBe(true);
    const start = dst.calls.find((c) => c.op === "startResumableUpload")!;
    expect(start.body).toEqual({ name: "scan.pdf", mimeType: PDF, parents: [DEST] });
    expect(start.size).toBe(3);
    expect(text(dst.calls.find((c) => c.op === "uploadToSession")!.bytes!)).toBe("abc");
  });
});

describe("transfer into non-Drive sinks", () => {
  it("refuses a file over the sink's cap from stat, before downloading", async () => {
    const { client, calls } = drive({ id: "FAKEbig01", parents: [], size: String(FILE_CAPS.whatsappSend + 1) });
    const sendFile = () => {
      throw new Error("must not send");
    };
    const ctx = fakeContext({ drive: client, whatsapp: { sendFile } });
    await expect(
      transfer({ kind: "drive", fileId: "FAKEbig01" }, { kind: "wa-send", recipient: "447700900000" }, ctx),
    ).rejects.toMatchObject({ status: 413 });
    expect(calls.some((c) => c.op === "getStream")).toBe(false);
  });

  it("sends a Gmail attachment over WhatsApp as base64 with caption", async () => {
    const gmail = fakeGoogle((c) =>
      c.url.includes("/attachments/")
        ? { size: 3, data: toBase64Url("abc") }
        : { payload: { parts: [{ mimeType: PDF, filename: "inv.pdf", body: { attachmentId: "FAKEatt01", size: 3 } }] } },
    );
    const sent: unknown[][] = [];
    const whatsapp = {
      async sendFile(...args: unknown[]) {
        sent.push(args);
        return { ok: true, messageId: "FAKEWAOUT01" };
      },
    };
    const result = await transfer(
      { kind: "gmail", messageId: "FAKEmsg01", attachmentId: "FAKEatt01" },
      { kind: "wa-send", recipient: "447700900000" },
      fakeContext({ gmail: gmail.client, whatsapp }),
      { caption: "your invoice", mediaType: "document" },
    );
    expect(result.mode).toBe("streamed");
    expect(sent).toEqual([["447700900000", "inv.pdf", btoa("abc"), "document", "your invoice"]]);
  });

  it("appends the type's extension to a bare name on a WhatsApp send, as the old tool did", async () => {
    const { client } = drive({ id: "FAKEfile01", parents: [] });
    const sent: unknown[][] = [];
    const whatsapp = {
      async sendFile(...args: unknown[]) {
        sent.push(args);
        return { ok: true, messageId: "FAKEWAOUT01" };
      },
    };
    const result = await transfer(
      { kind: "drive", fileId: "FAKEfile01" },
      { kind: "wa-send", recipient: "447700900000" },
      fakeContext({ drive: client, whatsapp }),
      { name: "Invoice" },
    );
    expect(result.name).toBe("Invoice.pdf");
    expect(sent[0]![1]).toBe("Invoice.pdf");
  });

  it("releases the WhatsApp stream stat() opened when the sink's cap refuses it", async () => {
    let cancelled = false;
    const whatsapp = {
      async openMedia() {
        const body = new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        });
        return { filename: "big.pdf", mimeType: PDF, size: FILE_CAPS.freeagentAttachment + 1, body };
      },
    };
    const freeagent = {
      putUrl() {
        throw new Error("must not upload");
      },
    };
    await expect(
      transfer(
        { kind: "wa", chatJid: "447700900000@s.whatsapp.net", messageId: "FAKEWAMSG01" },
        { kind: "freeagent", target: "bill", id: "1" },
        fakeContext({ whatsapp, freeagent }),
      ),
    ).rejects.toMatchObject({ status: 413 });
    expect(cancelled).toBe(true);
  });

  it("turns a bridge refusal into an error", async () => {
    const sink = makeSink({ kind: "wa-send", recipient: "447700900000" }, fakeContext({
      whatsapp: { sendFile: async () => ({ ok: false, detail: "not paired" }) },
    }));
    await expect(sink.put({ name: "a.pdf", mimeType: PDF, size: 1 }, bytes("a"))).rejects.toThrow("not paired");
  });

  it.each([
    ["bill", "https://api.freeagent.com/v2/bills/123", "bill"],
    ["explanation", "https://api.freeagent.com/v2/bank_transaction_explanations/123", "bank_transaction_explanation"],
    ["expense", "https://api.freeagent.com/v2/expenses/123", "expense"],
  ] as const)("attaches to a FreeAgent %s with the CLI's attachment shape", async (target, url, key) => {
    const puts: [string, unknown][] = [];
    const freeagent = {
      async putUrl(u: string, body: unknown) {
        puts.push([u, body]);
        return { ok: true };
      },
    };
    const { client } = drive({ id: "FAKEfile01", parents: [] });
    const result = await transfer(
      { kind: "drive", fileId: "FAKEfile01" },
      { kind: "freeagent", target, id: "123" },
      fakeContext({ drive: client, freeagent }),
      { name: "2026-10-03 receipt.pdf" },
    );
    expect(result).toMatchObject({ mode: "streamed", name: "2026-10-03 receipt.pdf", size: 3 });
    expect(puts).toEqual([
      [url, { [key]: { attachment: { data: btoa("abc"), file_name: "2026-10-03 receipt.pdf", content_type: PDF } } }],
    ]);
  });

  it("freeagentAttachmentBody carries a description when given", () => {
    expect(freeagentAttachmentBody("bill", { name: "a.pdf", mimeType: "" }, bytes("a"), "receipt")).toEqual({
      bill: { attachment: { data: btoa("a"), file_name: "a.pdf", content_type: "application/octet-stream", description: "receipt" } },
    });
  });

  it("refuses a FreeAgent attachment over its cap before downloading", async () => {
    const { client, calls } = drive({ id: "FAKEbig01", parents: [], size: String(FILE_CAPS.freeagentAttachment + 1) });
    await expect(
      transfer({ kind: "drive", fileId: "FAKEbig01" }, { kind: "freeagent", target: "bill", id: "1" }, fakeContext({ drive: client })),
    ).rejects.toMatchObject({ status: 413 });
    expect(calls.some((c) => c.op === "getStream")).toBe(false);
  });
});

describe("gmail draft sink", () => {
  const RAW = "From: a@example.test\r\nTo: b@example.test\r\nSubject: hi\r\nContent-Type: text/plain\r\n\r\nbody\r\n";

  function gmailWithDraft() {
    return fakeGoogle((c) => {
      if (c.op === "getJson") return { id: "FAKEdraft01", message: { raw: toBase64Url(RAW), threadId: "FAKEthread01" } };
      if (c.op === "sendBody") return { id: "FAKEdraft01" };
      throw new Error(`unexpected ${c.op}`);
    });
  }

  it("splices the attachment into the stored draft and writes it back", async () => {
    const { client, calls } = gmailWithDraft();
    const sink = makeSink({ kind: "gmail-draft", draftId: "FAKEdraft01" }, fakeContext({ gmail: client }));
    const result = await sink.put({ name: "a.pdf", mimeType: PDF, size: 3 }, new Response("abc").body!);
    expect(result).toMatchObject({ name: "a.pdf", size: 3 });
    const put = calls.find((c) => c.op === "sendBody")!;
    expect(put.method).toBe("PUT");
    expect(put.url).toMatch(/\/upload\/gmail\/v1\/users\/me\/drafts\/FAKEdraft01$/);
    const body = String(put.body);
    expect(body).toContain('"threadId":"FAKEthread01"');
    expect(body).toContain("filename=\"a.pdf\"");
    expect(body).toContain(btoa("abc"));
    expect(body).toContain("body");
  });

  it("refuses when the draft has no room, without reading the body", async () => {
    const { client, calls } = gmailWithDraft();
    const sink = makeSink({ kind: "gmail-draft", draftId: "FAKEdraft01" }, fakeContext({ gmail: client }));
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    await expect(sink.put({ name: "big.pdf", mimeType: PDF, size: FILE_CAPS.gmailMessage }, body)).rejects.toMatchObject({
      status: 413,
    });
    expect(calls.some((c) => c.op === "sendBody")).toBe(false);
    expect(cancelled).toBe(true);
  });
});
