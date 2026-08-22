import { describe, expect, it } from "vitest";
import {
  buildFreeagentAuthorizeRedirect,
  exchangeFreeagentCode,
  fetchCompanySubdomain,
  FREEAGENT_TOKEN_URL,
  FreeAgentApiError,
  FreeAgentClient,
  FreeAgentTokenSource,
  FreeAgentUpstreamError,
  isApiUrl,
  refreshFreeagent,
  staticClient,
  type FreeAgentTokens,
} from "../src/freeagentapi";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function capture(response: Response) {
  const calls: { input: string; init?: RequestInit }[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    return response.clone();
  };
  return { calls, fetcher };
}

describe("exchangeFreeagentCode", () => {
  it("posts client_secret_basic form to the token endpoint", async () => {
    const { calls, fetcher } = capture(
      jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 604800 }),
    );
    const tokens = await exchangeFreeagentCode({
      clientId: "cid",
      clientSecret: "sec",
      code: "abc",
      redirectUri: "https://example.com/callback",
      now: 1_000_000,
      fetcher,
    });
    expect(tokens).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: 1_000_000 + 604800 * 1000 });
    expect(calls[0]!.input).toBe(FREEAGENT_TOKEN_URL);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${btoa("cid:sec")}`);
    expect(headers["user-agent"]).toBeTruthy();
    const body = new URLSearchParams(calls[0]!.init?.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
  });

  it("surfaces the status on non-JSON failures instead of echoing the body", async () => {
    const { fetcher } = capture(new Response("<html>HTTP Basic: Access denied.</html>", { status: 401 }));
    await expect(
      exchangeFreeagentCode({ clientId: "c", clientSecret: "s", code: "x", redirectUri: "r", fetcher }),
    ).rejects.toThrow(/status 401/);
    await expect(
      exchangeFreeagentCode({ clientId: "c", clientSecret: "s", code: "x", redirectUri: "r", fetcher }),
    ).rejects.not.toThrow(/Access denied/);
  });

  it("rejects a 200 with no access token", async () => {
    const { fetcher } = capture(jsonResponse({ something: "else" }));
    await expect(
      exchangeFreeagentCode({ clientId: "c", clientSecret: "s", code: "x", redirectUri: "r", fetcher }),
    ).rejects.toThrow(FreeAgentUpstreamError);
  });
});

describe("refreshFreeagent", () => {
  it("keeps the old refresh token when the response omits one", async () => {
    const { calls, fetcher } = capture(jsonResponse({ access_token: "at2", expires_in: 100 }));
    const tokens = await refreshFreeagent({
      clientId: "c",
      clientSecret: "s",
      refreshToken: "rt-old",
      now: 5000,
      fetcher,
    });
    expect(tokens).toEqual({ accessToken: "at2", refreshToken: "rt-old", expiresAt: 5000 + 100_000 });
    const body = new URLSearchParams(calls[0]!.init?.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
  });

  it("adopts a rotated refresh token when the response carries one", async () => {
    const { fetcher } = capture(jsonResponse({ access_token: "at2", refresh_token: "rt-new", expires_in: 100 }));
    const tokens = await refreshFreeagent({
      clientId: "c",
      clientSecret: "s",
      refreshToken: "rt-old",
      fetcher,
    });
    expect(tokens.refreshToken).toBe("rt-new");
  });
});

describe("buildFreeagentAuthorizeRedirect", () => {
  it("targets approve_app with client_id, redirect_uri and state", () => {
    const url = new URL(
      buildFreeagentAuthorizeRedirect({ clientId: "cid", redirectUri: "https://w.example/callback", state: "f.x" }),
    );
    expect(url.origin + url.pathname).toBe("https://api.freeagent.com/v2/approve_app");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("f.x");
  });
});

describe("FreeAgentTokenSource", () => {
  const fresh: FreeAgentTokens = { accessToken: "live", refreshToken: "rt", expiresAt: Date.now() + 86_400_000 };

  it("serves the stored access token while fresh, without any request", async () => {
    const { calls, fetcher } = capture(jsonResponse({}));
    const source = new FreeAgentTokenSource("c", "s", fresh, undefined, fetcher);
    expect(await source.token()).toBe("live");
    expect(calls).toHaveLength(0);
  });

  it("refreshes an expired set and reports the rotation for persistence", async () => {
    const { fetcher } = capture(jsonResponse({ access_token: "at2", refresh_token: "rt2", expires_in: 604800 }));
    const rotations: FreeAgentTokens[] = [];
    const source = new FreeAgentTokenSource(
      "c",
      "s",
      { accessToken: "", refreshToken: "rt", expiresAt: 0 },
      async (tokens) => {
        rotations.push(tokens);
      },
      fetcher,
    );
    expect(await source.token()).toBe("at2");
    expect(rotations).toHaveLength(1);
    expect(rotations[0]!.refreshToken).toBe("rt2");
  });
});

describe("isApiUrl", () => {
  it("accepts only https URLs on the API host under /v2/", () => {
    expect(isApiUrl("https://api.freeagent.com/v2/bank_transactions/1")).toBe(true);
    expect(isApiUrl("https://api.freeagent.com/other")).toBe(false);
    expect(isApiUrl("http://api.freeagent.com/v2/x")).toBe(false);
    expect(isApiUrl("https://api.freeagent.com.evil.example/v2/x")).toBe(false);
    expect(isApiUrl("not a url")).toBe(false);
  });
});

describe("FreeAgentClient", () => {
  it("sends bearer auth and drops empty params", async () => {
    const { calls, fetcher } = capture(jsonResponse({ ok: true }));
    const client = staticClient("tok", fetcher);
    await client.get("/bank_transactions", { view: undefined, from_date: "", per_page: "100" });
    const url = new URL(calls[0]!.input);
    expect(url.pathname).toBe("/v2/bank_transactions");
    expect(url.searchParams.get("per_page")).toBe("100");
    expect(url.searchParams.has("view")).toBe(false);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
    expect(headers["user-agent"]).toBeTruthy();
  });

  it("refuses to send the token to a non-API url", async () => {
    const { calls, fetcher } = capture(jsonResponse({}));
    const client = staticClient("tok", fetcher);
    await expect(client.getUrl("https://evil.example/v2/x")).rejects.toThrow(FreeAgentApiError);
    expect(calls).toHaveLength(0);
  });

  it("summarizes JSON errors without echoing unknown bodies", async () => {
    const { fetcher } = capture(jsonResponse({ errors: { error: { message: "bad" } } }, 422));
    await expect(staticClient("tok", fetcher).get("/bills")).rejects.toThrow(/status 422.*bad/);

    const html = capture(new Response("<html>internal secret</html>", { status: 500 }));
    const err = (await staticClient("tok", html.fetcher).get("/bills").catch((e: unknown) => e)) as FreeAgentApiError;
    expect(err).toBeInstanceOf(FreeAgentApiError);
    expect(err.message).toBe("FreeAgent API error (status 500)");
  });
});

describe("fetchCompanySubdomain", () => {
  it("returns the subdomain", async () => {
    const { fetcher } = capture(jsonResponse({ company: { subdomain: "acme" } }));
    expect(await fetchCompanySubdomain(staticClient("t", fetcher))).toBe("acme");
  });

  it("returns empty string when the shape is unexpected", async () => {
    const { fetcher } = capture(jsonResponse({ company: {} }));
    expect(await fetchCompanySubdomain(staticClient("t", fetcher))).toBe("");
  });
});
