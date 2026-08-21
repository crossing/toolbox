import { describe, expect, it } from "vitest";
import type { Fetcher } from "@toolbox/mcp-shared";
import {
  buildIdentityRedirect,
  buildLinkRedirect,
  emailAllowed,
  exchangeIdentityCode,
  exchangeLinkCode,
  GOOGLE_READ_SCOPES,
  GOOGLE_TOKEN_URL,
  GOOGLE_WRITE_SCOPES,
  refreshUpstream,
  scopesAllowWrite,
  UpstreamError,
} from "../src/google";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function capture(response: Response) {
  const calls: { input: string; init?: RequestInit }[] = [];
  const fetcher: Fetcher = async (input, init) => {
    calls.push({ input: String(input), init });
    return response.clone();
  };
  return { calls, fetcher };
}

describe("buildIdentityRedirect", () => {
  it("asks for identity scopes only, with no offline access", () => {
    const url = new URL(
      buildIdentityRedirect({ clientId: "cid", redirectUri: "https://gw/callback", state: "m.x" }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("openid email");
    expect(url.searchParams.get("state")).toBe("m.x");
    expect(url.searchParams.get("access_type")).toBeNull();
    expect(url.searchParams.get("prompt")).toBeNull();
  });
});

describe("exchangeIdentityCode", () => {
  const opts = { clientId: "cid", clientSecret: "cs", code: "code", redirectUri: "https://gw/callback" };

  it("returns the access token", async () => {
    const fetcher: Fetcher = async (_url, init) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("code");
      return new Response(JSON.stringify({ access_token: "at", expires_in: 3599 }));
    };
    expect(await exchangeIdentityCode({ ...opts, fetcher })).toBe("at");
  });

  it("sanitizes error responses", async () => {
    const fetcher: Fetcher = async () =>
      new Response(JSON.stringify({ error: "invalid_grant", client_secret: "leak" }), { status: 400 });
    await expect(exchangeIdentityCode({ ...opts, fetcher })).rejects.not.toThrow(/leak/);
    await expect(exchangeIdentityCode({ ...opts, fetcher })).rejects.toThrow(/invalid_grant/);
  });
});

describe("link scope sets", () => {
  it("read scopes never include write scopes or cloud-platform", () => {
    expect(GOOGLE_READ_SCOPES.join(" ")).not.toMatch(/compose|modify|settings|auth\/drive$/);
    expect(GOOGLE_WRITE_SCOPES.join(" ")).not.toContain("cloud-platform");
  });
  it("write scopes are a superset of read scopes", () => {
    for (const scope of GOOGLE_READ_SCOPES) expect(GOOGLE_WRITE_SCOPES).toContain(scope);
  });
  it("scopesAllowWrite spots write-only scopes, ignores read-only sets", () => {
    expect(scopesAllowWrite(GOOGLE_READ_SCOPES)).toBe(false);
    expect(scopesAllowWrite(GOOGLE_WRITE_SCOPES)).toBe(true);
    expect(scopesAllowWrite(["https://www.googleapis.com/auth/gmail.compose"])).toBe(true);
    expect(scopesAllowWrite([])).toBe(false);
  });
});

describe("buildLinkRedirect", () => {
  it("requests offline access with forced consent, unlike the identity flow", () => {
    const url = new URL(
      buildLinkRedirect({
        clientId: "cid",
        redirectUri: "https://gw/callback",
        state: "l.x",
        scopes: GOOGLE_READ_SCOPES,
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe(GOOGLE_READ_SCOPES.join(" "));
    expect(url.searchParams.get("state")).toBe("l.x");
  });
});

describe("exchangeLinkCode", () => {
  const opts = {
    clientId: "cid",
    clientSecret: "sec",
    code: "abc",
    redirectUri: "https://gw/callback",
    requestedScopes: GOOGLE_READ_SCOPES,
  };

  it("returns tokens and Google's granted scopes when reported", async () => {
    const { calls, fetcher } = capture(
      jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3599, scope: "openid email" }),
    );
    const result = await exchangeLinkCode({ ...opts, now: 1000, fetcher });
    expect(result.tokens).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: 1000 + 3599_000 });
    expect(result.scopes).toEqual(["openid", "email"]);
    expect(calls[0]!.input).toBe(GOOGLE_TOKEN_URL);
    const body = new URLSearchParams(calls[0]!.init?.body as string);
    expect(body.get("client_secret")).toBe("sec");
    expect(calls[0]!.init?.headers).not.toHaveProperty("authorization");
  });

  it("falls back to the requested scopes when Google omits them", async () => {
    const { fetcher } = capture(jsonResponse({ access_token: "at", refresh_token: "rt" }));
    const result = await exchangeLinkCode({ ...opts, fetcher });
    expect(result.scopes).toEqual(GOOGLE_READ_SCOPES);
  });

  it("fails loudly when Google returns no refresh token", async () => {
    const { fetcher } = capture(jsonResponse({ access_token: "at", expires_in: 3599 }));
    await expect(exchangeLinkCode({ ...opts, fetcher })).rejects.toThrow(/no refresh token/);
  });
});

describe("refreshUpstream", () => {
  it("keeps the original refresh token (Google does not rotate)", async () => {
    const { calls, fetcher } = capture(jsonResponse({ access_token: "at2", expires_in: 100 }));
    const tokens = await refreshUpstream({
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

  it("throws UpstreamError on non-JSON failure bodies", async () => {
    const { fetcher } = capture(new Response("<html>nope</html>", { status: 500 }));
    await expect(
      refreshUpstream({ clientId: "c", clientSecret: "s", refreshToken: "r", fetcher }),
    ).rejects.toThrow(UpstreamError);
  });
});

describe("emailAllowed", () => {
  it("matches case-insensitively against the CSV allowlist", () => {
    expect(emailAllowed("A@B.co", " a@b.co , c@d.co")).toBe(true);
    expect(emailAllowed("x@y.z", "a@b.co,c@d.co")).toBe(false);
    expect(emailAllowed("", "a@b.co")).toBe(false);
    expect(emailAllowed("a@b.co", "")).toBe(false);
  });
});
