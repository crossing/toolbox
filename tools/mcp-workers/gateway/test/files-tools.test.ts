// The `files` service's four tools, driven through a fake registerTool with a
// GatewayToolContext whose Google clients answer from a script. Signed URLs
// are minted with the real signer, so each test can verify what a token binds.
// Ids and accounts are obviously fake.

import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fileUrl } from "../src/files/http";
import { signToken, verifyToken } from "../src/files/signed";
import { registerFileReadTools, registerFileWriteTools } from "../src/files/tools";
import { FILE_CAPS } from "../src/files/types";
import { SERVICES, type GatewayToolContext } from "../src/registry";
import { registerRelayTools } from "../src/relay";
import { bytes, fakeGoogle, fakeVault, type GCall } from "./files-fake";
import { makeGrantStore } from "./grantfake";

const KEY = "test-files-url-key-not-a-secret";
// One grant store for the file: tokens are minted by the harness and read
// back by tokenPayload, as the real shards serve both sides.
const grants = makeGrantStore();
const ORIGIN = "https://gateway.example";
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const PDF = "application/pdf";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

/** Answers the _Transit lookup and anything a test does not script itself. */
function driveResponder(extra: (c: GCall) => unknown = () => undefined) {
  return (c: GCall) => {
    const answer = extra(c);
    if (answer !== undefined) return answer;
    if (c.op === "getJson" && c.url === DRIVE_FILES && String(c.query?.q).includes("'_Transit'")) {
      return { files: [{ id: "FAKEtransit01" }] };
    }
    throw new Error(`unscripted drive call ${c.op} ${c.url}`);
  };
}

function harness(opts: {
  canWrite?: boolean;
  drive?: (c: GCall) => unknown;
  gmail?: (c: GCall) => unknown;
  whatsapp?: unknown;
} = {}) {
  const drive = fakeGoogle(driveResponder(opts.drive));
  const gmail = fakeGoogle(opts.gmail ?? (() => {
    throw new Error("no gmail scripted");
  }));
  const resolved: [string, string | undefined][] = [];
  const audits: string[] = [];
  const ctx = {
    email: "owner@example.com",
    canWrite: opts.canWrite ?? true,
    async googleClient(service: string, account?: string) {
      resolved.push([service, account]);
      return (service === "drive" ? drive.client : gmail.client) as never;
    },
    async whatsappBridge() {
      return opts.whatsapp as never;
    },
    async freeagentClient() {
      throw new Error("no freeagent scripted");
    },
    transitCache: fakeVault(),
    async signFileUrl(req: Parameters<GatewayToolContext["signFileUrl"]>[0]) {
      const { token, grant } = await signToken(KEY, grants, { ...req, userId: "owner@example.com" });
      return { url: fileUrl(ORIGIN, token), expiresAt: grant.exp };
    },
    async audit(tool: string, summary: string) {
      audits.push(`${tool}: ${summary}`);
    },
  } as unknown as GatewayToolContext;

  const tools = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  registerFileReadTools(server, ctx);
  registerFileWriteTools(server, ctx);

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await tools.get(name)!(args, {});
    const text = result.content[0]!.text;
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // error text
    }
    return { isError: result.isError === true, text, body };
  };
  return { call, drive, gmail, resolved, audits };
}

async function tokenPayload(url: string, method: "GET" | "PUT") {
  const token = url.slice(`${ORIGIN}/files/`.length);
  // The URL itself must say nothing about whose file it is or where it goes.
  expect(url).not.toContain("owner@example.com");
  expect(url).not.toContain("FAKE");
  const verified = await verifyToken(KEY, grants, token, method);
  if (!verified.ok) throw new Error(`token did not verify: ${verified.reason}`);
  return verified.grant;
}

