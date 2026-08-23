// /manage/whatsapp — pairing and health for the WhatsApp bridge.
//
// Pairing is QR-first. WhatsApp treats a scanned QR as the ordinary way to add
// a linked device: no phone number is disclosed to the bridge, nothing has to
// be typed, and it is the only path on which a client may name itself — which
// is how the bridge comes to show up as "Xing's Assistant" in Linked devices
// rather than as another anonymous Chrome. The phone-code flow is kept as a
// fallback for when there is no camera to hand.
//
// The QR string itself never travels with the status payload: it is fetched
// once, by the endpoint that draws it, and the MCP status tool cannot reach it
// at all. Same reasoning as the pairing code — either one adds a device.
//
// The history importer posts to /manage/whatsapp/import with a short-lived
// code issued from this page, so the one-off `messages.db` copy can run from
// a shell without a browser session and without inventing a secret. The code
// is deliberately short and typable: it gets read off this page by eye.

import { escapeHtml } from "@toolbox/mcp-shared";
import type { BridgeStatus, ChatRow, ImportRequest, MessageRow } from "@toolbox/mcp-shared";
import type { Env } from "./env";
import { notice, page, pill } from "./html";
import { qrSvg } from "./qr";
import { bridgeFor } from "./whatsapp";

/** How often the page re-checks the bridge, awake and mid-pairing. */
const POLL_IDLE_MS = 8000;
const POLL_PAIRING_MS = 3000;

