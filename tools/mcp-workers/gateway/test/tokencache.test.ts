// The vault-owned token cache: the vault (TokenBroker over a real VaultStore)
// is the only thing that refreshes, sessions (VaultTokenSource) hold access
// tokens only. What matters is how many times the token endpoint is hit —
// FreeAgent rotates the refresh token on every refresh and allows 15 a
// minute — and that a failure never rewrites the stored set.

import { beforeEach, describe, expect, it } from "vitest";
import { decryptJson, encryptJson, importVaultKey } from "../src/crypto";
import {
  FREEAGENT_TOKEN_URL,
  FreeAgentApiError,
  FreeAgentClient,
  FreeAgentUpstreamError,
  exchangeFreeagentCode,
  refreshFreeagent,
} from "../src/freeagentapi";
import { GOOGLE_TOKEN_URL, refreshUpstream, UpstreamError } from "../src/google";
import { GoogleClient } from "../src/googleapi";
import type { VaultBlob } from "../src/manage";
import {
  MAX_REFRESH_MARGIN_MS,
  refreshMarginMs,
  TokenBroker,
  vaultTokenSource,
  type TokenEnv,
} from "../src/tokencache";
import { VaultStore } from "../src/vaultstore";
import { makeFakeSql } from "./sqlfake";

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;
const COMPANY = "fake-company";
const GMAIL = "owner@example.test";
const env: TokenEnv = {
  VAULT_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
  FREEAGENT_CLIENT_ID: "fake-fa-client",
  FREEAGENT_CLIENT_SECRET: "fake-fa-secret",
  GWS_CLIENT_ID: "fake-g-client",
  GWS_CLIENT_SECRET: "fake-g-secret",
};

interface Call {
  url: string;
  body?: string;
  auth?: string;
}

/** A scripted network: `respond` answers each call; token-endpoint calls are counted separately. */
function network(respond: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call = { url: String(input), body: init?.body as string | undefined, auth: headers.authorization };
    calls.push(call);
    return respond(call, calls.length);
  };
  const tokenCalls = () => calls.filter((c) => c.url === FREEAGENT_TOKEN_URL || c.url === GOOGLE_TOKEN_URL);
  return { calls, fetcher, tokenCalls };
}

const tokenJson = (access: string, refresh?: string, expiresIn = 3600) =>
  Response.json({ access_token: access, ...(refresh ? { refresh_token: refresh } : {}), expires_in: expiresIn });

describe("refreshMarginMs", () => {
  it("is min(5 minutes, lifetime / 4) and always under the lifetime", () => {
    expect(refreshMarginMs(HOUR)).toBe(MAX_REFRESH_MARGIN_MS);
    expect(refreshMarginMs(60_000)).toBe(15_000);
    expect(refreshMarginMs(undefined)).toBe(MAX_REFRESH_MARGIN_MS);
    for (const lifetime of [1_000, 60_000, 10 * 60_000, HOUR, 7 * 24 * HOUR]) {
      expect(refreshMarginMs(lifetime)).toBeLessThan(lifetime);
    }
  });
});

