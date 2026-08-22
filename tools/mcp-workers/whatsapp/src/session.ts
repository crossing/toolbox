// One WhatsApp connection, from open to clean close.
//
// Everything here is shaped by three facts about running Baileys inside a
// Durable Object:
//
//   - The WASM crypto bridge only compiles during Worker startup, so `baileys`
//     must be imported statically at module scope — never behind a lazy
//     `await import()` that isn't already in the graph.
//   - Every cache Baileys builds for itself is a NodeCache with a 10-minute
//     `setInterval`. Four of them plus the 30 s keepalive would keep the object
//     resident; plain Map-backed stores mean the only timer is the keepalive.
//   - `sock.end(undefined)` is the shutdown that keeps the session; `logout()`
//     unlinks the device server-side and is never what a sync cycle wants.
//
// Baileys' own event buffering makes "have I got everything?" subtle: the
// drain marker is `connection.update.receivedPendingNotifications`, but
// Socket/chats.js re-buffers immediately afterwards and flushes on a later
// task, so callers wait a beat past the marker before closing.

import makeWASocket, { DisconnectReason } from "baileys";
import type { CacheStore, ConnectionState, WAMessage, WAVersion } from "baileys";
// ILogger is declared in Utils/logger.d.ts and not re-exported from the root.
import type { ILogger } from "baileys/lib/Utils/logger.js";
import type { SqlAuthState } from "./auth";

export const DEFAULT_BROWSER: [string, string, string] = ["Cloudflare", "Chrome", "1.0"];

/** Long enough for a human to fetch their phone and type a pairing code. */
const QR_TIMEOUT_MS = 180_000;

function memCache(): CacheStore {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    set: <T>(key: string, value: T) => {
      map.set(key, value);
    },
    del: (key: string) => {
      map.delete(key);
    },
    flushAll: () => {
      map.clear();
    },
  };
}

export type LogSink = (level: "info" | "warn" | "error", message: string) => void;

function makeLogger(sink: LogSink): ILogger {
  const format = (obj: unknown, msg?: string): string =>
    msg ? `${msg} ${typeof obj === "object" ? JSON.stringify(obj)?.slice(0, 200) : String(obj)}` : String(obj);
  const logger: ILogger = {
    // Baileys checks `logger.level` before serialising XML on hot paths, so
    // keeping this at "warn" is a real saving, not cosmetic.
    level: "warn",
    child: () => logger,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (obj: unknown, msg?: string) => sink("warn", format(obj, msg)),
    error: (obj: unknown, msg?: string) => sink("error", format(obj, msg)),
  };
  return logger;
}

export interface SessionHandlers {
  auth: SqlAuthState;
  /** Called on every `creds.update`; must persist synchronously. */
  onCreds(): void;
  onMessages(messages: WAMessage[], type: string): void;
  onChats(chats: { jid: string; name?: string | null; lastMessageTime?: string | null }[]): void;
  log: LogSink;
  version?: WAVersion;
}

