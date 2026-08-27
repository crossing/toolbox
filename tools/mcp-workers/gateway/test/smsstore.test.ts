// The SMS store against real SQL. What matters most here is not that rows go
// in, but the three properties the design leans on: a retry collapses onto the
// row it already delivered, a purged body leaves a shape behind, and a code
// that arrived recently is recognised in an outbound payload even when its
// digits have been spaced apart.

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeFakeSql, type FakeSql } from "./sqlfake";
import {
  RETENTION_DEFAULTS,
  SmsStore,
  computeShape,
  normalizePeer,
  normalizeSecret,
  parseConcatHeader,
  senderClass,
} from "../src/smsstore";

const digest = async (input: string) => createHash("sha256").update(input).digest("hex");

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-23T12:00:00.000Z");

let open: FakeSql[] = [];

function store(): SmsStore {
  const sql = makeFakeSql();
  open.push(sql);
  return new SmsStore(sql, digest);
}

afterEach(() => {
  for (const sql of open) sql.close();
  open = [];
});

function inbound(overrides: Partial<Parameters<SmsStore["recordInbound"]>[0]> = {}) {
  return {
    oa: "447700900123",
    da: "+441234567890",
    ud: "Your code is 449182",
    scts: "2026-08-23T11:59:00.000Z",
    ...overrides,
  };
}

describe("normalizePeer", () => {
  it("keeps international form and adds the missing plus", () => {
    expect(normalizePeer("+447700900123")).toBe("+447700900123");
    expect(normalizePeer("447700900123")).toBe("+447700900123");
  });

  it("expands a national number", () => {
    expect(normalizePeer("07700900123")).toBe("+447700900123");
  });

  it("leaves shortcodes and sender IDs alone — they are identities, not numbers", () => {
    expect(normalizePeer("60123")).toBe("60123");
    expect(normalizePeer("BANKID")).toBe("BANKID");
  });
});

describe("senderClass", () => {
  it("separates real numbers from machine senders", () => {
    expect(senderClass("+447700900123")).toBe("e164");
    expect(senderClass("60123")).toBe("shortcode");
    expect(senderClass("BANKID")).toBe("alnum");
  });
});

describe("computeShape", () => {
  it("masks digits", () => {
    expect(computeShape("Your code is 449182")).toBe("Your code is DDDDDD");
  });

  it("masks mixed letter-and-digit tokens, which words never are", () => {
    expect(computeShape("Code A4K9QP expires")).toBe("Code XXXXXX expires");
  });

  it("drops URL paths, because a magic link is the credential", () => {
    expect(computeShape("Tap https://ex.test/a/9fJk2P to sign in")).toBe("Tap https://ex.test/… to sign in");
  });

  it("keeps the surrounding prose, which is what a review reads", () => {
    expect(computeShape("BANKID: 8823 is your one-time code, valid 10 minutes")).toBe(
      "BANKID: DDDD is your one-time code, valid DD minutes",
    );
  });
});

describe("parseConcatHeader", () => {
  it("reads an 8-bit reference", () => {
    expect(parseConcatHeader("050003CC0201")).toEqual({ ref: 0xcc, total: 2, seq: 1 });
  });

  it("reads a 16-bit reference", () => {
    expect(parseConcatHeader("06080404D20201")).toEqual({ ref: 0x04d2, total: 2, seq: 1 });
  });

  it("returns null for a header with no concatenation IE", () => {
    expect(parseConcatHeader("02")).toBeNull();
    expect(parseConcatHeader("nonsense")).toBeNull();
  });
});

describe("ingest", () => {
  it("stores a message and starts the sender census", async () => {
    const s = store();
    const result = await s.recordInbound(inbound(), NOW);
    expect(result).toMatchObject({ stored: true, duplicate: false });

    const messages = s.listMessages({});
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toBe("Your code is 449182");
    expect(messages[0]!.shape).toBe("Your code is DDDDDD");
    expect(messages[0]!.peer).toBe("+447700900123");

    const senders = s.listSenders();
    expect(senders).toEqual([expect.objectContaining({ oa: "+447700900123", count: 1, status: "new" })]);
  });

  it("collapses a redelivery onto the row it already holds", async () => {
    const s = store();
    const first = await s.recordInbound(inbound(), NOW);
    const second = await s.recordInbound(inbound(), NOW + 5_000);

    expect(second.id).toBe(first.id);
    expect(second.duplicate).toBe(true);
    // Still 200-worthy: the message *is* held.
    expect(second.stored).toBe(true);
    expect(s.listMessages({})).toHaveLength(1);
    expect(s.listSenders()[0]!.count).toBe(1);
  });

  it("joins a concatenated set and stores it once, in sequence order", async () => {
    const s = store();
    const partTwo = await s.recordInbound(
      inbound({ ud: "second half", udh: "050003CC0202" }),
      NOW,
    );
    expect(partTwo).toMatchObject({ id: null, pending: { have: 1, total: 2 } });
    expect(s.listMessages({})).toHaveLength(0);

    const partOne = await s.recordInbound(inbound({ ud: "first half ", udh: "050003CC0201" }), NOW);
    expect(partOne.id).not.toBeNull();

    const messages = s.listMessages({});
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toBe("first half second half");
    expect(messages[0]!.parts).toBe(2);
    expect(messages[0]!.incomplete).toBe(false);
  });

  it("surfaces a set that never completed rather than dropping it", async () => {
    const s = store();
    await s.recordInbound(inbound({ ud: "orphan half", udh: "050003CC0201" }), NOW);
    expect(await s.flushStaleParts(NOW + 30 * 60_000)).toBe(0);

    expect(await s.flushStaleParts(NOW + 2 * 60 * 60_000)).toBe(1);
    const messages = s.listMessages({});
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toBe("orphan half");
    expect(messages[0]!.incomplete).toBe(true);
  });
});

