import { describe, expect, it } from "vitest";
import {
  decryptMedia,
  encodeForUpload,
  encryptForUpload,
  expandMediaKey,
  fetchAndDecrypt,
  mediaUrl,
  MediaError,
  uploadEncrypted,
} from "../src/media";

// Build a ciphertext exactly the way WhatsApp does, so the decrypt path is
// tested against the real layout rather than against itself.
async function encryptLikeWhatsApp(plaintext: Uint8Array, mediaKey: Uint8Array, mediaType: string) {
  const { iv, cipherKey, macKey } = await expandMediaKey(mediaKey, mediaType);
  const aesKey = await crypto.subtle.importKey("raw", cipherKey, "AES-CBC", false, ["encrypt"]);
  const enc = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, aesKey, plaintext));
  const macInput = new Uint8Array(iv.length + enc.length);
  macInput.set(iv, 0);
  macInput.set(enc, iv.length);
  const hmacKey = await crypto.subtle.importKey("raw", macKey, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, macInput)).subarray(0, 10);
  const file = new Uint8Array(enc.length + 10);
  file.set(enc, 0);
  file.set(mac, enc.length);
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
  return {
    file,
    descriptor: {
      mediaType,
      mediaKeyB64: b64(mediaKey),
      fileSha256B64: b64(new Uint8Array(await crypto.subtle.digest("SHA-256", plaintext))),
      fileEncSha256B64: b64(new Uint8Array(await crypto.subtle.digest("SHA-256", file))),
    },
  };
}

const KEY = new Uint8Array(32).map((_, i) => (i * 7 + 3) % 256);

describe("decryptMedia", () => {
  it.each([0, 1, 15, 16, 17, 1000, 5000])("round-trips %i bytes", async (size) => {
    const plaintext = new Uint8Array(size).map((_, i) => i % 251);
    const { file, descriptor } = await encryptLikeWhatsApp(plaintext, KEY, "image");
    expect(new Uint8Array(await decryptMedia(file, descriptor))).toEqual(plaintext);
  });

  it("derives distinct keys per media type", async () => {
    const image = await expandMediaKey(KEY, "image");
    const audio = await expandMediaKey(KEY, "audio");
    expect(Buffer.from(image.cipherKey).equals(Buffer.from(audio.cipherKey))).toBe(false);
    // sticker and image share the same info string in WhatsApp's mapping
    const sticker = await expandMediaKey(KEY, "sticker");
    expect(Buffer.from(image.cipherKey).equals(Buffer.from(sticker.cipherKey))).toBe(true);
  });

  it("rejects an unknown media type", async () => {
    await expect(expandMediaKey(KEY, "hologram")).rejects.toThrow(/unsupported media type/);
  });

  it("rejects a tampered ciphertext", async () => {
    const { file, descriptor } = await encryptLikeWhatsApp(new Uint8Array([1, 2, 3]), KEY, "image");
    file[2] = file[2]! ^ 0xff;
    // fileEncSha256 catches it first; without it the MAC does.
    await expect(decryptMedia(file, descriptor)).rejects.toThrow(/fileEncSha256/);
    await expect(decryptMedia(file, { ...descriptor, fileEncSha256B64: null })).rejects.toThrow(/MAC check/);
  });

  it("rejects a truncated MAC", async () => {
    const { descriptor } = await encryptLikeWhatsApp(new Uint8Array([1]), KEY, "image");
    await expect(decryptMedia(new Uint8Array(4), descriptor)).rejects.toThrow(/too short/);
  });

  it("rejects plaintext that does not match fileSha256", async () => {
    const { file, descriptor } = await encryptLikeWhatsApp(new Uint8Array([9, 9]), KEY, "document");
    const wrong = { ...descriptor, fileSha256B64: Buffer.alloc(32).toString("base64") };
    await expect(decryptMedia(file, wrong)).rejects.toThrow(/fileSha256/);
  });

  it("needs a media key", async () => {
    await expect(
      decryptMedia(new Uint8Array(20), { mediaType: "image", mediaKeyB64: null, fileSha256B64: null, fileEncSha256B64: null }),
    ).rejects.toThrow(/no media key/);
  });
});

describe("mediaUrl", () => {
  it("prefers directPath, on the host from url when there is one", () => {
    expect(mediaUrl({ url: null, directPath: "/v/t62/x.enc" })).toBe("https://mmg.whatsapp.net/v/t62/x.enc");
    expect(mediaUrl({ url: "https://mmg-fna.whatsapp.net/v/old", directPath: "/v/t62/x.enc" })).toBe(
      "https://mmg-fna.whatsapp.net/v/t62/x.enc",
    );
  });

  it("falls back to the stored url", () => {
    expect(mediaUrl({ url: "https://mmg.whatsapp.net/v/direct", directPath: null })).toBe(
      "https://mmg.whatsapp.net/v/direct",
    );
  });

  it("complains when there is nothing to fetch", () => {
    expect(() => mediaUrl({ url: null, directPath: null })).toThrow(MediaError);
  });
});

