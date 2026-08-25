import { describe, expect, it } from "vitest";
import {
  base64ByteLength,
  buildMimeMessage,
  buildReferences,
  bytesToBase64,
  contentDisposition,
  deriveReplySubject,
  encodeAddressList,
  encodeHeaderValue,
  foldListHeader,
  normalizeBase64,
  sanitizeHeaderValue,
  wrapBase64,
  addAttachmentToMessage,
  base64UrlToBytes,
  bytesToLatin1,
  inspectMessage,
  latin1ToBytes,
  toBase64Url,
} from "../src/mime";
import { attachExportFor, exportedFilename } from "../src/drive";

// The longest line any header may occupy before folding is required.
const LINE_LIMIT = 998;

describe("encodeHeaderValue", () => {
  it("keeps every encoded-word inside the RFC 2047 75-character limit", () => {
    const long = "Ré: " + "présentation du rapport annuel ".repeat(6);
    const encoded = encodeHeaderValue(long);
    const words = encoded.split("\r\n ");
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75);
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/]+={0,2}\?=$/);
    }
  });

  it("round-trips through a decoder, chunk boundaries included", () => {
    const original = "réunion — 测试 — naïve café résumé ünïcødé ✓ 日本語のテキスト";
    const decoded = encodeHeaderValue(original)
      .split("\r\n ")
      .map((word) => {
        const body = /^=\?UTF-8\?B\?(.*)\?=$/.exec(word)?.[1] ?? "";
        return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
      });
    const joined = new Uint8Array(decoded.reduce<number[]>((acc, part) => acc.concat([...part]), []));
    expect(new TextDecoder().decode(joined)).toBe(original);
  });
});

describe("header injection", () => {
  it("strips CR/LF so a crafted recipient cannot add a header", () => {
    const msg = buildMimeMessage({
      to: "ok@example.com\r\nBcc: attacker@evil.example",
      subject: "hello\r\nX-Forged: yes",
      body: "body",
    });
    // The property that matters is line-level: the crafted text survives as
    // part of the To value, but it never becomes a header of its own.
    const headerLines = msg.split("\r\n\r\n")[0]!.split("\r\n");
    expect(headerLines.some((line) => /^Bcc:/i.test(line))).toBe(false);
    expect(headerLines.some((line) => /^X-Forged:/i.test(line))).toBe(false);
    expect(headerLines).toContain("To: ok@example.com Bcc: attacker@evil.example");
  });

  it("strips control characters from filenames and path separators", () => {
    expect(contentDisposition("../../etc/passwd")).toContain('filename=".._.._etc_passwd"');
    expect(sanitizeHeaderValue("a\r\nb")).toBe("a b");
  });
});

describe("encodeAddressList", () => {
  it("encodes display names but never the addr-spec", () => {
    expect(encodeAddressList("plain@example.com")).toBe("plain@example.com");
    expect(encodeAddressList("Ann <a@b.com>, Bo <c@d.com>")).toBe("Ann <a@b.com>, Bo <c@d.com>");
    const encoded = encodeAddressList("Björn <b@x.com>");
    expect(encoded).toMatch(/^=\?UTF-8\?B\?.+\?= <b@x\.com>$/);
    expect(encoded).toContain("<b@x.com>");
  });
});

describe("foldListHeader", () => {
  it("folds a long References chain under the line limit", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `<msg-${i}-${"x".repeat(40)}@mail.example.com>`).join(" ");
    const folded = foldListHeader("References", ids);
    const lines = folded.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(LINE_LIMIT);
    // Continuation lines must start with whitespace, or they are new headers.
    for (const line of lines.slice(1)) expect(line.startsWith(" ")).toBe(true);
    // No id is lost or split.
    expect(folded.replace(/\r\n /g, " ")).toBe(`References: ${ids}`);
  });

  it("keeps a short chain on one line", () => {
    expect(foldListHeader("References", "<a@b>")).toBe("References: <a@b>");
  });
});

