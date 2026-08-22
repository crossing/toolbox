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
  ImportCode,
  ImportRequest,
  ImportResult,
  LastInteraction,
  ListChatsQuery,
  ListMessagesQuery,
  MediaResult,
  MessageContext,
  MessageRow,
  PairingResult,
  PreflightResult,
  SendResult,
  SyncResult,
  WhatsAppBridgeApi,
} from "@toolbox/mcp-shared";
import { Curve, fetchLatestWaWebVersion, generateMessageIDV2, MEDIA_PATH_MAP, proto } from "baileys";
import type { WAVersion } from "baileys";
import { makeSqlAuthState, type SqlAuthState } from "./auth";
import { encryptForUpload, fetchAndDecrypt, MediaError, uploadEncrypted } from "./media";
import { chatNameFor, kindFromFilename, mimeFromFilename, toJid, toStoredMessage } from "./normalize";
import { DisconnectReason, isFatalDisconnect, Session, type SessionHandlers } from "./session";
import { Store } from "./store";

export interface BridgeEnv {
  BRIDGE: DurableObjectNamespace;
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

/** How long a history-import code stays valid. */
const IMPORT_CODE_TTL_MS = 30 * 60 * 1000;

/** How long a pairing attempt is given before it is written off. */
const PAIRING_WINDOW_MS = 3 * 60 * 1000;

/** Baileys re-buffers events right after the drain marker; wait it out. */
const POST_DRAIN_SETTLE_MS = 3000;

// Inline caps. An image comes back to the model as an image block, costing
// image tokens; anything else can only be base64 in a text block, where a
// megabyte is ~1.37 million characters — hundreds of thousands of tokens for
// a file the model usually cannot read anyway. Hence the lopsided limits.
const IMAGE_INLINE_CAP = 2 * 1024 * 1024;
const FILE_INLINE_CAP = 32 * 1024;

/** Outgoing files: base64 in an MCP call, so the limit is about the request. */
const MAX_SEND_BYTES = 5 * 1024 * 1024;

export class WhatsAppBridge extends DurableObject<BridgeEnv> implements WhatsAppBridgeApi {
  private sql: SqlStorage;
  private store: Store;
  private auth: SqlAuthState;
  /** One WhatsApp connection at a time: two would fight over the session. */
  private busy = false;
  /** The detached tail of a pairing attempt, kept referenced while it runs. */
  private pairing: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: BridgeEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(META_SCHEMA);
    this.store = new Store(this.sql);
    // Durable Object SQLite rejects BEGIN/SAVEPOINT, so batched key writes go
    // through the platform's own synchronous transaction.
    this.auth = makeSqlAuthState(this.sql, (fn) => ctx.storage.transactionSync(fn));
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
      log: this.getMeta<string[]>("log", []),
    };
  }

  // The pairing path does two things nothing else does: it generates
  // INITIAL_PREKEY_COUNT (812) Curve25519 keypairs in one invocation, and it
  // asks the key store for all 812 back in a single `get`. Both are worth
  // proving on the deployed object before a human is standing there with a
  // phone: the first is the largest CPU spike in the bridge's life, and the
  // second is the query that would exceed SQLite's 100-parameter cap if the
  // chunking regressed.
  async preflight(): Promise<PreflightResult> {
    if (this.auth.isPaired()) {
      return { ok: false, steps: [], detail: "refusing to run against a paired session" };
    }
    // workerd freezes the clock during synchronous work, so these timings read
    // 0 for anything that never awaits. The signal is that the steps complete
    // at all — a CPU-budget failure surfaces as error 1102, not a slow number.
    const steps: PreflightResult["steps"] = [];
    const time = <T>(name: string, fn: () => T): T => {
      const start = Date.now();
      const value = fn();
      steps.push({ name, ms: Date.now() - start, detail: "" });
      return value;
    };
    const timeAsync = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const start = Date.now();
      const value = await fn();
      steps.push({ name, ms: Date.now() - start, detail: "" });
      return value;
    };
    try {
      // The derivation workerd refuses without the shim in whatsapp/src/pbkdf2.ts.
      // If this step throws, pairing cannot work and nothing else matters.
      const derived = await timeAsync("PBKDF2 at WhatsApp's 131,072 iterations", async () => {
        const material = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode("PREFLIGHT"),
          { name: "PBKDF2" },
          false,
          ["deriveBits"],
        );
        return crypto.subtle.deriveBits(
          { name: "PBKDF2", salt: new Uint8Array(16), iterations: 2 << 16, hash: "SHA-256" },
          material,
          256,
        );
      });
      steps[steps.length - 1]!.detail = `${derived.byteLength} bytes derived`;

      const COUNT = 812;
      const keys = time("generate 812 keypairs", () =>
        Object.fromEntries(
          Array.from({ length: COUNT }, (_, index) => [String(index + 1), Curve.generateKeyPair()]),
        ),
      );
      time("write them through the key store", () => {
        void this.auth.state.keys.set({ "pre-key": keys });
      });
      const ids = Object.keys(keys);
      const read = time("read all 812 back in one get", () => this.auth.state.keys.get("pre-key", ids));
      const found = Object.keys(read as Record<string, unknown>).length;
      steps[steps.length - 1]!.detail = `${found} of ${COUNT} returned`;
      time("clean up", () => {
        void this.auth.state.keys.set({
          "pre-key": Object.fromEntries(ids.map((id) => [id, null])),
        });
      });
      const ok = found === COUNT;
      this.log("info", `preflight ${ok ? "passed" : "failed"}: ${steps.map((s) => `${s.name} ${s.ms}ms`).join(", ")}`);
      return { ok, steps, detail: ok ? null : `key store returned ${found} of ${COUNT}` };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.log("error", `preflight failed: ${detail}`);
      return { ok: false, steps, detail };
    }
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

  // --- the WhatsApp connection ---------------------------------------------

  // Every cycle writes through these, so a drain, a history sync and a send
  // all land in the store the same way.
  private makeHandlers(counters: { messages: number; chats: number }): SessionHandlers {
    return {
      auth: this.auth,
      // Pairing mutates creds seconds before WhatsApp tears the stream down;
      // an unpersisted `advSecretKey` or `account` loses the pairing outright.
      onCreds: () => this.auth.saveCreds(),
      onMessages: (messages, type) => {
        const meId = this.auth.state.creds.me?.id ?? null;
        for (const message of messages) {
          const row = toStoredMessage(message, meId);
          if (!row) continue;
          this.store.upsertMessage(row);
          this.store.upsertChat({
            jid: row.chatJid,
            name: chatNameFor(message),
            lastMessageTime: row.timestamp,
          });
          counters.messages++;
        }
        if (messages.length > 0) this.log("info", `stored ${messages.length} ${type} messages`);
      },
      onChats: (chats) => {
        for (const chat of chats) {
          this.store.upsertChat(chat);
          counters.chats++;
        }
      },
      log: (level, message) => this.log(level, message),
    };
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    // wrangler tail withholds logs from WebSocket-upgraded invocations until
    // the socket closes, so the bridge keeps its own short log instead.
    const entry = `${new Date().toISOString()} ${level}: ${message.slice(0, 300)}`;
    const lines = [entry, ...this.getMeta<string[]>("log", [])].slice(0, 40);
    this.setMeta("log", lines);
    // Also to the console, so `wrangler tail` can watch a live cycle.
    console.log(`[bridge] ${entry}`);
  }

  private async openSession(counters: { messages: number; chats: number }): Promise<Session> {
    return new Session({ ...this.makeHandlers(counters), version: await this.waVersion() });
  }

  // The web version is md5'd into the registration payload, so a stale one can
  // get the connection rejected. Cheap to cache for a day.
  private async waVersion(): Promise<WAVersion | undefined> {
    const cached = this.getMeta<{ version: WAVersion; at: number } | null>("waVersion", null);
    if (cached && Date.now() - cached.at < 24 * 60 * 60 * 1000) return cached.version;
    try {
      const { version } = await fetchLatestWaWebVersion({});
      this.setMeta("waVersion", { version, at: Date.now() });
      this.log("info", `WhatsApp web version ${version.join(".")}`);
      return version;
    } catch (err) {
      this.log("warn", `could not fetch the WhatsApp web version: ${String(err)}`);
      return cached?.version;
    }
  }

  async requestPairingCode(phoneNumber: string): Promise<PairingResult> {
    if (this.busy) throw new Error("the bridge is busy — try again in a minute");
    if (this.auth.isPaired()) throw new Error("a device is already paired; unpair it first");
    const digits = phoneNumber.replace(/[^0-9]/g, "");
    if (digits.length < 8) throw new Error("phone number must be international digits, no +");

    // requestPairingCode writes creds.me before the pairing is confirmed, so a
    // previously abandoned attempt would send the next connect down the login
    // path with an unregistered identity. Always start from a clean identity.
    this.auth.reset();
    this.busy = true;
    const counters = { messages: 0, chats: 0 };
    let session: Session | null = null;
    try {
      this.setMeta("connection", "connecting");
      this.log("info", "pairing: opening a socket");
      session = await this.openSession(counters);
      this.log("info", "pairing: socket constructed, waiting for the pair-device stanza");
      // The code can only be requested once the handshake has produced a QR.
      await session.waitForPairingWindow(90_000);
      this.log("info", "pairing: reached the pairing window");
      const code = await session.sock.requestPairingCode(digits);
      const expiresAt = Date.now() + PAIRING_WINDOW_MS;
      this.setMeta("pendingPairing", { phoneNumber: digits, code, expiresAt });
      this.log("info", `pairing code issued for ${digits}`);
      // The rest happens on WhatsApp's schedule — minutes, maybe. Hand the
      // code back now and let the socket run on; an open outbound socket keeps
      // this object resident.
      this.pairing = this.finishPairing(session, counters).finally(() => {
        this.busy = false;
        this.pairing = null;
      });
      return { code, phoneNumber: digits, expiresAt };
    } catch (err) {
      this.busy = false;
      this.setMeta("connection", "idle");
      this.setMeta("lastError", err instanceof Error ? err.message : String(err));
      await session?.close();
      throw err;
    }
  }

  // Second half of pairing: WhatsApp confirms, then immediately closes the
  // stream with 515 "restart required" — that close is success, not failure,
  // and the session only becomes usable on the reconnect that follows.
  private async finishPairing(
    session: Session,
    counters: { messages: number; chats: number },
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      await session.waitForUpdate((update) => update.connection === "close", PAIRING_WINDOW_MS, {
        rejectOnClose: false,
      });
      const code = session.lastDisconnectCode;
      await session.close();
      if (code !== DisconnectReason.restartRequired) {
        const detail = `pairing did not complete (${code ?? "no code"}: ${session.lastDisconnectMessage ?? "closed"})`;
        this.setMeta("lastError", detail);
        this.setMeta("pendingPairing", null);
        if (!this.auth.isPaired()) this.auth.reset();
        this.recordCycle({ startedAt, endedAt: Date.now(), outcome: "error", messages: 0, chats: 0, detail });
        return;
      }

      const second = await this.openSession(counters);
      try {
        await second.waitForOpen(90_000);
        this.setMeta("pendingPairing", null);
        this.setMeta("lastConnectedAt", Date.now());
        this.setMeta("lastError", null);
        this.setMeta("connection", "open");
        this.log("info", `paired as ${this.auth.state.creds.me?.id ?? "unknown"}`);
        // Best-effort: a fresh device usually has a backlog waiting.
        await second.waitForDrain(90_000).catch((err) => this.log("warn", `first drain: ${String(err)}`));
        await scheduler.wait(POST_DRAIN_SETTLE_MS);
        this.setMeta("lastDrainAt", Date.now());
      } finally {
        await second.close();
      }

      this.setMeta("autoSync", true);
      await this.ctx.storage.setAlarm(Date.now() + SYNC_INTERVAL_MS);
      this.recordCycle({
        startedAt,
        endedAt: Date.now(),
        outcome: "ok",
        messages: counters.messages,
        chats: counters.chats,
        detail: "paired",
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.setMeta("lastError", detail);
      this.recordCycle({ startedAt, endedAt: Date.now(), outcome: "error", messages: 0, chats: 0, detail });
    } finally {
      this.setMeta("connection", "idle");
    }
  }

  async unpair(): Promise<{ ok: boolean }> {
    this.auth.reset();
    this.setMeta("pendingPairing", null);
    this.setMeta("lastError", null);
    this.setMeta("autoSync", false);
    await this.ctx.storage.deleteAlarm();
    this.log("info", "device forgotten");
    return { ok: true };
  }

  async syncNow(): Promise<SyncResult> {
    if (!this.auth.isPaired()) {
      return { ok: false, messages: 0, chats: 0, detail: "no device is paired" };
    }
    return this.runCycle();
  }

  // Connect, let WhatsApp hand over whatever it queued, disconnect. Never
  // throws: the alarm path depends on that, because a thrown alarm is retried
  // with backoff and then dropped for good.
  private async runCycle(): Promise<SyncResult> {
    if (this.busy) {
      return { ok: false, messages: 0, chats: 0, detail: "a sync is already running" };
    }
    this.busy = true;
    const startedAt = Date.now();
    const counters = { messages: 0, chats: 0 };
    let session: Session | null = null;
    let ok = false;
    let detail: string | null = null;
    try {
      this.setMeta("connection", "connecting");
      session = await this.openSession(counters);
      await session.waitForOpen(60_000);
      this.setMeta("connection", "open");
      this.setMeta("lastConnectedAt", Date.now());
      await session.waitForDrain(90_000);
      // The drain marker is not the end of the story: Baileys re-buffers
      // straight afterwards and flushes on a later task.
      await scheduler.wait(POST_DRAIN_SETTLE_MS);
      this.setMeta("lastDrainAt", Date.now());
      detail = session.offlineCount === null ? null : `offline queue: ${session.offlineCount}`;
      ok = true;
      this.setMeta("lastError", null);
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
      this.setMeta("lastError", detail);
      // A device unlinked on the phone can never come back on these creds;
      // stop retrying and show it as unpaired rather than failing forever.
      if (session && isFatalDisconnect(session.lastDisconnectCode)) {
        if (session.lastDisconnectCode !== DisconnectReason.connectionReplaced) {
          this.auth.reset();
          detail = `${detail} — session is dead, pair again`;
        }
        this.setMeta("autoSync", false);
        await this.ctx.storage.deleteAlarm();
      }
    } finally {
      this.setMeta("connection", "closing");
      await session?.close();
      this.setMeta("connection", "idle");
      this.busy = false;
    }
    this.recordCycle({
      startedAt,
      endedAt: Date.now(),
      outcome: ok ? "ok" : "error",
      messages: counters.messages,
      chats: counters.chats,
      detail,
    });
    return { ok, messages: counters.messages, chats: counters.chats, detail };
  }

  async alarm(): Promise<void> {
    const auto = this.getMeta<boolean>("autoSync", false);
    // Re-arm before doing any work: an alarm that throws is retried with
    // backoff and dropped after six failures, and a dropped alarm means the
    // bridge silently stops syncing.
    if (auto) await this.ctx.storage.setAlarm(Date.now() + SYNC_INTERVAL_MS);
    if (!auto || !this.auth.isPaired() || this.busy) return;
    await this.runCycle();
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

  async downloadMedia(messageId: string, chatJid: string): Promise<MediaResult> {
    const descriptor = this.store.mediaFor(messageId, chatJid);
    if (!descriptor) return { ok: false, detail: "no such message in the store" };
    if (!descriptor.mediaType) return { ok: false, detail: "that message has no attachment" };
    try {
      const media = await fetchAndDecrypt(descriptor);
      const cap = media.mimeType.startsWith("image/") ? IMAGE_INLINE_CAP : FILE_INLINE_CAP;
      if (media.bytes.length > cap) {
        return {
          ok: false,
          size: media.bytes.length,
          mimeType: media.mimeType,
          filename: media.filename,
          detail: `attachment is ${Math.round(media.bytes.length / 1024)} KB, over the ${Math.round(cap / 1024)} KB inline limit`,
        };
      }
      return {
        ok: true,
        base64: Buffer.from(media.bytes).toString("base64"),
        mimeType: media.mimeType,
        filename: media.filename,
        size: media.bytes.length,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (err instanceof MediaError && err.retryable) this.log("warn", `media expired: ${messageId}`);
      return { ok: false, detail };
    }
  }

  // --- writes ---------------------------------------------------------------

  async sendMessage(recipient: string, message: string): Promise<SendResult> {
    if (!this.auth.isPaired()) return { ok: false, detail: "no device is paired" };
    if (!message.trim()) return { ok: false, detail: "refusing to send an empty message" };
    if (this.busy) return { ok: false, detail: "the bridge is busy — try again in a moment" };

    let jid: string;
    try {
      jid = toJid(recipient);
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }

    this.busy = true;
    const counters = { messages: 0, chats: 0 };
    let session: Session | null = null;
    try {
      this.setMeta("connection", "connecting");
      session = await this.openSession(counters);
      await session.waitForOpen(60_000);
      this.setMeta("connection", "open");
      this.setMeta("lastConnectedAt", Date.now());
      const sent = await session.sock.sendMessage(jid, { text: message });
      if (sent) {
        // emitOwnEvents is off, so our own message never comes back through
        // messages.upsert; file it directly or the store would forget it.
        const row = toStoredMessage(sent, this.auth.state.creds.me?.id ?? null);
        if (row) {
          this.store.upsertMessage(row);
          this.store.upsertChat({ jid: row.chatJid, lastMessageTime: row.timestamp });
        }
      }
      this.log("info", `sent a message to ${jid}`);
      return { ok: true, messageId: sent?.key?.id ?? undefined };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.setMeta("lastError", detail);
      return { ok: false, detail };
    } finally {
      this.setMeta("connection", "closing");
      await session?.close();
      this.setMeta("connection", "idle");
      this.busy = false;
    }
  }

  // Baileys' own media send is unusable here: it writes the encrypted file to
  // os.tmpdir() and streams it with node:https. So the file is encrypted in
  // memory, POSTed to a media host with fetch, and the resulting proto is
  // relayed directly — bypassing sendMessage's file-based machinery entirely.
  async sendFile(
    recipient: string,
    filename: string,
    base64: string,
    mediaType?: string,
    caption?: string,
  ): Promise<SendResult> {
    if (!this.auth.isPaired()) return { ok: false, detail: "no device is paired" };
    if (this.busy) return { ok: false, detail: "the bridge is busy — try again in a moment" };

    let jid: string;
    let bytes: Uint8Array;
    try {
      jid = toJid(recipient);
      bytes = new Uint8Array(Buffer.from(base64, "base64"));
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    if (bytes.length === 0) return { ok: false, detail: "the file is empty" };
    if (bytes.length > MAX_SEND_BYTES) {
      return { ok: false, detail: `file is ${Math.round(bytes.length / 1024)} KB, over the ${MAX_SEND_BYTES / 1024 / 1024} MB send limit` };
    }
    const kind = mediaType ?? kindFromFilename(filename);
    const mimeType = mimeFromFilename(filename, kind);

    this.busy = true;
    const counters = { messages: 0, chats: 0 };
    let session: Session | null = null;
    try {
      this.setMeta("connection", "connecting");
      session = await this.openSession(counters);
      await session.waitForOpen(60_000);
      this.setMeta("connection", "open");
      this.setMeta("lastConnectedAt", Date.now());

      const upload = await encryptForUpload(bytes, kind);
      const conn = (await session.sock.refreshMediaConn(false)) as unknown as {
        hosts: { hostname: string }[];
        auth: string;
      };
      const placed = await uploadEncrypted(upload, kind, conn, MEDIA_PATH_MAP as Record<string, string>);

      const descriptor = {
        url: placed.url,
        directPath: placed.directPath,
        mediaKey: upload.mediaKey,
        mimetype: mimeType,
        fileEncSha256: upload.fileEncSha256,
        fileSha256: upload.fileSha256,
        fileLength: upload.fileLength,
        mediaKeyTimestamp: Math.floor(Date.now() / 1000),
      };
      const message: proto.IMessage =
        kind === "image"
          ? { imageMessage: { ...descriptor, caption } }
          : kind === "video"
            ? { videoMessage: { ...descriptor, caption } }
            : kind === "audio"
              ? { audioMessage: { ...descriptor, ptt: false } }
              : { documentMessage: { ...descriptor, fileName: filename, caption } };

      const messageId = generateMessageIDV2(this.auth.state.creds.me?.id);
      await session.sock.relayMessage(jid, message, { messageId });

      const row = toStoredMessage(
        {
          key: { remoteJid: jid, fromMe: true, id: messageId },
          message,
          messageTimestamp: Math.floor(Date.now() / 1000),
        } as never,
        this.auth.state.creds.me?.id ?? null,
      );
      if (row) {
        this.store.upsertMessage(row);
        this.store.upsertChat({ jid: row.chatJid, lastMessageTime: row.timestamp });
      }
      this.log("info", `sent a ${kind} to ${jid}`);
      return { ok: true, messageId };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.setMeta("lastError", detail);
      return { ok: false, detail };
    } finally {
      this.setMeta("connection", "closing");
      await session?.close();
      this.setMeta("connection", "idle");
      this.busy = false;
    }
  }

  // --- import ---------------------------------------------------------------

  // The importer runs from a shell, so its credential has to survive being
  // read off a web page by eye: a short code from an unambiguous alphabet
  // rather than a signed blob. ~39 bits, single expiry window, and ten wrong
  // guesses burn it — enough for a one-off append-only capability.
  async issueImportCode(): Promise<ImportCode> {
    const alphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
    const code = `${chars.slice(0, 4)}-${chars.slice(4)}`;
    const expiresAt = Date.now() + IMPORT_CODE_TTL_MS;
    this.setMeta("importCode", { code, expiresAt, strikes: 0 });
    return { code, expiresAt };
  }

  private assertImportCode(candidate: string): void {
    const stored = this.getMeta<{ code: string; expiresAt: number; strikes: number } | null>(
      "importCode",
      null,
    );
    const normalize = (value: string) => value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
    if (!stored || stored.expiresAt < Date.now()) {
      throw new Error("no import code is active — issue one on /manage/whatsapp");
    }
    if (normalize(stored.code) !== normalize(candidate ?? "")) {
      const strikes = stored.strikes + 1;
      if (strikes >= 10) {
        this.setMeta("importCode", null);
        throw new Error("import code burned after too many wrong attempts");
      }
      this.setMeta("importCode", { ...stored, strikes });
      throw new Error("import code does not match");
    }
  }

  async importRows(request: ImportRequest, code: string): Promise<ImportResult> {
    this.assertImportCode(code);
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