describe("fetchAndDecrypt", () => {
  const base = { url: null, directPath: "/v/t62/x.enc", fileLength: null, mimeType: "image/jpeg", filename: null };

  it("sends the WhatsApp origin and returns the plaintext", async () => {
    const plaintext = new Uint8Array([5, 4, 3, 2, 1]);
    const { file, descriptor } = await encryptLikeWhatsApp(plaintext, KEY, "image");
    const seen: { url: string; origin: string | null }[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        origin: new Headers(init?.headers).get("origin"),
      });
      return new Response(file);
    }) as typeof fetch;

    const result = await fetchAndDecrypt({ ...base, ...descriptor }, { fetcher });
    expect(new Uint8Array(result.bytes)).toEqual(plaintext);
    expect(result.mimeType).toBe("image/jpeg");
    expect(seen[0]).toEqual({
      url: "https://mmg.whatsapp.net/v/t62/x.enc",
      origin: "https://web.whatsapp.com",
    });
  });

  it("marks expired media as retryable", async () => {
    const { descriptor } = await encryptLikeWhatsApp(new Uint8Array([1]), KEY, "image");
    const fetcher = (async () => new Response("gone", { status: 410 })) as typeof fetch;
    await expect(fetchAndDecrypt({ ...base, ...descriptor }, { fetcher })).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("reports other HTTP failures", async () => {
    const { descriptor } = await encryptLikeWhatsApp(new Uint8Array([1]), KEY, "image");
    const fetcher = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(fetchAndDecrypt({ ...base, ...descriptor }, { fetcher })).rejects.toThrow(/HTTP 500/);
  });
});

describe("the send side", () => {
  const PATHS = { image: "/mms/image", document: "/mms/document" };

  it("produces something the download path accepts", async () => {
    const plaintext = new Uint8Array(300).map((_, i) => (i * 5) % 251);
    const upload = await encryptForUpload(plaintext, "image");
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
    const back = await decryptMedia(upload.body, {
      mediaType: "image",
      mediaKeyB64: b64(upload.mediaKey),
      fileSha256B64: b64(upload.fileSha256),
      fileEncSha256B64: b64(upload.fileEncSha256),
    });
    expect(new Uint8Array(back)).toEqual(plaintext);
    expect(upload.fileLength).toBe(300);
  });

  it("base64url-encodes the upload token", () => {
    expect(encodeForUpload("ab+c/d==")).toBe("ab-c_d");
  });

  it("posts to the media host with the auth token and returns where it landed", async () => {
    const upload = await encryptForUpload(new Uint8Array([1, 2, 3]), "image");
    const seen: { url: string; method?: string; contentType: string | null }[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        method: init?.method,
        contentType: new Headers(init?.headers).get("content-type"),
      });
      return Response.json({ url: "https://mmg.whatsapp.net/v/up", direct_path: "/v/up" });
    }) as typeof fetch;

    const placed = await uploadEncrypted(
      upload,
      "image",
      { hosts: [{ hostname: "mmg.whatsapp.net" }], auth: "tok en/+" },
      PATHS,
      fetcher,
    );
    expect(placed).toEqual({ url: "https://mmg.whatsapp.net/v/up", directPath: "/v/up" });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.contentType).toBe("application/octet-stream");
    expect(seen[0]!.url).toContain("https://mmg.whatsapp.net/mms/image/");
    expect(seen[0]!.url).toContain("auth=tok%20en%2F%2B");
  });

  it("falls through to the next host and reports every failure", async () => {
    const upload = await encryptForUpload(new Uint8Array([1]), "document");
    const tried: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      tried.push(new URL(String(input)).host);
      return tried.length === 1
        ? new Response("no", { status: 503 })
        : Response.json({ direct_path: "/v/ok" });
    }) as typeof fetch;
    const placed = await uploadEncrypted(
      upload,
      "document",
      { hosts: [{ hostname: "a.example" }, { hostname: "b.example" }], auth: "t" },
      PATHS,
      fetcher,
    );
    expect(tried).toEqual(["a.example", "b.example"]);
    expect(placed.directPath).toBe("/v/ok");

    const allFail = (async () => new Response("no", { status: 500 })) as typeof fetch;
    await expect(
      uploadEncrypted(upload, "document", { hosts: [{ hostname: "a.example" }], auth: "t" }, PATHS, allFail),
    ).rejects.toThrow(/every host.*HTTP 500/s);
  });

  it("refuses a media type with no upload path", async () => {
    const upload = await encryptForUpload(new Uint8Array([1]), "image");
    await expect(
      uploadEncrypted(upload, "hologram", { hosts: [], auth: "t" }, PATHS),
    ).rejects.toThrow(/cannot upload/);
  });
});