describe("deriveReplySubject", () => {
  it("prefixes once and never twice", () => {
    expect(deriveReplySubject("Quarterly report")).toBe("Re: Quarterly report");
    expect(deriveReplySubject("Re: Quarterly report")).toBe("Re: Quarterly report");
    expect(deriveReplySubject("RE: Quarterly report")).toBe("RE: Quarterly report");
    expect(deriveReplySubject("re:Quarterly report")).toBe("re:Quarterly report");
  });

  it("leaves a foreign-language prefix alone rather than breaking the match", () => {
    expect(deriveReplySubject("AW: Bericht")).toBe("Re: AW: Bericht");
  });
});

describe("buildReferences", () => {
  it("appends the parent's Message-ID to its References", () => {
    expect(buildReferences("<c@x>", "<a@x> <b@x>")).toBe("<a@x> <b@x> <c@x>");
  });

  it("falls back to the Message-ID alone when the parent starts the thread", () => {
    expect(buildReferences("<c@x>", "")).toBe("<c@x>");
  });

  it("does not repeat an id a malformed thread already carries", () => {
    expect(buildReferences("<c@x>", "<a@x> <c@x>")).toBe("<a@x> <c@x>");
  });
});

describe("base64 handling", () => {
  it("normalizes url-alphabet, unpadded and whitespace-laden input", () => {
    expect(normalizeBase64("aGVsbG8=")).toBe("aGVsbG8=");
    expect(normalizeBase64("aGVsbG8")).toBe("aGVsbG8=");
    expect(normalizeBase64("aGVs\nbG8=")).toBe("aGVsbG8=");
    expect(normalizeBase64("q-_w")).toBe("q+/w");
  });

  it("rejects input that is not base64 at all", () => {
    expect(() => normalizeBase64("not base64!")).toThrow();
    expect(() => normalizeBase64("")).toThrow();
    expect(() => normalizeBase64("aGVsbG8=extra")).toThrow();
  });

  it("reports decoded length without decoding", () => {
    expect(base64ByteLength("aGVsbG8=")).toBe(5);
    expect(base64ByteLength(normalizeBase64(bytesToBase64(new Uint8Array(1000))))).toBe(1000);
  });

  it("encodes a payload larger than the argument-stack limit", () => {
    // The reason bytesToBase64 chunks: fromCharCode(...bytes) dies around here.
    const big = new Uint8Array(300_000).fill(65);
    const encoded = bytesToBase64(big);
    expect(base64ByteLength(encoded)).toBe(300_000);
  });

  it("wraps base64 at 76 columns", () => {
    const wrapped = wrapBase64("a".repeat(200));
    for (const line of wrapped.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
    expect(wrapped.replace(/\r\n/g, "")).toBe("a".repeat(200));
  });
});

describe("contentDisposition", () => {
  it("uses a bare filename for ascii names", () => {
    expect(contentDisposition("report.pdf")).toBe('Content-Disposition: attachment; filename="report.pdf"');
  });

  it("adds RFC 2231 filename* for non-ascii, keeping an ascii fallback first", () => {
    const disposition = contentDisposition("rapport-résumé.pdf");
    expect(disposition).toContain('filename="rapport-r_sum_.pdf"');
    expect(disposition).toContain("filename*=UTF-8''rapport-r%C3%A9sum%C3%A9.pdf");
    expect(disposition.indexOf('filename="')).toBeLessThan(disposition.indexOf("filename*="));
  });

  it("never emits an encoded-word in a parameter value", () => {
    expect(contentDisposition("mémo.txt")).not.toContain("=?UTF-8?");
  });
});

describe("buildMimeMessage with attachments", () => {
  const attachment = { filename: "doc.pdf", mimeType: "application/pdf", base64: normalizeBase64("JVBERi0=") };

  it("builds multipart/mixed with a base64 text part and one part per attachment", () => {
    const msg = buildMimeMessage({
      to: "a@b.com",
      subject: "With a file",
      body: "see attached",
      attachments: [attachment, { ...attachment, filename: "second.pdf" }],
    });
    const boundary = /boundary="([^"]+)"/.exec(msg)?.[1];
    expect(boundary).toMatch(/^toolbox-mcp-/);
    expect(msg).toContain("Content-Type: multipart/mixed;");
    // Body is base64 now, not 8bit: no line-length or bare-LF hazards.
    expect(msg).toContain("Content-Transfer-Encoding: base64");
    expect(msg).not.toContain("Content-Transfer-Encoding: 8bit");
    expect(msg.split(`--${boundary}`).length - 1).toBe(4); // 3 openers + closer
    expect(msg.endsWith(`--${boundary}--\r\n`)).toBe(true);
    expect(msg).toContain('filename="doc.pdf"');
    expect(msg).toContain('filename="second.pdf"');
  });

  it("is pure ascii, which is what lets it go out as a plain string", () => {
    const msg = buildMimeMessage({
      to: "Björn <b@x.com>",
      subject: "réunion — 测试",
      body: "café ☕ 日本語",
      attachments: [{ ...attachment, filename: "résumé-测试.pdf" }],
    });
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7f]*$/.test(msg)).toBe(true);
  });

  it("carries threading headers when replying", () => {
    const msg = buildMimeMessage({
      to: "a@b.com",
      subject: "Re: thing",
      body: "reply",
      inReplyTo: "<parent@x>",
      references: buildReferences("<parent@x>", "<older@x>"),
      attachments: [attachment],
    });
    expect(msg).toContain("In-Reply-To: <parent@x>");
    expect(msg).toContain("References: <older@x> <parent@x>");
  });
});

