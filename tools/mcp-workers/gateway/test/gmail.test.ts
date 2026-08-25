import { describe, expect, it } from "vitest";
import {
  buildMimeMessage,
  decodeBase64UrlText,
  encodeHeaderValue,
  headerValue,
  parsePayload,
  toBase64Url,
  type GmailPart,
} from "../src/gmail";
import { bytesToText, exportMimeFor } from "../src/drive";

describe("base64url", () => {
  it("round-trips utf-8 text without padding or +/ chars", () => {
    const text = "héllo → wörld?";
    const encoded = toBase64Url(text);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(decodeBase64UrlText(encoded)).toBe(text);
  });
});

describe("encodeHeaderValue", () => {
  it("leaves ascii alone and RFC2047-encodes the rest", () => {
    expect(encodeHeaderValue("plain subject")).toBe("plain subject");
    expect(encodeHeaderValue("héllo")).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
  });
});

describe("buildMimeMessage without attachments", () => {
  it("still builds exactly the plain-text message this server always sent", () => {
    const msg = buildMimeMessage({ to: "a@b.com", subject: "Hi", body: "line1\nline2" });
    expect(msg).toContain("To: a@b.com\r\n");
    expect(msg).toContain("Content-Type: text/plain; charset=\"UTF-8\"");
    expect(msg).toContain("Content-Transfer-Encoding: 8bit");
    expect(msg).not.toContain("Cc:");
    expect(msg).not.toContain("multipart/mixed");
    expect(msg).toMatch(/\r\n\r\nline1\nline2$/);
    const withCc = buildMimeMessage({ to: "a@b.com", cc: "c@d.com", bcc: "e@f.com", subject: "s", body: "b" });
    expect(withCc).toContain("Cc: c@d.com\r\n");
    expect(withCc).toContain("Bcc: e@f.com\r\n");
  });
});

describe("parsePayload", () => {
  const payload: GmailPart = {
    mimeType: "multipart/mixed",
    headers: [{ name: "Subject", value: "s" }],
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: toBase64Url("the text body") } },
          { mimeType: "text/html", body: { data: toBase64Url("<b>html</b>") } },
        ],
      },
      {
        mimeType: "application/pdf",
        filename: "doc.pdf",
        body: { attachmentId: "att1", size: 1234 },
      },
    ],
  };

  it("prefers text/plain and collects attachments", () => {
    const parsed = parsePayload(payload);
    expect(parsed.body).toBe("the text body");
    expect(parsed.bodyMimeType).toBe("text/plain");
    expect(parsed.attachments).toEqual([
      { filename: "doc.pdf", mimeType: "application/pdf", attachmentId: "att1", size: 1234 },
    ]);
  });

  it("falls back to html when no plain part exists", () => {
    const htmlOnly: GmailPart = {
      mimeType: "text/html",
      body: { data: toBase64Url("<p>only html</p>") },
    };
    const parsed = parsePayload(htmlOnly);
    expect(parsed.body).toBe("<p>only html</p>");
    expect(parsed.bodyMimeType).toBe("text/html");
  });

  it("caps very long bodies", () => {
    const long: GmailPart = { mimeType: "text/plain", body: { data: toBase64Url("x".repeat(30000)) } };
    const parsed = parsePayload(long);
    expect(parsed.body.length).toBeLessThan(30000);
    expect(parsed.body).toContain("[truncated]");
  });
});

describe("headerValue", () => {
  it("is case-insensitive and defaults empty", () => {
    expect(headerValue([{ name: "FROM", value: "x@y.z" }], "from")).toBe("x@y.z");
    expect(headerValue(undefined, "Subject")).toBe("");
  });
});

describe("drive helpers", () => {
  it("maps Google-native mimetypes to text exports", () => {
    expect(exportMimeFor("application/vnd.google-apps.document")).toBe("text/plain");
    expect(exportMimeFor("application/vnd.google-apps.spreadsheet")).toBe("text/csv");
    expect(exportMimeFor("application/pdf")).toBeUndefined();
  });

  it("decodes utf-8 content and falls back to base64", () => {
    expect(bytesToText(new TextEncoder().encode("plain text").buffer as ArrayBuffer)).toEqual({ text: "plain text" });
    const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x80]).buffer as ArrayBuffer;
    const result = bytesToText(binary);
    expect(result).toHaveProperty("base64");
  });
});