describe("TokenBroker (the vault side)", () => {
  let clock: number;
  let store: VaultStore;
  let key: CryptoKey;

  const now = () => clock;
  const blobOf = async (service: string, label: string) =>
    decryptJson<VaultBlob>(key, store.getAccount(service, label)!.ciphertext);
  const link = async (service: string, label: string, blob: VaultBlob) =>
    store.putAccount(service, label, await encryptJson(key, blob), []);

  beforeEach(async () => {
    clock = T0;
    store = new VaultStore(makeFakeSql());
    key = await importVaultKey(env.VAULT_KEY);
    await link("freeagent", COMPANY, {
      refreshToken: "fake-rt-1",
      accessToken: "fake-at-1",
      expiresAt: T0 + HOUR,
      issuedAt: T0,
    });
  });

  it("serves a stored token with time to spare, without touching the token endpoint", async () => {
    const net = network(() => tokenJson("unused"));
    const broker = new TokenBroker(store, env, net.fetcher, now);
    clock = T0 + 50 * 60_000; // 10 minutes left of an hour
    expect(await broker.accessToken("freeagent", COMPANY)).toEqual({ ok: true, accessToken: "fake-at-1", expiresAt: T0 + HOUR });
    expect(net.calls).toHaveLength(0);
  });

  it("refreshes once near expiry and persists the rotated refresh token", async () => {
    const net = network(() => tokenJson("fake-at-2", "fake-rt-2"));
    const broker = new TokenBroker(store, env, net.fetcher, now);
    clock = T0 + 56 * 60_000; // 4 minutes left: inside the 5-minute margin
    const result = await broker.accessToken("freeagent", COMPANY);
    expect(result).toEqual({ ok: true, accessToken: "fake-at-2", expiresAt: clock + HOUR });
    expect(net.tokenCalls()).toHaveLength(1);
    expect(new URLSearchParams(net.calls[0]!.body).get("refresh_token")).toBe("fake-rt-1");
    expect(await blobOf("freeagent", COMPANY)).toEqual({
      refreshToken: "fake-rt-2",
      accessToken: "fake-at-2",
      expiresAt: clock + HOUR,
      issuedAt: clock,
    });
    // And the new token is served from the vault from now on.
    expect((await broker.accessToken("freeagent", COMPANY)).ok).toBe(true);
    expect(net.tokenCalls()).toHaveLength(1);
  });

  it("shares one in-flight refresh among concurrent callers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const net = network(async () => {
      await gate;
      return tokenJson("fake-at-2", "fake-rt-2");
    });
    const broker = new TokenBroker(store, env, net.fetcher, now);
    clock = T0 + HOUR + 1; // expired
    const asks = Array.from({ length: 8 }, () => broker.accessToken("freeagent", COMPANY));
    // Let every caller reach the token endpoint if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const results = await Promise.all(asks);
    expect(net.tokenCalls()).toHaveLength(1);
    expect(new Set(results.map((r) => (r.ok ? r.accessToken : r.message)))).toEqual(new Set(["fake-at-2"]));
    expect((await blobOf("freeagent", COMPANY)).refreshToken).toBe("fake-rt-2");
  });

  it("works from a legacy blob holding only a refresh token", async () => {
    await link("freeagent", "legacy", { refreshToken: "fake-rt-legacy" });
    const net = network(() => tokenJson("fake-at-legacy", "fake-rt-legacy-2"));
    const broker = new TokenBroker(store, env, net.fetcher, now);
    expect(await broker.accessToken("freeagent", "legacy")).toMatchObject({ ok: true, accessToken: "fake-at-legacy" });
    expect(net.tokenCalls()).toHaveLength(1);
    expect(await blobOf("freeagent", "legacy")).toMatchObject({ refreshToken: "fake-rt-legacy-2", issuedAt: T0 });
  });

  it("persists Google access tokens too, keeping the unrotated refresh token", async () => {
    await link("google", GMAIL, { refreshToken: "fake-g-rt" });
    const net = network(() => tokenJson("fake-g-at"));
    const broker = new TokenBroker(store, env, net.fetcher, now);
    expect(await broker.accessToken("google", GMAIL)).toMatchObject({ ok: true, accessToken: "fake-g-at" });
    expect(net.calls[0]!.url).toBe(GOOGLE_TOKEN_URL);
    expect(await blobOf("google", GMAIL)).toEqual({
      refreshToken: "fake-g-rt",
      accessToken: "fake-g-at",
      expiresAt: T0 + HOUR,
      issuedAt: T0,
    });
    // A later ask — another session, or the vault after eviction — reuses it.
    const later = new TokenBroker(store, env, net.fetcher, now);
    clock = T0 + 30 * 60_000;
    expect(await later.accessToken("google", GMAIL)).toMatchObject({ ok: true, accessToken: "fake-g-at" });
    expect(net.tokenCalls()).toHaveLength(1);
  });

  it("force-refreshes only while the stored token is the one that failed", async () => {
    const net = network(() => tokenJson("fake-at-2", "fake-rt-2"));
    const broker = new TokenBroker(store, env, net.fetcher, now);
    expect(await broker.accessToken("freeagent", COMPANY, { staleToken: "fake-at-1" })).toMatchObject({ accessToken: "fake-at-2" });
    // A second caller reporting the same dead token gets the replacement, no refresh.
    expect(await broker.accessToken("freeagent", COMPANY, { staleToken: "fake-at-1" })).toMatchObject({ accessToken: "fake-at-2" });
    expect(net.tokenCalls()).toHaveLength(1);
  });

  it("waits out a short Retry-After on the token endpoint once", async () => {
    const net = network((_c, n) =>
      n === 1 ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : tokenJson("fake-at-2", "fake-rt-2"),
    );
    const broker = new TokenBroker(store, env, net.fetcher, now);
    clock = T0 + HOUR;
    expect(await broker.accessToken("freeagent", COMPANY)).toMatchObject({ ok: true, accessToken: "fake-at-2" });
    expect(net.tokenCalls()).toHaveLength(2);
  });

  it("surfaces a long Retry-After without touching the stored tokens", async () => {
    const net = network(() => new Response("", { status: 429, headers: { "retry-after": "40" } }));
    const broker = new TokenBroker(store, env, net.fetcher, now);
    const before = store.getAccount("freeagent", COMPANY)!.ciphertext;
    clock = T0 + HOUR;
    expect(await broker.accessToken("freeagent", COMPANY)).toEqual({
      ok: false,
      kind: "rate_limited",
      message: "FreeAgent rate limited; retry in 40 s",
      retryAfterS: 40,
    });
    expect(net.tokenCalls()).toHaveLength(1);
    expect(store.getAccount("freeagent", COMPANY)!.ciphertext).toBe(before);
  });

  it("reports a dead refresh grant as a failed refresh, not an expired code, and writes nothing", async () => {
    const net = network(() => new Response("<html>HTTP Basic: Access denied.</html>", { status: 401 }));
    const broker = new TokenBroker(store, env, net.fetcher, now);
    const before = store.getAccount("freeagent", COMPANY)!.ciphertext;
    clock = T0 + HOUR;
    const result = await broker.accessToken("freeagent", COMPANY);
    expect(result.ok).toBe(false);
    const message = result.ok ? "" : result.message;
    expect(message).toMatch(/refresh failed \(status 401\)/);
    expect(message).toMatch(/renewed on mcp\.xing\.works\/manage/);
    expect(message).not.toMatch(/authorization code/);
    expect(message).not.toMatch(/Access denied|fake-rt/);
    expect(store.getAccount("freeagent", COMPANY)!.ciphertext).toBe(before);
  });

  it("does not overwrite a relink that landed during the refresh", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const net = network(async () => {
      await gate;
      return tokenJson("fake-at-old-link", "fake-rt-old-link");
    });
    const broker = new TokenBroker(store, env, net.fetcher, now);
    clock = T0 + HOUR;
    const ask = broker.accessToken("freeagent", COMPANY);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await link("freeagent", COMPANY, { refreshToken: "fake-rt-relinked" });
    release();
    expect((await ask).ok).toBe(true);
    expect((await blobOf("freeagent", COMPANY)).refreshToken).toBe("fake-rt-relinked");
  });
});

