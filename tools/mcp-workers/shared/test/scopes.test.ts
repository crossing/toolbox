import { describe, expect, it } from "vitest";
import { grantedScopes, hasScope } from "../src/scopes";
import { decodeAuthRequest, encodeAuthRequest, escapeHtml, renderApprovalPage } from "../src/approval";
import { requireScope } from "../src/endpoints";

describe("hasScope", () => {
  it("accepts a props object carrying the scope", () => {
    expect(hasScope({ userId: "owner", scopes: ["read", "write"] }, "write")).toBe(true);
  });
  it("rejects missing scope, malformed props, and null", () => {
    expect(hasScope({ userId: "owner", scopes: ["read"] }, "write")).toBe(false);
    expect(hasScope({ userId: "owner" }, "read")).toBe(false);
    expect(hasScope(null, "read")).toBe(false);
    expect(hasScope("read", "read")).toBe(false);
  });
});

describe("grantedScopes", () => {
  it("always grants read", () => {
    expect(grantedScopes([], false)).toEqual(["read"]);
    expect(grantedScopes(["read"], false)).toEqual(["read"]);
  });
  it("grants write only with human approval", () => {
    expect(grantedScopes(["read", "write"], false)).toEqual(["read"]);
    expect(grantedScopes(["read", "write"], true)).toEqual(["read", "write"]);
  });
  it("grants write on approval when the client requested nothing specific", () => {
    expect(grantedScopes([], true)).toEqual(["read", "write"]);
  });
  it("never invents scopes the client did not ask for", () => {
    expect(grantedScopes(["read"], true)).toEqual(["read"]);
  });
});

describe("approval page", () => {
  it("round-trips the auth request", () => {
    const req = { clientId: "abc", scope: ["read"], state: "s" };
    expect(decodeAuthRequest(encodeAuthRequest(req))).toEqual(req);
  });
  it("escapes html in client-controlled fields", () => {
    const page = renderApprovalPage({
      serverName: "freeagent",
      clientName: `<script>alert(1)</script>`,
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      requestedScopes: ["read"],
      encodedAuthRequest: "e30=",
      offerWrite: false,
    });
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&lt;script&gt;");
    expect(page).not.toContain("allow_write");
  });
  it("offers the write checkbox only when asked", () => {
    const page = renderApprovalPage({
      serverName: "freeagent",
      clientName: "c",
      redirectUri: "https://example.com/cb",
      requestedScopes: ["read", "write"],
      encodedAuthRequest: "e30=",
      offerWrite: true,
    });
    expect(page).toContain("allow_write");
  });
  it("escapeHtml covers the five specials", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("requireScope", () => {
  const inner = {
    fetch: async () => new Response("ok", { status: 200 }),
  };
  const ctxWith = (props: unknown) =>
    ({ props, waitUntil() {}, passThroughOnException() {} }) as unknown as ExecutionContext;

  it("passes through when the grant carries the scope", async () => {
    const res = await requireScope("write", inner).fetch(
      new Request("https://x/rw"),
      {},
      ctxWith({ userId: "owner", scopes: ["read", "write"] }),
    );
    expect(res.status).toBe(200);
  });
  it("rejects read-only tokens on the write endpoint", async () => {
    const res = await requireScope("write", inner).fetch(
      new Request("https://x/rw"),
      {},
      ctxWith({ userId: "owner", scopes: ["read"] }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "insufficient_scope" });
  });
  it("rejects when props are absent entirely", async () => {
    const res = await requireScope("write", inner).fetch(new Request("https://x/rw"), {}, ctxWith(undefined));
    expect(res.status).toBe(403);
  });
});
