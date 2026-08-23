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
import { wsDebug } from "./ws-shim";

// WhatsApp validates the shape of a companion registration, and it is fussier
// about the phone-code path than the QR path: an unrecognised client identity
// gets `<error code="400" text="bad-request"/>` back. Baileys' own default is
// the tuple every other Baileys client sends, so it is the one the server has
// certainly seen before.
export const DEFAULT_BROWSER: [string, string, string] = ["Mac OS", "Chrome", "14.4.1"];

interface BinaryNodeish {
  tag?: string;
  attrs?: Record<string, unknown>;
  content?: unknown;
}

/**
 * A stanza as XML-ish text, two levels deep. The reason WhatsApp rejects
 * something is never on the outer node — `<iq type="error">` carries an
 * `<error code=… text=…/>` child, and without it the log says only that
 * something went wrong.
 */
function describeNode(node: unknown, depth = 0): string {
  const binary = node as BinaryNodeish;
  if (!binary?.tag) return "";
  const attrs = Object.entries(binary.attrs ?? {})
    .map(([key, value]) => ` ${key}="${String(value).slice(0, 60)}"`)
    .join("");
  const children = Array.isArray(binary.content) && depth < 2
    ? binary.content.map((child) => describeNode(child, depth + 1)).filter(Boolean).join("")
    : "";
  return children ? `<${binary.tag}${attrs}>${children}</${binary.tag}>` : `<${binary.tag}${attrs}/>`;
}

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

/**
 * Baileys gates hot paths on `logger.level` (it only serialises XML when the
 * level is "trace"/"debug"), so the normal level is "warn" and that is a real
 * saving. Verbose mode exists for one job: telling whether a stanza we are
 * waiting for — a pairing confirmation, say — ever arrived at all.
 */
