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
import { deviceBrowser, DisconnectReason, isFatalDisconnect, Session, type SessionHandlers } from "./session";
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

/** How long verbose logging stays on before it switches itself off. */
const VERBOSE_TTL_MS = 30 * 60 * 1000;

/** How long a history-import code stays valid. */
const IMPORT_CODE_TTL_MS = 30 * 60 * 1000;

// How long a pairing attempt is given before it is written off. WhatsApp's own
// code lifetime is the real bound; this is deliberately longer so the socket
// is never what cuts a pairing short — someone has to fetch a phone, unlock
// it, and find Linked devices.
const PAIRING_WINDOW_MS = 5 * 60 * 1000;

// How long each linking QR is displayed before Baileys asks WhatsApp for the
// next ref. WhatsApp hands out five, so this also sets the length of the whole
// QR window: five rotations at 50 s is a little over four minutes, just inside
// PAIRING_WINDOW_MS.
const QR_ROTATE_MS = 50 * 1000;

/** What WhatsApp → Linked devices calls this bridge, unless told otherwise. */
const DEFAULT_DEVICE_NAME = "Xing's Assistant";

/** Device names have to be legible in a phone's UI, not expressive. */
const MAX_DEVICE_NAME = 40;

/** Baileys re-buffers events right after the drain marker; wait it out. */
const POST_DRAIN_SETTLE_MS = 3000;

