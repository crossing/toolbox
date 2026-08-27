// /manage/sms — the human surface for the SMS store.
//
// Three jobs, in the order they matter. It shows whether the receive hook is
// actually working, which is the only way to tell before any MCP tool exists.
// It carries the sender census, because a useful list of senders cannot be
// written in advance — it is harvested from what arrives, and labelling it has
// to be a few clicks rather than data entry. And it previews what retention
// will delete, so the thing reviewed is the policy rather than a queue of
// individual messages, which nobody reviews for long.
//
// The hook URL is revealed into the response body rather than through a
// redirect: the path *is* the credential, and Workers Logs record request
// URLs. Same reasoning as the WhatsApp import code.

import { escapeHtml } from "@toolbox/mcp-shared";
import type { Env } from "./env";
import { notice, page, pill } from "./html";
import { inboxFor } from "./sms";
import { dispatchSms, dlrUrl, smsCredentials } from "./smssend";
import {
  RETENTION_DEFAULTS,
  type PendingSend,
  type RetentionRow,
  type SenderRow,
  type SenderStatus,
  type SmsStatus,
  type StoredMessage,
} from "./smsstore";

const STATUSES: SenderStatus[] = ["new", "machine", "conversation", "ignored"];

function shortTs(iso: string | null): string {
  if (!iso) return "—";
  return iso.replace("T", " ").slice(0, 16);
}

