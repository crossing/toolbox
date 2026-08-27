// SmsInbox — one Durable Object holding every text the AAISP number receives.
//
// Unlike the WhatsApp bridge this lives inside gateway-mcp rather than in its
// own Worker. The bridge got a separate script because it holds a live Baileys
// session that a deploy must not evict; an SMS store has no session and no
// socket, so eviction costs nothing — SQLite persists and the next request
// re-hydrates it.
//
// The methods are one-line delegations on purpose: RPC needs them declared on
// the class, and the logic they forward to is plain SQL in smsstore.ts, where
// a test can reach it without a Durable Object runtime.

import { DurableObject } from "cloudflare:workers";
import {
  SmsStore,
  type InboundFields,
  type MessageFilter,
  type RecordResult,
  type RetentionRow,
  type PendingSend,
  type ReleaseTicket,
  type SendOutcome,
  type SenderPatch,
  type SenderRow,
  type ShapeRow,
  type SmsStatus,
  type StoredMessage,
  type TaintHit,
} from "./smsstore";

/** How often retention runs. Nothing here is time-critical: the alarm exists
 *  so bodies do not accumulate forever, not so they vanish promptly. */
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class SmsInbox extends DurableObject<unknown> {
  private store: SmsStore;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.store = new SmsStore(ctx.storage.sql, sha256Hex);
  }

  async receive(fields: InboundFields): Promise<RecordResult> {
    const result = await this.store.recordInbound(fields, Date.now());
    // Armed lazily rather than in the constructor: a DO that never receives
    // anything should not be woken every day to discover it has nothing to do.
    await this.ensureAlarm();
    return result;
  }

  listMessages(filter: MessageFilter): StoredMessage[] {
    return this.store.listMessages(filter);
  }

  getThread(peer: string, limit?: number): StoredMessage[] {
    return this.store.getThread(peer, limit);
  }

  listSenders(): SenderRow[] {
    return this.store.listSenders();
  }

  shapesFor(oa: string, limit?: number): ShapeRow[] {
    return this.store.shapesFor(oa, limit);
  }

  setSender(oa: string, patch: SenderPatch): void {
    this.store.setSender(oa, patch);
  }

  addPattern(oa: string, pattern: string, ttlSeconds: number, samples: number): void {
    this.store.addPattern(oa, pattern, ttlSeconds, samples, Date.now());
  }

  deletePattern(oa: string, pattern: string): void {
    this.store.deletePattern(oa, pattern);
  }

  /** The one control the open store leans on. Every write path in the gateway
   *  should consult it, not only the SMS one. */
  checkTaint(payload: string): TaintHit | null {
    return this.store.checkTaint(payload, Date.now());
  }

  /** Sends are staged here and dispatched by the Worker, which is the only
   *  side holding AAISP credentials. */
  stageSend(peer: string, body: string, requestedBy: string): PendingSend {
    return this.store.stageSend(crypto.randomUUID(), peer, body, requestedBy, Date.now());
  }

  listSends(limit?: number): PendingSend[] {
    return this.store.listSends(limit);
  }

  beginRelease(id: string): ReleaseTicket {
    return this.store.beginRelease(id, Date.now());
  }

  async completeSend(id: string, outcome: SendOutcome): Promise<void> {
    await this.store.completeSend(id, outcome, Date.now());
  }

  cancelSend(id: string): void {
    this.store.cancelSend(id, Date.now());
  }

  recordDlr(id: string, code: number): boolean {
    return this.store.recordDlr(id, code);
  }

  status(): SmsStatus {
    return this.store.status(Date.now());
  }

  retentionPreview(): RetentionRow[] {
    return this.store.retentionPreview(Date.now());
  }

  async purgeNow(): Promise<{ bodies: number; secrets: number; flushed: number }> {
    return this.runMaintenance();
  }

  async alarm(): Promise<void> {
    await this.runMaintenance();
    await this.ctx.storage.setAlarm(Date.now() + PURGE_INTERVAL_MS);
  }

  private async runMaintenance(): Promise<{ bodies: number; secrets: number; flushed: number }> {
    const now = Date.now();
    const flushed = await this.store.flushStaleParts(now);
    const purged = this.store.purge(now);
    this.store.setMeta("last_purge", new Date(now).toISOString());
    return { ...purged, flushed };
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + PURGE_INTERVAL_MS);
    }
  }
}
