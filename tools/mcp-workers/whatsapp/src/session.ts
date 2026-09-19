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

import makeWASocket, { DisconnectReason, proto } from "baileys";
import type { CacheStore, ConnectionState, WAMessage, WAMessageKey, WAVersion } from "baileys";
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

/**
 * The client identity for a socket that is registering a *new* device, with
 * the name in the slot WhatsApp actually reads.
 *
 * Baileys' tuple is `[os, browser, version]`, and it is tempting to read that
 * as "platform, client name, client version" — it is not what reaches the
 * phone. `generateRegistrationNode` (Utils/validate-connection.js) builds
 *
 *     { os: browser[0], platformType: getPlatformType(browser[1]), … }
 *
 * The phone renders that as "<platform label> (<os>)" — so `["Xing's
 * Assistant", "Chrome", …]` shows up as **Google Chrome (Xing's Assistant)**.
 * `os` is the only free text of the two: `browser[1]` is looked up in the
 * `DeviceProps.PlatformType` enum, where anything unrecognised silently falls
 * through to CHROME. Putting a device name in the second slot therefore does
 * nothing at all except leave the first slot — "Mac OS" — as the parenthetical,
 * which is exactly what it looked like when the first QR pairing came back
 * named after the platform.
 *
 * `browser[2]` reaches nothing: the advertised app version comes from
 * `config.version`, which is md5'd separately.
 */
export function deviceBrowser(name: string): [string, string, string] {
  return [name, "Chrome", "14.4.1"];
}

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
 * Serialize a value Baileys handed the logger into a log line.
 *
 * The trap this exists to avoid: Baileys reports failures as
 * `logger.error({ jid, err }, 'Failed to encrypt for recipient')`, where `err`
 * is an `Error`. `JSON.stringify` only serialises an Error's *enumerable* own
 * properties. On workerd a Node `RangeError` exposes `code` and `name` as
 * enumerable but leaves `message` and `stack` non-enumerable, so a plain
 * `JSON.stringify({ jid, err })` collapses to
 * `{"jid":"…","err":{"code":"ERR_OUT_OF_RANGE","name":"RangeError"}}` — the one
 * field that says *what* went out of range is dropped before it is ever logged,
 * which is exactly why the encryption failure could not be diagnosed from the
 * bridge log. The replacer below expands any Error (top-level or nested) into
 * its name, message, code, stack and Boom `output`, so the message survives.
 */
export function serializeLogValue(obj: unknown): string {
  const replacer = (_key: string, value: unknown): unknown => {
    if (value instanceof Error) {
      const err = value as Error & { code?: unknown; output?: unknown };
      return {
        name: err.name,
        message: err.message,
        ...(err.code !== undefined ? { code: err.code } : {}),
        ...(err.output !== undefined ? { output: err.output } : {}),
        stack: err.stack,
      };
    }
    return value;
  };
  return JSON.stringify(obj, replacer) ?? String(obj);
}

/**
 * Baileys gates hot paths on `logger.level` (it only serialises XML when the
 * level is "trace"/"debug"), so the normal level is "warn" and that is a real
 * saving. Verbose mode exists for one job: telling whether a stanza we are
 * waiting for — a pairing confirmation, say — ever arrived at all.
 */