describe("file_stat", () => {
  it("reports a Drive file's metadata without downloading it", async () => {
    const { call, drive, resolved } = harness({
      drive: (c) =>
        c.op === "getJson" && c.url === `${DRIVE_FILES}/FAKEfile01`
          ? { id: "FAKEfile01", name: "lease.pdf", mimeType: PDF, size: "1234", md5Checksum: "abc", parents: ["FAKEpara"] }
          : undefined,
    });
    const { isError, body } = await call("file_stat", { ref: "drive:FAKEfile01?account=work@example.com" });
    expect(isError).toBe(false);
    expect(body).toEqual({
      ref: "drive:FAKEfile01?account=work@example.com",
      name: "lease.pdf",
      mimeType: PDF,
      size: 1234,
      md5: "abc",
    });
    // The ref's account wins, resolved through the drive service's own checks.
    expect(resolved).toEqual([["drive", "work@example.com"]]);
    expect(drive.calls.map((c) => c.op)).toEqual(["getJson"]);
  });

  it("releases the WhatsApp stream a stat had to open", async () => {
    let cancelled = false;
    const whatsapp = {
      async openMedia() {
        const body = new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        });
        return { filename: "scan.pdf", mimeType: PDF, size: 3, body };
      },
    };
    const { call } = harness({ whatsapp });
    const { body } = await call("file_stat", { ref: "wa:447700900000@s.whatsapp.net/FAKEWAMSG01" });
    expect(body).toMatchObject({ name: "scan.pdf", size: 3 });
    expect(cancelled).toBe(true);
  });

  it("explains a malformed ref instead of failing opaquely", async () => {
    const { call } = harness();
    const { isError, text } = await call("file_stat", { ref: "dropbox:xyz" });
    expect(isError).toBe(true);
    expect(text).toMatch(/drive:|gmail:|wa:/);
  });
});

describe("file_transfer", () => {
  it("refuses a WhatsApp send without confirm, before touching any service", async () => {
    const { call, resolved } = harness();
    const { isError, text } = await call("file_transfer", { from: "drive:FAKEfile01", to: "wa:send/447700900111" });
    expect(isError).toBe(true);
    expect(text).toContain("confirm");
    expect(resolved).toEqual([]);
  });

  it("moves a _Transit upload into a PARA folder, keeping its id", async () => {
    const { call, drive } = harness({
      drive: (c) => {
        if (c.op === "getJson" && c.url === `${DRIVE_FILES}/FAKEfile01`) {
          return { id: "FAKEfile01", name: "upload.pdf", mimeType: PDF, size: "9", parents: ["FAKEtransit01"] };
        }
        if (c.op === "getJson" && c.url === `${DRIVE_FILES}/FAKEtransit01`) {
          return { id: "FAKEtransit01", name: "_Transit", mimeType: "application/vnd.google-apps.folder" };
        }
        if (c.op === "sendJson" && c.method === "PATCH") return { id: "FAKEfile01", name: "2026-10-03 lease.pdf", size: "9" };
        return undefined;
      },
    });
    const { isError, body } = await call("file_transfer", {
      from: "drive:FAKEfile01",
      to: "drive:folder/FAKEpara",
      name: "2026-10-03 lease.pdf",
    });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ mode: "moved", ref: "drive:FAKEfile01", name: "2026-10-03 lease.pdf" });
    const patch = drive.calls.find((c) => c.method === "PATCH")!;
    expect(patch.query).toMatchObject({ addParents: "FAKEpara", removeParents: "FAKEtransit01" });
    expect(drive.calls.some((c) => c.op === "getStream" || c.op === "uploadToSession")).toBe(false);
  });

  it("sends to WhatsApp with confirm, passing caption and media type", async () => {
    const sends: unknown[][] = [];
    const whatsapp = {
      async sendFile(...args: unknown[]) {
        sends.push(args);
        return { ok: true, messageId: "FAKESENT1" };
      },
    };
    const { call } = harness({
      whatsapp,
      drive: (c) => {
        if (c.op === "getJson") return { id: "FAKEfile01", name: "photo.jpg", mimeType: "image/jpeg", size: "3", parents: [] };
        if (c.op === "getStream") return bytes("jpg");
        return undefined;
      },
    });
    const { isError, body } = await call("file_transfer", {
      from: "drive:FAKEfile01",
      to: "wa:send/447700900111",
      caption: "hi",
      media_type: "image",
      confirm: true,
    });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ mode: "streamed", from: "drive:FAKEfile01", to: "wa:send/447700900111" });
    expect(sends).toEqual([["447700900111", "photo.jpg", btoa("jpg"), "image", "hi"]]);
  });
});

