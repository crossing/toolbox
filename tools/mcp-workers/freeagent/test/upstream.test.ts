import { describe, expect, it } from "vitest";
import {
  buildAuthorizeRedirect,
  exchangeCode,
  FREEAGENT_TOKEN_URL,
  refreshUpstream,
  sanitizedTokenError,
  UpstreamError,
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

describe("sanitizedTokenError", () => {
  it("surfaces only error and error_description", () => {
    expect(
      sanitizedTokenError(JSON.stringify({ error: "invalid_grant", error_description: "expired", secret: "x" })),
    ).toBe("invalid_grant: expired");
  });

  it("never echoes a non-JSON body", () => {
    expect(sanitizedTokenError("<html>secret</html>")).toBe("unparseable token endpoint response");
  });
});

describe("exchangeCode", () => {
  it("posts client_secret_basic form to the token endpoint", async () => {
    const { calls, fetcher } = capture(
      jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 604800 }),
    );
    const tokens = await exchangeCode({
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
    expect(body.get("code")).toBe("abc");
    expect(body.get("redirect_uri")).toBe("https://example.com/callback");
  });

  it("throws a sanitized error on token endpoint failure", async () => {
    const { fetcher } = capture(jsonResponse({ error: "invalid_client", error_description: "nope" }, 401));
    await expect(
      exchangeCode({ clientId: "c", clientSecret: "s", code: "x", redirectUri: "r", fetcher }),
    ).rejects.toThrow("invalid_client: nope");
  });

  it("rejects a 200 with no access token", async () => {
    const { fetcher } = capture(jsonResponse({ something: "else" }));
    await expect(
      exchangeCode({ clientId: "c", clientSecret: "s", code: "x", redirectUri: "r", fetcher }),
    ).rejects.toThrow(UpstreamError);
  });
});

describe("refreshUpstream", () => {
  it("sends the refresh grant and keeps the old refresh token when omitted", async () => {
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
    expect(body.get("refresh_token")).toBe("rt-old");
  });
});

describe("buildAuthorizeRedirect", () => {
  it("targets approve_app with client_id, redirect_uri and state", () => {
    const url = new URL(
      buildAuthorizeRedirect({ clientId: "cid", redirectUri: "https://w.example/callback", state: "s+t=" }),
    );
    expect(url.origin + url.pathname).toBe("https://api.freeagent.com/v2/approve_app");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("https://w.example/callback");
    expect(url.searchParams.get("state")).toBe("s+t=");
  });
});