describe("VaultTokenSource and the clients (the session side)", () => {
  let clock: number;
  let store: VaultStore;
  let key: CryptoKey;
  const now = () => clock;

  beforeEach(async () => {
    clock = T0;
    store = new VaultStore(makeFakeSql());
    key = await importVaultKey(env.VAULT_KEY);
    store.putAccount(
      "freeagent",
      COMPANY,
      await encryptJson(key, { refreshToken: "fake-rt-1", accessToken: "fake-at-1", expiresAt: T0 + HOUR, issuedAt: T0 } satisfies VaultBlob),
      [],
    );
  });

  /** FreeAgent API that accepts only `live` tokens; the token endpoint mints fake-at-2. */
  function freeagentNet(live: Set<string>) {
    return network((call) => {
      if (call.url === FREEAGENT_TOKEN_URL) return tokenJson("fake-at-2", "fake-rt-2");
      const token = call.auth?.replace(/^Bearer /, "") ?? "";
      return live.has(token) ? Response.json({ bills: [] }) : new Response("", { status: 401 });
    });
  }

  function session(broker: TokenBroker) {
    const source = vaultTokenSource(
      { accessToken: (service, label, opts) => broker.accessToken(service, label, opts) },
      "freeagent",
      COMPANY,
    );
    return source;
  }

  it("ten rapid calls cost no refresh while the token is fresh", async () => {
    const net = freeagentNet(new Set(["fake-at-1"]));
    const broker = new TokenBroker(store, env, net.fetcher, now);
    const client = new FreeAgentClient(session(broker), net.fetcher);
    for (let i = 0; i < 10; i++) await client.get("/bills");
    expect(net.tokenCalls()).toHaveLength(0);
    expect(net.calls).toHaveLength(10);
  });

  it("a second session reuses the token the first one had refreshed", async () => {
    const net = freeagentNet(new Set(["fake-at-2"]));
    const broker = new TokenBroker(store, env, net.fetcher, now);
    clock = T0 + HOUR; // the stored token is due
    const a = session(broker);
    const b = session(broker);
    expect(await a.token()).toBe("fake-at-2");
    expect(await b.token()).toBe("fake-at-2");
    expect(net.tokenCalls()).toHaveLength(1);
  });

  it("on a 401 refreshes once through the vault and retries the request", async () => {
    const net = freeagentNet(new Set(["fake-at-2"])); // fake-at-1 was revoked early
    const broker = new TokenBroker(store, env, net.fetcher, now);
    const client = new FreeAgentClient(session(broker), net.fetcher);
    expect(await client.get("/bills")).toEqual({ bills: [] });
    expect(net.tokenCalls()).toHaveLength(1);
    expect(net.calls.filter((c) => c.url.endsWith("/bills")).map((c) => c.auth)).toEqual([
      "Bearer fake-at-1",
      "Bearer fake-at-2",
    ]);
  });

  it("a burst of 401s on one dead token, across sessions, costs one refresh", async () => {
    const net = freeagentNet(new Set(["fake-at-2"]));
    const broker = new TokenBroker(store, env, net.fetcher, now);
    const clients = [session(broker), session(broker), session(broker)].map((s) => new FreeAgentClient(s, net.fetcher));
    const results = await Promise.all(clients.flatMap((c) => [c.get("/bills"), c.get("/bills")]));
    expect(results).toHaveLength(6);
    expect(net.tokenCalls()).toHaveLength(1);
  });

  it("a second 401 after the retry surfaces instead of looping", async () => {
    const net = freeagentNet(new Set());
    const broker = new TokenBroker(store, env, net.fetcher, now);
    const client = new FreeAgentClient(session(broker), net.fetcher);
    const err = (await client.get("/bills").catch((e: unknown) => e)) as FreeAgentApiError;
    expect(err).toBeInstanceOf(FreeAgentApiError);
    expect(err.status).toBe(401);
    expect(net.tokenCalls()).toHaveLength(1);
  });

  it("turns a vault rate limit into a FreeAgent 429 tool error", async () => {
    const net = network(() => new Response("", { status: 429, headers: { "retry-after": "90" } }));
    const broker = new TokenBroker(store, env, net.fetcher, now);
    clock = T0 + HOUR;
    const err = (await session(broker).token().catch((e: unknown) => e)) as FreeAgentApiError;
    expect(err).toBeInstanceOf(FreeAgentApiError);
    expect(err.status).toBe(429);
    expect(err.message).toBe("FreeAgent rate limited; retry in 90 s");
  });

  it("retries a FreeAgent API 429 with a short Retry-After once, and surfaces a long one", async () => {
    let n = 0;
    const short = network(() => (++n === 1 ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : Response.json({ ok: 1 })));
    const client = new FreeAgentClient({ token: async () => "fake-at" }, short.fetcher);
    expect(await client.get("/bills")).toEqual({ ok: 1 });
    expect(short.calls).toHaveLength(2);

    const long = network(() => new Response("", { status: 429, headers: { "retry-after": "61" } }));
    const err = (await new FreeAgentClient({ token: async () => "fake-at" }, long.fetcher)
      .get("/bills")
      .catch((e: unknown) => e)) as FreeAgentApiError;
    expect(err.status).toBe(429);
    expect(err.message).toBe("FreeAgent rate limited; retry in 61 s");
    expect(long.calls).toHaveLength(1);
  });

  it("GoogleClient refreshes through the vault on a 401 and retries once", async () => {
    store.putAccount("google", GMAIL, await encryptJson(key, { refreshToken: "fake-g-rt", accessToken: "fake-g-old", expiresAt: T0 + HOUR, issuedAt: T0 } satisfies VaultBlob), []);
    const net = network((call) => {
      if (call.url === GOOGLE_TOKEN_URL) return tokenJson("fake-g-new");
      return call.auth === "Bearer fake-g-new" ? Response.json({ id: "x" }) : Response.json({ error: { message: "bad" } }, { status: 401 });
    });
    const broker = new TokenBroker(store, env, net.fetcher, now);
    const source = vaultTokenSource({ accessToken: (s, l, o) => broker.accessToken(s, l, o) }, "google", GMAIL);
    const google = new GoogleClient(source, net.fetcher);
    expect(await google.getJson("https://www.googleapis.com/drive/v3/files/x")).toEqual({ id: "x" });
    expect(net.tokenCalls()).toHaveLength(1);
    expect((await decryptJson<VaultBlob>(key, store.getAccount("google", GMAIL)!.ciphertext)).accessToken).toBe("fake-g-new");
  });
});