describe("file_upload_url", () => {
  it("creates a _Transit placeholder and signs a single PUT onto it", async () => {
    const { call, drive } = harness({
      drive: (c) => (c.op === "sendJson" && c.method === "POST" ? { id: "FAKEupload01" } : undefined),
    });
    const { isError, body } = await call("file_upload_url", { name: "2026-10-03 scan.pdf", mime_type: PDF, size: 2048 });
    expect(isError).toBe(false);
    const create = drive.calls.find((c) => c.op === "sendJson")!;
    expect(create.body).toEqual({ name: "2026-10-03 scan.pdf", mimeType: PDF, parents: ["FAKEtransit01"] });
    expect(body).toMatchObject({ ref: "drive:FAKEupload01", method: "PUT", max_bytes: 2048 });
    expect(body.curl).toBe(`curl -T <path> "${body.url as string}"`);
    expect(Date.parse(body.expires_at as string)).toBeGreaterThan(Date.now());

    const payload = await tokenPayload(body.url as string, "PUT");
    expect(payload).toMatchObject({
      userId: "owner@example.com",
      account: null,
      method: "PUT",
      target: "FAKEupload01",
      maxBytes: 2048,
    });
  });

  it("refuses a size over the signed-PUT ceiling before touching Drive", async () => {
    const { call, drive } = harness();
    const { isError, text } = await call("file_upload_url", {
      name: "huge.bin",
      mime_type: "application/octet-stream",
      size: FILE_CAPS.signedPut + 1,
    });
    expect(isError).toBe(true);
    expect(text).toContain("cap is");
    expect(drive.calls).toEqual([]);
  });
});

