// Gmail resolves to the work account and Drive to the personal one, so an
// attachment cannot be saved across — it comes down as base64 and goes back up
// as bytes. These tests pin the upload half of that, because getting it subtly
// wrong produces a file that exists, has the right name, and is unopenable.

import { describe, expect, it } from "vitest";
import { registerDriveWriteTools } from "../src/drive";

interface Call {
  method: string;
  url: string;
  contentType?: string;
  body?: unknown;
  query?: unknown;
}

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function harness() {
  const calls: Call[] = [];
  const client = {
    async sendJson(method: string, url: string, body: unknown, query?: unknown) {
      calls.push({ method, url, body, query });
      return { id: "FILE1" };
    },
    async sendBody(method: string, url: string, contentType: string, body: string, query?: unknown) {
      calls.push({ method, url, contentType, body, query });
      return { id: "FILE1" };
    },
  };
  const tools = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      tools.set(name, handler);
    },
  };
  registerDriveWriteTools(server as never, (async () => client) as never);
  return { calls, tools };
}

const PDF_B64 = "JVBERi0xLjQKJcOkw7zDtsOfCg==";

describe("drive_create_file", () => {
  it("sends binary as a base64-encoded multipart part with its real mime type", async () => {
    const { calls, tools } = harness();
    await tools.get("drive_create_file")!(
      { name: "invoice.pdf", parent_id: "PARENT", base64: PDF_B64, mime_type: "application/pdf" },
      {},
    );

    expect(calls).toHaveLength(1);
    const body = String(calls[0]!.body);
    expect(calls[0]!.contentType).toMatch(/^multipart\/related; boundary=toolbox-mcp-/);
    expect(calls[0]!.query).toMatchObject({ uploadType: "multipart" });
    // Without this header Drive stores the base64 *as text* — a PDF that opens
    // in a text editor and nowhere else.
    expect(body).toContain("Content-Transfer-Encoding: base64");
    expect(body).toContain("Content-Type: application/pdf");
    expect(body).toContain(PDF_B64);
    expect(body).not.toContain("text/plain");
    expect(body).toContain('"parents":["PARENT"]');
    // Parts are CRLF-delimited; a bare \n makes Google reject the upload.
    expect(body.split("\r\n").length).toBeGreaterThan(8);
  });

  it("still sends text as text", async () => {
    const { calls, tools } = harness();
    await tools.get("drive_create_file")!({ name: "note.md", content: "# hello" }, {});
    const body = String(calls[0]!.body);
    expect(body).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(body).toContain("# hello");
    expect(body).not.toContain("Content-Transfer-Encoding");
  });

  it("creates a folder when neither content nor base64 is given", async () => {
    const { calls, tools } = harness();
    await tools.get("drive_create_file")!({ name: "Sale Pack" }, {});
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toMatchObject({ mimeType: "application/vnd.google-apps.folder" });
  });

  it("defaults an unlabelled binary to octet-stream rather than guessing", async () => {
    const { calls, tools } = harness();
    await tools.get("drive_create_file")!({ name: "blob", base64: PDF_B64 }, {});
    expect(String(calls[0]!.body)).toContain("Content-Type: application/octet-stream");
  });

  it("refuses both at once instead of silently picking one", async () => {
    const { calls, tools } = harness();
    const result = await tools.get("drive_create_file")!({ name: "x", content: "a", base64: PDF_B64 }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/not both/);
    expect(calls).toHaveLength(0);
  });
});

describe("drive_update_file", () => {
  it("replaces a file body with binary", async () => {
    const { calls, tools } = harness();
    await tools.get("drive_update_file")!({ file_id: "F9", base64: PDF_B64, mime_type: "image/jpeg" }, {});
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toContain("/files/F9");
    expect(String(calls[0]!.body)).toContain("Content-Transfer-Encoding: base64");
    expect(String(calls[0]!.body)).toContain("Content-Type: image/jpeg");
  });

  it("moves without touching content", async () => {
    const { calls, tools } = harness();
    await tools.get("drive_update_file")!(
      { file_id: "F9", add_parent_id: "NEW", remove_parent_id: "OLD" },
      {},
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toMatchObject({ addParents: "NEW", removeParents: "OLD" });
  });

  it("says so when asked to do nothing", async () => {
    const { tools } = harness();
    const result = await tools.get("drive_update_file")!({ file_id: "F9" }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/nothing to update/);
  });
});