function makeLogger(sink: LogSink, verbose: boolean): ILogger {
  const format = (obj: unknown, msg?: string): string =>
    msg ? `${msg} ${typeof obj === "object" ? JSON.stringify(obj)?.slice(0, 300) : String(obj)}` : String(obj);
  const logger: ILogger = {
    level: verbose ? "debug" : "warn",
    child: () => logger,
    trace: () => {},
    debug: verbose ? (obj: unknown, msg?: string) => sink("info", `baileys: ${format(obj, msg)}`) : () => {},
    info: verbose ? (obj: unknown, msg?: string) => sink("info", `baileys: ${format(obj, msg)}`) : () => {},
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
  /** Forward Baileys' own debug/info logs; for diagnosing a stuck handshake. */
  verbose?: boolean;
  /**
   * Every linking QR WhatsApp issues, including the rotations. Only the QR
   * pairing flow sets this; every other connection ignores the event.
   */
  onQr?(qr: string): void;
  /** How long each QR lives before Baileys asks for the next ref. */
  qrTimeoutMs?: number;
  /**
   * The client identity, which is also what WhatsApp → Linked devices ends up
   * displaying. Overriding it is safe on the QR path and *not* on the
   * phone-code path, where an unrecognised identity is answered with 400.
   */
  browser?: [string, string, string];
}

interface Waiter {
  check: (update: Partial<ConnectionState>) => boolean;
  resolve: (update: Partial<ConnectionState>) => void;
  reject: (err: Error) => void;
  rejectOnClose: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Waiting for connection milestones, against the state accumulated so far
 * rather than only against future events.
 *
 * WhatsApp does not promise an order. A reconnecting device is told its
 * offline queue is drained *before* Baileys reports the connection open:
 *
 *     connection.update: drained            12:57:02.259
 *     connection.update: connection=open    12:57:02.346
 *
 * Code that awaits "open" and only then asks for "drained" misses the marker
 * by 87ms and waits out its whole timeout for an event that already happened.
 * So every update is merged into a running state, and a new waiter is tested
 * against that state before it is queued.
 */
export class ConnectionWaiters {
  private waiters: Waiter[] = [];
  private state: Partial<ConnectionState> = {};

  /** Merge an update and settle whatever it satisfies. */
  settle(update: Partial<ConnectionState>): void {
    Object.assign(this.state, update);
    const closed = update.connection === "close";
    for (const waiter of [...this.waiters]) {
      if (waiter.check(this.state)) {
        this.remove(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(this.state);
      } else if (closed && waiter.rejectOnClose) {
        this.remove(waiter);
        clearTimeout(waiter.timer);
        waiter.reject(new Error(this.closeReason()));
      }
    }
  }

  /** Populated by the owner so a rejection can say why the socket went. */
  closeReason: () => string = () => "connection closed";

  wait(
    check: (update: Partial<ConnectionState>) => boolean,
    timeoutMs: number,
    { rejectOnClose = true }: { rejectOnClose?: boolean } = {},
  ): Promise<Partial<ConnectionState>> {
    // Already true? Then there is nothing to wait for.
    if (check(this.state)) return Promise.resolve(this.state);
    if (rejectOnClose && this.state.connection === "close") {
      return Promise.reject(new Error(this.closeReason()));
    }
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

  cancelAll(): void {
    for (const waiter of this.waiters) clearTimeout(waiter.timer);
    this.waiters = [];
  }

  private remove(waiter: Waiter): void {
    this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
  }
}

export class Session {
  readonly sock: ReturnType<typeof makeWASocket>;
  private waiters = new ConnectionWaiters();
  private ended = false;
  /** Populated when WhatsApp tears the stream down; a Boom status code. */
  lastDisconnectCode: number | null = null;
  lastDisconnectMessage: string | null = null;
  /** `<ib><offline count="N"/></ib>` — Baileys logs it but never emits it. */
  offlineCount: number | null = null;

  constructor(private handlers: SessionHandlers) {
    this.waiters.closeReason = () =>
      `connection closed (${this.lastDisconnectCode ?? "?"}: ${this.lastDisconnectMessage ?? "no reason"})`;
    handlers.log("info", `opening socket with version ${handlers.version ? handlers.version.join(".") : "baileys default"}`);
    this.sock = makeWASocket({
      auth: handlers.auth.state,
      logger: makeLogger(handlers.log, handlers.verbose ?? false),
      ...(handlers.version ? { version: handlers.version } : {}),
      browser: handlers.browser ?? DEFAULT_BROWSER,
      // A bridge that syncs every few minutes has no use for a full history
      // replay, and asking for one costs a 20 s wait on every first connect.
      syncFullHistory: false,
      // Staying invisible keeps the phone's notifications working normally.
      markOnlineOnConnect: false,
      fireInitQueries: false,
      emitOwnEvents: false,
      generateHighQualityLinkPreview: false,
      qrTimeout: handlers.qrTimeoutMs ?? QR_TIMEOUT_MS,
      msgRetryCounterCache: memCache(),
      callOfferCache: memCache(),
      userDevicesCache: memCache(),
      placeholderResendCache: memCache(),
    });

    this.sock.ev.on("creds.update", () => handlers.onCreds());

    // Every state change, in the bridge's own log: a stalled handshake is
    // otherwise invisible, since wrangler tail withholds logs from
    // WebSocket-upgraded invocations until the socket closes.
    this.sock.ev.on("connection.update", (update) => {
      const err = update.lastDisconnect?.error as
        | { output?: { statusCode?: number; payload?: unknown }; message?: string }
        | undefined;
      const shape = [
        update.connection ? `connection=${update.connection}` : "",
        update.qr ? "qr" : "",
        update.isNewLogin ? "isNewLogin" : "",
        update.receivedPendingNotifications ? "drained" : "",
        err ? `closed code=${err.output?.statusCode ?? "?"} reason=${(err.message ?? "").slice(0, 120)}` : "",
      ].filter(Boolean).join(" ");
      if (shape) handlers.log("info", `connection.update: ${shape}`);
      // Baileys rotates the QR on its own timer until the refs run out, so
      // this fires several times per pairing attempt.
      if (update.qr && handlers.onQr) handlers.onQr(update.qr);
    });

    this.sock.ev.on("connection.update", (update) => {
      if (update.connection === "close") {
        const err = update.lastDisconnect?.error as
          | { output?: { statusCode?: number }; message?: string }
          | undefined;
        this.lastDisconnectCode = err?.output?.statusCode ?? null;
        this.lastDisconnectMessage = err?.message ?? null;
      }
      this.waiters.settle(update);
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

    if (handlers.verbose) {
      // Every inbound stanza tag, so "did the confirmation arrive" is a fact
      // rather than an inference.
      this.sock.ws.on("frame", (node: unknown) => {
        handlers.log("info", `frame ${describeNode(node)}`);
      });
    }

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

  waitForUpdate(
    check: (update: Partial<ConnectionState>) => boolean,
    timeoutMs: number,
    options: { rejectOnClose?: boolean } = {},
  ): Promise<Partial<ConnectionState>> {
    return this.waiters.wait(check, timeoutMs, options);
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

  /** The socket-level trace of this connection, newest last. */
  wsTrace(): string[] {
    return [...wsDebug];
  }

  /** Clean shutdown that preserves the session; never `logout()`. */
  async close(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.handlers.log("info", `socket trace: ${wsDebug.slice(-12).join(" | ")}`);
    this.waiters.cancelAll();
    try {
      // sock.end() finishes with ev.destroy(), which DISCARDS whatever is in
      // Baileys' event buffer rather than flushing it — and the buffer is
      // re-armed the moment the drain marker fires (Socket/chats.js), holding
      // the tail of the offline queue. Those messages were already acked on
      // the wire, so WhatsApp will never send them again: flush before ending
      // or they are lost for good.
      this.sock.ev.flush();
      await Promise.race([this.sock.end(undefined), scheduler.wait(8000)]);
    } catch (err) {
      this.handlers.log("warn", `closing the socket threw: ${String(err)}`);
    }
  }
}

/** True when a disconnect means the stored session is dead, not just dropped. */
export function isFatalDisconnect(code: number | null): boolean {
  // Deliberately excludes connectionReplaced (440). That one means another
  // client took the session — a stale socket of ours, or the phone doing
  // something — and it says nothing about the credentials. Treating it as
  // fatal would let one transient collision switch scheduled syncing off
  // until a human noticed.
  return (
    code === DisconnectReason.loggedOut ||
    code === DisconnectReason.forbidden ||
    code === DisconnectReason.multideviceMismatch
  );
}

export { DisconnectReason };
