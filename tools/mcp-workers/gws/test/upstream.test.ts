import { describe, expect, it } from "vitest";
import {
  buildAuthorizeRedirect,
  emailAllowed,
  exchangeCode,
  GOOGLE_TOKEN_URL,
  READ_UPSTREAM_SCOPES,
  refreshUpstream,
  UpstreamError,
  WRITE_UPSTREAM_SCOPES,
} from "../src/upstream";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function capture(response: Response) {
  const calls: { input: string; init?: RequestInit }[] = [];
  const fetcher = async (input: string, init?: RequestInit) => {
    calls.push({ input, init });
    return response.clone();
  };
  return { calls, fetcher };
}

describe("scope sets", () => {
  it("read scopes never include write scopes or cloud-platform", () => {
    expect(READ_UPSTREAM_SCOPES.join(" ")).not.toMatch(/compose|modify|settings|auth\/drive$/);
    expect(WRITE_UPSTREAM_SCOPES.join(" ")).not.toContain("cloud-platform");
  });
  it("write scopes are a superset of read scopes", () => {
    for (const scope of READ_UPSTREAM_SCOPES) expect(WRITE_UPSTREAM_SCOPES).toContain(scope);
  });
});

describe("buildAuthorizeRedirect", () => {
  it("requests offline access with forced consent", () => {
    const url = new URL(
      buildAuthorizeRedirect({
        clientId: "cid",
        redirectUri: "https://w.example/callback",
        state: "st",
        scopes: READ_UPSTREAM_SCOPES,
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe(READ_UPSTREAM_SCOPES.join(" "));
  });
});

describe("exchangeCode", () => {
  it("posts client credentials in the body (Google convention)", async () => {
    const { calls, fetcher } = capture(
      jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3599 }),
    );
    const tokens = await exchangeCode({
      clientId: "cid",
      clientSecret: "sec",
      code: "abc",
      redirectUri: "https://w.example/callback",
      now: 1000,
      fetcher,
    });
    expect(tokens).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: 1000 + 3599_000 });
    expect(calls[0]!.input).toBe(GOOGLE_TOKEN_URL);
    const body = new URLSearchParams(calls[0]!.init?.body as string);
    expect(body.get("client_id")).toBe("cid");
    expect(body.get("client_secret")).toBe("sec");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(calls[0]!.init?.headers).not.toHaveProperty("authorization");
  });

  it("fails loudly when Google returns no refresh token", async () => {
    const { fetcher } = capture(jsonResponse({ access_token: "at", expires_in: 3599 }));
    await expect(
      exchangeCode({ clientId: "c", clientSecret: "s", code: "x", redirectUri: "r", fetcher }),
    ).rejects.toThrow(/no refresh token/);
  });

  it("sanitizes token endpoint errors", async () => {
    const { fetcher } = capture(jsonResponse({ error: "invalid_grant", error_description: "expired" }, 400));
    await expect(
      exchangeCode({ clientId: "c", clientSecret: "s", code: "x", redirectUri: "r", fetcher }),
    ).rejects.toThrow("invalid_grant: expired");
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
  it("matches case-insensitively with whitespace tolerance", () => {
    expect(emailAllowed("A@b.com", " a@b.com , c@d.com")).toBe(true);
    expect(emailAllowed("c@d.com", "a@b.com,c@d.com")).toBe(true);
  });
  it("rejects unknown, empty, and near-miss emails", () => {
    expect(emailAllowed("evil@b.com", "a@b.com,c@d.com")).toBe(false);
    expect(emailAllowed("", "a@b.com")).toBe(false);
    expect(emailAllowed("a@b.com", "")).toBe(false);
    expect(emailAllowed("a@b.com.evil", "a@b.com")).toBe(false);
  });
});
