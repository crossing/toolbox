// G4 feasibility spike. Not a product — a probe that answers the two
// binary questions that decide whether the full-cloud Baileys approach is
// viable in workerd at all, before any bridge-DO is built:
//
//   1. Does baileys' WASM crypto bridge (whatsapp-rust-bridge) instantiate
//      under workerd? It compiles synchronously at module top-level.
//   2. Can we import baileys' socket factory and open its outbound WebSocket
//      to the WhatsApp server from a Worker?
//
// GET /crypto  — exercises the WASM-backed md5/hkdf; proves (1).
// GET /connect — makes a Baileys socket, waits for the first upstream frame
//                or error; proves (2). No pairing, no persistence yet.

interface Env {}

// Import at module scope on purpose: if the WASM top-level compile is
// rejected by workerd, the module fails to load and every route 500s with
// the reason — exactly the signal the spike wants.
import { hkdf, md5 } from "baileys/lib/Utils/crypto.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Raw outbound-WebSocket probe, bypassing Baileys entirely: does workerd
// (in this environment) complete an upgrade to WhatsApp's WS endpoint?
async function probeRawWs(): Promise<Response> {
  const result = await new Promise<Record<string, unknown>>((resolve) => {
    let settled = false;
    const done = (extra: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      resolve(extra);
    };
    fetch("https://web.whatsapp.com/ws/chat", {
      headers: { Upgrade: "websocket", Origin: "https://web.whatsapp.com" },
    })
      .then((resp) => {
        const socket = (resp as unknown as { webSocket?: WebSocket }).webSocket;
        if (resp.status !== 101 || !socket) {
          done({ status: resp.status, hasWebSocket: !!socket, note: "no upgrade" });
          return;
        }
        socket.accept();
        socket.addEventListener("message", (e: MessageEvent) => {
          const len = typeof e.data === "string" ? e.data.length : (e.data as ArrayBuffer).byteLength;
          done({ status: 101, hasWebSocket: true, firstFrameBytes: len, note: "upstream frame received" });
          try {
            socket.close();
          } catch {
            /* ignore */
          }
        });
        socket.addEventListener("error", () => done({ status: 101, socketError: true }));
        socket.addEventListener("close", (e: CloseEvent) => done({ status: 101, closed: { code: e.code, reason: e.reason } }));
        // WhatsApp expects the client to speak first; a bare upgrade with no
        // handshake may just sit idle, so a timeout here still tells us the
        // upgrade itself succeeded.
        setTimeout(() => done({ status: 101, hasWebSocket: true, idle: true, note: "upgraded, no unsolicited frame" }), 8000);
      })
      .catch((err) => done({ threw: err instanceof Error ? err.message : String(err) }));
  });
  return json(result);
}

// Upgrade to a known-good echo server: isolates "workerd can do outbound WS
// at all here" from "the WhatsApp endpoint specifically fails".
async function probeEchoWs(): Promise<Response> {
  const out = await new Promise<Record<string, unknown>>((resolve) => {
    let s = false;
    const d = (x: Record<string, unknown>) => {
      if (s) return;
      s = true;
      resolve(x);
    };
    fetch("https://echo.websocket.org/", { headers: { Upgrade: "websocket" } })
      .then((resp) => {
        const sock = (resp as unknown as { webSocket?: WebSocket }).webSocket;
        if (resp.status !== 101 || !sock) {
          d({ status: resp.status, hasWebSocket: !!sock });
          return;
        }
        sock.accept();
        sock.addEventListener("message", (e: MessageEvent) => {
          const len = typeof e.data === "string" ? e.data.length : (e.data as ArrayBuffer).byteLength;
          d({ status: 101, gotFrame: len });
          try {
            sock.close();
          } catch {
            /* ignore */
          }
        });
        sock.send("hello");
        setTimeout(() => d({ status: 101, idle: true }), 6000);
      })
      .catch((e) => d({ threw: e instanceof Error ? e.message : String(e) }));
  });
  return json(out);
}

async function probeCrypto(): Promise<Response> {
  const digest = md5(Buffer.from("gateway-g4-spike"));
  const derived = await hkdf(Buffer.from("input-key-material"), 32, {
    info: "whatsapp-spike",
  });
  return json({
    ok: true,
    md5Hex: Buffer.from(digest).toString("hex"),
    hkdfLen: derived.length,
    note: "WASM bridge (md5, hkdf) executed under workerd",
  });
}

// A throwaway in-memory SignalKeyStore — enough to open a connection and
// reach the QR step, which is all the spike probes.
function memoryKeyStore() {
  const data: Record<string, Record<string, unknown>> = {};
  return {
    get: async (type: string, ids: string[]) => {
      const out: Record<string, unknown> = {};
      for (const id of ids) out[id] = data[type]?.[id];
      return out;
    },
    set: async (entries: Record<string, Record<string, unknown>>) => {
      for (const type of Object.keys(entries)) {
        data[type] ??= {};
        Object.assign(data[type], entries[type]);
      }
    },
  };
}

async function probeConnect(): Promise<Response> {
  const baileys = (await import("baileys")) as unknown as {
    default: (cfg: unknown) => { ev: { on: (e: string, cb: (a: unknown) => void) => void }; end: (e?: Error) => void };
    makeWASocket?: (cfg: unknown) => { ev: { on: (e: string, cb: (a: unknown) => void) => void }; end: (e?: Error) => void };
    initAuthCreds: () => unknown;
  };
  const makeWASocket = baileys.makeWASocket ?? baileys.default;
  const events: string[] = [];
  const result = await new Promise<Record<string, unknown>>((resolve) => {
    let settled = false;
    const done = (extra: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      resolve({ events, ...extra });
    };
    try {
      const sock = makeWASocket({
        auth: { creds: baileys.initAuthCreds(), keys: memoryKeyStore() },
        browser: ["gateway-spike", "Chrome", "1.0"],
      });
      sock.ev.on("connection.update", (u: unknown) => {
        const upd = u as { connection?: string; qr?: string; lastDisconnect?: { error?: { message?: string } } };
        events.push(`connection.update:${upd.connection ?? ""}${upd.qr ? "+qr" : ""}`);
        if (upd.qr) {
          try {
            sock.end();
          } catch {
            /* ignore */
          }
          done({ reachedQR: true, note: "outbound WS to WhatsApp opened; QR frame received" });
        }
        if (upd.connection === "close") {
          done({ reachedQR: false, closeReason: upd.lastDisconnect?.error?.message ?? "closed" });
        }
      });
    } catch (err) {
      done({ threw: err instanceof Error ? err.message : String(err) });
    }
    setTimeout(() => done({ timedOut: true }), 20000);
  });
  return json(result);
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/plainfetch") {
        const r = await fetch("https://api.freeagent.com/v2/");
        return json({ ok: true, status: r.status, note: "plain outbound fetch works" });
      }
      if (url.pathname === "/echows") return await probeEchoWs();
      if (url.pathname === "/crypto") return await probeCrypto();
      if (url.pathname === "/rawws") return await probeRawWs();
      if (url.pathname === "/connect") return await probeConnect();
      return json({ routes: ["/crypto", "/connect"], startup: "module loaded — WASM top-level compile survived" });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }, 500);
    }
  },
};
