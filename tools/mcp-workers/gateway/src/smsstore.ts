// The SMS store's tables and every rule for reading, learning from and pruning
// them, with no Durable Object around them. `SmsInbox` is the DO shell;
// everything a test needs to reach lives here — the same split as
// vault.ts / vaultstore.ts, and for the same reason.
//
// The store is *open*: read paths return message bodies unredacted, because
// the alternative to "a store a model can read" is not "a secret nobody can
// see" but "an SMS on a phone", and because codes expire in minutes. What
// guards the codes is the write path — see `checkTaint` — not the read path.
// docs/plans/aaisp-sms.md carries the full reasoning.

import type { SqlLike } from "./vaultstore";

/** Bodies are dropped by retention; `shape` is kept forever, so it holds no secret. */
export const SMS_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  peer TEXT NOT NULL,
  own_number TEXT NOT NULL,
  body TEXT,
  shape TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  parts INTEGER NOT NULL DEFAULT 1,
  incomplete INTEGER NOT NULL DEFAULT 0,
  status TEXT,
  dlr_code INTEGER,
  raw TEXT
);
CREATE INDEX IF NOT EXISTS messages_ts ON messages (timestamp);
CREATE INDEX IF NOT EXISTS messages_peer_ts ON messages (peer, timestamp);

CREATE TABLE IF NOT EXISTS senders (
  oa TEXT PRIMARY KEY,
  shape_class TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  retention_days INTEGER
);

CREATE TABLE IF NOT EXISTS sender_patterns (
  oa TEXT NOT NULL,
  pattern TEXT NOT NULL,
  ttl_seconds INTEGER NOT NULL DEFAULT 900,
  samples INTEGER NOT NULL DEFAULT 0,
  approved_at TEXT NOT NULL,
  PRIMARY KEY (oa, pattern)
);