// No legitimate connection lives longer than this: a cycle's waits add up to
// about three minutes, and a pairing window is three. Past it, an in-progress
// flag is residue from an instance that went away mid-operation, and honouring
// it would lock the bridge until someone noticed.
const STALE_OPERATION_MS = 6 * 60 * 1000;

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
  private busySince = 0;
  /** The detached tail of a pairing attempt, kept referenced while it runs. */
  private pairing: Promise<void> | null = null;
  /** The socket that tail is watching, so an abandoned attempt can be dropped. */
  private pairingSession: Session | null = null;
  /** Set by cancelPairing so the tail knows the close was ours. */
  private pairingCancelled = false;

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

  // In-memory, so eviction clears it; the timestamp covers the case where the
  // object survives but an operation did not.
  private get inProgress(): boolean {
    return this.busy && Date.now() - this.busySince < STALE_OPERATION_MS;
  }

  private beginOperation(): void {
    this.busy = true;
    this.busySince = Date.now();
  }

  private setConnection(state: BridgeStatus["connection"]): void {
    this.setMeta("connection", state);
    this.setMeta("connectionSince", Date.now());
  }

  /** The stored state, unless it is old enough to be residue. */
  private connectionState(): BridgeStatus["connection"] {
    const state = this.getMeta<BridgeStatus["connection"]>("connection", "idle");
    if (state === "idle") return state;
    const since = this.getMeta<number>("connectionSince", 0);
    return Date.now() - since > STALE_OPERATION_MS ? "idle" : state;
  }

  private recordCycle(cycle: BridgeCycle): void {
    const cycles = [cycle, ...this.getMeta<BridgeCycle[]>("cycles", [])].slice(0, MAX_CYCLES);
    this.setMeta("cycles", cycles);
  }

  // --- lifecycle ------------------------------------------------------------

  async status(): Promise<BridgeStatus> {
    const counts = this.store.counts();
    const pending = this.getMeta<BridgeStatus["pendingPairing"]>("pendingPairing", null);
    const qr = this.pendingQr();
    return {
      paired: this.auth.isPaired(),
      me: this.auth.state.creds.me
        ? { id: this.auth.state.creds.me.id, name: this.auth.state.creds.me.name ?? null }
        : null,
      pendingPairing: pending && pending.expiresAt > Date.now() ? pending : null,
      // Described, never quoted: the string is only handed out by pairingQr().
      pendingQr: qr ? { issuedAt: qr.issuedAt, expiresAt: qr.expiresAt } : null,
      deviceName: this.deviceName(),
      connection: this.connectionState(),
      autoSync: this.getMeta<boolean>("autoSync", false),
      verbose: this.isVerbose(),
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

  // Workers Logs is the log of record. `observability` is enabled on this
  // Worker, so everything written to console is indexed and queryable for
  // three days — and console arguments that are objects are indexed field by
  // field, which is why this emits a structured entry rather than a formatted
  // string. Query it with
  //   POST /accounts/<id>/workers/observability/telemetry/query
  // filtering `$metadata.service = whatsapp-bridge`, not with `wrangler tail`,
  // which withholds logs from WebSocket-upgraded invocations until the socket
  // closes — which for this Worker is always.
  //
  // The console method carries the level, so warnings and errors are filterable
  // as such instead of by grepping a prefix.
  private log(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}): void {
    const entry = { service: "whatsapp-bridge", level, msg: message.slice(0, 300), ...fields };
    if (level === "error") console.error(entry);
    else if (level === "warn") console.warn(entry);
    else console.log(entry);

    // The SQLite ring is a mirror, not the log. A Worker cannot query Workers
    // Logs without an API token, and /manage/whatsapp has to be able to show
    // the last few minutes without one; it also outlives the three-day
    // retention window for the handful of lines anyone comes back to.
    const line = `${new Date().toISOString()} ${level}: ${message.slice(0, 300)}`;
    const lines = [line, ...this.getMeta<string[]>("log", [])].slice(0, this.isVerbose() ? 250 : 40);
    this.setMeta("log", lines);
  }

  // `qr` is only ever set for the socket that registers a new device: that is
  // the one WhatsApp takes the client identity from, and the only one whose
  // QR events anyone wants recorded.
  private async openSession(
    counters: { messages: number; chats: number },
    options: { qr?: boolean } = {},
  ): Promise<Session> {
    return new Session({
      ...this.makeHandlers(counters),
      version: await this.waVersion(),
      verbose: this.isVerbose(),
      ...(options.qr
        ? {
            qrTimeoutMs: QR_ROTATE_MS,
            browser: deviceBrowser(this.deviceName()),
            onQr: (qr: string) => {
              this.setMeta("pendingQr", {
                qr,
                issuedAt: Date.now(),
                expiresAt: Date.now() + QR_ROTATE_MS,
              });
            },
          }
        : {}),
    });
  }

  private deviceName(): string {
    return this.getMeta<string>("deviceName", DEFAULT_DEVICE_NAME);
  }

  private pendingQr(): { qr: string; issuedAt: number; expiresAt: number } | null {
    const stored = this.getMeta<{ qr: string; issuedAt: number; expiresAt: number } | null>(
      "pendingQr",
      null,
    );
    return stored && stored.expiresAt > Date.now() ? stored : null;
  }

  async setDeviceName(name: string): Promise<{ deviceName: string }> {
    const cleaned = name.replace(/\s+/g, " ").trim().slice(0, MAX_DEVICE_NAME);
    const deviceName = cleaned === "" ? DEFAULT_DEVICE_NAME : cleaned;
    this.setMeta("deviceName", deviceName);
    this.log("info", `device name for the next pairing: ${deviceName}`);
    return { deviceName };
  }

  async pairingQr(): Promise<{ qr: string; expiresAt: number } | null> {
    const pending = this.pendingQr();
    return pending ? { qr: pending.qr, expiresAt: pending.expiresAt } : null;
  }

  async setUseLatestVersion(enabled: boolean): Promise<{ useLatestVersion: boolean }> {
    this.setMeta("useLatestVersion", enabled);
    this.log("info", `web version source: ${enabled ? "fetched from WhatsApp" : "baileys pinned"}`);
    return { useLatestVersion: enabled };
  }

  // Verbose logging forwards Baileys' own output and every inbound stanza,
  // which is hundreds of events per cycle instead of a dozen. The Workers Free
  // plan allows 200,000 log events a day *across the account*, shared with the
  // gateway, so a verbose flag left on by someone who got distracted is the
  // one realistic way to spend it. It expires by itself.
  async setVerbose(enabled: boolean): Promise<{ verbose: boolean }> {
    this.setMeta("verboseUntil", enabled ? Date.now() + VERBOSE_TTL_MS : 0);
    this.log("info", `verbose logging ${enabled ? `on for ${VERBOSE_TTL_MS / 60000} minutes` : "off"}`);
    return { verbose: enabled };
  }

  private isVerbose(): boolean {
    return this.getMeta<number>("verboseUntil", 0) > Date.now();
  }

  // The web version is md5'd into the registration payload, so a stale one can
  // get the connection rejected — but so can a *newer* one that the companion
  // registration endpoint does not accept, which is why this is a toggle and
  // the default is Baileys' pinned version.
  private async waVersion(): Promise<WAVersion | undefined> {
    if (!this.getMeta<boolean>("useLatestVersion", false)) return undefined;
    const cached = this.getMeta<{ version: WAVersion; at: number } | null>("waVersion", null);
    if (cached && Date.now() - cached.at < 24 * 60 * 60 * 1000) return cached.version;
    try {
      // fetchLatestWaWebVersion never throws: on any failure it hands back
      // Baileys' pinned version with isLatest false. Caching that for a day
      // would pin a stale version well past the point WhatsApp minds.
      const { version, isLatest } = await fetchLatestWaWebVersion({});
      if (isLatest) {
        this.setMeta("waVersion", { version, at: Date.now() });
        this.log("info", `WhatsApp web version ${version.join(".")}`);
      } else {
        this.log("warn", "could not resolve the current WhatsApp web version; using the pinned one");
      }
      return version;
    } catch (err) {
      this.log("warn", `could not fetch the WhatsApp web version: ${String(err)}`);
      return cached?.version;
    }
  }

  // The preferred way in. WhatsApp treats a QR link as the ordinary case —
  // no phone number is disclosed to the bridge, the client may name itself,
  // and there is nothing to mistype. The socket has to stay open while the
  // codes rotate, which is what keeps this object resident.
  async beginQrPairing(): Promise<{ expiresAt: number }> {
    if (this.inProgress) throw new Error("the bridge is busy — try again in a minute");
    if (this.auth.isPaired()) throw new Error("a device is already paired; unpair it first");

    // Any earlier attempt left creds.me set, which would send this connection
    // down the login path with an identity WhatsApp never registered.
    this.auth.reset();
    this.setMeta("pendingQr", null);
    this.setMeta("pendingPairing", null);
    this.pairingCancelled = false;
    this.beginOperation();
    const counters = { messages: 0, chats: 0 };
    let session: Session | null = null;
    try {
      this.setConnection("connecting");
      this.log("info", `QR pairing: opening a socket as "${this.deviceName()}"`);
      session = await this.openSession(counters, { qr: true });
      // The first QR arrives with the same event the phone-code path waits on.
      await session.waitForPairingWindow(90_000);
      const expiresAt = Date.now() + PAIRING_WINDOW_MS;
      this.log("info", "QR pairing: code displayed, waiting for the phone");
      this.pairingSession = session;
      this.pairing = this.finishPairing(session, counters).finally(() => {
        this.busy = false;
        this.pairing = null;
        this.pairingSession = null;
      });
      return { expiresAt };
    } catch (err) {
      this.busy = false;
      this.setConnection("idle");
      this.setMeta("pendingQr", null);
      this.setMeta("lastError", err instanceof Error ? err.message : String(err));
      await session?.close();
      throw err;
    }
  }

  // Someone changed their mind, or the QR went stale while nobody was looking.
  // Closing the socket resolves the detached tail's wait; the cancelled flag is
  // what stops it filing that close as a failed pairing.
  async cancelPairing(): Promise<{ ok: boolean }> {
    const session = this.pairingSession;
    this.pairingCancelled = true;
    this.pairingSession = null;
    this.setMeta("pendingQr", null);
    this.setMeta("pendingPairing", null);
    if (session) await session.close();
    if (!this.auth.isPaired()) this.auth.reset();
    this.busy = false;
    this.setConnection("idle");
    this.log("info", "pairing attempt cancelled");
    return { ok: true };
  }

  async requestPairingCode(phoneNumber: string): Promise<PairingResult> {
    if (this.inProgress) throw new Error("the bridge is busy — try again in a minute");
    if (this.auth.isPaired()) throw new Error("a device is already paired; unpair it first");
    const digits = phoneNumber.replace(/[^0-9]/g, "");
    if (digits.length < 8) throw new Error("phone number must be international digits, no +");

    // requestPairingCode writes creds.me before the pairing is confirmed, so a
    // previously abandoned attempt would send the next connect down the login
    // path with an unregistered identity. Always start from a clean identity.
    this.auth.reset();
    this.setMeta("pendingQr", null);
    this.pairingCancelled = false;
    this.beginOperation();
    const counters = { messages: 0, chats: 0 };
    let session: Session | null = null;
    try {
      this.setConnection("connecting");
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
      this.pairingSession = session;
      this.pairing = this.finishPairing(session, counters).finally(() => {
        this.busy = false;
        this.pairing = null;
        this.pairingSession = null;
      });
      return { code, phoneNumber: digits, expiresAt };
    } catch (err) {
      this.busy = false;
      this.setConnection("idle");
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
      try {
        await session.waitForUpdate((update) => update.connection === "close", PAIRING_WINDOW_MS, {
          rejectOnClose: false,
        });
      } finally {
        // A human who never types the code leaves this socket running until
        // WhatsApp's own QR-ref timer kills it, holding the object resident
        // and colliding with the next attempt.
        await session.close();
      }
      // cancelPairing() closed the socket on purpose; it has already tidied up.
      if (this.pairingCancelled) return;

      const code = session.lastDisconnectCode;
      if (code !== DisconnectReason.restartRequired) {
        const detail = `pairing did not complete (${code ?? "no code"}: ${session.lastDisconnectMessage ?? "closed"})`;
        this.setMeta("lastError", detail);
        this.setMeta("pendingPairing", null);
        this.setMeta("pendingQr", null);
        if (!this.auth.isPaired()) this.auth.reset();
        this.recordCycle({ startedAt, endedAt: Date.now(), outcome: "error", messages: 0, chats: 0, detail });
        return;
      }

      // Scheduling is armed here, before the reconnect: from this point the
      // device is paired, and a failed first cycle should be a retry rather
      // than a bridge that never wakes up again.
      this.setMeta("autoSync", true);
      await this.ctx.storage.setAlarm(Date.now() + SYNC_INTERVAL_MS);

      const second = await this.openSession(counters);
      try {
        await second.waitForOpen(90_000);
        this.setMeta("pendingPairing", null);
        this.setMeta("pendingQr", null);
        this.setMeta("lastConnectedAt", Date.now());
        this.setMeta("lastError", null);
        this.setConnection("open");
        this.log("info", `paired as ${this.auth.state.creds.me?.id ?? "unknown"}`, {
          event: "paired",
          jid: this.auth.state.creds.me?.id ?? null,
          deviceName: this.deviceName(),
        });
        // Best-effort: a fresh device usually has a backlog waiting.
        await second.waitForDrain(90_000).catch((err) => this.log("warn", `first drain: ${String(err)}`));
        await scheduler.wait(POST_DRAIN_SETTLE_MS);
        this.setMeta("lastDrainAt", Date.now());
      } finally {
        await second.close();
      }

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
      this.setConnection("idle");
    }
  }

  async unpair(): Promise<{ ok: boolean }> {
    // auth.reset() mutates the very creds object a running socket holds.
    if (this.inProgress) {
      throw new Error("the bridge is mid-connection; try again in a minute");
    }
    this.auth.reset();
    this.setMeta("pendingPairing", null);
    this.setMeta("pendingQr", null);
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
    if (this.inProgress) {
      return { ok: false, messages: 0, chats: 0, detail: "a sync is already running" };
    }
    this.beginOperation();
    const startedAt = Date.now();
    const counters = { messages: 0, chats: 0 };
    let session: Session | null = null;
    let ok = false;
    let detail: string | null = null;
    try {
      this.setConnection("connecting");
      session = await this.openSession(counters);
      await session.waitForOpen(60_000);
      this.setConnection("open");
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
        this.auth.reset();
        detail = `${detail} — session is dead, pair again`;
        this.setMeta("autoSync", false);
        await this.ctx.storage.deleteAlarm();
      }
    } finally {
      this.setConnection("closing");
      await session?.close();
      this.setConnection("idle");
      this.busy = false;
    }
    // The one line worth querying across days: "how many cycles failed, and
    // with what". Structured, so it filters on `event` and `ok` rather than
    // on the shape of a sentence.
    this.log(ok ? "info" : "error", `sync cycle ${ok ? "ok" : "failed"}`, {
      event: "cycle",
      ok,
      messages: counters.messages,
      chats: counters.chats,
      ms: Date.now() - startedAt,
      detail,
    });
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
    if (!auto || !this.auth.isPaired() || this.inProgress) return;
    await this.runCycle();
  }

  // --- reads ----------------------------------------------------------------

  async searchContacts(query: string, limit?: number, page?: number): Promise<ContactRow[]> {
    return this.store.searchContacts(query, limit, page);
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
    // The kind is known before the bytes are: an image imported without a mime
    // type still deserves the image cap.
    const isImage = descriptor.mediaType === "image" || descriptor.mediaType === "sticker";
    const cap = isImage ? IMAGE_INLINE_CAP : FILE_INLINE_CAP;
    if (descriptor.fileLength && descriptor.fileLength > cap) {
      return {
        ok: false,
        size: descriptor.fileLength,
        mimeType: descriptor.mimeType ?? undefined,
        filename: descriptor.filename,
        detail: `attachment is ${Math.round(descriptor.fileLength / 1024)} KB, over the ${Math.round(cap / 1024)} KB inline limit`,
      };
    }
    try {
      const media = await fetchAndDecrypt(descriptor, { maxBytes: cap });
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
    if (this.inProgress) return { ok: false, detail: "the bridge is busy — try again in a moment" };

    let jid: string;
    try {
      jid = toJid(recipient);
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }

    this.beginOperation();
    const counters = { messages: 0, chats: 0 };
    let session: Session | null = null;
    try {
      this.setConnection("connecting");
      session = await this.openSession(counters);
      await session.waitForOpen(60_000);
      this.setConnection("open");
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
      this.setConnection("closing");
      await session?.close();
      this.setConnection("idle");
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
    if (this.inProgress) return { ok: false, detail: "the bridge is busy — try again in a moment" };

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

    this.beginOperation();
    const counters = { messages: 0, chats: 0 };
    let session: Session | null = null;
    try {
      this.setConnection("connecting");
      session = await this.openSession(counters);
      await session.waitForOpen(60_000);
      this.setConnection("open");
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
      this.setConnection("closing");
      await session?.close();
      this.setConnection("idle");
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