function ago(iso: string | null, nowMs: number): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const secs = Math.max(0, Math.round((nowMs - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

function retentionLabel(sender: SenderRow): string {
  const days = sender.retentionDays ?? RETENTION_DEFAULTS[sender.status] ?? null;
  if (days === null) return "kept";
  return `${days}d`;
}

function senderRows(senders: SenderRow[], nowMs: number): string {
  if (senders.length === 0) {
    return `<tr><td colspan="7" class="muted">No messages have arrived yet.</td></tr>`;
  }
  return senders
    .map((sender) => {
      const options = STATUSES.map(
        (status) =>
          `<option value="${status}"${status === sender.status ? " selected" : ""}>${status}</option>`,
      ).join("");
      return `<tr>
        <td class="mono nowrap"><a href="/manage/sms?sender=${encodeURIComponent(sender.oa)}">${escapeHtml(sender.oa)}</a></td>
        <td class="nowrap">${pill(sender.shapeClass, sender.shapeClass === "e164" ? "idle" : "warn")}</td>
        <td class="num">${sender.count}</td>
        <td class="nowrap muted">${escapeHtml(ago(sender.lastSeen, nowMs))}</td>
        <td class="nowrap">${retentionLabel(sender)}${sender.patterns > 0 ? ` · ${sender.patterns}p` : ""}</td>
        <td>
          <form method="post" action="/manage/sms/sender" class="field">
            <input type="hidden" name="oa" value="${escapeHtml(sender.oa)}">
            <input type="text" name="label" value="${escapeHtml(sender.label ?? "")}" placeholder="label" size="12">
            <select name="status">${options}</select>
            <input type="text" name="retention_days" value="${sender.retentionDays ?? ""}" placeholder="days" size="4">
            <button type="submit">Save</button>
          </form>
        </td>
      </tr>`;
    })
    .join("");
}

function messageRows(messages: StoredMessage[]): string {
  if (messages.length === 0) {
    return `<tr><td colspan="4" class="muted">Nothing stored yet.</td></tr>`;
  }
  return messages
    .map((message) => {
      // A purged row keeps only its shape; showing that rather than an empty
      // cell is the honest rendering of what the store still holds.
      const text = message.body ?? message.shape;
      const tag = message.body ? "" : ` ${pill("shape only")}`;
      const partial = message.incomplete ? ` ${pill("partial", "warn")}` : "";
      return `<tr>
        <td class="nowrap muted">${escapeHtml(shortTs(message.timestamp))}</td>
        <td class="mono nowrap">${escapeHtml(message.peer)}</td>
        <td>${escapeHtml(text)}${tag}${partial}</td>
        <td class="num">${message.parts}</td>
      </tr>`;
    })
    .join("");
}

function renderSenderDetail(
  oa: string,
  shapes: { shape: string; count: number; lastSeen: string }[],
): string {
  const rows =
    shapes.length === 0
      ? `<tr><td colspan="3" class="muted">No messages from this sender.</td></tr>`
      : shapes
          .map(
            (row) => `<tr>
              <td class="mono">${escapeHtml(row.shape)}</td>
              <td class="num">${row.count}</td>
              <td class="nowrap muted">${escapeHtml(shortTs(row.lastSeen))}</td>
            </tr>`,
          )
          .join("");
  return `<a class="back" href="/manage/sms">← all senders</a>
<section class="card">
  <h2>Templates from ${escapeHtml(oa)}</h2>
  <p class="hint">Digit runs, mixed letter-and-digit tokens and URL paths are masked, so these are
    kept permanently and hold no secret. They are what a pattern review reads.</p>
  <div class="scroll"><table>
    <thead><tr><th>Shape</th><th class="num">Seen</th><th>Last</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</section>`;
}

/**
 * The release surface. It renders recipient and full body deliberately: an
 * approval that says only "send a message" is theatre, and the whole point of
 * staging is that a human sees exactly what is about to leave.
 */
function sendRows(sends: PendingSend[], nowMs: number): string {
  if (sends.length === 0) {
    return `<tr><td colspan="5" class="muted">Nothing queued.</td></tr>`;
  }
  return sends
    .map((send) => {
      const actions =
        send.state === "pending"
          ? `<form method="post" action="/manage/sms/release" class="inline">
               <input type="hidden" name="id" value="${escapeHtml(send.id)}">
               <button type="submit">Release</button>
             </form>
             <form method="post" action="/manage/sms/cancel" class="inline">
               <input type="hidden" name="id" value="${escapeHtml(send.id)}">
               <button type="submit">Cancel</button>
             </form>`
          : `<span class="muted">${escapeHtml(ago(send.decidedAt, nowMs))}</span>`;
      const tone =
        send.state === "sent" ? "ok" : send.state === "pending" ? "warn" : send.state === "releasing" ? "warn" : "err";
      return `<tr>
        <td class="mono nowrap">${escapeHtml(send.peer)}</td>
        <td>${escapeHtml(send.body)}${
          send.error ? `<div class="muted">${escapeHtml(send.error)}</div>` : ""
        }</td>
        <td class="nowrap">${pill(send.state, tone)}</td>
        <td class="nowrap muted">${escapeHtml(send.requestedBy)}<br>${escapeHtml(ago(send.requestedAt, nowMs))}</td>
        <td class="nowrap">${actions}</td>
      </tr>`;
    })
    .join("");
}

function renderPage(
  env: Env,
  status: SmsStatus,
  senders: SenderRow[],
  messages: StoredMessage[],
  preview: RetentionRow[],
  sends: PendingSend[],
  message: string,
  revealedHookUrl: string | null,
  nowMs: number,
): string {
  const numbers = (env.SMS_OWN_NUMBERS ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  const live = status.lastReceipt !== null;
  const sendable = smsCredentials(env) !== null;

  const hookCard = revealedHookUrl
    ? `<p class="hint">Paste this into the number's inbound-message target in the AAISP control pages.
         Anyone who learns it can write into this store, so treat it as a password.</p>
       <p class="secret" style="font-size:.95rem;letter-spacing:0">${escapeHtml(revealedHookUrl)}</p>`
    : `<p class="hint">The path is the credential — AAISP does not authenticate its POST, so nothing
         else stands between a stranger and this store.</p>
       <form method="post" action="/manage/sms/reveal"><button type="submit">Show hook URL</button></form>`;

  const previewRows =
    preview.length === 0
      ? `<tr><td colspan="3" class="muted">Nothing is due for deletion.</td></tr>`
      : preview
          .map(
            (row) => `<tr>
              <td class="mono nowrap">${escapeHtml(row.oa)}${row.label ? ` <span class="muted">${escapeHtml(row.label)}</span>` : ""}</td>
              <td class="nowrap">older than ${row.days}d</td>
              <td class="num">${row.messages}</td>
            </tr>`,
          )
          .join("");

  return `${notice(message)}
<a class="back" href="/manage">← services</a>

<section class="card">
  <h2>Receive hook</h2>
  <dl class="kv">
    <dt>Status</dt><dd>${live ? pill("receiving", "ok") : pill("nothing yet", "warn")}</dd>
    <dt>Last message</dt><dd>${escapeHtml(ago(status.lastReceipt, nowMs))}${
      status.lastReceipt ? ` <span class="muted">${escapeHtml(shortTs(status.lastReceipt))}</span>` : ""
    }</dd>
    <dt>Own numbers</dt><dd class="mono">${numbers.length ? escapeHtml(numbers.join(", ")) : `<span class="muted">not configured</span>`}</dd>
  </dl>
  ${hookCard}
</section>

<section class="card">
  <h2>Store</h2>
  <dl class="kv">
    <dt>Messages</dt><dd>${status.messages} <span class="muted">(${status.bodiesRetained} with bodies)</span></dd>
    <dt>Senders</dt><dd>${status.senders}${status.newSenders ? ` <span class="muted">· ${status.newSenders} unreviewed</span>` : ""}</dd>
    <dt>Incomplete sets</dt><dd>${status.pendingParts}</dd>
    <dt>Patterns</dt><dd>${status.patterns} <span class="muted">· ${status.liveSecrets} live secret${status.liveSecrets === 1 ? "" : "s"}</span></dd>
  </dl>
</section>

<section class="card">
  <h2>Senders</h2>
  <p class="hint">Harvested from what arrives, not configured in advance. Status drives retention;
    <code>new</code> is never purged, so nothing disappears before it has been looked at.</p>
  <div class="scroll"><table>
    <thead><tr><th>Sender</th><th>Kind</th><th class="num">Msgs</th><th>Last</th><th>Keeps</th><th></th></tr></thead>
    <tbody>${senderRows(senders, nowMs)}</tbody>
  </table></div>
</section>

<section class="card">
  <h2>Recent</h2>
  <div class="scroll"><table>
    <thead><tr><th>When</th><th>From</th><th>Message</th><th class="num">Parts</th></tr></thead>
    <tbody>${messageRows(messages)}</tbody>
  </table></div>
</section>

<section class="card">
  <h2>Queued sends</h2>
  <p class="hint">Nothing here has been sent. <code>sms_send</code> stages a request and stops;
    a message leaves only when released below. Client-side approval was the alternative and decays
    the moment someone clicks "allow for this chat" — this one cannot be talked around.
    ${sendable ? "" : '<strong>Sending is not configured on this Worker, so Release will fail.</strong>'}</p>
  <div class="scroll"><table>
    <thead><tr><th>To</th><th>Message</th><th>State</th><th>Asked by</th><th></th></tr></thead>
    <tbody>${sendRows(sends, nowMs)}</tbody>
  </table></div>
</section>

<section class="card">
  <h2>Retention</h2>
  <p class="hint">Bodies are dropped on a daily alarm; the masked shape is always kept. Review the
    policy here rather than the messages — a per-message queue is one nobody reads.</p>
  <div class="scroll"><table>
    <thead><tr><th>Sender</th><th>Rule</th><th class="num">Due</th></tr></thead>
    <tbody>${previewRows}</tbody>
  </table></div>
  <div class="actions">
    <form method="post" action="/manage/sms/purge"><button type="submit">Run now</button></form>
    <span class="muted">last run ${escapeHtml(ago(status.lastPurge, nowMs))}</span>
  </div>
</section>`;
}

export async function handleSmsManage(
  request: Request,
  env: Env,
  url: URL,
  email: string | null,
): Promise<Response> {
  if (!email) return new Response("not signed in", { status: 401 });
  const who = `<span>${escapeHtml(email)}</span>
    <form method="post" action="/manage/logout"><button type="submit">Sign out</button></form>`;

  const render = async (message: string, revealed: string | null = null): Promise<Response> => {
    const inbox = inboxFor(env);
    const sender = url.searchParams.get("sender");
    if (sender) {
      const shapes = await inbox.shapesFor(sender, 40);
      return page("gateway — SMS", renderSenderDetail(sender, shapes), { section: "sms", who });
    }
    const [status, senders, messages, preview, sends] = await Promise.all([
      inbox.status(),
      inbox.listSenders(),
      inbox.listMessages({ limit: 25 }),
      inbox.retentionPreview(),
      inbox.listSends(25),
    ]);
    return page(
      "gateway — SMS",
      renderPage(env, status, senders, messages, preview, sends, message, revealed, Date.now()),
      { section: "sms", who },
    );
  };

  if (url.pathname === "/manage/sms" && request.method === "GET") {
    return render(url.searchParams.get("notice") ?? "");
  }

  if (url.pathname === "/manage/sms/reveal" && request.method === "POST") {
    if (!env.SMS_HOOK_SECRET) {
      return render("SMS_HOOK_SECRET is not set on this Worker — the hook will refuse every delivery.");
    }
    return render("", `${url.origin}/hooks/sms/${env.SMS_HOOK_SECRET}`);
  }

  if (url.pathname === "/manage/sms/sender" && request.method === "POST") {
    const form = await request.formData();
    const oa = String(form.get("oa") ?? "");
    if (!oa) return new Response("missing sender", { status: 400 });
    const status = String(form.get("status") ?? "");
    const rawDays = String(form.get("retention_days") ?? "").trim();
    const days = rawDays === "" ? null : Number.parseInt(rawDays, 10);
    if (days !== null && (Number.isNaN(days) || days < 0)) {
      return redirectBack("retention must be a whole number of days, or blank for the default");
    }
    await inboxFor(env).setSender(oa, {
      label: String(form.get("label") ?? "").trim() || null,
      status: (STATUSES as string[]).includes(status) ? (status as SenderStatus) : undefined,
      retentionDays: days,
    });
    return redirectBack(`saved ${oa}`);
  }

  if (url.pathname === "/manage/sms/release" && request.method === "POST") {
    const form = await request.formData();
    const id = String(form.get("id") ?? "");
    if (!id) return new Response("missing id", { status: 400 });
    const inbox = inboxFor(env);

    // Claiming the row and checking taint happen together inside the store, so
    // a second click cannot dispatch the same message twice.
    const ticket = await inbox.beginRelease(id);
    if (!ticket.ok) return redirectBack(`not released — ${ticket.reason}`);

    const result = await dispatchSms(env, ticket.peer, ticket.body, dlrUrl(env, url.origin, id));
    await inbox.completeSend(id, {
      ok: result.ok,
      detail: result.detail,
      ownNumber: smsCredentials(env)?.username,
    });
    return redirectBack(result.ok ? `sent to ${ticket.peer} — ${result.detail}` : `send failed — ${result.detail}`);
  }

  if (url.pathname === "/manage/sms/cancel" && request.method === "POST") {
    const form = await request.formData();
    const id = String(form.get("id") ?? "");
    if (!id) return new Response("missing id", { status: 400 });
    await inboxFor(env).cancelSend(id);
    return redirectBack("cancelled");
  }

  if (url.pathname === "/manage/sms/purge" && request.method === "POST") {
    const result = await inboxFor(env).purgeNow();
    return redirectBack(
      `purge done — ${result.bodies} bodies dropped, ${result.flushed} incomplete sets flushed, ${result.secrets} expired secrets cleared`,
    );
  }

  return new Response("not found", { status: 404 });
}

function redirectBack(message: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `/manage/sms?notice=${encodeURIComponent(message)}` },
  });
}