function makeLogger(sink: LogSink, verbose: boolean): ILogger {
  // An Error handed straight in, or nested in an object, is expanded to keep
  // its message and stack (see serializeLogValue). Errors get a wider budget
  // than a routine line because the message plus the first stack frames is what
  // makes a failure diagnosable; the bridge's own log ring caps what it keeps.
  const format = (obj: unknown, msg?: string): string => {
    if (obj instanceof Error) obj = { err: obj };
    const body = typeof obj === "object" && obj !== null ? serializeLogValue(obj).slice(0, 1500) : String(obj);
    return msg ? `${msg} ${body}` : body;
  };
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
  /** `archived` is only present when WhatsApp said so (an app-state sync from the phone). */
  onChats(chats: { jid: string; name?: string | null; lastMessageTime?: string | null; archived?: boolean }[]): void;
  /** Chats deleted on another device. The store flags them; it never drops them. */
  onChatsDeleted?(jids: string[]): void;
  /**
   * One of our own messages, as a proto, for a recipient device that could not
   * decrypt it and is asking again. See the note on `getMessage` below.
   */
  getMessage?(key: WAMessageKey): proto.IMessage | undefined;
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

/** How long a close will wait for offline messages still inside Baileys. */
export const INBOUND_PROCESS_BOUND_MS = 30_000;
/** How long it then waits for a sender to answer a retry receipt. */
export const RETRY_GRACE_MS = 10_000;
const INBOUND_POLL_MS = 400;

export interface InboundSummary {
  /** Offline stanzas seen on the wire this connection, by kind. */
  offline: { message: number; receipt: number; notification: number; call: number };
  /** Offline message stanzas that never came out of Baileys as an upsert. */
  pendingMessages: number;
  /** Messages that arrived but could not be decrypted (a retry was requested). */
  undecryptable: number;
  /** …of which the sender's resend arrived before the socket closed. */
  recovered: number;
}

/**
 * Knowing when it is safe to hang up.
 *
 * WhatsApp's "offline queue drained" marker (`<ib><offline count=N/>`) means the
 * N stanzas have been *delivered on the wire*. It says nothing about Baileys
 * having dealt with them: in 7.0.0-rc14 offline stanzas go into a sequential queue
 * (Utils/offline-node-processor.js) that is worked through asynchronously, one
 * `await`ed handler at a time — decrypt, send the receipt, and only then emit
 * `messages.upsert` (Socket/messages-recv.js handleMessage).
 *
 * A bridge that closes a fixed beat after the marker — or, worse, the moment
 * its own send has gone out, which is what every on-demand operation did —
 * can therefore cut a message off at any of these points:
 *
 *   - still queued behind a slow stanza: never processed, never acked, so it
 *     is redelivered next time behind the same slow stanza, indefinitely
 *     ("offline queue: 2 … messages: 0", cycle after cycle);
 *   - decrypted but not yet upserted: the Signal ratchet has advanced and been
 *     persisted, the store has nothing, and the stanza was never acked. On
 *     redelivery the key is spent, so decryption fails — and when libsignal
 *     words that failure "Key used already or never filled", Baileys NACKs the
 *     stanza and returns *without emitting anything at all*. The message is
 *     gone and no row says so.
 *
 * So this watches the raw stanzas going in and the upserts coming out, and
 * `settle` holds the socket until every offline message seen has come out — or
 * a bound passes, because a stanza Baileys drops on purpose (an `msmsg`, the
 * NACK above) never will. Messages that came out undecryptable get a further,
 * shorter grace for the sender's phone to answer the retry receipt; a resend
 * that misses it is simply queued for the next connection.
 *
 * Only messages can be tracked this way: receipts and notifications leave no
 * event to count. They share the queue, so they are covered whenever a message
 * sits behind them, and are otherwise redelivered harmlessly.
 */
export class InboundTracker {
  readonly offline = { message: 0, receipt: 0, notification: 0, call: 0 };
  private pending = new Set<string>();
  private awaitingRetry = new Set<string>();
  private undecryptable = 0;
  private recovered = 0;

  /** Every inbound stanza of a kind Baileys queues when it carries `offline`. */
  onStanza(tag: keyof InboundTracker["offline"], attrs: Record<string, string> | undefined): void {
    if (!attrs?.offline) return;
    this.offline[tag]++;
    if (tag === "message" && attrs.id) this.pending.add(attrs.id);
  }

  onUpsert(messages: WAMessage[]): void {
    for (const message of messages) {
      const id = message.key?.id;
      if (!id) continue;
      this.pending.delete(id);
      if (message.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT) {
        if (!this.awaitingRetry.has(id)) this.undecryptable++;
        this.awaitingRetry.add(id);
      } else if (this.awaitingRetry.delete(id)) {
        this.recovered++;
      }
    }
  }

  summary(): InboundSummary {
    return {
      offline: { ...this.offline },
      pendingMessages: this.pending.size,
      undecryptable: this.undecryptable,
      recovered: this.recovered,
    };
  }

  /**
   * @param flush releases Baileys' event buffer, which is where an upsert sits
   *   until something lets it out — without it nothing here would ever see one.
   */
  async settle(deps: {
    flush(): void;
    wait(ms: number): Promise<void>;
    now?(): number;
    isOpen?(): boolean;
    processMs?: number;
    retryMs?: number;
  }): Promise<InboundSummary> {
    const now = deps.now ?? (() => Date.now());
    const isOpen = deps.isOpen ?? (() => true);
    const until = async (done: () => boolean, budgetMs: number) => {
      const deadline = now() + budgetMs;
      deps.flush();
      while (!done() && isOpen() && now() < deadline) {
        await deps.wait(INBOUND_POLL_MS);
        deps.flush();
      }
    };
    await until(() => this.pending.size === 0, deps.processMs ?? INBOUND_PROCESS_BOUND_MS);
    await until(() => this.awaitingRetry.size === 0, deps.retryMs ?? RETRY_GRACE_MS);
    return this.summary();
  }
}

/**
 * What a cycle took in, in enough detail that "offline queue: 2, messages: 0"
 * can never again be all there is to go on: how many of the queued stanzas were
 * messages at all, whether any never came out of Baileys, and whether any came
 * out unreadable.
 */
export function describeInbound(offlineCount: number | null, inbound: InboundSummary): string | null {
  if (offlineCount === null) return null;
  const { message, receipt, notification, call } = inbound.offline;
  const parts = [`offline queue: ${offlineCount}`];
  if (message + receipt + notification + call > 0) {
    parts.push(`(${message} message, ${receipt} receipt, ${notification} notification${call ? `, ${call} call` : ""})`);
  }
  if (inbound.pendingMessages > 0) {
    parts.push(`— ${inbound.pendingMessages} message(s) never came out of Baileys; they stay queued on WhatsApp if unacknowledged`);
  }
  if (inbound.undecryptable > 0) {
    parts.push(`— ${inbound.undecryptable} undecryptable (${inbound.recovered} recovered by resend)`);
  }
  return parts.join(" ");
}

export class Session {
  readonly sock: ReturnType<typeof makeWASocket>;
  readonly inbound = new InboundTracker();
  private settled: Promise<InboundSummary> | null = null;
  private closing: Promise<void> | null = null;
  /** WhatsApp (or the network) closed the stream; nothing more will arrive. */
  private streamClosed = false;
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
      // When a recipient's device cannot decrypt something we sent, it asks for
      // it again with a retry receipt. Baileys answers from an in-memory cache
      // of recent sends and falls back to this — and the cache belongs to the
      // socket that sent, which here is closed seconds later. The receipt
      // arrives on some later socket that has never heard of the message, so
      // without this every retry request for a bridge send is dropped ("recv
      // retry request, but message not available") and that device never gets
      // the message. Group sends are where it bites: one sender key, many
      // devices, and any one of them may have missed the distribution.
      ...(handlers.getMessage
        ? { getMessage: async (key: WAMessageKey) => handlers.getMessage!(key) }
        : {}),
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
        this.streamClosed = true;
        const err = update.lastDisconnect?.error as
          | { output?: { statusCode?: number }; message?: string }
          | undefined;
        this.lastDisconnectCode = err?.output?.statusCode ?? null;
        this.lastDisconnectMessage = err?.message ?? null;
      }
      this.waiters.settle(update);
    });

    this.sock.ev.on("messages.upsert", ({ messages, type }) => {
      this.inbound.onUpsert(messages);
      try {
        handlers.onMessages(messages, type);
      } catch (err) {
        handlers.log("error", `storing messages failed: ${String(err)}`);
      }
    });

    this.sock.ev.on("chats.upsert", (chats) => this.reportChats(chats));
    this.sock.ev.on("chats.update", (chats) => this.reportChats(chats));
    // Arrives when the chat is deleted on the phone or another linked device
    // (an app-state `deleteChatAction`).
    this.sock.ev.on("chats.delete", (jids) => {
      try {
        if (jids.length > 0) handlers.onChatsDeleted?.(jids);
      } catch (err) {
        handlers.log("error", `flagging deleted chats failed: ${String(err)}`);
      }
    });
    // A group's subject arrives on its own events, not on chats.*: a rename is
    // `groups.update`, and being added to a group is `groups.upsert`. Without
    // these a renamed group keeps its old name for good.
    const reportGroups = (groups: { id?: string | null; subject?: string | null }[]) =>
      this.reportChats(groups.filter((group) => Boolean(group.subject)).map((group) => ({ id: group.id, name: group.subject })));
    this.sock.ev.on("groups.upsert", reportGroups);
    this.sock.ev.on("groups.update", reportGroups);
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

    // What came in as backlog, counted off the raw stanzas — see InboundTracker.
    for (const tag of ["message", "receipt", "notification", "call"] as const) {
      this.sock.ws.on(`CB:${tag}`, (node: unknown) => {
        this.inbound.onStanza(tag, (node as BinaryNodeish).attrs as Record<string, string> | undefined);
      });
    }

    // The backlog size is only ever logged by Baileys; read it off the raw node.
    this.sock.ws.on("CB:ib,,offline", (node: unknown) => {
      const children = (node as { content?: { tag: string; attrs: Record<string, string> }[] }).content;
      const offline = children?.find((child) => child.tag === "offline");
      this.offlineCount = offline ? Number(offline.attrs.count ?? 0) : null;
    });
  }

  private reportChats(chats: { id?: string | null; name?: string | null; archived?: boolean | null }[]): void {
    const mapped = chats
      .filter((chat) => Boolean(chat.id))
      .map((chat) => ({
        jid: chat.id as string,
        name: chat.name ?? null,
        ...(typeof chat.archived === "boolean" ? { archived: chat.archived } : {}),
      }));
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

  /**
   * Hold on until the offline messages seen on the wire have come out of
   * Baileys, within bounds. Idempotent: a caller that wants the numbers asks
   * first, and `close()` reuses the answer rather than waiting twice.
   */
  settleInbound(): Promise<InboundSummary> {
    this.settled ??= this.inbound.settle({
      flush: () => {
        this.sock.ev.flush();
      },
      wait: (ms) => scheduler.wait(ms),
      isOpen: () => !this.ended && !this.streamClosed,
    });
    return this.settled;
  }

  /** Clean shutdown that preserves the session; never `logout()`. */
  close(): Promise<void> {
    // Memoised: cancelPairing and a pairing tail can both reach for the same
    // socket, and the second must not end it while the first is still settling.
    this.closing ??= this.shutDown();
    return this.closing;
  }

  private async shutDown(): Promise<void> {
    // Every socket receives the offline queue, whatever it was opened for — a
    // send, a group rename — so every close has to let it finish. See
    // InboundTracker for what is lost otherwise.
    try {
      const inbound = await this.settleInbound();
      if (inbound.pendingMessages > 0 || inbound.undecryptable > inbound.recovered) {
        this.handlers.log(
          "warn",
          `closing with inbound unfinished: ${inbound.pendingMessages} offline message(s) never came out of Baileys, ${inbound.undecryptable - inbound.recovered} undecryptable awaiting a resend`,
        );
      }
    } catch (err) {
      this.handlers.log("warn", `settling inbound messages threw: ${String(err)}`);
    }
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
