// WhatsAppBridge — the Durable Object that owns the WhatsApp session.
//
// It lives in its own Worker script rather than inside gateway-mcp: a deploy
// evicts every Durable Object in the script it belongs to, and this one holds
// a paired device session that should not churn every time a gateway tool
// changes. The gateway reaches it over a cross-script DO binding.
//
// Connection model is intermittent, never always-on: an alarm every
// SYNC_INTERVAL_MS wakes the object, connects, drains WhatsApp's offline
// queue into SQLite, and disconnects. Always-on would burn ~83% of the free
// Durable Object duration budget and still die on every redeploy; this costs
// roughly 8%.

import { DurableObject } from "cloudflare:workers";
import type {
  BridgeCycle,
  BridgeStatus,
  ChatRow,
  ContactRow,
  ImportRequest,
  ImportResult,
  LastInteraction,
  ListChatsQuery,
  ListMessagesQuery,
  MediaResult,
  MessageContext,
  MessageRow,
  PairingResult,
  SendResult,
  SyncResult,
  WhatsAppBridgeApi,
} from "@toolbox/mcp-shared";
import { makeSqlAuthState, type SqlAuthState } from "./auth";
import { Store } from "./store";

export interface BridgeEnv {
  BRIDGE: DurableObjectNamespace;
  MEDIA?: R2Bucket;
}

/** How often the bridge wakes to drain WhatsApp's offline queue. */
export const SYNC_INTERVAL_MS = 10 * 60 * 1000;

const META_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const MAX_CYCLES = 10;

export class WhatsAppBridge extends DurableObject<BridgeEnv> implements WhatsAppBridgeApi {
  private sql: SqlStorage;
  private store: Store;
  private auth: SqlAuthState;

  constructor(ctx: DurableObjectState, env: BridgeEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(META_SCHEMA);
    this.store = new Store(this.sql);
    this.auth = makeSqlAuthState(this.sql);
  }

  // --- meta helpers ---------------------------------------------------------

  private getMeta<T>(key: string, fallback: T): T {
    const rows = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray();
    if (rows.length === 0) return fallback;
    try {
      return JSON.parse(rows[0]!.value as string) as T;
    } catch {
      return fallback;
    }
  }

  private setMeta(key: string, value: unknown): void {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    );
  }

  private recordCycle(cycle: BridgeCycle): void {
    const cycles = [cycle, ...this.getMeta<BridgeCycle[]>("cycles", [])].slice(0, MAX_CYCLES);
    this.setMeta("cycles", cycles);
  }

  // --- lifecycle ------------------------------------------------------------

  async status(): Promise<BridgeStatus> {
    const counts = this.store.counts();
    const pending = this.getMeta<BridgeStatus["pendingPairing"]>("pendingPairing", null);
    return {
      paired: this.auth.isPaired(),
      me: this.auth.state.creds.me
        ? { id: this.auth.state.creds.me.id, name: this.auth.state.creds.me.name ?? null }
        : null,
      pendingPairing: pending && pending.expiresAt > Date.now() ? pending : null,
      connection: this.getMeta<BridgeStatus["connection"]>("connection", "idle"),
      lastConnectedAt: this.getMeta<number | null>("lastConnectedAt", null),
      lastDrainAt: this.getMeta<number | null>("lastDrainAt", null),
      lastError: this.getMeta<string | null>("lastError", null),
      nextAlarmAt: (await this.ctx.storage.getAlarm()) ?? null,
      chatCount: counts.chats,
      messageCount: counts.messages,
      recentCycles: this.getMeta<BridgeCycle[]>("cycles", []),
    };
  }

  async setAutoSync(enabled: boolean): Promise<{ enabled: boolean; nextAlarmAt: number | null }> {
    this.setMeta("autoSync", enabled);
    if (enabled) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
    return { enabled, nextAlarmAt: (await this.ctx.storage.getAlarm()) ?? null };
  }

  async requestPairingCode(_phoneNumber: string): Promise<PairingResult> {
    throw new Error("pairing is not wired up yet");
  }

  async unpair(): Promise<{ ok: boolean }> {
    this.auth.reset();
    this.setMeta("pendingPairing", null);
    this.setMeta("lastError", null);
    await this.ctx.storage.deleteAlarm();
    return { ok: true };
  }

  async syncNow(): Promise<SyncResult> {
    throw new Error("sync is not wired up yet");
  }

  async alarm(): Promise<void> {
    if (this.getMeta<boolean>("autoSync", false)) {
      await this.ctx.storage.setAlarm(Date.now() + SYNC_INTERVAL_MS);
    }
  }

  // --- reads ----------------------------------------------------------------

  async searchContacts(query: string): Promise<ContactRow[]> {
    return this.store.searchContacts(query);
  }

  async listMessages(query: ListMessagesQuery): Promise<MessageRow[]> {
    return this.store.listMessages(query);
  }

  async listChats(query: ListChatsQuery): Promise<ChatRow[]> {
    return this.store.listChats(query);
  }

  async getChat(chatJid: string): Promise<ChatRow | null> {
    return this.store.getChat(chatJid);
  }

  async getDirectChatByContact(senderPhoneNumber: string): Promise<ChatRow | null> {
    return this.store.getDirectChatByContact(senderPhoneNumber);
  }

  async getContactChats(jid: string, limit?: number, page?: number): Promise<ChatRow[]> {
    return this.store.getContactChats(jid, limit, page);
  }

  async getLastInteraction(jid: string): Promise<LastInteraction> {
    return { message: this.store.getLastInteraction(jid) };
  }

  async getMessageContext(messageId: string, before?: number, after?: number): Promise<MessageContext> {
    return this.store.getMessageContext(messageId, before, after);
  }

  async downloadMedia(_messageId: string, _chatJid: string): Promise<MediaResult> {
    return { ok: false, detail: "media download is not wired up yet" };
  }

  // --- writes ---------------------------------------------------------------

  async sendMessage(_recipient: string, _message: string): Promise<SendResult> {
    return { ok: false, detail: "sending is not wired up yet" };
  }

  async sendFile(
    _recipient: string,
    _filename: string,
    _base64: string,
    _mediaType?: string,
    _caption?: string,
  ): Promise<SendResult> {
    return { ok: false, detail: "sending is not wired up yet" };
  }

  // --- import ---------------------------------------------------------------

  async importRows(request: ImportRequest): Promise<ImportResult> {
    let chatsWritten = 0;
    let messagesWritten = 0;
    let skipped = 0;
    for (const chat of request.chats) {
      if (!chat.jid) {
        skipped++;
        continue;
      }
      this.store.upsertChat(chat);
      chatsWritten++;
    }
    for (const msg of request.messages) {
      if (!msg.id || !msg.chatJid || !msg.timestamp) {
        skipped++;
        continue;
      }
      this.store.upsertMessage(msg);
      messagesWritten++;
    }
    return { chatsWritten, messagesWritten, skipped };
  }
}
