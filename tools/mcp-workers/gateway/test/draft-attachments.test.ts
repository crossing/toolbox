// gmail_create_draft's two additions: replying inside a thread, and carrying
// attachments (inline, or relayed server-side from a Drive account that is
// usually a different Google account from the mailbox).
//
// The transport split is the thing most worth pinning. A plain draft still goes
// out as base64url in a JSON `raw` field exactly as it always has; a draft with
// attachments goes to the media-upload host as multipart, with the Draft
// metadata part carrying threadId. Both shapes were verified against the live
// Gmail API before being written down here.

import { describe, expect, it } from "vitest";
import { GoogleApiError } from "../src/googleapi";
import { registerGmailWriteTools } from "../src/gmail";

interface Call {
  method: string;
  url: string;
  contentType?: string;
  body?: unknown;
  query?: unknown;
}

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

const PARENT_ID = "PARENT_MSG";
const PARENT = {
  threadId: "THREAD1",
  payload: {
    headers: [
      { name: "Message-ID", value: "<parent@mail.example.com>" },
      { name: "References", value: "<older@mail.example.com>" },
      { name: "Subject", value: "Contract for review" },
    ],
  },
};

interface HarnessOptions {
  driveMeta?: { name?: string; mimeType?: string; size?: string };
  driveBytes?: Uint8Array;
  driveError?: GoogleApiError;
  parentError?: GoogleApiError;
}

function harness(opts: HarnessOptions = {}) {
  const calls: Call[] = [];
  const driveCalls: Call[] = [];

  const gmail = {
    async getJson(url: string, query?: unknown) {
      calls.push({ method: "GET", url, query });
      if (opts.parentError) throw opts.parentError;
      return PARENT;
    },
    async sendJson(method: string, url: string, body: unknown, query?: unknown) {
      calls.push({ method, url, body, query });
      return { id: "DRAFT1", message: { id: "MSG1" } };
    },
    async sendBody(method: string, url: string, contentType: string, body: string, query?: unknown) {
      calls.push({ method, url, contentType, body, query });
      return { id: "DRAFT1", message: { id: "MSG1" } };
    },
  };

  const drive = {
    async getJson(url: string, query?: unknown) {
      driveCalls.push({ method: "GET", url, query });
      if (opts.driveError) throw opts.driveError;
      return opts.driveMeta ?? { name: "contract.pdf", mimeType: "application/pdf", size: "9" };
    },
    async getRaw(url: string, query?: unknown) {
      driveCalls.push({ method: "GET", url, query });
      const bytes = opts.driveBytes ?? new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10]);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };

  const tools = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      tools.set(name, handler);
    },
  };
  registerGmailWriteTools(server as never, (async () => gmail) as never, (async () => drive) as never);
  return { calls, driveCalls, tools };
}

async function createDraft(tools: Map<string, Handler>, args: Record<string, unknown>) {
  const result = await tools.get("gmail_create_draft")!(args, {});
  return { isError: result.isError === true, text: result.content[0]!.text };
}

/** The message/rfc822 part of a multipart upload body. */
function rfc822From(body: string): string {
  const marker = "Content-Type: message/rfc822\r\n\r\n";
  return body.slice(body.indexOf(marker) + marker.length);
}