describe("search", () => {
  it("matches bodies, and falls back to the shape once a body is gone", async () => {
    const s = store();
    await s.recordInbound(inbound({ ud: "Delivery 449182 is out" }), NOW);
    expect(s.listMessages({ query: "Delivery" })).toHaveLength(1);
    expect(s.listMessages({ query: "449182" })).toHaveLength(1);

    s.setSender("+447700900123", { status: "machine", retentionDays: 0 });
    s.purge(NOW + DAY);

    expect(s.listMessages({ query: "449182" })).toHaveLength(0);
    expect(s.listMessages({ query: "Delivery" })).toHaveLength(1);
  });
});

describe("retention", () => {
  it("drops bodies past the window but never the shape", async () => {
    const s = store();
    await s.recordInbound(inbound({ oa: "BANKID", scts: "2026-06-01T00:00:00.000Z" }), NOW);
    s.setSender("BANKID", { status: "machine" });

    expect(s.retentionPreview(NOW)).toEqual([
      expect.objectContaining({ oa: "BANKID", days: RETENTION_DEFAULTS.machine, messages: 1 }),
    ]);

    expect(s.purge(NOW).bodies).toBe(1);
    const [message] = s.listMessages({});
    expect(message!.body).toBeNull();
    expect(message!.shape).toBe("Your code is DDDDDD");
  });

  it("holds unreviewed senders, so nothing vanishes before it is understood", async () => {
    const s = store();
    await s.recordInbound(inbound({ oa: "NEWONE", scts: "2020-01-01T00:00:00.000Z" }), NOW);
    expect(s.listSenders()[0]!.status).toBe("new");
    expect(s.retentionPreview(NOW)).toEqual([]);
    expect(s.purge(NOW).bodies).toBe(0);
    expect(s.listMessages({})[0]!.body).not.toBeNull();
  });

  it("keeps conversations indefinitely", async () => {
    const s = store();
    await s.recordInbound(inbound({ scts: "2019-01-01T00:00:00.000Z" }), NOW);
    s.setSender("+447700900123", { status: "conversation" });
    expect(s.purge(NOW).bodies).toBe(0);
  });
});

describe("secrets", () => {
  const PATTERN = "code is (?<secret>\\d{4,8})";

  it("captures nothing until a pattern is approved", async () => {
    const s = store();
    await s.recordInbound(inbound({ oa: "BANKID" }), NOW);
    expect(s.status(NOW).liveSecrets).toBe(0);
    expect(s.checkTaint("the code is 449182", NOW)).toBeNull();
  });

  it("extracts on arrival once the sender has one, and flags it on the way out", async () => {
    const s = store();
    s.addPattern("BANKID", PATTERN, 900, 3, NOW);
    await s.recordInbound(inbound({ oa: "BANKID" }), NOW);

    expect(s.status(NOW).liveSecrets).toBe(1);
    expect(s.checkTaint("forwarding 449182 as asked", NOW)).toMatchObject({ oa: "BANKID" });
  });

  it("sees through spacing and punctuation", async () => {
    const s = store();
    s.addPattern("BANKID", PATTERN, 900, 3, NOW);
    await s.recordInbound(inbound({ oa: "BANKID" }), NOW);

    expect(s.checkTaint("449 182", NOW)).not.toBeNull();
    expect(s.checkTaint("449-182", NOW)).not.toBeNull();
  });

  it("lets a code go once it has expired", async () => {
    const s = store();
    s.addPattern("BANKID", PATTERN, 900, 3, NOW);
    await s.recordInbound(inbound({ oa: "BANKID" }), NOW);

    expect(s.checkTaint("449182", NOW + 14 * 60_000)).not.toBeNull();
    expect(s.checkTaint("449182", NOW + 16 * 60_000)).toBeNull();
  });

  it("ignores an unrelated payload", async () => {
    const s = store();
    s.addPattern("BANKID", PATTERN, 900, 3, NOW);
    await s.recordInbound(inbound({ oa: "BANKID" }), NOW);
    expect(s.checkTaint("see you at six", NOW)).toBeNull();
  });

  it("refuses a pattern that will not compile, at approval rather than on receipt", () => {
    const s = store();
    expect(() => s.addPattern("BANKID", "(?<secret>\\d+", 900, 1, NOW)).toThrow();
  });

  it("normalizeSecret folds case and separators", () => {
    expect(normalizeSecret("A4K9-QP")).toBe("a4k9qp");
    expect(normalizeSecret("449 182")).toBe("449182");
  });
});

