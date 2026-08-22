// /manage/whatsapp — pairing and health for the WhatsApp bridge.
//
// Pairing uses WhatsApp's phone-number pairing code rather than a QR: the
// bridge has no terminal to draw one in, and a code can be read off this page
// and typed into the phone. The code is a credential for adding a linked
// device, so it is shown here (behind the manage sign-in) and deliberately
// never returned to a model — the MCP status tool redacts it.
//
// The history importer posts to /manage/whatsapp/import with a short-lived
// bearer token issued from this page, so the one-off `messages.db` copy can
// run from a shell without a browser session and without inventing a secret.

import { escapeHtml } from "@toolbox/mcp-shared";
import type { BridgeStatus, ImportRequest } from "@toolbox/mcp-shared";
import { signToken, verifyToken } from "./crypto";
import type { Env } from "./env";
import { page } from "./html";
import { bridgeFor } from "./whatsapp";

const IMPORT_TTL_MS = 30 * 60 * 1000;

interface ImportToken {
  kind: "wa-import";
  owner: string;
  exp: number;
}

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

function renderPage(status: BridgeStatus, notice: string, importToken: string | null): string {
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
<form method="post" action="/manage/whatsapp/autosync">
  <input type="hidden" name="enabled" value="${autoSyncOn ? "0" : "1"}">
  <button type="submit">${autoSyncOn ? "Pause scheduled syncing" : "Resume scheduled syncing"}</button>
</form>
<h2>Recent syncs</h2>
<table><tr><th>Started</th><th>Outcome</th><th>Drained</th><th>Detail</th></tr>
${renderCycles(status)}
</table>
<h2>History import</h2>
<div class="linkbox">
  <form method="post" action="/manage/whatsapp/import-token"><button type="submit">Issue import token</button></form>
  <div class="muted">One-off copy of the local bridge's messages.db into the cloud store. The token
  is valid for 30 minutes and authorises POSTs to <code>/manage/whatsapp/import</code>.</div>
  ${importToken ? `<p><code>${escapeHtml(importToken)}</code></p>` : ""}
</div>`;
}

async function statusOrError(env: Env): Promise<{ status?: BridgeStatus; error?: string }> {
  try {
    return { status: await bridgeFor(env).status() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
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
  // The importer runs from a shell with a bearer token instead of a session.
  if (url.pathname === "/manage/whatsapp/import" && request.method === "POST") {
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const payload = await verifyToken<ImportToken>(env.COOKIE_SECRET, token);
    if (!payload || payload.kind !== "wa-import" || payload.exp < Date.now()) {
      return Response.json({ error: "invalid or expired import token" }, { status: 401 });
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
      return Response.json(await bridgeFor(env).importRows(body));
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 502 },
      );
    }
  }

  if (!email) return new Response("not signed in", { status: 401 });

  if (url.pathname === "/manage/whatsapp" && request.method === "GET") {
    const { status, error } = await statusOrError(env);
    if (!status) return errorPage(`bridge unreachable: ${error}`);
    return page(
      "gateway — WhatsApp",
      renderPage(status, url.searchParams.get("notice") ?? "", url.searchParams.get("token")),
    );
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

  if (url.pathname === "/manage/whatsapp/import-token" && request.method === "POST") {
    const token = await signToken(env.COOKIE_SECRET, {
      kind: "wa-import",
      owner: email,
      exp: Date.now() + IMPORT_TTL_MS,
    } satisfies ImportToken);
    return new Response(null, {
      status: 303,
      headers: { location: `/manage/whatsapp?token=${encodeURIComponent(token)}` },
    });
  }

  return new Response("not found", { status: 404 });
}

function redirectBack(notice: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `/manage/whatsapp?notice=${encodeURIComponent(notice)}` },
  });
}
