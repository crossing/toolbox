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
    if (resp.status !== 101 || !socket) {
      this.readyState = CLOSED;
      this.emit("unexpected-response");
      this.emit("error", new Error(`websocket upgrade failed (status ${resp.status})`));
      return;
    }
    socket.accept();
    this.socket = socket;
    this.readyState = OPEN;
    socket.addEventListener("message", (event: MessageEvent) => {
      const data = event.data;
      // Baileys' noise handler expects a Buffer for binary frames.
      if (typeof data === "string") this.emit("message", Buffer.from(data));
      else this.emit("message", Buffer.from(data as ArrayBuffer));
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      this.readyState = CLOSED;
      this.emit("close", event.code, Buffer.from(event.reason ?? ""));
    });
    socket.addEventListener("error", () => {
      this.readyState = CLOSED;
      this.emit("error", new Error("websocket error"));
    });
    this.emit("open");
  }

  send(data: string | ArrayBufferView | ArrayBuffer, cb?: (err?: Error) => void): void {
    try {
      if (!this.socket || this.readyState !== OPEN) throw new Error("socket not open");
      // workerd accepts string or BufferSource; normalize Buffer views.
      if (typeof data === "string") {
        this.socket.send(data);
      } else if (ArrayBuffer.isView(data)) {
        const copy = new Uint8Array(data.byteLength);
        copy.set(new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength));
        this.socket.send(copy.buffer);
      } else {
        this.socket.send(data);
      }
      cb?.();
    } catch (err) {
      cb?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    this.readyState = CLOSING;
    try {
      this.socket?.close(code, reason);
    } catch {
      /* already gone */
    }
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