interface Waiter {
  check: (update: Partial<ConnectionState>) => boolean;
  resolve: (update: Partial<ConnectionState>) => void;
  reject: (err: Error) => void;
  rejectOnClose: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export class Session {
  readonly sock: ReturnType<typeof makeWASocket>;
  private waiters: Waiter[] = [];
  private ended = false;
  /** Populated when WhatsApp tears the stream down; a Boom status code. */
  lastDisconnectCode: number | null = null;
  lastDisconnectMessage: string | null = null;
  /** `<ib><offline count="N"/></ib>` — Baileys logs it but never emits it. */
  offlineCount: number | null = null;

  constructor(private handlers: SessionHandlers) {
    this.sock = makeWASocket({
      auth: handlers.auth.state,
      logger: makeLogger(handlers.log),
      ...(handlers.version ? { version: handlers.version } : {}),
      browser: DEFAULT_BROWSER,
      // A bridge that syncs every few minutes has no use for a full history
      // replay, and asking for one costs a 20 s wait on every first connect.
      syncFullHistory: false,
      // Staying invisible keeps the phone's notifications working normally.
      markOnlineOnConnect: false,
      fireInitQueries: false,
      emitOwnEvents: false,
      generateHighQualityLinkPreview: false,
      qrTimeout: QR_TIMEOUT_MS,
      msgRetryCounterCache: memCache(),
      callOfferCache: memCache(),
      userDevicesCache: memCache(),
      placeholderResendCache: memCache(),
    });

    this.sock.ev.on("creds.update", () => handlers.onCreds());

    this.sock.ev.on("connection.update", (update) => {
      if (update.connection === "close") {
        const err = update.lastDisconnect?.error as
          | { output?: { statusCode?: number }; message?: string }
          | undefined;
        this.lastDisconnectCode = err?.output?.statusCode ?? null;
        this.lastDisconnectMessage = err?.message ?? null;
      }
      this.settle(update);
    });

    this.sock.ev.on("messages.upsert", ({ messages, type }) => {
      try {
        handlers.onMessages(messages, type);
      } catch (err) {
        handlers.log("error", `storing messages failed: ${String(err)}`);
      }
    });

    this.sock.ev.on("chats.upsert", (chats) => this.reportChats(chats));
    this.sock.ev.on("chats.update", (chats) => this.reportChats(chats));
    this.sock.ev.on("messaging-history.set", ({ chats, messages }) => {
      this.reportChats(chats ?? []);
      if (messages?.length) handlers.onMessages(messages, "history");
    });

    // The backlog size is only ever logged by Baileys; read it off the raw node.
    this.sock.ws.on("CB:ib,,offline", (node: unknown) => {
      const children = (node as { content?: { tag: string; attrs: Record<string, string> }[] }).content;
      const offline = children?.find((child) => child.tag === "offline");
      this.offlineCount = offline ? Number(offline.attrs.count ?? 0) : null;
    });
  }

  private reportChats(chats: { id?: string | null; name?: string | null; conversationTimestamp?: unknown }[]): void {
    const mapped = chats
      .filter((chat) => Boolean(chat.id))
      .map((chat) => ({ jid: chat.id as string, name: chat.name ?? null }));
    if (mapped.length > 0) {
      try {
        this.handlers.onChats(mapped);
      } catch (err) {
        this.handlers.log("error", `storing chats failed: ${String(err)}`);
      }
    }
  }

  private settle(update: Partial<ConnectionState>): void {
    const closed = update.connection === "close";
    for (const waiter of [...this.waiters]) {
      if (waiter.check(update)) {
        this.remove(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(update);
      } else if (closed && waiter.rejectOnClose) {
        this.remove(waiter);
        clearTimeout(waiter.timer);
        waiter.reject(
          new Error(
            `connection closed (${this.lastDisconnectCode ?? "?"}: ${this.lastDisconnectMessage ?? "no reason"})`,
          ),
        );
      }
    }
  }

  private remove(waiter: Waiter): void {
    this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
  }

  waitForUpdate(
    check: (update: Partial<ConnectionState>) => boolean,
    timeoutMs: number,
    { rejectOnClose = true }: { rejectOnClose?: boolean } = {},
  ): Promise<Partial<ConnectionState>> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        check,
        resolve,
        reject,
        rejectOnClose,
        timer: setTimeout(() => {
          this.remove(waiter);
          reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for WhatsApp`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /** Resolves once the socket is authenticated and usable. */
  waitForOpen(timeoutMs = 60_000): Promise<Partial<ConnectionState>> {
    return this.waitForUpdate((update) => update.connection === "open", timeoutMs);
  }

  /**
   * Resolves once WhatsApp says the offline queue has been handed over. The
   * server sends the marker even when there was nothing pending, so this is
   * safe to wait on unconditionally — but only on a logged-in connection.
   */
  waitForDrain(timeoutMs = 90_000): Promise<Partial<ConnectionState>> {
    return this.waitForUpdate((update) => update.receivedPendingNotifications === true, timeoutMs);
  }

  /** Resolves when the pairing-code flow may start (post-handshake). */
  waitForPairingWindow(timeoutMs = 60_000): Promise<Partial<ConnectionState>> {
    return this.waitForUpdate((update) => Boolean(update.qr), timeoutMs);
  }

  /** Clean shutdown that preserves the session; never `logout()`. */
  async close(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters) clearTimeout(waiter.timer);
    this.waiters = [];
    try {
      // Baileys awaits the WebSocket's `close` event with no timeout of its
      // own; the shim guarantees one, but a wedged shutdown must never eat the
      // alarm's wall clock either.
      await Promise.race([this.sock.end(undefined), scheduler.wait(8000)]);
    } catch (err) {
      this.handlers.log("warn", `closing the socket threw: ${String(err)}`);
    }
  }
}

/** True when a disconnect means the stored session is dead, not just dropped. */
export function isFatalDisconnect(code: number | null): boolean {
  return (
    code === DisconnectReason.loggedOut ||
    code === DisconnectReason.forbidden ||
    code === DisconnectReason.multideviceMismatch ||
    code === DisconnectReason.connectionReplaced
  );
}

export { DisconnectReason };
