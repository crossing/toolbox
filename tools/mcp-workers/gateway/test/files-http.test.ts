// The /files/<token> route end to end, with a fake vault and a scripted
// network: the token is the whole credential, so what matters is what each
// kind of bad token gets back, that a PUT URL works exactly once, that size
// limits bite before any bytes move, and that nothing secret is echoed.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptJson, importVaultKey, signToken as signCookie } from "../src/crypto";
import type { Env } from "../src/env";
import { contentDisposition, fileUrl, grantShardName, grantStoreFor, handleFilesRequest, pinDriveAccount } from "../src/files/http";
import { claimGrant, getGrant, putGrant, signToken, type SignRequest } from "../src/files/signed";
import { FILE_CAPS } from "../src/files/types";
import { TokenBroker, type AccessTokenOptions, type TokenService } from "../src/tokencache";
import { makeFakeSql, type FakeSql } from "./sqlfake";

const FILES_KEY = "fake-files-url-key";
const VAULT_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const USER = "owner@example.test";
const SESSION = "https://upload.example.test/session?upload_id=FAKEsession01";
const DRIVE = "https://www.googleapis.com/drive/v3/files";

// The grant shards: one SQL table per shard name, shared by every harness in
// a test, as the real "files-url-grants/<n>" Durable Objects are shared by
// every request. Each is a UserVault-shaped stub running the real grant SQL.
let shards = new Map<string, FakeSql>();
function grantShard(name: string) {
  let sql = shards.get(name);
  if (!sql) shards.set(name, (sql = makeFakeSql()));
  const db = sql;
  return {
    putFileGrant: async (jti: string, grant: Parameters<typeof putGrant>[2], now: number) => putGrant(db, jti, grant, now),
    getFileGrant: async (jti: string, now: number) => getGrant(db, jti, now),
    claimFileGrant: async (jti: string, now: number) => claimGrant(db, jti, now),
  };
}
const isShard = (name: string) => name.startsWith("files-url-grants/");
beforeEach(() => {
  shards = new Map();
});
afterEach(() => {
  for (const sql of shards.values()) sql.close();
});

/** An Env whose USER_VAULT routes shard names to the grant stubs and anything else to `vault`. */
function vaultNamespace(vault: unknown) {
  return {
    idFromName: (name: string) => name,
    get: (id: string) => (isShard(id) ? grantShard(id) : vault),
  };
}
const issuingEnv = { USER_VAULT: vaultNamespace(null) } as unknown as Env;

interface Call {
  url: string;
  method: string;
  body?: string;
}

interface Harness {
  env: Env;
  calls: Call[];
  call(request: Request): Promise<Response>;
}

async function harness(
  opts: { driveEnabled?: boolean; filesEnabled?: boolean; allowed?: string; linked?: boolean; respond?: (call: Call) => Response } = {},
): Promise<Harness> {
  let ciphertext = await encryptJson(await importVaultKey(VAULT_KEY), { refreshToken: "fake-refresh" });
  // The vault's token cache runs for real over this one account row, so the
  // route's token-endpoint calls still land in `calls` below.
  const accounts = {
    getAccount: () => ({ label: USER, ciphertext }),
    replaceAccountCiphertext: (_s: string, _l: string, expected: string, next: string) => {
      if (expected !== ciphertext) return false;
      ciphertext = next;
      return true;
    },
  };
  let broker: TokenBroker | undefined;
  const vault = {
    isServiceEnabled: async (service: string) => (service === "files" ? (opts.filesEnabled ?? true) : (opts.driveEnabled ?? true)),
    getAccountForService: async () => (opts.linked === false ? null : { label: USER, ciphertext }),
    accessToken: (service: TokenService, label: string, o?: AccessTokenOptions) => broker!.accessToken(service, label, o),
  };
  const env = {
    FILES_URL_KEY: FILES_KEY,
    ALLOWED_EMAILS: opts.allowed ?? `other@example.test, ${USER.toUpperCase()}`,
    VAULT_KEY,
    GWS_CLIENT_ID: "fake-client",
    GWS_CLIENT_SECRET: "fake-secret",
    USER_VAULT: vaultNamespace(vault),
  } as unknown as Env;

  const calls: Call[] = [];
  const respond =
    opts.respond ??
    ((c: Call) => {
      const url = new URL(c.url);
      if (url.hostname === "oauth2.googleapis.com") {
        return Response.json({ access_token: "fake-access", expires_in: 3600 });
      }
      if (c.url.startsWith(SESSION)) {
        return Response.json({ id: "FAKEfile01", name: "upload.pdf", mimeType: "application/pdf", size: String(c.body?.length ?? 0), md5Checksum: "fakemd5" });
      }
      if (url.pathname.startsWith("/upload/")) return new Response(null, { headers: { location: SESSION } });
      if (url.searchParams.get("alt") === "media") return new Response("file bytes");
      if (url.pathname.endsWith("/export")) return new Response("%PDF-fake");
      if (url.pathname.endsWith("/FAKEdoc01")) {
        return Response.json({ id: "FAKEdoc01", name: "Notes", mimeType: "application/vnd.google-apps.document" });
      }
      return Response.json({ id: "FAKEfile01", name: "report é.pdf", mimeType: "application/pdf", size: "10" });
    });
  const fetcher = async (url: string, init?: RequestInit) => {
    const body = init?.body instanceof ReadableStream ? await new Response(init.body).text() : (init?.body as string | undefined);
    const c = { url, method: init?.method ?? "GET", body };
    calls.push(c);
    return respond(c);
  };
  broker = new TokenBroker(accounts, env, fetcher);
  return { env, calls, call: async (request) => (await handleFilesRequest(request, env, { fetcher }))! };
}

