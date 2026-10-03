import { describe, expect, it } from "vitest";
import {
  encryptedLength,
  encryptForUpload,
  mediaFilename,
  MediaError,
  openDecryptedStream,
} from "../src/media";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const KEY = new Uint8Array(32).map((_, i) => (i * 11 + 5) % 256);

// The send side writes exactly WhatsApp's layout (media.test.ts proves it
// against an independent encryptor), so it doubles as the fixture here.
async function fixture(size: number, mediaType = "document") {
  const plaintext = new Uint8Array(size).map((_, i) => (i * 13) % 251);
  const upload = await encryptForUpload(plaintext, mediaType, KEY);
  return {
    plaintext,
    file: upload.body,
    descriptor: {
      mediaType,
      url: null,
      directPath: "/v/t62/fake.enc",
      mediaKeyB64: b64(upload.mediaKey),
      fileSha256B64: b64(upload.fileSha256),
      fileEncSha256B64: b64(upload.fileEncSha256),
      fileLength: size as number | null,
      mimeType: "application/pdf",
      filename: "statement.pdf",
    },
  };
}

/** Serve `file` in chunks of `chunk` bytes, with or without a Content-Length. */
function serve(file: Uint8Array, { chunk = 7, length = true }: { chunk?: number; length?: boolean } = {}) {
  const calls: { cancelled: boolean } = { cancelled: false };
  const fetcher = (async () => {
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= file.length) return controller.close();
        controller.enqueue(file.slice(offset, offset + chunk));
        offset += chunk;
      },
      cancel() {
        calls.cancelled = true;
      },
    });
    const headers = length ? { "content-length": String(file.length) } : undefined;
    return new Response(body, { headers });
  }) as typeof fetch;
  return { fetcher, calls };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<{ bytes: Uint8Array; chunks: number }> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return { bytes, chunks: parts.length };
}

/** Read until the stream errors; return how many bytes came out first. */
async function drainUntilError(stream: ReadableStream<Uint8Array>): Promise<{ got: number; error: unknown }> {
  const reader = stream.getReader();
  let got = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return { got, error: null };
      got += value.length;
    }
  } catch (error) {
    return { got, error };
  }
}

describe("encryptedLength", () => {
  it("always pads, by a whole block when already aligned", () => {
    expect(encryptedLength(0)).toBe(26);
    expect(encryptedLength(15)).toBe(26);
    expect(encryptedLength(16)).toBe(42);
    expect(encryptedLength(17)).toBe(42);
  });
});

