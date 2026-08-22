// A node-`ws`-compatible WebSocket over workerd's native outbound WebSocket.
//
// Baileys' socket layer does `import WebSocket from 'ws'` and hardcodes
// `new WebSocketClient(url, config)` with no injection point, so the only
// clean swap is to alias the `ws` module to this file in wrangler.jsonc.
// workerd has no `ws` (that package throws "does not work in the browser"),
// but it does have outbound WebSockets via a fetch Upgrade: the response
// carries a `webSocket` you `accept()` and drive with addEventListener.
//
// Only the surface Baileys' WebSocketClient touches is implemented:
// the OPEN/CLOSED/... constants, readyState, EventEmitter on/once/emit,
// send(data, cb), close(), setMaxListeners. ping/pong/upgrade events don't
// exist on workerd sockets and Baileys treats them as optional.

import { EventEmitter } from "events";

// Spike-only diagnostic ring buffer; the /connect probe reads it. Removed
// with the shim's productionization.
export const wsDebug: string[] = [];
function dbg(msg: string): void {
  wsDebug.push(`${wsDebug.length}:${msg}`);
  if (wsDebug.length > 100) wsDebug.shift();
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

interface WsOptions {
  origin?: string;
  headers?: Record<string, string>;
}

export default class WorkerdWebSocket extends EventEmitter {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;

  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSING = CLOSING;
  readonly CLOSED = CLOSED;

  readyState: number = CONNECTING;
  private socket: WebSocket | null = null;

  constructor(url: string | URL, options: WsOptions = {}) {
    super();
    this.setMaxListeners(0);
    void this.open(url.toString(), options);
  }

  private async open(url: string, options: WsOptions): Promise<void> {
    // workerd's fetch upgrade wants http(s); the WA URL is ws(s).
    const httpUrl = url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
    const headers: Record<string, string> = { Upgrade: "websocket", ...(options.headers ?? {}) };
    if (options.origin) headers.Origin = options.origin;
    let resp: Response;
    try {
      resp = await fetch(httpUrl, { headers });
    } catch (err) {
      this.readyState = CLOSED;
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const socket = (resp as unknown as { webSocket?: WebSocket }).webSocket;
    dbg(`fetch status=${resp.status} hasWS=${!!socket}`);
    if (resp.status !== 101 || !socket) {
      this.readyState = CLOSED;
      this.emit("unexpected-response");
      this.emit("error", new Error(`websocket upgrade failed (status ${resp.status})`));
      return;
    }
    // workerd delivers binary frames as Blob (the arraybuffer binaryType
    // hint is ignored on an accepted socket), and Baileys' noise decoder
    // needs a Buffer. Blob→ArrayBuffer is async, so an ordered promise chain
    // preserves handshake frame order regardless of read latency.
    (socket as unknown as { binaryType: string }).binaryType = "arraybuffer";
    socket.accept();
    this.socket = socket;
    this.readyState = OPEN;
    let queue: Promise<void> = Promise.resolve();
    socket.addEventListener("message", (event: MessageEvent) => {
      const data = event.data;
      queue = queue.then(async () => {
        let buf: Buffer;
        if (typeof data === "string") {
          dbg(`recv str ${data.length}`);
          buf = Buffer.from(data);
        } else if (data instanceof ArrayBuffer) {
          dbg(`recv ab ${data.byteLength}`);
          buf = Buffer.from(data);
        } else {
          const ab = await (data as Blob).arrayBuffer();
          dbg(`recv blob ${ab.byteLength}`);
          buf = Buffer.from(ab);
        }
        this.emit("message", buf);
      });
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      if (this.readyState === CLOSED) return;
      this.readyState = CLOSED;
      dbg(`close code=${event.code} reason=${JSON.stringify(event.reason)}`);
      this.emit("close", event.code, Buffer.from(event.reason ?? ""));
    });
    socket.addEventListener("error", (event: Event) => {
      this.readyState = CLOSED;
      const msg = (event as unknown as { message?: string }).message ?? "websocket error";
      dbg(`error ${msg}`);
      this.emit("error", new Error(msg));
    });
    dbg("open");
    this.emit("open");
  }

  send(data: string | ArrayBufferView | ArrayBuffer, cb?: (err?: Error) => void): void {
    try {
      if (!this.socket || this.readyState !== OPEN) throw new Error("socket not open");
      // workerd accepts string or BufferSource; normalize Buffer views.
      if (typeof data === "string") {
        this.socket.send(data);
        dbg(`send str ${data.length}`);
      } else if (ArrayBuffer.isView(data)) {
        const copy = new Uint8Array(data.byteLength);
        copy.set(new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength));
        this.socket.send(copy.buffer);
        dbg(`send bin ${data.byteLength}`);
      } else {
        this.socket.send(data);
        dbg(`send buf ${(data as ArrayBuffer).byteLength}`);
      }
      cb?.();
    } catch (err) {
      cb?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // Baileys' WebSocketClient.close() awaits `once('close')` before it lets
  // sock.end() finish (Socket/Client/websocket.js:38-48). workerd only fires
  // `close` on a socket it actually accepted, so a socket that never opened —
  // or one whose close event is swallowed — would hang the shutdown inside a
  // Durable Object alarm. Guarantee the event either way.
  close(code?: number, reason?: string): void {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    const wasOpen = this.readyState === OPEN && this.socket !== null;
    this.readyState = CLOSING;
    try {
      this.socket?.close(code, reason);
    } catch {
      /* already gone */
    }
    if (!wasOpen) {
      this.finishClose(code ?? 1000, reason ?? "closed before open");
      return;
    }
    setTimeout(() => this.finishClose(code ?? 1006, "close event never arrived"), 5000);
  }

  private finishClose(code: number, reason: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    dbg(`close (synthetic) code=${code}`);
    this.emit("close", code, Buffer.from(reason));
  }

  // Baileys calls these ws-only helpers; make them harmless no-ops.
  terminate(): void {
    this.close();
  }
  ping(): void {
    /* workerd manages keepalive; no app-level ping frame */
  }
  pong(): void {
    /* no-op */
  }
}

export { WorkerdWebSocket as WebSocket };
