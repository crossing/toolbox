import { describe, expect, it } from "vitest";
import { GoogleApiError, GoogleClient, TokenSource } from "../src/googleapi";

interface Call {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
}

/** A Google client whose token is fresh and whose fetches are scripted. */
function client(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    const body = init?.body instanceof ReadableStream ? await new Response(init.body).text() : (init?.body as string);
    const call = { url, method: init?.method, headers: { ...(init?.headers as Record<string, string>) }, body };
    calls.push(call);
    return respond(call);
  };
  const tokens = new TokenSource(
    "fake-client",
    "fake-secret",
    { accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: Date.now() + 3_600_000 },
    fetcher,
  );
  return { calls, google: new GoogleClient(tokens, fetcher) };
}

const SESSION = "https://upload.example.test/session?upload_id=FAKEsession01";

describe("GoogleClient streaming helpers", () => {
  it("getStream hands back the body unread", async () => {
    const { calls, google } = client(() => new Response("file bytes"));
    const stream = await google.getStream("https://www.googleapis.com/drive/v3/files/FAKEfile01", { alt: "media" });
    expect(await new Response(stream).text()).toBe("file bytes");
    expect(calls[0]!.url).toContain("alt=media");
    expect(calls[0]!.headers.accept).toBe("*/*");
  });

  it("getStream surfaces Google's error message", async () => {
    const { google } = client(() => new Response(JSON.stringify({ error: { message: "File not found" } }), { status: 404 }));
    await expect(google.getStream("https://www.googleapis.com/drive/v3/files/x")).rejects.toThrow(GoogleApiError);
  });

  it("startResumableUpload creates a file and returns the Location", async () => {
    const { calls, google } = client(() => new Response(null, { status: 200, headers: { location: SESSION } }));
    const uri = await google.startResumableUpload({ name: "a.pdf", parents: ["FAKEfolder01"] }, "application/pdf", 42, {
      query: { fields: "id,md5Checksum" },
    });
    expect(uri).toBe(SESSION);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    const url = new URL(call.url);
    expect(url.pathname).toBe("/upload/drive/v3/files");
    expect(url.searchParams.get("uploadType")).toBe("resumable");
    expect(url.searchParams.get("fields")).toBe("id,md5Checksum");
    expect(call.headers["x-upload-content-type"]).toBe("application/pdf");
    expect(call.headers["x-upload-content-length"]).toBe("42");
    expect(JSON.parse(call.body!)).toEqual({ name: "a.pdf", parents: ["FAKEfolder01"] });
  });

  it("startResumableUpload with fileId replaces that file's content", async () => {
    const { calls, google } = client(() => new Response(null, { status: 200, headers: { location: SESSION } }));
    await google.startResumableUpload({}, "text/plain", undefined, { fileId: "FAKEfile01" });
    expect(calls[0]!.method).toBe("PATCH");
    expect(new URL(calls[0]!.url).pathname).toBe("/upload/drive/v3/files/FAKEfile01");
    expect(calls[0]!.headers["x-upload-content-length"]).toBeUndefined();
  });

  it("startResumableUpload refuses a reply without a session", async () => {
    const { google } = client(() => new Response(null, { status: 200 }));
    await expect(google.startResumableUpload({}, "text/plain")).rejects.toThrow(/no upload session/);
  });

  it("uploadToSession streams the body and returns the file JSON", async () => {
    const { calls, google } = client(() => new Response(JSON.stringify({ id: "FAKEfile02", md5Checksum: "abc" })));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello "));
        controller.enqueue(new TextEncoder().encode("world"));
        controller.close();
      },
    });
    expect(await google.uploadToSession(SESSION, body, 11)).toEqual({ id: "FAKEfile02", md5Checksum: "abc" });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(SESSION);
    expect(calls[0]!.headers["content-length"]).toBe("11");
    expect(calls[0]!.body).toBe("hello world");
  });
});