describe("review input", () => {
  it("groups a sender's templates by frequency", async () => {
    const s = store();
    s.addPattern("BANKID", "code is (?<secret>\\d+)", 900, 1, NOW);
    await s.recordInbound(inbound({ oa: "BANKID", ud: "Your code is 111111" }), NOW);
    await s.recordInbound(inbound({ oa: "BANKID", ud: "Your code is 222222" }), NOW);
    await s.recordInbound(inbound({ oa: "BANKID", ud: "Balance: 42.10" }), NOW);

    const shapes = s.shapesFor("BANKID");
    expect(shapes[0]).toMatchObject({ shape: "Your code is DDDDDD", count: 2 });
    expect(shapes).toHaveLength(2);
  });
});

describe("staged sends", () => {
  it("stages without sending, and a release hands the Worker what to dispatch", async () => {
    const s = store();
    const staged = s.stageSend("send-1", "07700 900456", "meet at six", "xor@jecity.net", NOW);
    expect(staged.state).toBe("pending");
    // Normalised on the way in, so the dispatch and the thread agree on the peer.
    expect(staged.peer).toBe("+447700900456");

    const ticket = s.beginRelease("send-1", NOW);
    expect(ticket).toMatchObject({ ok: true, peer: "+447700900456", body: "meet at six" });
    expect(s.getSend("send-1")?.state).toBe("releasing");
  });

  it("refuses to release a body carrying a code that arrived recently", async () => {
    const s = store();
    s.addPattern("BANKID", "code is (?<secret>\\d+)", 900, 1, NOW);
    await s.recordInbound(inbound({ oa: "BANKID", ud: "Your code is 449182" }), NOW);

    // Spaced apart, which is the lazy evasion the normaliser is there to cover.
    s.stageSend("send-2", "+447700900456", "the code is 449 182", "xor@jecity.net", NOW);
    const ticket = s.beginRelease("send-2", NOW);

    expect(ticket.ok).toBe(false);
    const send = s.getSend("send-2");
    expect(send?.state).toBe("refused");
    // A refusal is audited rather than silent — it is either an injection or a
    // bug, and both are worth knowing about.
    expect(send?.error).toContain("BANKID");
  });

  it("releases the same message only once", async () => {
    const s = store();
    s.stageSend("send-3", "+447700900456", "hello", "xor@jecity.net", NOW);
    expect(s.beginRelease("send-3", NOW).ok).toBe(true);
    const second = s.beginRelease("send-3", NOW);
    expect(second).toMatchObject({ ok: false });
    if (!second.ok) expect(second.reason).toContain("releasing");
  });

  it("a sent message becomes a real outbound row, so a thread reads as a conversation", async () => {
    const s = store();
    await s.recordInbound(inbound({ oa: "447700900456", ud: "you there?" }), NOW);
    s.stageSend("send-4", "+447700900456", "on my way", "xor@jecity.net", NOW);
    s.beginRelease("send-4", NOW);
    await s.completeSend("send-4", { ok: true, detail: "OK:1", ownNumber: "+447441148085" }, NOW);

    const thread = s.getThread("+447700900456");
    expect(thread.map((m) => m.direction)).toEqual(["in", "out"]);
    expect(thread[1]).toMatchObject({ body: "on my way", status: "sent" });
    expect(s.getSend("send-4")?.state).toBe("sent");
  });

  it("keeps a failed send out of the message history", async () => {
    const s = store();
    s.stageSend("send-5", "+447700900456", "nope", "xor@jecity.net", NOW);
    s.beginRelease("send-5", NOW);
    await s.completeSend("send-5", { ok: false, detail: "ERR: no credit" }, NOW);

    expect(s.getSend("send-5")).toMatchObject({ state: "failed", error: "ERR: no credit" });
    expect(s.getThread("+447700900456")).toHaveLength(0);
  });

  it("cancelling only bites while the send is still pending", async () => {
    const s = store();
    s.stageSend("send-6", "+447700900456", "hi", "xor@jecity.net", NOW);
    s.beginRelease("send-6", NOW);
    s.cancelSend("send-6", NOW);
    // Already claimed for dispatch, so a late cancel must not rewrite it.
    expect(s.getSend("send-6")?.state).toBe("releasing");
  });

  it("applies a delivery report to the message the send produced", async () => {
    const s = store();
    s.stageSend("send-7", "+447700900456", "ping", "xor@jecity.net", NOW);
    s.beginRelease("send-7", NOW);
    await s.completeSend("send-7", { ok: true, detail: "OK:1" }, NOW);

    expect(s.recordDlr("send-7", 1)).toBe(true);
    expect(s.getThread("+447700900456")[0]).toMatchObject({ status: "delivered" });
    // A report for something we never sent is not an error worth retrying.
    expect(s.recordDlr("send-nonexistent", 1)).toBe(false);
  });
});
