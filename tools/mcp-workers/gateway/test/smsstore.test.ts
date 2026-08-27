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