describe("gmail_create_draft — the existing plain path", () => {
  it("still posts base64url raw as JSON, with no upload host in sight", async () => {
    const { calls, tools } = harness();
    const { isError } = await createDraft(tools, { to: "a@b.com", subject: "Hi", body: "hello" });

    expect(isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
    expect(calls[0]!.url).not.toContain("/upload/");
    const message = (calls[0]!.body as { message: { raw: string; threadId?: string } }).message;
    expect(message.raw).not.toMatch(/[+/=]/);
    expect(message.threadId).toBeUndefined();
  });

  it("refuses a draft with no subject and nothing to derive one from", async () => {
    const { calls, tools } = harness();
    const { isError, text } = await createDraft(tools, { to: "a@b.com", body: "hello" });
    expect(isError).toBe(true);
    expect(text).toContain("subject is required");
    expect(calls).toHaveLength(0);
  });
});

describe("gmail_create_draft — replying in a thread", () => {
  it("reads the parent's headers and sets threading itself", async () => {
    const { calls, tools } = harness();
    const { isError, text } = await createDraft(tools, {
      to: "a@b.com",
      body: "my reply",
      in_reply_to_message_id: PARENT_ID,
    });

    expect(isError).toBe(false);
    // Cheap fetch: metadata only, and only the three headers it needs.
    expect(calls[0]!.query).toMatchObject({
      format: "metadata",
      metadataHeaders: ["Message-ID", "References", "Subject"],
    });
    const message = (calls[1]!.body as { message: { raw: string; threadId?: string } }).message;
    expect(message.threadId).toBe("THREAD1");
    const raw = Buffer.from(message.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(raw).toContain("In-Reply-To: <parent@mail.example.com>");
    expect(raw).toContain("References: <older@mail.example.com> <parent@mail.example.com>");
    // Gmail threads only when the subject matches, so it is derived.
    expect(raw).toContain("Subject: Re: Contract for review");
  });

  it("lets an explicit subject win over the derived one", async () => {
    const { calls, tools } = harness();
    await createDraft(tools, {
      to: "a@b.com",
      body: "x",
      subject: "Something else entirely",
      in_reply_to_message_id: PARENT_ID,
    });
    const message = (calls[1]!.body as { message: { raw: string } }).message;
    const raw = Buffer.from(message.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(raw).toContain("Subject: Something else entirely");
  });

  it("names the id and the mailbox when the parent is not found, and creates nothing", async () => {
    const { calls, tools } = harness({ parentError: new GoogleApiError(404, "Requested entity was not found.") });
    const { isError, text } = await createDraft(tools, {
      to: "a@b.com",
      body: "x",
      in_reply_to_message_id: PARENT_ID,
    });

    expect(isError).toBe(true);
    expect(text).toContain(PARENT_ID);
    expect(text).toContain("per-account");
    expect(text).not.toBe("Requested entity was not found.");
    // Nothing was created: the parent lookup happens before anything else.
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("refuses a thread_id that contradicts the parent rather than guessing", async () => {
    const { calls, tools } = harness();
    const { isError, text } = await createDraft(tools, {
      to: "a@b.com",
      body: "x",
      in_reply_to_message_id: PARENT_ID,
      thread_id: "SOME_OTHER_THREAD",
    });

    expect(isError).toBe(true);
    expect(text).toContain("SOME_OTHER_THREAD");
    expect(text).toContain("THREAD1");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

describe("gmail_create_draft — inline attachments", () => {
  it("switches to the media-upload host with threadId in the metadata part", async () => {
    const { calls, tools } = harness();
    const { isError } = await createDraft(tools, {
      to: "a@b.com",
      body: "see attached",
      in_reply_to_message_id: PARENT_ID,
      attachments: [{ filename: "note.txt", mime_type: "text/plain", base64: "aGVsbG8=" }],
    });

    expect(isError).toBe(false);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts");
    expect(post.query).toMatchObject({ uploadType: "multipart" });
    expect(post.contentType).toMatch(/^multipart\/related; boundary=toolbox-mcp-/);
    const body = String(post.body);
    expect(body).toContain('{"message":{"threadId":"THREAD1"}}');
    const rfc822 = rfc822From(body);
    expect(rfc822).toContain("Content-Type: multipart/mixed;");
    expect(rfc822).toContain('filename="note.txt"');
    expect(rfc822).toContain("aGVsbG8=");
  });

  it("rejects data that is not base64 before it can reach a recipient corrupt", async () => {
    const { calls, tools } = harness();
    const { isError, text } = await createDraft(tools, {
      to: "a@b.com",
      subject: "s",
      body: "b",
      attachments: [{ filename: "bad.bin", mime_type: "application/octet-stream", base64: "not base64!!" }],
    });
    expect(isError).toBe(true);
    expect(text).toContain("bad.bin");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("points an oversized inline attachment at Drive instead", async () => {
    const { tools } = harness();
    const huge = "A".repeat(8 * 1024 * 1024); // ~6 MB decoded, over the 5 MB inline cap
    const { isError, text } = await createDraft(tools, {
      to: "a@b.com",
      subject: "s",
      body: "b",
      attachments: [{ filename: "big.bin", mime_type: "application/octet-stream", base64: huge }],
    });
    expect(isError).toBe(true);
    expect(text).toContain("drive_attachments");
  });
});

describe("gmail_create_draft — attachments relayed from Drive", () => {
  it("fetches with the Drive account and attaches with the mail account", async () => {
    const { calls, driveCalls, tools } = harness();
    const { isError, text } = await createDraft(tools, {
      to: "a@b.com",
      subject: "Contract",
      body: "attached",
      drive_attachments: [{ file_id: "FILE1" }],
      drive_account: "personal@example.com",
    });

    expect(isError).toBe(false);
    // The bytes went Drive -> Worker -> Gmail without a tool result carrying them.
    expect(driveCalls.some((c) => c.url.endsWith("/files/FILE1"))).toBe(true);
    expect(text).not.toContain("JVBERi");
    expect(JSON.parse(text)).toMatchObject({
      attachments: [{ filename: "contract.pdf", mimeType: "application/pdf" }],
      attachmentBytes: 9,
    });
    const body = String(calls.find((c) => c.method === "POST")!.body);
    expect(rfc822From(body)).toContain('filename="contract.pdf"');
  });

  it("exports a Google Doc as a PDF rather than attaching nothing", async () => {
    const { calls, driveCalls, tools } = harness({
      driveMeta: { name: "Offer letter", mimeType: "application/vnd.google-apps.document" },
    });
    const { isError, text } = await createDraft(tools, {
      to: "a@b.com",
      subject: "Offer",
      body: "attached",
      drive_attachments: [{ file_id: "DOC1" }],
    });

    expect(isError).toBe(false);
    const exportCall = driveCalls.find((c) => c.url.endsWith("/export"))!;
    expect(exportCall.query).toMatchObject({ mimeType: "application/pdf" });
    expect(JSON.parse(text).attachments[0]).toMatchObject({
      filename: "Offer letter.pdf",
      mimeType: "application/pdf",
    });
    expect(rfc822From(String(calls.find((c) => c.method === "POST")!.body))).toContain("Content-Type: application/pdf");
  });

  it("says which account it looked in when the file id belongs to another one", async () => {
    const { calls, tools } = harness({ driveError: new GoogleApiError(404, "File not found: FILE1.") });
    const { isError, text } = await createDraft(tools, {
      to: "a@b.com",
      subject: "s",
      body: "b",
      drive_attachments: [{ file_id: "FILE1" }],
      drive_account: "personal@example.com",
    });

    expect(isError).toBe(true);
    // The bare Drive 404 reads as "bad id" when the real cause is "wrong
    // credentials" — the rewrite has to name the account and the way out.
    expect(text).toContain('"personal@example.com" Drive account');
    expect(text).toContain("drive_account");
    expect(text).toContain("gateway_list_accounts");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("names the default account when no drive_account was given", async () => {
    const { tools } = harness({ driveError: new GoogleApiError(404, "File not found: FILE1.") });
    const { text } = await createDraft(tools, {
      to: "a@b.com",
      subject: "s",
      body: "b",
      drive_attachments: [{ file_id: "FILE1" }],
    });
    expect(text).toContain("the default Drive account");
  });

  it("distinguishes a file it may not read from one it cannot find", async () => {
    const { tools } = harness({ driveError: new GoogleApiError(403, "Insufficient permissions") });
    const { isError, text } = await createDraft(tools, {
      to: "a@b.com",
      subject: "s",
      body: "b",
      drive_attachments: [{ file_id: "FILE1" }],
    });
    expect(isError).toBe(true);
    expect(text).toContain("may not read it");
    expect(text).toContain("Share it");
  });

  it("refuses more attachments than it will hold", async () => {
    const { tools } = harness();
    const { isError, text } = await createDraft(tools, {
      to: "a@b.com",
      subject: "s",
      body: "b",
      drive_attachments: Array.from({ length: 11 }, (_, i) => ({ file_id: `F${i}` })),
    });
    expect(isError).toBe(true);
    expect(text).toContain("at most 10 attachments");
  });

  it("refuses a Drive file too big for Gmail's 25 MB ceiling", async () => {
    const { calls, tools } = harness({
      driveMeta: { name: "huge.zip", mimeType: "application/zip", size: String(20 * 1024 * 1024) },
    });
    const { isError, text } = await createDraft(tools, {
      to: "a@b.com",
      subject: "s",
      body: "b",
      drive_attachments: [{ file_id: "BIG" }],
    });
    expect(isError).toBe(true);
    expect(text).toContain("huge.zip");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});