function when(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

/** Absolute time is what you audit with; relative time is what you read. */
function ago(ts: number | null | undefined, now: number): string {
  if (!ts) return "—";
  const delta = Math.round((now - ts) / 1000);
  const future = delta < 0;
  const secs = Math.abs(delta);
  const text =
    secs < 60
      ? `${secs}s`
      : secs < 3600
        ? `${Math.round(secs / 60)}m`
        : secs < 86400
          ? `${Math.round(secs / 3600)}h`
          : `${Math.round(secs / 86400)}d`;
  return `${when(ts)} (${future ? `in ${text}` : `${text} ago`})`;
}

/** Store timestamps are ISO-8601; a table only has room for the useful half. */
function shortTs(iso: string | null): string {
  if (!iso) return "—";
  return iso.replace("T", " ").slice(0, 16);
}

function connectionTone(state: BridgeStatus["connection"]): "ok" | "warn" | "idle" {
  if (state === "open") return "ok";
  if (state === "idle") return "idle";
  return "warn";
}

// The values the poller patches in place. Everything structural — the store
// preview, the cycle table, the log — changes the stamp instead and the page
// reloads, which is both simpler and honest about what it is showing.
function liveFields(status: BridgeStatus, now: number): Record<string, string> {
  return {
    connection: status.connection,
    lastConnected: ago(status.lastConnectedAt, now),
    lastDrain: ago(status.lastDrainAt, now),
    nextSync: status.nextAlarmAt ? ago(status.nextAlarmAt, now) : "paused",
    stored: `${status.chatCount} chats, ${status.messageCount} messages`,
    lastError: status.lastError ?? "none",
    qrExpires: status.pendingQr ? ago(status.pendingQr.expiresAt, now) : "—",
  };
}

/** Anything whose change should redraw the whole page rather than a field. */
function stampOf(status: BridgeStatus): string {
  return [
    status.paired ? "1" : "0",
    status.pendingQr?.issuedAt ?? 0,
    status.pendingPairing?.expiresAt ?? 0,
    status.lastDrainAt ?? 0,
    status.chatCount,
    status.messageCount,
    status.recentCycles.length,
    status.recentCycles[0]?.endedAt ?? 0,
    status.verbose ? "v" : "",
    status.autoSync ? "a" : "",
  ].join(".");
}

const POLL_SCRIPT = `(function(){
  var body = document.body, stamp = body.dataset.stamp;
  var every = body.dataset.pairing === "1" ? ${POLL_PAIRING_MS} : ${POLL_IDLE_MS};
  function apply(s){
    if (s.stamp !== stamp) { location.reload(); return; }
    for (var k in s.fields) {
      var e = document.querySelector('[data-f="' + k + '"]');
      if (e) e.textContent = s.fields[k];
    }
    var c = document.querySelector('[data-f="connection"]');
    if (c) c.className = "pill " + s.connectionTone;
  }
  setInterval(function(){
    fetch("/manage/whatsapp/status.json", { credentials: "same-origin" })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(s){ if (s) apply(s); })
      .catch(function(){});
  }, every);
})();`;

function renderCycles(status: BridgeStatus): string {
  if (status.recentCycles.length === 0) {
    return `<tr><td colspan="4" class="muted">No sync cycles yet.</td></tr>`;
  }
  return status.recentCycles
    .map(
      (cycle) => `<tr>
      <td class="muted mono">${escapeHtml(when(cycle.startedAt))}</td>
      <td>${cycle.outcome === "ok" ? pill("ok", "ok") : pill(cycle.outcome, "err")}</td>
      <td class="num">${cycle.messages} msg / ${cycle.chats} chat</td>
      <td class="muted">${escapeHtml(cycle.detail ?? "")}</td>
    </tr>`,
    )
    .join("\n");
}

// A metadata-only peek at the store, through the same query path the MCP
// tools use — enough to see that a sync actually landed rows without putting
// message text on a web page.
function renderPreview(chats: ChatRow[], messages: MessageRow[]): string {
  const chatRows =
    chats.length === 0
      ? `<tr><td colspan="2" class="muted">No chats stored yet.</td></tr>`
      : chats
          .map(
            (chat) => `<tr><td>${escapeHtml(chat.name ?? chat.jid)}</td>
            <td class="muted mono nowrap">${escapeHtml(shortTs(chat.lastMessageTime))}</td></tr>`,
          )
          .join("\n");
  const messageRows =
    messages.length === 0
      ? `<tr><td colspan="3" class="muted">No messages stored yet.</td></tr>`
      : messages
          .map(
            (msg) => `<tr><td class="muted mono nowrap">${escapeHtml(shortTs(msg.timestamp))}</td>
            <td>${escapeHtml(msg.chatName ?? msg.chatJid)}</td>
            <td>${msg.isFromMe ? "me" : escapeHtml(msg.senderName ?? msg.sender)}${
              msg.mediaType ? ` ${pill(msg.mediaType)}` : ""
            }</td></tr>`,
          )
          .join("\n");
  return `<section class="card">
  <h2>Store</h2>
  <p class="hint">Metadata only — message text is never rendered here, only returned through the
  tools.</p>
  <div class="grid2">
    <div class="scroll"><table>
      <thead><tr><th>Chat</th><th>Last activity</th></tr></thead>
      <tbody>${chatRows}</tbody>
    </table></div>
    <div class="scroll"><table>
      <thead><tr><th>When</th><th>Chat</th><th>From</th></tr></thead>
      <tbody>${messageRows}</tbody>
    </table></div>
  </div>
</section>`;
}

function renderDeviceCard(status: BridgeStatus, now: number): string {
  if (status.paired) {
    return `<section class="card">
  <h2>Device</h2>
  <dl class="kv">
    <dt>Paired as</dt><dd class="mono">${escapeHtml(status.me?.id ?? "unknown")}</dd>
    ${status.me?.name ? `<dt>Profile name</dt><dd>${escapeHtml(status.me.name)}</dd>` : ""}
  </dl>
  <form method="post" action="/manage/whatsapp/unpair" class="actions">
    <label class="check"><input type="checkbox" name="confirm" value="1"> yes, forget this device</label>
    <button type="submit" class="danger">Unpair</button>
  </form>
  <p class="hint" style="margin-bottom:0">Unpairing wipes the session keys held here. The device also
  has to be removed on the phone (WhatsApp → Linked devices); stored messages are kept either way.</p>
</section>`;
  }

  const qr = status.pendingQr;
  const pending = status.pendingPairing;
  const active = qr
    ? `<div class="stack-sm">
        <img class="qr" alt="WhatsApp linking QR code"
             src="/manage/whatsapp/qr.svg?v=${qr.issuedAt}">
        <p class="hint" style="margin:0">On the phone: <strong>WhatsApp → Settings → Linked
        devices → Link a device</strong>, then point the camera here. The code rotates on its own;
        this page follows it. Expires <span data-f="qrExpires">${escapeHtml(ago(qr.expiresAt, now))}</span>.</p>
        <form method="post" action="/manage/whatsapp/cancel">
          <button type="submit">Cancel</button>
        </form>
      </div>`
    : pending
      ? `<div class="stack-sm">
          <p class="secret">${escapeHtml(pending.code)}</p>
          <p class="hint" style="margin:0">Type it on the phone under <strong>Link with phone number
          instead</strong>, for ${escapeHtml(pending.phoneNumber)}. Expires
          ${escapeHtml(ago(pending.expiresAt, now))}.</p>
          <form method="post" action="/manage/whatsapp/cancel"><button type="submit">Cancel</button></form>
        </div>`
      : `<div class="stack-sm">
          <form method="post" action="/manage/whatsapp/pair-qr" class="field">
            <label class="stack">Device name
              <input name="device_name" value="${escapeHtml(status.deviceName)}" maxlength="40">
            </label>
            <button type="submit" class="primary">Show a linking QR</button>
          </form>
          <p class="hint" style="margin:0">The name is what WhatsApp → Linked devices will call this
          bridge. Opening the QR holds a socket open for about five minutes.</p>
          <details>
            <summary class="muted">No camera? Link with a phone code instead</summary>
            <form method="post" action="/manage/whatsapp/pair" class="field" style="margin-top:.6rem">
              <label class="stack">Phone number (international, digits only)
                <input name="phone" inputmode="numeric" placeholder="447700900000" required>
              </label>
              <button type="submit">Request pairing code</button>
            </form>
            <p class="hint" style="margin-bottom:0">WhatsApp is fussier about this path: the bridge has
            to identify itself as a stock browser, so the device name above is ignored.</p>
          </details>
        </div>`;

  return `<section class="card">
  <h2>Device</h2>
  <p class="hint">No device is paired, so the WhatsApp tools are off.</p>
  ${active}
</section>`;
}

function renderPage(
  status: BridgeStatus,
  message: string,
  importCode: string | null,
  preview: string,
  now: number,
): string {
  const f = liveFields(status, now);
  return `${notice(message)}
${renderDeviceCard(status, now)}

<section class="card">
  <h2>Bridge</h2>
  <dl class="kv">
    <dt>Connection</dt><dd><span class="pill ${connectionTone(status.connection)}" data-f="connection">${escapeHtml(f.connection!)}</span></dd>
    <dt>Last connected</dt><dd data-f="lastConnected">${escapeHtml(f.lastConnected!)}</dd>
    <dt>Last drain</dt><dd data-f="lastDrain">${escapeHtml(f.lastDrain!)}</dd>
    <dt>Next sync</dt><dd data-f="nextSync">${escapeHtml(f.nextSync!)}</dd>
    <dt>Stored</dt><dd data-f="stored">${escapeHtml(f.stored!)}</dd>
    <dt>Last error</dt><dd class="${status.lastError ? "warn" : "muted"}" data-f="lastError">${escapeHtml(f.lastError!)}</dd>
  </dl>
  <div class="actions">
    <form method="post" action="/manage/whatsapp/sync"><button type="submit" class="primary">Sync now</button></form>
    <form method="post" action="/manage/whatsapp/autosync">
      <input type="hidden" name="enabled" value="${status.autoSync ? "0" : "1"}">
      <button type="submit">${status.autoSync ? "Pause scheduled syncing" : "Resume scheduled syncing"}</button>
    </form>
    <form method="post" action="/manage/whatsapp/verbose">
      <input type="hidden" name="enabled" value="${status.verbose ? "0" : "1"}">
      <button type="submit">${status.verbose ? "Verbose logging off" : "Verbose logging on"}</button>
    </form>
  </div>
</section>

${preview}

<section class="card">
  <h2>Recent syncs</h2>
  <div class="scroll"><table>
    <thead><tr><th>Started</th><th>Outcome</th><th class="num">Drained</th><th>Detail</th></tr></thead>
    <tbody>${renderCycles(status)}</tbody>
  </table></div>
</section>

<section class="card">
  <h2>Log</h2>
  <pre class="log">${escapeHtml(status.log.slice(0, 25).join("\n")) || "nothing logged yet"}</pre>
</section>

<section class="card">
  <h2>Maintenance</h2>
  <div class="actions">
    <form method="post" action="/manage/whatsapp/preflight"><button type="submit">Run preflight</button></form>
    <form method="post" action="/manage/whatsapp/import-code"><button type="submit">Issue import code</button></form>
  </div>
  ${importCode ? `<p class="secret">${escapeHtml(importCode)}</p>` : ""}
  <p class="hint" style="margin-bottom:0"><strong>Preflight</strong> generates the 812 pre-keys a
  pairing would, writes and re-reads them through the key store, then throws them away — the cheapest
  way to find out that the expensive half of pairing works before someone is standing there holding a
  phone. It refuses to run once a device is paired, and its timings read 0ms for synchronous steps
  because workerd stops the clock. <strong>Import code</strong> authorises one-off history copies with
  <code>tools/mcp-workers/scripts/wa-import.py --code &lt;code&gt;</code> for 30 minutes.</p>
</section>`;
}

async function statusOrError(env: Env): Promise<{ status?: BridgeStatus; error?: string }> {
  try {
    return { status: await bridgeFor(env).status() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function renderFullPage(
  env: Env,
  email: string,
  message: string,
  importCode: string | null,
): Promise<Response> {
  const { status, error } = await statusOrError(env);
  if (!status) return errorPage(`bridge unreachable: ${error}`);
  const bridge = bridgeFor(env);
  const [chats, messages] = await Promise.all([
    bridge.listChats({ limit: 8 }),
    bridge.listMessages({ limit: 8 }),
  ]);
  const now = Date.now();
  const pairing = Boolean(status.pendingQr || status.pendingPairing);
  return page(
    "gateway — WhatsApp",
    renderPage(status, message, importCode, renderPreview(chats, messages), now),
    {
      section: "whatsapp",
      who: `<a href="/manage">← services</a><span>${escapeHtml(email)}</span>`,
      script: POLL_SCRIPT,
      bodyData: { stamp: stampOf(status), pairing: pairing ? "1" : "0" },
      headers: {
        // The body carries a live pairing QR; nothing here should be cached.
        "cache-control": "no-store",
      },
    },
  );
}

function errorPage(message: string, status = 502): Response {
  return page("gateway — WhatsApp", `<section class="card"><p class="warn">${escapeHtml(message)}</p></section>`, {
    section: "whatsapp",
    status,
    who: `<a href="/manage">← services</a>`,
  });
}

export async function handleWhatsappManage(
  request: Request,
  env: Env,
  url: URL,
  email: string | null,
): Promise<Response> {
  // The importer runs from a shell with an import code instead of a session.
  if (url.pathname === "/manage/whatsapp/import" && request.method === "POST") {
    const code = request.headers.get("x-import-code") ?? "";
    if (!code) {
      return Response.json({ error: "missing x-import-code header" }, { status: 401 });
    }
    let body: ImportRequest;
    try {
      body = (await request.json()) as ImportRequest;
    } catch {
      return Response.json({ error: "body must be JSON" }, { status: 400 });
    }
    if (!Array.isArray(body?.chats) || !Array.isArray(body?.messages)) {
      return Response.json({ error: "expected { chats: [], messages: [] }" }, { status: 400 });
    }
    try {
      return Response.json(await bridgeFor(env).importRows(body, code));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A bad code is the caller's fault, not the bridge's.
      const status = /import code/i.test(message) ? 401 : 502;
      return Response.json({ error: message }, { status });
    }
  }

  if (!email) return new Response("not signed in", { status: 401 });

  if (url.pathname === "/manage/whatsapp" && request.method === "GET") {
    return renderFullPage(env, email, url.searchParams.get("notice") ?? "", null);
  }

  // What the page polls. Formatting happens here so the browser script stays
  // a dozen lines of DOM assignment with no clock arithmetic of its own.
  if (url.pathname === "/manage/whatsapp/status.json" && request.method === "GET") {
    const { status, error } = await statusOrError(env);
    if (!status) return Response.json({ error }, { status: 502 });
    const now = Date.now();
    return Response.json(
      {
        stamp: stampOf(status),
        fields: liveFields(status, now),
        connectionTone: connectionTone(status.connection),
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  // Drawn server-side: the QR string is a device-linking capability, and this
  // way it is answered to one signed-in request and never sits in the page.
  if (url.pathname === "/manage/whatsapp/qr.svg" && request.method === "GET") {
    let pending: { qr: string; expiresAt: number } | null;
    try {
      pending = await bridgeFor(env).pairingQr();
    } catch (err) {
      return new Response(err instanceof Error ? err.message : "bridge unreachable", { status: 502 });
    }
    if (!pending) return new Response("no pairing QR is live", { status: 404 });
    return new Response(qrSvg(pending.qr, { label: "WhatsApp linking QR" }), {
      headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (url.pathname === "/manage/whatsapp/pair-qr" && request.method === "POST") {
    const form = await request.formData();
    const deviceName = String(form.get("device_name") ?? "");
    try {
      const bridge = bridgeFor(env);
      if (deviceName.trim()) await bridge.setDeviceName(deviceName);
      await bridge.beginQrPairing();
    } catch (err) {
      return redirectBack(`could not start pairing: ${err instanceof Error ? err.message : String(err)}`);
    }
    return redirectBack("scan the QR with the phone");
  }

  if (url.pathname === "/manage/whatsapp/cancel" && request.method === "POST") {
    try {
      await bridgeFor(env).cancelPairing();
    } catch (err) {
      return redirectBack(`could not cancel: ${err instanceof Error ? err.message : String(err)}`);
    }
    return redirectBack("pairing attempt cancelled");
  }

  if (url.pathname === "/manage/whatsapp/pair" && request.method === "POST") {
    const form = await request.formData();
    const phone = String(form.get("phone") ?? "").replace(/[^0-9]/g, "");
    if (phone.length < 8) return errorPage("that does not look like an international phone number", 400);
    try {
      await bridgeFor(env).requestPairingCode(phone);
    } catch (err) {
      return errorPage(`pairing failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return redirectBack("pairing code requested — type it on the phone");
  }

  if (url.pathname === "/manage/whatsapp/sync" && request.method === "POST") {
    try {
      const result = await bridgeFor(env).syncNow();
      return redirectBack(
        result.ok
          ? `synced: ${result.messages} messages, ${result.chats} chats`
          : `sync failed: ${result.detail ?? "unknown error"}`,
      );
    } catch (err) {
      return redirectBack(`sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (url.pathname === "/manage/whatsapp/verbose" && request.method === "POST") {
    const form = await request.formData();
    const enabled = form.get("enabled") === "1";
    try {
      await bridgeFor(env).setVerbose(enabled);
    } catch (err) {
      return redirectBack(`could not change logging: ${err instanceof Error ? err.message : String(err)}`);
    }
    return redirectBack(enabled ? "verbose logging on" : "verbose logging off");
  }

  if (url.pathname === "/manage/whatsapp/autosync" && request.method === "POST") {
    const form = await request.formData();
    const enabled = form.get("enabled") === "1";
    try {
      await bridgeFor(env).setAutoSync(enabled);
    } catch (err) {
      return redirectBack(`could not change scheduling: ${err instanceof Error ? err.message : String(err)}`);
    }
    return redirectBack(enabled ? "scheduled syncing on" : "scheduled syncing paused");
  }

  if (url.pathname === "/manage/whatsapp/unpair" && request.method === "POST") {
    const form = await request.formData();
    if (form.get("confirm") !== "1") return redirectBack("unpair needs the confirmation ticked");
    try {
      await bridgeFor(env).unpair();
    } catch (err) {
      return redirectBack(`unpair failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return redirectBack("device forgotten");
  }

  if (url.pathname === "/manage/whatsapp/preflight" && request.method === "POST") {
    try {
      const result = await bridgeFor(env).preflight();
      const timings = result.steps.map((step) => `${step.name}: ${step.ms}ms ${step.detail}`.trim()).join("; ");
      return redirectBack(
        result.ok ? `preflight passed — ${timings}` : `preflight failed — ${result.detail ?? ""} ${timings}`,
      );
    } catch (err) {
      return redirectBack(`preflight failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (url.pathname === "/manage/whatsapp/import-code" && request.method === "POST") {
    try {
      // Rendered straight into the response rather than redirected with the
      // code in the query string: Workers Logs record request URLs, and this
      // is a bearer capability for writing into the message store.
      const issued = await bridgeFor(env).issueImportCode();
      return renderFullPage(env, email, "import code issued — it is valid for 30 minutes", issued.code);
    } catch (err) {
      return errorPage(`could not issue a code: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return new Response("not found", { status: 404 });
}

function redirectBack(message: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `/manage/whatsapp?notice=${encodeURIComponent(message)}` },
  });
}
