// AAISP's SMS API answers with one line of plain text and an HTTP status that
// does not track it — a rejected message can still come back 200. So the whole
// point of these tests is that the reply body decides, and that anything we do
// not recognise counts as a failure rather than as an optimistic success.

import { describe, expect, it, vi } from "vitest";
import { dispatchSms, dlrUrl, smsCredentials } from "../src/smssend";
import type { Env } from "../src/env";

function env(overrides: Partial<Env> = {}): Env {
  return {
    AAISP_SMS_USERNAME: "+447441148085",
    AAISP_SMS_PASSWORD: "outgoing-secret",
    SMS_HOOK_SECRET: "hooksecret",
    ...overrides,
  } as unknown as Env;
}

function reply(body: string, status = 200): typeof fetch {
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
}

describe("smsCredentials", () => {
  it("treats blank as absent, so a half-provisioned Worker stages instead of pretending", () => {
    expect(smsCredentials(env())).toMatchObject({ username: "+447441148085" });
    expect(smsCredentials(env({ AAISP_SMS_PASSWORD: "   " }))).toBeNull();
    expect(smsCredentials(env({ AAISP_SMS_USERNAME: undefined }))).toBeNull();
  });
});

describe("dlrUrl", () => {
  it("carries the send id, because nothing in AAISP's report identifies our message", () => {
    const url = dlrUrl(env(), "https://mcp.example.test", "send-1");
    expect(url).toBe("https://mcp.example.test/hooks/sms/hooksecret/dlr?id=send-1&code=%code");
  });

  it("is null without a hook secret rather than a URL nothing can authenticate", () => {
    expect(dlrUrl(env({ SMS_HOOK_SECRET: "" }), "https://x.test", "s")).toBeNull();
  });
});

describe("dispatchSms", () => {
  it("sends form-encoded and reports OK", async () => {
    const fetchImpl = reply("OK:1");
    const result = await dispatchSms(env(), "+447700900456", "hello", null, fetchImpl);

    expect(result).toEqual({ ok: true, detail: "OK:1" });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const sent = new URLSearchParams(init.body as string);
    expect(sent.get("da")).toBe("+447700900456");
    expect(sent.get("ud")).toBe("hello");
    expect(sent.get("username")).toBe("+447441148085");
    // Capped so a runaway string cannot become a runaway invoice.
    expect(sent.get("limit")).toBe("4");
  });

  it("passes the delivery-report URL through when there is one", async () => {
    const fetchImpl = reply("OK:1");
    await dispatchSms(env(), "+447700900456", "hi", "https://x.test/dlr?id=1&code=%code", fetchImpl);
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(new URLSearchParams(init.body as string).get("srr")).toBe("https://x.test/dlr?id=1&code=%code");
  });

  it("treats ERR as a failure even though it arrives as HTTP 200", async () => {
    const result = await dispatchSms(env(), "+447700900456", "hi", null, reply("ERR: bad password"));
    expect(result).toEqual({ ok: false, detail: "ERR: bad password" });
  });

  it("treats an unrecognised reply as a failure, never as a success", async () => {
    const result = await dispatchSms(env(), "+447700900456", "hi", null, reply("<html>maintenance</html>", 503));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("unrecognised reply");
  });

  it("does not throw when AAISP is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch;
    const result = await dispatchSms(env(), "+447700900456", "hi", null, fetchImpl);
    expect(result).toMatchObject({ ok: false });
    expect(result.detail).toContain("connection reset");
  });

  it("refuses to send at all when the credentials are missing", async () => {
    const fetchImpl = reply("OK:1");
    const result = await dispatchSms(env({ AAISP_SMS_PASSWORD: "" }), "+447700900456", "hi", null, fetchImpl);
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