describe("file_download_url", () => {
  it("signs a GET for a Drive file at its current size, keeping the ref's account", async () => {
    const { call, resolved } = harness({
      drive: (c) =>
        c.op === "getJson" && c.url === `${DRIVE_FILES}/FAKEfile01`
          ? { id: "FAKEfile01", name: "lease.pdf", mimeType: PDF, size: "1234", parents: [] }
          : undefined,
    });
    const { isError, body } = await call("file_download_url", { ref: "drive:FAKEfile01?account=work@example.com" });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ ref: "drive:FAKEfile01?account=work@example.com", name: "lease.pdf", size: 1234 });
    expect(body.staged).toBeUndefined();
    expect(body.curl).toBe(`curl -o <path> "${body.url as string}"`);
    expect(await tokenPayload(body.url as string, "GET")).toMatchObject({
      account: "work@example.com",
      method: "GET",
      target: "FAKEfile01",
      maxBytes: 1234,
    });
    expect(resolved).toEqual([["drive", "work@example.com"]]);
  });

  it("names the export format in the target for a native Sheet", async () => {
    const { call } = harness({
      drive: (c) =>
        c.op === "getJson" && c.url === `${DRIVE_FILES}/FAKEsheet01`
          ? { id: "FAKEsheet01", name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet", parents: [] }
          : undefined,
    });
    const { body } = await call("file_download_url", { ref: "drive:FAKEsheet01" });
    expect(body.mimeType).toBe(XLSX);
    expect(await tokenPayload(body.url as string, "GET")).toMatchObject({
      account: null,
      target: `FAKEsheet01;export=${XLSX}`,
      maxBytes: 0,
    });
  });

  const gmailScript = (c: GCall) => {
    if (c.url.endsWith("/messages/FAKEMSG01")) {
      return {
        payload: {
          mimeType: "multipart/mixed",
          parts: [{ filename: "invoice.pdf", mimeType: PDF, body: { attachmentId: "FAKEATT01", size: 7 } }],
        },
      };
    }
    if (c.url.endsWith("/attachments/FAKEATT01")) return { size: 7, data: btoa("invoice").replace(/=+$/, "") };
    throw new Error(`unscripted gmail call ${c.url}`);
  };

  it("stages a Gmail attachment into _Transit and signs a GET for the copy", async () => {
    const { call, drive, audits } = harness({
      gmail: gmailScript,
      drive: (c) => {
        if (c.op === "startResumableUpload") return "https://upload.example/session";
        if (c.op === "uploadToSession") return { id: "FAKEstaged01", name: "invoice.pdf", size: "7" };
        return undefined;
      },
    });
    const { isError, body } = await call("file_download_url", { ref: "gmail:FAKEMSG01/FAKEATT01" });
    expect(isError).toBe(false);
    expect(body).toMatchObject({
      ref: "drive:FAKEstaged01",
      source: "gmail:FAKEMSG01/FAKEATT01",
      staged: true,
      name: "invoice.pdf",
      size: 7,
    });
    const upload = drive.calls.find((c) => c.op === "startResumableUpload")!;
    expect(upload.body).toMatchObject({ parents: ["FAKEtransit01"] });
    expect(await tokenPayload(body.url as string, "GET")).toMatchObject({ target: "FAKEstaged01", maxBytes: 7 });
    expect(audits).toEqual(["file_download_url: staged gmail:FAKEMSG01/FAKEATT01 -> drive:FAKEstaged01"]);
  });

  it("refuses to stage without the write grant", async () => {
    const { call, drive } = harness({ canWrite: false, gmail: gmailScript });
    const { isError, text } = await call("file_download_url", { ref: "gmail:FAKEMSG01/FAKEATT01" });
    expect(isError).toBe(true);
    expect(text).toContain("write access");
    expect(text).toContain("gmail: ref");
    expect(drive.calls).toEqual([]);
  });

  it("names a freeagent: ref in the refusal", async () => {
    const { call, drive } = harness({ canWrite: false });
    const { isError, text } = await call("file_download_url", { ref: "freeagent:attachment/12345" });
    expect(isError).toBe(true);
    expect(text).toContain("freeagent: ref stages it in Drive");
    expect(text).not.toContain("gmail");
    expect(drive.calls).toEqual([]);
  });
});

describe("files service", () => {
  it("is registered, on by default, with no account namespace of its own", () => {
    const svc = SERVICES.find((s) => s.id === "files")!;
    expect(svc).toBeDefined();
    expect(svc.defaultEnabled).toBe(true);
    expect(svc.accountService).toBeUndefined();
  });

  it("publishes schemas the SDK can serialize, reads separate from writes", async () => {
    const server = new McpServer({ name: "probe", version: "0" });
    const ctx = {} as GatewayToolContext;
    const svc = SERVICES.find((s) => s.id === "files")!;
    svc.registerRead(server, ctx);
    const listTools = async () =>
      (
        await (
          server.server as unknown as {
            _requestHandlers: Map<
              string,
              (req: unknown, extra: unknown) => Promise<{ tools: { name: string; inputSchema: { properties?: object; required?: string[] }; annotations?: { readOnlyHint?: boolean } }[] }>
            >;
          }
        )._requestHandlers.get("tools/list")!({ method: "tools/list", params: {} }, {})
      ).tools;
    expect((await listTools()).map((t) => t.name).sort()).toEqual(["file_download_url", "file_stat"]);

    svc.registerWrite!(server, ctx);
    const tools = await listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect([...byName.keys()].sort()).toEqual(["file_download_url", "file_stat", "file_transfer", "file_upload_url"]);
    expect(byName.get("file_stat")!.annotations?.readOnlyHint).toBe(true);
    // Staging a gmail:/wa: ref writes to Drive, so it must not invite auto-approval.
    expect(byName.get("file_download_url")!.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("file_transfer")!.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("file_transfer")!.inputSchema.required!.sort()).toEqual(["from", "to"]);
    expect(byName.get("file_upload_url")!.inputSchema.required!.sort()).toEqual(["mime_type", "name", "size"]);
  });
});

