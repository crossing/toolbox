import { describe, expect, it } from "vitest";
import { fetchCompanySubdomain, FreeAgentApiError, FreeAgentClient, isApiUrl } from "../src/api";

function stub(body: string, status = 200) {
  const calls: { input: string; init?: RequestInit }[] = [];
  const fetcher = async (input: string, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(body, { status });
  };
  return { calls, fetcher };
}

describe("isApiUrl", () => {
  it("accepts only https URLs on the API host under /v2/", () => {
    expect(isApiUrl("https://api.freeagent.com/v2/bank_transactions/1")).toBe(true);
    expect(isApiUrl("https://api.freeagent.com/other")).toBe(false);
    expect(isApiUrl("http://api.freeagent.com/v2/x")).toBe(false);
    expect(isApiUrl("https://api.freeagent.com.evil.example/v2/x")).toBe(false);
    expect(isApiUrl("https://evil.example/v2/x")).toBe(false);
    expect(isApiUrl("not a url")).toBe(false);
  });
});

describe("FreeAgentClient", () => {
  it("sends bearer auth and drops empty params", async () => {
    const { calls, fetcher } = stub(JSON.stringify({ ok: true }));
    const client = new FreeAgentClient("tok", fetcher);
    await client.get("/bank_transactions", {
      bank_account: "https://api.freeagent.com/v2/bank_accounts/1",
      view: undefined,
      from_date: "",
      per_page: "100",
    });
    const url = new URL(calls[0]!.input);
    expect(url.pathname).toBe("/v2/bank_transactions");
    expect(url.searchParams.get("per_page")).toBe("100");
    expect(url.searchParams.has("view")).toBe(false);
    expect(url.searchParams.has("from_date")).toBe(false);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
    expect(headers["user-agent"]).toBeTruthy();
  });

  it("refuses to send the token to a non-API url", async () => {
    const { calls, fetcher } = stub("{}");
    const client = new FreeAgentClient("tok", fetcher);
    await expect(client.getUrl("https://evil.example/v2/x")).rejects.toThrow(FreeAgentApiError);
    expect(calls).toHaveLength(0);
  });

  it("summarizes JSON errors without echoing unknown bodies", async () => {
    const { fetcher } = stub(JSON.stringify({ errors: { error: { message: "bad" } } }), 422);
    const client = new FreeAgentClient("tok", fetcher);
    await expect(client.get("/bills")).rejects.toThrow(/status 422.*bad/);

    const html = stub("<html>internal secret</html>", 500);
    const client2 = new FreeAgentClient("tok", html.fetcher);
    const err = (await client2.get("/bills").catch((e: unknown) => e)) as FreeAgentApiError;
    expect(err).toBeInstanceOf(FreeAgentApiError);
    expect(err.message).toBe("FreeAgent API error (status 500)");
  });
});

describe("fetchCompanySubdomain", () => {
  it("returns the subdomain", async () => {
    const { fetcher } = stub(JSON.stringify({ company: { subdomain: "acme" } }));
    expect(await fetchCompanySubdomain(new FreeAgentClient("t", fetcher))).toBe("acme");
  });

  it("returns empty string when the shape is unexpected", async () => {
    const { fetcher } = stub(JSON.stringify({ company: {} }));
    expect(await fetchCompanySubdomain(new FreeAgentClient("t", fetcher))).toBe("");
  });
});
