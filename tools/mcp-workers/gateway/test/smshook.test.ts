// The receive hook's contract, which is narrower than it looks: a wrong secret
// must be indistinguishable from a route that does not exist, and a 200 must
// mean the message is held — AAISP's retry behaviour is undocumented, so a
// message we drop while claiming success is a message lost silently.

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { handleSmsHook } from "../src/smshook";
import { SmsStore } from "../src/smsstore";
import { makeFakeSql, type FakeSql } from "./sqlfake";

const SECRET = "0123456789abcdef0123456789abcdef";
const digest = async (input: string) => createHash("sha256").update(input).digest("hex");

let open: FakeSql[] = [];

afterEach(() => {
  for (const sql of open) sql.close();
  open = [];
});

function fakeEnv(overrides: Partial<Env> = {}): { env: Env; store: SmsStore } {
  const sql = makeFakeSql();
  open.push(sql);
  const store = new SmsStore(sql, digest);
  const stub = {
    receive: (fields: Parameters<SmsStore["recordInbound"]>[0]) => store.recordInbound(fields, Date.now()),
  };
  const env = {
    SMS_HOOK_SECRET: SECRET,
    SMS_OWN_NUMBERS: "+441234567890",
    SMS_INBOX: { idFromName: () => "id", get: () => stub },
    ...overrides,
  } as unknown as Env;
  return { env, store };
}

function post(secret: string, fields: Record<string, string>): Request {
  return new Request(`https://mcp.test/hooks/sms/${secret}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

const GOOD = { oa: "447700900123", da: "+441234567890", ud: "Your code is 449182", scts: "2026-08-23T11:59:00Z" };

async function call(env: Env, request: Request) {
  return handleSmsHook(request, env, new URL(request.url));
}

describe("routing", () => {
  it("ignores paths that are not the hook, so the rest of the Worker still routes", async () => {
    const { env } = fakeEnv();
    const request = new Request("https://mcp.test/manage");
    expect(await call(env, request)).toBeNull();
  });
});

describe("the path is the credential", () => {
  it("answers a wrong secret with a plain 404", async () => {
    const { env, store } = fakeEnv();
    const response = await call(env, post("wrong", GOOD));
    expect(response?.status).toBe(404);
    expect(store.listMessages({})).toHaveLength(0);
  });

  it("answers a truncated secret with a 404 too", async () => {
    const { env } = fakeEnv();
    expect((await call(env, post(SECRET.slice(0, 16), GOOD)))?.status).toBe(404);
  });

  it("refuses everything when no secret is configured", async () => {
    const { env } = fakeEnv({ SMS_HOOK_SECRET: "" });
    expect((await call(env, post("", GOOD)))?.status).toBe(404);
  });
});

describe("delivery", () => {
  it("stores a well-formed POST and says so", async () => {
    const { env, store } = fakeEnv();
    const response = await call(env, post(SECRET, GOOD));
    expect(response?.status).toBe(200);

    const [message] = store.listMessages({});
    expect(message).toMatchObject({ peer: "+447700900123", body: "Your code is 449182" });
    // The raw form is kept for forensics alongside the parsed fields.
    expect(store.listSenders()[0]!.oa).toBe("+447700900123");
  });

  it("accepts GET, because AAISP switches to it when the URL ends in ? or &", async () => {
    const { env, store } = fakeEnv();
    const query = new URLSearchParams(GOOD).toString();
    const request = new Request(`https://mcp.test/hooks/sms/${SECRET}?${query}`);
    expect((await call(env, request))?.status).toBe(200);
    expect(store.listMessages({})).toHaveLength(1);
  });

  it("normalises a timestamp with an offset so ordering stays chronological", async () => {
    const { env, store } = fakeEnv();
    await call(env, post(SECRET, { ...GOOD, scts: "2026-08-23T12:59:00+01:00" }));
    expect(store.listMessages({})[0]!.timestamp).toBe("2026-08-23T11:59:00.000Z");
  });

  it("falls back to arrival time when the stamp is unusable", async () => {
    const { env, store } = fakeEnv();
    await call(env, post(SECRET, { ...GOOD, scts: "not a date" }));
    expect(store.listMessages({})[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("still returns 200 for a redelivery, which is held rather than dropped", async () => {
    const { env, store } = fakeEnv();
    expect((await call(env, post(SECRET, GOOD)))?.status).toBe(200);
    expect((await call(env, post(SECRET, GOOD)))?.status).toBe(200);
    expect(store.listMessages({})).toHaveLength(1);
  });
});

describe("field validation", () => {
  it("refuses a delivery addressed to a number that is not ours", async () => {
    const { env, store } = fakeEnv();
    const response = await call(env, post(SECRET, { ...GOOD, da: "+441111111111" }));
    expect(response?.status).toBe(400);
    expect(store.listMessages({})).toHaveLength(0);
  });

  it("refuses an empty or oversized body", async () => {
    const { env } = fakeEnv();
    expect((await call(env, post(SECRET, { ...GOOD, ud: "" })))?.status).toBe(400);
    expect((await call(env, post(SECRET, { ...GOOD, ud: "x".repeat(4001) })))?.status).toBe(400);
  });

  it("refuses a missing or absurd sender", async () => {
    const { env } = fakeEnv();
    expect((await call(env, post(SECRET, { ...GOOD, oa: "" })))?.status).toBe(400);
    expect((await call(env, post(SECRET, { ...GOOD, oa: "x".repeat(33) })))?.status).toBe(400);
  });

  it("accepts any destination when no own-numbers list is configured yet", async () => {
    const { env, store } = fakeEnv({ SMS_OWN_NUMBERS: "" });
    expect((await call(env, post(SECRET, { ...GOOD, da: "+449999999999" })))?.status).toBe(200);
    expect(store.listMessages({})).toHaveLength(1);
  });

  it("rejects a method that is neither GET nor POST", async () => {
    const { env } = fakeEnv();
    const request = new Request(`https://mcp.test/hooks/sms/${SECRET}`, { method: "DELETE" });
    expect((await call(env, request))?.status).toBe(405);
  });
});