describe("token endpoint error text", () => {
  it("says refresh failed with the status for a FreeAgent refresh_token grant", async () => {
    const net = network(() => Response.json({ error: "invalid_grant", error_description: "expired" }, { status: 400 }));
    const err = await refreshFreeagent({ clientId: "c", clientSecret: "s", refreshToken: "fake-rt", fetcher: net.fetcher }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FreeAgentUpstreamError);
    expect((err as Error).message).toBe(
      "FreeAgent token refresh failed (status 400): invalid_grant: expired; the FreeAgent link must be renewed on mcp.xing.works/manage",
    );
  });

  it("keeps the expired-code hint for the authorization_code exchange only", async () => {
    const net = network(() => new Response("<html>nope</html>", { status: 401 }));
    await expect(
      exchangeFreeagentCode({ clientId: "c", clientSecret: "s", code: "x", redirectUri: "r", fetcher: net.fetcher }),
    ).rejects.toThrow(/status 401.*authorization code may have expired/);
  });

  it("says refresh failed with the status for a Google refresh_token grant", async () => {
    const net = network(() => Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 }));
    const err = await refreshUpstream({ clientId: "c", clientSecret: "s", refreshToken: "fake-rt", fetcher: net.fetcher }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as Error).message).toMatch(/^Google token refresh failed \(status 400\): invalid_grant/);
    expect((err as Error).message).toMatch(/renewed on mcp\.xing\.works\/manage/);
  });
});