describe("attachExportFor", () => {
  it("exports native documents as something a recipient can open", () => {
    expect(attachExportFor("application/vnd.google-apps.document")).toEqual({
      mimeType: "application/pdf",
      extension: "pdf",
    });
    expect(attachExportFor("application/vnd.google-apps.spreadsheet")?.extension).toBe("xlsx");
    expect(attachExportFor("application/pdf")).toBeUndefined();
  });

  it("adds the export extension only when the name lacks it", () => {
    expect(exportedFilename("Report", "application/pdf")).toBe("Report.pdf");
    expect(exportedFilename("Report.pdf", "application/pdf")).toBe("Report.pdf");
    expect(exportedFilename("Report.PDF", "application/pdf")).toBe("Report.PDF");
  });
});

describe("addAttachmentToMessage", () => {
  const attachment = { filename: "extra.pdf", mimeType: "application/pdf", base64: normalizeBase64("JVBERi0=") };
  const CRLF = "\r\n";

  // The shape a real Gmail draft actually has: a mixed wrapper around an
  // alternative pair, plus an attachment already on it.
  const realDraft = [
    "MIME-Version: 1.0",
    "Subject: Invoice",
    "From: me@example.com",
    'Content-Type: multipart/mixed; boundary="OUTER"',
    "",
    "--OUTER",
    'Content-Type: multipart/alternative; boundary="INNER"',
    "",
    "--INNER",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    "invoice and timesheet are attached.",
    "--INNER",
    'Content-Type: text/html; charset="UTF-8"',
    "",
    "<div><b>invoice</b> and timesheet are attached.</div>",
    "--INNER--",
    "--OUTER",
    "Content-Type: application/pdf; name=\"invoice.pdf\"",
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0x",
    "--OUTER--",
    "",
  ].join(CRLF);

  it("splices into multipart/mixed, leaving every existing byte alone", () => {
    const updated = addAttachmentToMessage(realDraft, attachment);
    // The html alternative and the existing attachment survive verbatim.
    expect(updated).toContain("<div><b>invoice</b> and timesheet are attached.</div>");
    expect(updated).toContain('name="invoice.pdf"');
    expect(updated).toContain("JVBERi0x");
    expect(updated).toContain('name="extra.pdf"');
    // Same wrapper, no new nesting, closing delimiter still last.
    expect(updated).not.toContain("toolbox-mcp-");
    expect(updated.split("--OUTER--").length - 1).toBe(1);
    expect(updated.trimEnd().endsWith("--OUTER--")).toBe(true);
    // Everything before the new part is unchanged, character for character.
    const insertedAt = updated.indexOf("--OUTER" + CRLF + "Content-Type: application/pdf; name=\"extra.pdf\"");
    expect(realDraft.startsWith(updated.slice(0, insertedAt))).toBe(true);
  });

  it("demotes a multipart/alternative body into a part rather than joining it", () => {
    const alternative = [
      "Subject: Note",
      'Content-Type: multipart/alternative; boundary="INNER"',
      "",
      "--INNER",
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      "plain version",
      "--INNER",
      'Content-Type: text/html; charset="UTF-8"',
      "",
      "<p>html version</p>",
      "--INNER--",
      "",
    ].join(CRLF);

    const updated = addAttachmentToMessage(alternative, attachment);
    const shape = inspectMessage(updated);
    expect(shape.isMixed).toBe(true);
    expect(shape.boundary).toMatch(/^toolbox-mcp-/);
    // The alternative pair is intact, one level down — an attachment must not
    // become a third "alternative rendering" of the body.
    expect(updated).toContain('Content-Type: multipart/alternative; boundary="INNER"');
    expect(updated).toContain("<p>html version</p>");
    expect(updated).toContain("plain version");
    expect(updated).toContain("--INNER--");
    expect(updated).toContain('name="extra.pdf"');
    // Subject stays a message header; Content-Type travels down with the body.
    const newHeaders = updated.split(CRLF + CRLF)[0]!;
    expect(newHeaders).toContain("Subject: Note");
    expect(newHeaders).not.toContain("multipart/alternative");
  });

  it("wraps a plain text/plain draft", () => {
    const plain = [
      "To: a@b.com",
      "Subject: Simple",
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      "just some words",
    ].join(CRLF);

    const updated = addAttachmentToMessage(plain, attachment);
    expect(inspectMessage(updated).isMixed).toBe(true);
    expect(updated).toContain("just some words");
    expect(updated).toContain("Content-Transfer-Encoding: 8bit");
    expect(updated).toContain('name="extra.pdf"');
    expect(updated.split(CRLF + CRLF)[0]!).toContain("To: a@b.com");
    // MIME-Version appears once, not twice.
    expect(updated.match(/^MIME-Version:/gm)).toHaveLength(1);
  });

  it("keeps a folded header folded and finds a boundary pushed onto a continuation", () => {
    const folded = [
      "Subject: Long",
      "Content-Type: multipart/mixed;",
      '\tboundary="FOLDED"',
      "",
      "--FOLDED",
      "Content-Type: text/plain",
      "",
      "body",
      "--FOLDED--",
      "",
    ].join(CRLF);
    expect(inspectMessage(folded).boundary).toBe("FOLDED");
    const updated = addAttachmentToMessage(folded, attachment);
    expect(updated).toContain('name="extra.pdf"');
    expect(updated).not.toContain("toolbox-mcp-");
  });
});

describe("byte-exact message round-trip", () => {
  it("survives base64url -> latin1 -> bytes for content this code never decodes", () => {
    // A latin-1 8bit body: transcoding it as utf-8 anywhere would corrupt it.
    const original = new Uint8Array([72, 101, 0xe9, 0x0d, 0x0a, 0xff, 0x00, 0x80, 65]);
    const roundTripped = latin1ToBytes(bytesToLatin1(original));
    expect([...roundTripped]).toEqual([...original]);
    expect([...base64UrlToBytes(toBase64Url(original))]).toEqual([...original]);
  });
});