CREATE TABLE IF NOT EXISTS live_secrets (
  secret TEXT PRIMARY KEY,
  oa TEXT NOT NULL,
  message_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parts (
  oa TEXT NOT NULL,
  ref INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  total INTEGER NOT NULL,
  ud TEXT NOT NULL,
  da TEXT NOT NULL,
  scts TEXT NOT NULL,
  raw TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (oa, ref, seq)
);

CREATE TABLE IF NOT EXISTS pending_sends (
  id TEXT PRIMARY KEY,
  peer TEXT NOT NULL,
  body TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  decided_at TEXT,
  message_id TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS pending_sends_state ON pending_sends (state, requested_at);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Default body retention per sender status, in days; null means never purge. */
export const RETENTION_DEFAULTS: Record<string, number | null> = {
  machine: 30,
  conversation: null,
  new: null, // held until reviewed — nothing is purged before it is understood
  ignored: 7,
};

/** Incomplete concatenated sets are surfaced as partial messages after this long. */
export const PART_TIMEOUT_MS = 60 * 60 * 1000;

export type SenderStatus = "new" | "machine" | "conversation" | "ignored";
export type ShapeClass = "e164" | "shortcode" | "alnum";

export interface InboundFields {
  oa: string;
  da: string;
  ud: string;
  scts: string;
  udh?: string | null;
  raw?: string | null;
}

export interface StoredMessage {
  id: string;
  direction: string;
  peer: string;
  ownNumber: string;
  body: string | null;
  shape: string;
  timestamp: string;
  parts: number;
  incomplete: boolean;
  status: string | null;
}

export interface SenderRow {
  oa: string;
  shapeClass: ShapeClass;
  firstSeen: string;
  lastSeen: string;
  count: number;
  label: string | null;
  status: SenderStatus;
  retentionDays: number | null;
  patterns: number;
}

export interface RecordResult {
  /** False only when the hook must not claim to have stored the message. */
  stored: boolean;
  /** Null while a concatenated set is still incomplete. */
  id: string | null;
  /** True when this delivery was a duplicate of one already held. */
  duplicate: boolean;
  /** Parts still outstanding for a concatenated set. */
  pending?: { ref: number; have: number; total: number };
}

export interface TaintHit {
  oa: string;
  messageId: string;
  expiresAt: string;
}

export interface SmsStatus {
  messages: number;
  senders: number;
  bodiesRetained: number;
  pendingParts: number;
  liveSecrets: number;
  patterns: number;
  lastReceipt: string | null;
  lastPurge: string | null;
  newSenders: number;
}

export interface RetentionRow {
  oa: string;
  label: string | null;
  days: number;
  messages: number;
}

export interface ShapeRow {
  shape: string;
  count: number;
  lastSeen: string;
}

export interface SenderPatch {
  label?: string | null;
  status?: SenderStatus;
  retentionDays?: number | null;
}

/**
 * Every send attempt, kept as a log rather than a queue. `sending` exists
 * because dispatch happens in the Worker — the Durable Object holds no
 * credentials — so the row is written before AAISP is reached and settled
 * after, which means a send that dies mid-flight leaves evidence.
 */
export type SendState = "sending" | "sent" | "failed" | "refused";

export interface SendRecord {
  id: string;
  peer: string;
  body: string;
  requestedBy: string;
  requestedAt: string;
  state: SendState;
  decidedAt: string | null;
  messageId: string | null;
  error: string | null;
}

/** What the store hands back to the Worker that must dispatch. */
export type SendTicket =
  | { ok: true; id: string; peer: string; body: string }
  | { ok: false; reason: string; taint?: TaintHit };

export interface SendOutcome {
  ok: boolean;
  /** AAISP's reply line, kept verbatim for the audit trail. */
  detail?: string;
  ownNumber?: string;
}

export interface MessageFilter {
  peer?: string;
  after?: string;
  before?: string;
  query?: string;
  limit?: number;
  offset?: number;
}

/**
 * The SmsInbox Durable Object's RPC surface, declared here rather than in
 * smsinbox.ts so that callers — and their tests — never have to import
 * `cloudflare:workers` just to know the shape of a stub. Same reason the
 * WhatsApp bridge's contract lives in the shared package.
 */
export interface SmsInboxApi {
  receive(fields: InboundFields): Promise<RecordResult>;
  listMessages(filter: MessageFilter): Promise<StoredMessage[]>;
  getThread(peer: string, limit?: number): Promise<StoredMessage[]>;
  listSenders(): Promise<SenderRow[]>;
  shapesFor(oa: string, limit?: number): Promise<ShapeRow[]>;
  setSender(oa: string, patch: SenderPatch): Promise<void>;
  addPattern(oa: string, pattern: string, ttlSeconds: number, samples: number): Promise<void>;
  deletePattern(oa: string, pattern: string): Promise<void>;
  checkTaint(payload: string): Promise<TaintHit | null>;
  beginSend(peer: string, body: string, requestedBy: string): Promise<SendTicket>;
  listSends(limit?: number): Promise<SendRecord[]>;
  completeSend(id: string, outcome: SendOutcome): Promise<void>;
  recordDlr(id: string, code: number): Promise<boolean>;
  status(): Promise<SmsStatus>;
  retentionPreview(): Promise<RetentionRow[]>;
  purgeNow(): Promise<{ bodies: number; secrets: number; flushed: number }>;
}

/** A digest of the message's identity fields; the caller supplies it because
 *  WebCrypto is async and every other method here is synchronous. */
export type Digest = (input: string) => Promise<string>;

// ---------------------------------------------------------------------------
// Pure helpers — exported so tests can pin the behaviour that matters most.
// ---------------------------------------------------------------------------

/**
 * AAISP delivers `oa` in international form for real numbers, but shortcodes
 * and alphanumeric sender IDs come through verbatim and must stay that way —
 * they are identities, not numbers, and rewriting them would break threading.
 */
export function normalizePeer(oa: string): string {
  const t = oa.trim();
  if (/^\+\d{6,}$/.test(t)) return t;
  if (/^0\d{9,10}$/.test(t)) return `+44${t.slice(1)}`;
  // Seven digits or more is a real number missing its `+`; six or fewer is a
  // shortcode, which must not acquire one.
  if (/^\d{7,}$/.test(t)) return `+${t}`;
  return t;
}

/**
 * Destinations are stricter than senders. An inbound `oa` may legitimately be a
 * shortcode or an alphabetic sender ID, and normalizePeer leaves those alone —
 * but you cannot text a sender ID back, and `to` arrives as free text from a
 * model, so "+44 7700 900456" and "07700-900456" have to land on the same row
 * as the number they obviously are. Anything that is not a dialable number is
 * rejected here rather than handed to AAISP to refuse.
 */
export function normalizeDestination(raw: string): string {
  const stripped = raw.replace(/[\s().-]/g, "");
  const peer = normalizePeer(stripped);
  if (!/^\+\d{7,15}$/.test(peer)) {
    throw new Error(`not a dialable number: ${raw.slice(0, 40)}`);
  }
  return peer;
}

export function senderClass(peer: string): ShapeClass {
  if (/^\+\d{7,}$/.test(peer)) return "e164";
  if (/^\d{3,6}$/.test(peer)) return "shortcode";
  return "alnum";
}

/**
 * The permanently-retained skeleton of a message: enough to recognise the
 * template a sender uses, with nothing secret left in it. Three passes, in
 * this order because each would otherwise hide the next:
 *
 *  1. URL path and query — a magic link *is* the credential, and the host is
 *     the only part worth keeping.
 *  2. Mixed letter+digit tokens — "A4K9QP" is a code; ordinary words never
 *     mix the two, so this costs nothing in readability.
 *  3. Remaining digits.
 */
export function computeShape(body: string): string {
  return body
    .replace(/(https?:\/\/[^\s/]+)(\/\S*)?/gi, (_m, host: string) => `${host}/…`)
    .replace(/\b(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{5,}\b/g, (m) => "X".repeat(m.length))
    .replace(/\d/g, "D");
}

/**
 * Comparison form for the taint check: case-folded, separators removed, so
 * "449 182" and "449-182" both match the code "449182". It can in principle
 * match across word boundaries ("call 44" + "9182"); that is the acceptable
 * side of the trade, since the check flags rather than silently mangles.
 */
export function normalizeSecret(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

export interface ConcatHeader {
  ref: number;
  total: number;
  seq: number;
}

/**
 * Parse the concatenation IE out of a hex UDH. IEI 0x00 carries an 8-bit
 * reference, 0x08 a 16-bit one; anything else in the header (port addressing,
 * language shifts) is skipped rather than rejected — it does not change how
 * the parts join.
 */
export function parseConcatHeader(udh: string): ConcatHeader | null {
  const hex = udh.trim().replace(/\s+/g, "");
  if (hex.length < 2 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  const udhl = bytes[0]!;
  if (udhl + 1 > bytes.length) return null;
  let i = 1;
  while (i + 1 < udhl + 1) {
    const iei = bytes[i]!;
    const iedl = bytes[i + 1]!;
    const data = bytes.slice(i + 2, i + 2 + iedl);
    if (iei === 0x00 && data.length >= 3) {
      return { ref: data[0]!, total: data[1]!, seq: data[2]! };
    }
    if (iei === 0x08 && data.length >= 4) {
      return { ref: (data[0]! << 8) | data[1]!, total: data[2]!, seq: data[3]! };
    }
    i += 2 + iedl;
  }
  return null;
}

// ---------------------------------------------------------------------------

export class SmsStore {
  constructor(
    private sql: SqlLike,
    private digest: Digest,
  ) {
    this.sql.exec(SMS_SCHEMA);
  }

  // -- ingest ---------------------------------------------------------------

  /**
   * Record one inbound delivery. Returns `stored: false` only when nothing was
   * written, because the hook's contract is to return 200 for what it holds
   * and never for what it dropped.
   */
  async recordInbound(fields: InboundFields, nowMs: number): Promise<RecordResult> {
    const peer = normalizePeer(fields.oa);
    const header = fields.udh ? parseConcatHeader(fields.udh) : null;

    if (header && header.total > 1) {
      this.sql.exec(
        `INSERT INTO parts (oa, ref, seq, total, ud, da, scts, raw, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(oa, ref, seq) DO NOTHING`,
        peer,
        header.ref,
        header.seq,
        header.total,
        fields.ud,
        fields.da,
        fields.scts,
        fields.raw ?? null,
        new Date(nowMs).toISOString(),
      );
      const held = this.sql
        .exec("SELECT seq, ud FROM parts WHERE oa = ? AND ref = ? ORDER BY seq", peer, header.ref)
        .toArray();
      if (held.length < header.total) {
        return {
          stored: true,
          id: null,
          duplicate: false,
          pending: { ref: header.ref, have: held.length, total: header.total },
        };
      }
      const joined = held.map((row) => row.ud as string).join("");
      this.sql.exec("DELETE FROM parts WHERE oa = ? AND ref = ?", peer, header.ref);
      return this.store({ ...fields, ud: joined }, peer, nowMs, header.total, false);
    }

    return this.store(fields, peer, nowMs, 1, false);
  }

  private async store(
    fields: InboundFields,
    peer: string,
    nowMs: number,
    parts: number,
    incomplete: boolean,
  ): Promise<RecordResult> {
    // Content-hash id, so an undocumented AAISP retry collapses onto the row
    // it already delivered. It would be an oracle for guessing message content
    // if bodies were hidden; they are not, so it is simply a good dedupe key.
    const id = await this.digest(`${peer}|${fields.da}|${fields.scts}|${fields.ud}`);
    const inserted = this.sql
      .exec(
        `INSERT INTO messages (id, direction, peer, own_number, body, shape, timestamp, parts, incomplete, raw)
         VALUES (?, 'in', ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING
         RETURNING id`,
        id,
        peer,
        fields.da,
        fields.ud,
        computeShape(fields.ud),
        fields.scts,
        parts,
        incomplete ? 1 : 0,
        fields.raw ?? null,
      )
      .toArray();

    if (inserted.length === 0) return { stored: true, id, duplicate: true };

    this.touchSender(peer, fields.scts, nowMs);
    this.setMeta("last_receipt", new Date(nowMs).toISOString());
    // Extraction runs only after the row is committed: a pattern that throws
    // must cost the code its secret-tracking, never cost the store the
    // message.
    this.extractSecrets(id, peer, fields.ud, nowMs);
    return { stored: true, id, duplicate: false };
  }

  private touchSender(peer: string, scts: string, nowMs: number): void {
    const seen = new Date(nowMs).toISOString();
    this.sql.exec(
      `INSERT INTO senders (oa, shape_class, first_seen, last_seen, count, status)
       VALUES (?, ?, ?, ?, 1, 'new')
       ON CONFLICT(oa) DO UPDATE SET
         count = count + 1,
         last_seen = excluded.last_seen`,
      peer,
      senderClass(peer),
      scts || seen,
      scts || seen,
    );
  }

  // -- secrets --------------------------------------------------------------

  /**
   * Run this sender's approved patterns over the body and remember whatever
   * they capture until it expires. Inert until a pattern is approved, which is
   * the point: the intelligence is spent once, during review, and never
   * per-message.
   *
   * The body is length-capped before it reaches a regex. That bounds the
   * damage a badly-written pattern can do, though it cannot rule out
   * pathological backtracking entirely — which is why patterns are reviewed by
   * a human rather than proposed straight into the table.
   */
  extractSecrets(messageId: string, oa: string, body: string, nowMs: number): void {
    const rows = this.sql
      .exec("SELECT pattern, ttl_seconds FROM sender_patterns WHERE oa = ?", oa)
      .toArray();
    if (rows.length === 0) return;
    const subject = body.slice(0, 1000);
    for (const row of rows) {
      try {
        const re = new RegExp(row.pattern as string);
        const match = re.exec(subject);
        const captured = match?.groups?.secret ?? match?.[1];
        if (!captured) continue;
        const expiresAt = new Date(nowMs + (row.ttl_seconds as number) * 1000).toISOString();
        this.sql.exec(
          `INSERT INTO live_secrets (secret, oa, message_id, expires_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(secret) DO UPDATE SET
             expires_at = MAX(excluded.expires_at, live_secrets.expires_at),
             message_id = excluded.message_id`,
          normalizeSecret(captured),
          oa,
          messageId,
          expiresAt,
        );
      } catch {
        // A pattern that will not compile or throws is skipped; the message is
        // already stored and stays stored.
      }
    }
  }

  /**
   * Does an outbound payload carry a secret that arrived recently? This is the
   * one control the open store leans on, and it belongs on every write path in
   * the gateway rather than on the SMS one alone: for exfiltrating a code,
   * texting it back to a phone is the least useful channel an attacker has.
   */
  checkTaint(payload: string, nowMs: number): TaintHit | null {
    const now = new Date(nowMs).toISOString();
    const haystack = normalizeSecret(payload);
    if (haystack.length === 0) return null;
    const rows = this.sql
      .exec("SELECT secret, oa, message_id, expires_at FROM live_secrets WHERE expires_at > ?", now)
      .toArray();
    for (const row of rows) {
      const secret = row.secret as string;
      if (secret.length >= 4 && haystack.includes(secret)) {
        return {
          oa: row.oa as string,
          messageId: row.message_id as string,
          expiresAt: row.expires_at as string,
        };
      }
    }
    return null;
  }

  // -- sends ----------------------------------------------------------------

  /**
   * Open a send: write the row, run the taint check, and hand the Worker what
   * to dispatch. One call, because the row must exist before AAISP is reached
   * — a send that dies mid-flight should leave evidence rather than nothing.
   *
   * `sms_send` is marked destructive and sits behind the gateway's own
   * authentication, so there is no human release step. What stands in its
   * place is a legible log and this check.
   */
  beginSend(id: string, peer: string, body: string, requestedBy: string, nowMs: number): SendTicket {
    let destination: string;
    try {
      destination = normalizeDestination(peer);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }

    this.sql.exec(
      `INSERT INTO pending_sends (id, peer, body, requested_by, requested_at, state)
       VALUES (?, ?, ?, ?, ?, 'sending')`,
      id,
      destination,
      body,
      requestedBy,
      new Date(nowMs).toISOString(),
    );

    // Checked here rather than in the tool, so nothing can reach sms.cgi
    // without having passed it. Inert until a pattern is approved — until
    // then the log is what a human actually reviews.
    const taint = this.checkTaint(body, nowMs);
    if (taint) {
      this.markSend(id, "refused", nowMs, { error: `payload carries a code received from ${taint.oa}` });
      return { ok: false, reason: "the message carries a recently received code", taint };
    }

    return { ok: true, id, peer: destination, body };
  }

  listSends(limit = 50): SendRecord[] {
    return this.sql
      .exec(
        `SELECT id, peer, body, requested_by, requested_at, state, decided_at, message_id, error
           FROM pending_sends ORDER BY requested_at DESC LIMIT ?`,
        limit,
      )
      .toArray()
      .map(toSendRecord);
  }

  getSend(id: string): SendRecord | null {
    const rows = this.sql
      .exec(
        `SELECT id, peer, body, requested_by, requested_at, state, decided_at, message_id, error
           FROM pending_sends WHERE id = ?`,
        id,
      )
      .toArray();
    return rows.length === 0 ? null : toSendRecord(rows[0]!);
  }

  /**
   * Record what AAISP said. A successful send becomes a real outbound row in
   * `messages`, so a thread reads as a conversation rather than half of one.
   */
  async completeSend(id: string, outcome: SendOutcome, nowMs: number): Promise<void> {
    const send = this.getSend(id);
    if (!send) return;
    if (!outcome.ok) {
      this.markSend(id, "failed", nowMs, { error: outcome.detail ?? "send failed" });
      return;
    }
    const stamp = new Date(nowMs).toISOString();
    const messageId = await this.digest(`out|${send.peer}|${stamp}|${send.body}`);
    this.sql.exec(
      `INSERT INTO messages (id, direction, peer, own_number, body, shape, timestamp, parts, incomplete, status)
       VALUES (?, 'out', ?, ?, ?, ?, ?, 1, 0, 'sent')
       ON CONFLICT(id) DO NOTHING`,
      messageId,
      send.peer,
      outcome.ownNumber ?? "",
      send.body,
      computeShape(send.body),
      stamp,
    );
    this.markSend(id, "sent", nowMs, { messageId, error: outcome.detail ?? null });
  }

  /**
   * A delivery report from AAISP, correlated by the send id carried in the
   * `srr` URL — nothing else in their report identifies our message.
   */
  recordDlr(id: string, code: number): boolean {
    const send = this.getSend(id);
    if (!send?.messageId) return false;
    const status = code === 1 ? "delivered" : code === 8 ? "accepted" : "undelivered";
    this.sql.exec("UPDATE messages SET status = ?, dlr_code = ? WHERE id = ?", status, code, send.messageId);
    return true;
  }

  private markSend(
    id: string,
    state: SendState,
    nowMs: number,
    patch: { messageId?: string | null; error?: string | null },
  ): void {
    this.sql.exec(
      `UPDATE pending_sends
          SET state = ?, decided_at = ?,
              message_id = COALESCE(?, message_id),
              error = ?
        WHERE id = ?`,
      state,
      new Date(nowMs).toISOString(),
      patch.messageId ?? null,
      patch.error ?? null,
      id,
    );
  }
  addPattern(oa: string, pattern: string, ttlSeconds: number, samples: number, nowMs: number): void {
    // Compiling here means an unusable pattern is rejected at approval time
    // rather than discovered on the receive path.
    new RegExp(pattern);
    this.sql.exec(
      `INSERT INTO sender_patterns (oa, pattern, ttl_seconds, samples, approved_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(oa, pattern) DO UPDATE SET ttl_seconds = excluded.ttl_seconds`,
      oa,
      pattern,
      ttlSeconds,
      samples,
      new Date(nowMs).toISOString(),
    );
  }

  deletePattern(oa: string, pattern: string): void {
    this.sql.exec("DELETE FROM sender_patterns WHERE oa = ? AND pattern = ?", oa, pattern);
  }

  // -- reads ----------------------------------------------------------------

  listMessages(filter: MessageFilter): StoredMessage[] {
    const where: string[] = [];
    const bind: unknown[] = [];
    if (filter.peer) {
      where.push("peer = ?");
      bind.push(normalizePeer(filter.peer));
    }
    if (filter.after) {
      where.push("timestamp >= ?");
      bind.push(filter.after);
    }
    if (filter.before) {
      where.push("timestamp <= ?");
      bind.push(filter.before);
    }
    if (filter.query) {
      // Purged rows keep only their shape, so search covers both columns:
      // an old message still matches on the words its template contained.
      where.push("(body LIKE ? OR shape LIKE ?)");
      bind.push(`%${filter.query}%`, `%${filter.query}%`);
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    const rows = this.sql
      .exec(
        `SELECT id, direction, peer, own_number, body, shape, timestamp, parts, incomplete, status
           FROM messages
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY timestamp DESC, id
          LIMIT ? OFFSET ?`,
        ...bind,
        limit,
        offset,
      )
      .toArray();
    return rows.map(toMessage);
  }

  getThread(peer: string, limit = 200): StoredMessage[] {
    return this.sql
      .exec(
        `SELECT id, direction, peer, own_number, body, shape, timestamp, parts, incomplete, status
           FROM messages WHERE peer = ? ORDER BY timestamp, id LIMIT ?`,
        normalizePeer(peer),
        Math.min(Math.max(limit, 1), 500),
      )
      .toArray()
      .map(toMessage);
  }

  listSenders(): SenderRow[] {
    return this.sql
      .exec(
        `SELECT s.oa, s.shape_class, s.first_seen, s.last_seen, s.count, s.label, s.status, s.retention_days,
                (SELECT COUNT(*) FROM sender_patterns p WHERE p.oa = s.oa) AS patterns
           FROM senders s ORDER BY s.count DESC, s.oa`,
      )
      .toArray()
      .map((row) => ({
        oa: row.oa as string,
        shapeClass: row.shape_class as ShapeClass,
        firstSeen: row.first_seen as string,
        lastSeen: row.last_seen as string,
        count: row.count as number,
        label: (row.label as string | null) ?? null,
        status: row.status as SenderStatus,
        retentionDays: (row.retention_days as number | null) ?? null,
        patterns: row.patterns as number,
      }));
  }

  /** Distinct templates a sender has used, most frequent first — the input a
   *  pattern review actually works from. */
  shapesFor(oa: string, limit = 20): ShapeRow[] {
    return this.sql
      .exec(
        `SELECT shape, COUNT(*) AS n, MAX(timestamp) AS last_seen
           FROM messages WHERE peer = ? GROUP BY shape ORDER BY n DESC LIMIT ?`,
        oa,
        limit,
      )
      .toArray()
      .map((row) => ({
        shape: row.shape as string,
        count: row.n as number,
        lastSeen: row.last_seen as string,
      }));
  }

  setSender(oa: string, patch: SenderPatch): void {
    if (patch.label !== undefined) {
      this.sql.exec("UPDATE senders SET label = ? WHERE oa = ?", patch.label, oa);
    }
    if (patch.status !== undefined) {
      this.sql.exec("UPDATE senders SET status = ? WHERE oa = ?", patch.status, oa);
    }
    if (patch.retentionDays !== undefined) {
      this.sql.exec("UPDATE senders SET retention_days = ? WHERE oa = ?", patch.retentionDays, oa);
    }
  }

  status(nowMs: number): SmsStatus {
    const one = (query: string, ...bind: unknown[]) =>
      (this.sql.exec(query, ...bind).toArray()[0]?.n as number) ?? 0;
    return {
      messages: one("SELECT COUNT(*) AS n FROM messages"),
      senders: one("SELECT COUNT(*) AS n FROM senders"),
      bodiesRetained: one("SELECT COUNT(*) AS n FROM messages WHERE body IS NOT NULL"),
      pendingParts: one("SELECT COUNT(DISTINCT oa || ':' || ref) AS n FROM parts"),
      liveSecrets: one("SELECT COUNT(*) AS n FROM live_secrets WHERE expires_at > ?", new Date(nowMs).toISOString()),
      patterns: one("SELECT COUNT(*) AS n FROM sender_patterns"),
      lastReceipt: this.getMeta("last_receipt"),
      lastPurge: this.getMeta("last_purge"),
      newSenders: one("SELECT COUNT(*) AS n FROM senders WHERE status = 'new'"),
    };
  }

  // -- retention ------------------------------------------------------------

  /** What the next purge would drop, by sender — reviewable at a glance, which
   *  is the point: nobody reviews a per-message deletion queue for long. */
  retentionPreview(nowMs: number): RetentionRow[] {
    return this.listSenders()
      .map((sender) => {
        const days = sender.retentionDays ?? RETENTION_DEFAULTS[sender.status] ?? null;
        if (days === null) return null;
        const cutoff = new Date(nowMs - days * 86_400_000).toISOString();
        const n =
          (this.sql
            .exec(
              "SELECT COUNT(*) AS n FROM messages WHERE peer = ? AND body IS NOT NULL AND timestamp < ?",
              sender.oa,
              cutoff,
            )
            .toArray()[0]?.n as number) ?? 0;
        return n > 0 ? { oa: sender.oa, label: sender.label, days, messages: n } : null;
      })
      .filter((row): row is RetentionRow => row !== null);
  }

  /**
   * Drop bodies past their sender's retention, flush concatenated sets that
   * will never complete, and expire live secrets. `shape` survives everything:
   * it is what a pattern review reads, and it is why bodies can be dropped
   * aggressively from the first day.
   */
  purge(nowMs: number): { bodies: number; secrets: number } {
    let bodies = 0;
    for (const sender of this.listSenders()) {
      const days = sender.retentionDays ?? RETENTION_DEFAULTS[sender.status] ?? null;
      if (days === null) continue;
      const cutoff = new Date(nowMs - days * 86_400_000).toISOString();
      const hit = this.sql
        .exec(
          `UPDATE messages SET body = NULL, raw = NULL
            WHERE peer = ? AND body IS NOT NULL AND timestamp < ? RETURNING id`,
          sender.oa,
          cutoff,
        )
        .toArray();
      bodies += hit.length;
    }
    const now = new Date(nowMs).toISOString();
    const secrets = this.sql
      .exec("DELETE FROM live_secrets WHERE expires_at <= ? RETURNING secret", now)
      .toArray().length;
    return { bodies, secrets };
  }

  /**
   * Concatenated sets that never completed. A half-message is information too,
   * so what arrived is stored and marked incomplete rather than dropped.
   */
  async flushStaleParts(nowMs: number): Promise<number> {
    const cutoff = new Date(nowMs - PART_TIMEOUT_MS).toISOString();
    const stale = this.sql
      .exec(
        `SELECT oa, ref FROM parts GROUP BY oa, ref HAVING MIN(received_at) < ?`,
        cutoff,
      )
      .toArray();
    let flushed = 0;
    for (const row of stale) {
      const oa = row.oa as string;
      const ref = row.ref as number;
      const held = this.sql
        .exec("SELECT seq, ud, da, scts, raw, total FROM parts WHERE oa = ? AND ref = ? ORDER BY seq", oa, ref)
        .toArray();
      if (held.length === 0) continue;
      const first = held[0]!;
      this.sql.exec("DELETE FROM parts WHERE oa = ? AND ref = ?", oa, ref);
      await this.store(
        {
          oa,
          da: first.da as string,
          scts: first.scts as string,
          ud: held.map((p) => p.ud as string).join(""),
          raw: (first.raw as string | null) ?? null,
        },
        oa,
        nowMs,
        held.length,
        true,
      );
      flushed += 1;
    }
    return flushed;
  }

  // -- meta -----------------------------------------------------------------

  getMeta(key: string): string | null {
    const rows = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray();
    return rows.length ? (rows[0]!.value as string) : null;
  }

  setMeta(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }
}

function toSendRecord(row: Record<string, unknown>): SendRecord {
  return {
    id: row.id as string,
    peer: row.peer as string,
    body: row.body as string,
    requestedBy: row.requested_by as string,
    requestedAt: row.requested_at as string,
    state: row.state as SendState,
    decidedAt: (row.decided_at as string | null) ?? null,
    messageId: (row.message_id as string | null) ?? null,
    error: (row.error as string | null) ?? null,
  };
}

function toMessage(row: Record<string, unknown>): StoredMessage {
  return {
    id: row.id as string,
    direction: row.direction as string,
    peer: row.peer as string,
    ownNumber: row.own_number as string,
    body: (row.body as string | null) ?? null,
    shape: row.shape as string,
    timestamp: row.timestamp as string,
    parts: row.parts as number,
    incomplete: row.incomplete === 1,
    status: (row.status as string | null) ?? null,
  };
}
