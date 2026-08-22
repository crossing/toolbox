// /manage/whatsapp — pairing and health for the WhatsApp bridge.
//
// Pairing uses WhatsApp's phone-number pairing code rather than a QR: the
// bridge has no terminal to draw one in, and a code can be read off this page
// and typed into the phone. The code is a credential for adding a linked
// device, so it is shown here (behind the manage sign-in) and deliberately
// never returned to a model — the MCP status tool redacts it.
//
// The history importer posts to /manage/whatsapp/import with a short-lived
// code issued from this page, so the one-off `messages.db` copy can run from
// a shell without a browser session and without inventing a secret. The code
// is deliberately short and typable: it gets read off this page by eye.

import { escapeHtml } from "@toolbox/mcp-shared";
import type { BridgeStatus, ChatRow, ImportRequest, MessageRow } from "@toolbox/mcp-shared";
import type { Env } from "./env";
import { page } from "./html";
import { bridgeFor } from "./whatsapp";

function when(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function renderCycles(status: BridgeStatus): string {
  if (status.recentCycles.length === 0) {
    return `<tr><td colspan="4" class="muted">No sync cycles yet.</td></tr>`;
  }
  return status.recentCycles
    .map(
      (cycle) => `<tr>
      <td class="muted">${escapeHtml(when(cycle.startedAt))}</td>
      <td>${escapeHtml(cycle.outcome)}</td>
      <td>${cycle.messages} msg / ${cycle.chats} chat</td>
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
            <td class="muted">${escapeHtml(chat.lastMessageTime ?? "—")}</td></tr>`,
          )
          .join("\n");
  const messageRows =
    messages.length === 0
      ? `<tr><td colspan="3" class="muted">No messages stored yet.</td></tr>`
      : messages
          .map(
            (msg) => `<tr><td class="muted">${escapeHtml(msg.timestamp)}</td>
            <td>${escapeHtml(msg.chatName ?? msg.chatJid)}</td>
            <td>${msg.isFromMe ? "me" : escapeHtml(msg.senderName ?? msg.sender)}${
              msg.mediaType ? ` <span class="muted">[${escapeHtml(msg.mediaType)}]</span>` : ""
            }</td></tr>`,
          )
          .join("\n");
  return `<h2>Store</h2>
<p class="muted">Metadata only — message text is not rendered here.</p>
<table><tr><th>Chat</th><th>Last activity</th></tr>
${chatRows}
</table>
<table><tr><th>When</th><th>Chat</th><th>From</th></tr>
${messageRows}
</table>`;
}

function renderPage(
  status: BridgeStatus,
  notice: string,
  importCode: string | null,
  preview: string,
): string {
  const pairing = status.pendingPairing;
  const pairBlock = status.paired
    ? `<div class="linkbox">
        <p>Paired as <strong>${escapeHtml(status.me?.id ?? "unknown")}</strong>
        ${status.me?.name ? `(${escapeHtml(status.me.name)})` : ""}.</p>
        <form method="post" action="/manage/whatsapp/unpair">
          <label><input type="checkbox" name="confirm" value="1"> yes, forget this device</label>
          <button type="submit">Unpair</button>
        </form>
        <div class="muted">Unpairing wipes the session keys here. The device also has to be removed
        on the phone (WhatsApp → Linked devices). Stored messages are kept.</div>
      </div>`
    : `<div class="linkbox">
        <form method="post" action="/manage/whatsapp/pair">
          <label>Phone number (international, digits only)
            <input name="phone" inputmode="numeric" placeholder="447700900000" required>
          </label>
          <button type="submit">Request pairing code</button>
        </form>
        <div class="muted">On the phone: WhatsApp → Settings → Linked devices → Link a device →
        Link with phone number instead. The code below is valid for a few minutes.</div>
        ${
          pairing
            ? `<p class="code">${escapeHtml(pairing.code)}</p>
               <div class="muted">for ${escapeHtml(pairing.phoneNumber)}, expires ${escapeHtml(when(pairing.expiresAt))}</div>`
            : ""
        }
      </div>`;

  const autoSyncOn = status.nextAlarmAt !== null;
  return `<h1>gateway — WhatsApp</h1>
<p><a href="/manage">← back to services</a></p>
${notice ? `<p><strong>${escapeHtml(notice)}</strong></p>` : ""}
<h2>Device</h2>
${pairBlock}
<h2>Bridge</h2>
<table>
  <tr><th>Paired</th><td>${status.paired ? "yes" : "no"}</td></tr>
  <tr><th>Connection</th><td>${escapeHtml(status.connection)}</td></tr>
  <tr><th>Last connected</th><td>${escapeHtml(when(status.lastConnectedAt))}</td></tr>
  <tr><th>Last drain</th><td>${escapeHtml(when(status.lastDrainAt))}</td></tr>
  <tr><th>Next scheduled sync</th><td>${escapeHtml(when(status.nextAlarmAt))}</td></tr>
  <tr><th>Stored</th><td>${status.chatCount} chats, ${status.messageCount} messages</td></tr>
  <tr><th>Last error</th><td class="${status.lastError ? "warn" : "muted"}">${escapeHtml(status.lastError ?? "none")}</td></tr>
</table>
<form method="post" action="/manage/whatsapp/sync"><button type="submit">Sync now</button></form>
<form method="post" action="/manage/whatsapp/verbose">
  <input type="hidden" name="enabled" value="1">
  <button type="submit">Verbose logging on</button>
</form>
<form method="post" action="/manage/whatsapp/verbose">
  <input type="hidden" name="enabled" value="0">
  <button type="submit">off</button>
</form>
<form method="post" action="/manage/whatsapp/autosync">
  <input type="hidden" name="enabled" value="${autoSyncOn ? "0" : "1"}">
  <button type="submit">${autoSyncOn ? "Pause scheduled syncing" : "Resume scheduled syncing"}</button>
</form>
${preview}
<h2>Recent syncs</h2>
<table><tr><th>Started</th><th>Outcome</th><th>Drained</th><th>Detail</th></tr>
${renderCycles(status)}
</table>
<h2>Log</h2>
<pre class="muted" style="white-space:pre-wrap">${escapeHtml(status.log.slice(0, 25).join("\n")) || "nothing logged yet"}</pre>
<h2>Preflight</h2>
<div class="linkbox">
  <form method="post" action="/manage/whatsapp/preflight"><button type="submit">Run preflight</button></form>
  <div class="muted">Generates the 812 pre-keys a pairing would, writes and re-reads them through the
  key store, then throws them away — the cheapest way to find out that the expensive half of pairing
  works before someone is standing there holding a phone. Refuses to run once a device is paired.
  The timings read 0ms for synchronous steps — workerd stops the clock — so what matters is that
  every step completes and the key store returns all 812.</div>
</div>
<h2>History import</h2>
<div class="linkbox">
  <form method="post" action="/manage/whatsapp/import-code"><button type="submit">Issue import code</button></form>
  <div class="muted">One-off copy of the local bridge's messages.db into the cloud store, with
  <code>tools/mcp-workers/scripts/wa-import.py --code &lt;code&gt;</code>. Valid for 30 minutes.</div>
  ${importCode ? `<p class="code">${escapeHtml(importCode)}</p>` : ""}
</div>`;
}

async function statusOrError(env: Env): Promise<{ status?: BridgeStatus; error?: string }> {
  try {
    return { status: await bridgeFor(env).status() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function renderFullPage(env: Env, notice: string, importCode: string | null): Promise<Response> {
  const { status, error } = await statusOrError(env);
  if (!status) return errorPage(`bridge unreachable: ${error}`);
  const bridge = bridgeFor(env);
  const [chats, messages] = await Promise.all([
    bridge.listChats({ limit: 8 }),
    bridge.listMessages({ limit: 8 }),
  ]);
  return page(
    "gateway — WhatsApp",
    renderPage(status, notice, importCode, renderPreview(chats, messages)),
  );
}

function errorPage(message: string, status = 502): Response {
  return page(
    "gateway — WhatsApp",
    `<h1>gateway — WhatsApp</h1><p><a href="/manage">← back</a></p>
     <p class="warn">${escapeHtml(message)}</p>`,
    status,
  );
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
    return renderFullPage(env, url.searchParams.get("notice") ?? "", null);
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
    return redirectBack(enabled ? "verbose logging on — retry the pairing" : "verbose logging off");
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
      return renderFullPage(env, "import code issued — it is valid for 30 minutes", issued.code);
    } catch (err) {
      return errorPage(`could not issue a code: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return new Response("not found", { status: 404 });
}

function redirectBack(notice: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `/manage/whatsapp?notice=${encodeURIComponent(notice)}` },
  });
}