describe("openDecryptedStream", () => {
  it.each([0, 1, 15, 16, 17, 1000, 70_000])("streams %i bytes with the exact size up front", async (size) => {
    const { plaintext, file, descriptor } = await fixture(size);
    const media = await openDecryptedStream(descriptor, { fetcher: serve(file, { chunk: 333 }).fetcher });
    expect(media.streamed).toBe(true);
    expect(media.size).toBe(size);
    expect(media.mimeType).toBe("application/pdf");
    expect(media.filename).toBe("statement.pdf");
    const { bytes } = await drain(media.body);
    expect(bytes).toEqual(plaintext);
  });

  it("handles chunks smaller than the MAC and a missing Content-Length", async () => {
    const { plaintext, file, descriptor } = await fixture(100);
    const media = await openDecryptedStream(descriptor, { fetcher: serve(file, { chunk: 3, length: false }).fetcher });
    expect(media.streamed).toBe(true);
    expect((await drain(media.body)).bytes).toEqual(plaintext);
  });

  it("returns a byte stream, the only kind Workers RPC carries", async () => {
    const { plaintext, file, descriptor } = await fixture(64);
    const media = await openDecryptedStream(descriptor, { fetcher: serve(file).fetcher });
    // A BYOB reader can only be had from a `type: "bytes"` stream.
    const reader = media.body.getReader({ mode: "byob" });
    const { value } = await reader.read(new Uint8Array(1024));
    expect(value!.length).toBeGreaterThan(0);
    expect(Array.from(value!)).toEqual(Array.from(plaintext.subarray(0, value!.length)));
    await reader.cancel();
  });

  it("withholds the last bytes when the MAC fails", async () => {
    // 32 bytes is block-aligned, so padding is a whole block and the final
    // decrypt yields nothing: the withheld bytes must come from earlier.
    const { file, descriptor } = await fixture(32);
    const bad = file.slice();
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
    const media = await openDecryptedStream(
      { ...descriptor, fileEncSha256B64: null },
      { fetcher: serve(bad, { chunk: 5 }).fetcher },
    );
    const { got, error } = await drainUntilError(media.body);
    expect(String(error)).toMatch(/MAC check failed/);
    expect(got).toBeLessThan(32);
  });

  it("errors on a tampered ciphertext via fileEncSha256", async () => {
    const { file, descriptor } = await fixture(500);
    const bad = file.slice();
    bad[3] = bad[3]! ^ 1;
    const media = await openDecryptedStream(descriptor, { fetcher: serve(bad, { chunk: 64 }).fetcher });
    const { got, error } = await drainUntilError(media.body);
    expect(error).toBeInstanceOf(MediaError);
    expect(got).toBeLessThan(500);
  });

  it("errors when the plaintext does not match fileSha256", async () => {
    const { file, descriptor } = await fixture(40);
    const media = await openDecryptedStream(
      { ...descriptor, fileSha256B64: b64(new Uint8Array(32)) },
      { fetcher: serve(file).fetcher },
    );
    const { got, error } = await drainUntilError(media.body);
    expect(String(error)).toMatch(/fileSha256/);
    expect(got).toBeLessThan(40);
  });

  it("errors on a truncated download", async () => {
    const { file, descriptor } = await fixture(200);
    const media = await openDecryptedStream(descriptor, {
      fetcher: serve(file.slice(0, 150), { length: false }).fetcher,
    });
    const { error } = await drainUntilError(media.body);
    expect(String(error)).toMatch(/ended after 150 of/);
  });

  it("errors and cancels the download when it runs past the declared length", async () => {
    const { file, descriptor } = await fixture(200);
    const long = new Uint8Array(file.length + 4096);
    long.set(file, 0);
    const served = serve(long, { chunk: 64, length: false });
    const media = await openDecryptedStream(descriptor, { fetcher: served.fetcher });
    const { error } = await drainUntilError(media.body);
    expect(String(error)).toMatch(/longer than/);
    expect(served.calls.cancelled).toBe(true);
  });

  it("refuses up front when fileLength is over the ceiling", async () => {
    const { file, descriptor } = await fixture(100);
    let fetched = false;
    const fetcher = (async () => {
      fetched = true;
      return new Response(file);
    }) as typeof fetch;
    await expect(openDecryptedStream(descriptor, { fetcher, maxBytes: 50 })).rejects.toThrow(/over the/);
    expect(fetched).toBe(false);
  });

  it("falls back to decrypting in memory when the size is unknown", async () => {
    const { plaintext, file, descriptor } = await fixture(300);
    const media = await openDecryptedStream(
      { ...descriptor, fileLength: null },
      { fetcher: serve(file).fetcher },
    );
    expect(media.streamed).toBe(false);
    expect(media.size).toBe(300);
    expect((await drain(media.body)).bytes).toEqual(plaintext);
  });

  it("falls back when fileLength contradicts the download's length", async () => {
    const { plaintext, file, descriptor } = await fixture(300);
    const media = await openDecryptedStream({ ...descriptor, fileLength: 9999 }, { fetcher: serve(file).fetcher });
    expect(media.streamed).toBe(false);
    expect(media.size).toBe(300);
    expect((await drain(media.body)).bytes).toEqual(plaintext);
  });

  it("caps the in-memory fallback before buffering", async () => {
    const { file, descriptor } = await fixture(300);
    const served = serve(file);
    await expect(
      openDecryptedStream({ ...descriptor, fileLength: null }, { fetcher: served.fetcher, maxBufferedBytes: 100 }),
    ).rejects.toThrow(/over the/);
    expect(served.calls.cancelled).toBe(true);
  });

  it("verifies the in-memory fallback too", async () => {
    const { file, descriptor } = await fixture(300);
    const bad = file.slice();
    bad[10] = bad[10]! ^ 1;
    await expect(
      openDecryptedStream({ ...descriptor, fileLength: null }, { fetcher: serve(bad).fetcher }),
    ).rejects.toThrow(/fileEncSha256/);
  });

  it("marks expired media as retryable", async () => {
    const { descriptor } = await fixture(10);
    const fetcher = (async () => new Response("gone", { status: 404 })) as typeof fetch;
    await expect(openDecryptedStream(descriptor, { fetcher })).rejects.toMatchObject({ retryable: true });
  });

  it("refuses a message without an attachment or key before fetching", async () => {
    const { descriptor } = await fixture(10);
    const fetcher = (async () => {
      throw new Error("should not fetch");
    }) as typeof fetch;
    await expect(openDecryptedStream({ ...descriptor, mediaType: null }, { fetcher })).rejects.toThrow(/no attachment/);
    await expect(openDecryptedStream({ ...descriptor, mediaKeyB64: null }, { fetcher })).rejects.toThrow(/no media key/);
    await expect(openDecryptedStream({ ...descriptor, mediaType: "hologram" }, { fetcher })).rejects.toThrow(
      /unsupported media type/,
    );
  });

  it("refuses a media URL off the WhatsApp hosts", async () => {
    const { descriptor } = await fixture(10);
    await expect(
      openDecryptedStream({ ...descriptor, directPath: null, url: "https://attacker.example/x" }),
    ).rejects.toThrow(/refusing to fetch/);
  });

  it("cancels the download when the consumer cancels", async () => {
    const { file, descriptor } = await fixture(5000);
    const served = serve(file, { chunk: 100 });
    const media = await openDecryptedStream(descriptor, { fetcher: served.fetcher });
    const reader = media.body.getReader();
    await reader.read();
    await reader.cancel("enough");
    expect(served.calls.cancelled).toBe(true);
  });
});

describe("mediaFilename", () => {
  it("keeps the sender's filename, minus path separators", () => {
    expect(mediaFilename("ID1", "document", "application/pdf", "Invoice.pdf")).toBe("Invoice.pdf");
    expect(mediaFilename("ID1", "document", "application/pdf", "../a/b.pdf")).toBe(".._a_b.pdf");
  });

  it("derives one from the type and message id otherwise", () => {
    expect(mediaFilename("3EB0FAKE", "image", "image/jpeg", null)).toBe("whatsapp-image-3EB0FAKE.jpg");
    expect(mediaFilename("3EB0FAKE", "audio", "audio/ogg; codecs=opus", "  ")).toBe("whatsapp-audio-3EB0FAKE.ogg");
    expect(mediaFilename("a/b", null, null, null)).toBe("whatsapp-media-a_b.bin");
  });
});