async function token(overrides: Partial<SignRequest> = {}, now?: () => number): Promise<string> {
  const req: SignRequest = { userId: USER, method: "GET", target: "FAKEfile01", maxBytes: 10, ...overrides };
  return (await signToken(FILES_KEY, grantStoreFor(issuingEnv), req, now)).token;
}

const url = (t: string) => fileUrl("https://mcp.example.test/", t);

function put(t: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(url(t), {
    method: "PUT",
    body,
    headers: { "content-length": String(new TextEncoder().encode(body).byteLength), ...headers },
  });
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

describe("routing and the healthcheck", () => {
  it("ignores paths outside /files/", async () => {
    const h = await harness();
    expect(await handleFilesRequest(new Request("https://mcp.example.test/mcp"), h.env)).toBeNull();
  });

  it("answers GET and HEAD /files/healthcheck with an empty 204, no token needed", async () => {
    const h = await harness();
    for (const method of ["GET", "HEAD"]) {
      const res = await h.call(new Request(url("healthcheck"), { method }));
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
    expect(h.calls).toHaveLength(0);
  });

  it("refuses other methods on the healthcheck and on tokens", async () => {
    const h = await harness();
    expect((await h.call(new Request(url("healthcheck"), { method: "POST" }))).status).toBe(405);
    const res = await h.call(new Request(url(await token()), { method: "DELETE" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("PUT");
  });

  it("404s an empty or nested token path", async () => {
    const h = await harness();
    expect((await h.call(new Request("https://mcp.example.test/files/"))).status).toBe(404);
    expect((await h.call(new Request(url("a.b/c")))).status).toBe(404);
  });
});

describe("bad tokens", () => {
  it("refuses garbage and forged tokens with 403, without echoing them", async () => {
    const h = await harness();
    const good = await token();
    const forged = `${good.split(".")[0]}.${"A".repeat(43)}`;
    for (const t of ["not-a-token", forged]) {
      const res = await h.call(new Request(url(t)));
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).not.toContain(t);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a token signed with another key", async () => {
    const h = await harness();
    const { token: other } = await signToken("some-other-key", grantStoreFor(issuingEnv), { userId: USER, method: "GET", target: "x", maxBytes: 1 });
    expect((await h.call(new Request(url(other)))).status).toBe(403);
  });

  it("refuses a round-1 self-describing token outright with 403", async () => {
    const h = await harness();
    const roundOne = await signCookie(FILES_KEY, { v: 1, userId: USER, account: null, method: "GET", target: "FAKEfile01", maxBytes: 10, exp: Date.now() + 60_000, jti: "0".repeat(32) });
    expect((await h.call(new Request(url(roundOne)))).status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it("answers an expired token with 410", async () => {
    const h = await harness();
    const t = await token({}, () => Date.now() - 16 * 60 * 1000);
    const res = await h.call(new Request(url(t)));
    expect(res.status).toBe(410);
    expect(await errorOf(res)).toMatch(/expired/);
  });

  it("refuses a GET URL used for PUT, and the reverse, with 405", async () => {
    const h = await harness();
    expect((await h.call(put(await token(), "x"))).status).toBe(405);
    expect((await h.call(new Request(url(await token({ method: "PUT" }))))).status).toBe(405);
  });

  it("answers 503 when FILES_URL_KEY is not set", async () => {
    const h = await harness();
    (h.env as { FILES_URL_KEY?: string }).FILES_URL_KEY = "";
    expect((await h.call(new Request(url(await token()))))).toHaveProperty("status", 503);
  });
});

describe("GET", () => {
  it("streams alt=media with type, length and an RFC 6266 disposition", async () => {
    const h = await harness();
    const res = await h.call(new Request(url(await token())));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("file bytes");
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-length")).toBe("10");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="report _.pdf"; filename*=UTF-8''report%20%C3%A9.pdf`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(h.calls.some((c) => c.url.includes("alt=media"))).toBe(true);
  });

  it("answers HEAD from metadata without downloading", async () => {
    const h = await harness();
    const res = await h.call(new Request(url(await token()), { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("10");
    expect(h.calls.some((c) => c.url.includes("alt=media"))).toBe(false);
  });

  it("refuses a file that has grown past the size it was signed at", async () => {
    const h = await harness();
    const res = await h.call(new Request(url(await token({ maxBytes: 9 }))));
    expect(res.status).toBe(409);
  });

  it("exports a Docs-native file as PDF by default, or as the target names", async () => {
    const h = await harness();
    const res = await h.call(new Request(url(await token({ target: "FAKEdoc01", maxBytes: 0 }))));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(await res.text()).toBe("%PDF-fake");
    const csv = await h.call(new Request(url(await token({ target: "FAKEdoc01;export=text/csv", maxBytes: 0 }))));
    expect(csv.headers.get("content-type")).toBe("text/csv");
    expect(h.calls.filter((c) => c.url.includes("/export")).at(-1)!.url).toContain("mimeType=text%2Fcsv");
  });

  it("maps a Drive 404 to 404 and other Drive failures to 502, never relaying Google's body", async () => {
    const leak = `see ${SESSION}`;
    for (const [status, expected] of [
      [404, 404],
      [500, 502],
    ] as const) {
      const h = await harness({
        respond: (c) =>
          c.url.includes("oauth2")
            ? Response.json({ access_token: "fake-access", expires_in: 3600 })
            : Response.json({ error: { message: leak } }, { status }),
      });
      const res = await h.call(new Request(url(await token())));
      expect(res.status).toBe(expected);
      expect(await res.text()).not.toContain("upload_id");
    }
  });

  it("refuses when Drive is disabled or unlinked for the user", async () => {
    expect((await (await harness({ driveEnabled: false })).call(new Request(url(await token())))).status).toBe(403);
    expect((await (await harness({ linked: false })).call(new Request(url(await token())))).status).toBe(403);
  });

  it("revokes issued URLs once Files is switched off or the user leaves ALLOWED_EMAILS, before any Drive call", async () => {
    for (const opts of [{ filesEnabled: false }, { allowed: "other@example.test" }]) {
      const h = await harness(opts);
      expect((await h.call(new Request(url(await token())))).status).toBe(403);
      expect((await h.call(put(await token({ method: "PUT", maxBytes: 1000 }), "x"))).status).toBe(403);
      expect(h.calls).toHaveLength(0);
    }
  });
});

describe("PUT", () => {
  const putToken = (o: Partial<SignRequest> = {}, now?: () => number) => token({ method: "PUT", maxBytes: 1000, ...o }, now);

  it("fills the placeholder through a resumable session and returns its drive ref", async () => {
    const h = await harness();
    const res = await h.call(put(await putToken({ account: "work@example.test" }), "hello upload"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ref: "drive:FAKEfile01?account=work@example.test", size: 12, md5: "fakemd5" });
    // The session URI is a credential: it reaches Drive, never the client.
    expect(JSON.stringify(body)).not.toContain("upload_id");
    const start = h.calls.find((c) => c.url.includes("uploadType=resumable"))!;
    expect(start.method).toBe("PATCH");
    expect(new URL(start.url).pathname).toBe("/upload/drive/v3/files/FAKEfile01");
    const upload = h.calls.find((c) => c.url === SESSION)!;
    expect(upload.method).toBe("PUT");
    expect(upload.body).toBe("hello upload");
  });

  it("works exactly once: a replay is refused with 410 and touches no Drive upload", async () => {
    const h = await harness();
    const t = await putToken();
    expect((await h.call(put(t, "first"))).status).toBe(200);
    const uploads = h.calls.filter((c) => c.url === SESSION).length;
    const replay = await h.call(put(t, "second"));
    expect(replay.status).toBe(410);
    expect(await errorOf(replay)).toMatch(/already been used/);
    expect(h.calls.filter((c) => c.url === SESSION).length).toBe(uploads);
  });

  it("lets exactly one of two concurrent PUTs through; the other gets 410", async () => {
    const h = await harness();
    const t = await putToken();
    const results = await Promise.all([h.call(put(t, "one")), h.call(put(t, "two"))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
    expect(h.calls.filter((c) => c.url === SESSION)).toHaveLength(1);
  });

  it("refuses a PUT whose account is no longer linked without burning the URL", async () => {
    const t = await putToken({ account: "FAKE-unlinked" });
    const gone = await (await harness({ linked: false })).call(put(t, "first"));
    expect(gone.status).toBe(403);
    // Re-linked, the same URL still works: the refusal came before the claim.
    expect((await (await harness()).call(put(t, "second"))).status).toBe(200);
  });

  it("refuses a PUT URL past its expiry with 410 even when never used", async () => {
    const h = await harness();
    const t = await putToken({}, () => Date.now() - 15 * 60 * 1000);
    const res = await h.call(put(t, "late"));
    expect(res.status).toBe(410);
    expect(await errorOf(res)).toMatch(/expired/);
    expect(h.calls).toHaveLength(0);
  });

  it("requires Content-Length (411) and leaves the URL usable", async () => {
    const h = await harness();
    const t = await putToken();
    const chunked = new Request(url(t), {
      method: "PUT",
      body: new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode("x")), c.close()) }),
      duplex: "half",
    } as RequestInit);
    expect((await h.call(chunked)).status).toBe(411);
    expect((await h.call(put(t, "x"))).status).toBe(200);
  });

  it("refuses a body over maxBytes (413) before spending the URL or calling Drive", async () => {
    const h = await harness();
    const t = await putToken({ maxBytes: 4 });
    const res = await h.call(put(t, "too long"));
    expect(res.status).toBe(413);
    expect(h.calls).toHaveLength(0);
    expect((await h.call(put(t, "ok"))).status).toBe(200);
  });

  it("caps at the Workers body limit even when maxBytes is larger", async () => {
    const h = await harness();
    const t = await putToken({ maxBytes: FILE_CAPS.signedPut * 2 });
    const req = new Request(url(t), { method: "PUT", headers: { "content-length": String(FILE_CAPS.signedPut + 1) } });
    expect((await h.call(req)).status).toBe(413);
  });
});

describe("grantShardName", () => {
  it("is a pure function of the jti, never an email-shaped vault name", () => {
    const names = new Set<string>();
    for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") {
      const name = grantShardName(`${c}${"x".repeat(21)}`);
      expect(name).toMatch(/^files-url-grants\/[0-7]$/);
      expect(name).not.toContain("@");
      names.add(name);
    }
    expect(names.size).toBe(8);
    expect(grantShardName("Qabc")).toBe(grantShardName("Qxyz"));
  });
});

describe("contentDisposition", () => {
  it("keeps ASCII names plain and strips quotes and line breaks", () => {
    expect(contentDisposition("a.pdf")).toBe('attachment; filename="a.pdf"');
    expect(contentDisposition('a"b\r\n.pdf')).toBe('attachment; filename="a_b__.pdf"');
  });
});

describe("pinDriveAccount", () => {
  const vault = (labels: Record<string, string>, fallback: string | null) => ({
    calls: [] as (string | undefined)[],
    getAccountForService(accountService: string, service: string, label?: string) {
      this.calls.push(label);
      expect([accountService, service]).toEqual(["google", "drive"]);
      if (label !== undefined) return labels[label] ? { label } : null;
      return fallback ? { label: fallback } : null;
    },
  });

  it("resolves 'the user's Drive account' to its label at issue time", async () => {
    const v = vault({}, "FAKE-default");
    expect(await pinDriveAccount(v, null)).toBe("FAKE-default");
    expect(v.calls).toEqual([undefined]);
  });

  it("keeps an explicit label, and refuses one that is not linked", async () => {
    const v = vault({ "FAKE-second": "x" }, "FAKE-default");
    expect(await pinDriveAccount(v, "FAKE-second")).toBe("FAKE-second");
    await expect(pinDriveAccount(v, "FAKE-gone")).rejects.toThrow();
    await expect(pinDriveAccount(vault({}, null), null)).rejects.toThrow();
  });
});