// The deprecated relay pair, now thin delegations to transfer(): same input
// schema, the old Drive-file result with ref and mode alongside.
describe("relay wrappers", () => {
  async function relay(name: string, args: Record<string, unknown>, parts: { gmail?: (c: GCall) => unknown; whatsapp?: unknown }) {
    const drive = fakeGoogle((c) => {
      if (c.op === "startResumableUpload") return "https://upload.example/session";
      if (c.op === "uploadToSession") return { id: "FAKEsaved01", name: "saved", mimeType: PDF, size: String(c.size) };
      // The _Transit lookup by name, for parent_id "_Transit".
      if (c.op === "getJson" && c.url.endsWith("/files")) return { files: [{ id: "FAKEtransit01" }] };
      throw new Error(`unscripted drive call ${c.op}`);
    });
    const gmail = fakeGoogle(parts.gmail ?? (() => undefined));
    const tools = new Map<string, Handler>();
    registerRelayTools(
      { registerTool: (n: string, _c: unknown, h: Handler) => tools.set(n, h) } as unknown as McpServer,
      {
        drive: async () => drive.client as never,
        gmail: async () => gmail.client as never,
        whatsapp: async () => parts.whatsapp as never,
        vault: fakeVault(),
      },
    );
    const result = await tools.get(name)!(args, {});
    return { result, drive, body: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
  }

  it("drive_save_gmail_attachment streams into the folder under the given name", async () => {
    const { result, drive, body } = await relay(
      "drive_save_gmail_attachment",
      { message_id: "FAKEMSG01", attachment_id: "FAKEATT01", name: "2026-10-03 invoice.pdf", parent_id: "FAKEpara" },
      {
        gmail: (c) =>
          c.url.endsWith("/messages/FAKEMSG01")
            ? { payload: { parts: [{ filename: "invoice.pdf", mimeType: PDF, body: { attachmentId: "FAKEATT01", size: 7 } }] } }
            : { size: 7, data: btoa("invoice").replace(/=+$/, "") },
      },
    );
    expect(result.isError).toBeFalsy();
    expect(drive.calls[0]!.body).toEqual({ name: "2026-10-03 invoice.pdf", mimeType: PDF, parents: ["FAKEpara"] });
    expect(body).toMatchObject({ id: "FAKEsaved01", bytes: 7, relayed: true, ref: "drive:FAKEsaved01", mode: "streamed" });
  });

  it("drive_save_gmail_attachment resolves parent_id _Transit as file_transfer does", async () => {
    const { result, drive } = await relay(
      "drive_save_gmail_attachment",
      { message_id: "FAKEMSG01", attachment_id: "FAKEATT01", name: "invoice.pdf", parent_id: "_Transit" },
      {
        gmail: (c) =>
          c.url.endsWith("/messages/FAKEMSG01")
            ? { payload: { parts: [{ filename: "invoice.pdf", mimeType: PDF, body: { attachmentId: "FAKEATT01", size: 7 } }] } }
            : { size: 7, data: btoa("invoice").replace(/=+$/, "") },
      },
    );
    expect(result.isError).toBeFalsy();
    expect(drive.calls.find((c) => c.op === "startResumableUpload")!.body).toMatchObject({ parents: ["FAKEtransit01"] });
  });

  it("drive_save_whatsapp_media streams past the old inline caps, to the Drive root by default", async () => {
    const size = 3 * 1024 * 1024;
    const whatsapp = {
      async openMedia() {
        return { filename: "big.pdf", mimeType: PDF, size, body: new Response(new Uint8Array(size)).body! };
      },
    };
    const { result, drive, body } = await relay(
      "drive_save_whatsapp_media",
      { message_id: "FAKEWAMSG01", chat_jid: "447700900000@s.whatsapp.net" },
      { whatsapp },
    );
    expect(result.isError).toBeFalsy();
    expect(drive.calls[0]!.body).toEqual({ name: "big.pdf", mimeType: PDF, parents: ["root"] });
    expect(drive.calls[1]!.bytes!.byteLength).toBe(size);
    expect(body).toMatchObject({ bytes: size, relayed: true });
  });
});
