import { describe, expect, it } from "vitest";
import type { Fetcher } from "@toolbox/mcp-shared";
import { buildIdentityRedirect, emailAllowed, exchangeIdentityCode } from "../src/google";

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

describe("emailAllowed", () => {
  it("matches case-insensitively against the CSV allowlist", () => {
    expect(emailAllowed("A@B.co", " a@b.co , c@d.co")).toBe(true);
    expect(emailAllowed("x@y.z", "a@b.co,c@d.co")).toBe(false);
    expect(emailAllowed("", "a@b.co")).toBe(false);
    expect(emailAllowed("a@b.co", "")).toBe(false);
  });
});
