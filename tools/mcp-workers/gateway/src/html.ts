// The management interface's page chrome, shared by /manage and its
// sub-pages so they cannot drift apart visually.
//
// Everything is inline: one stylesheet in the document, no external fonts, no
// CDN, no build step. The pages are server-rendered forms and stay that way —
// the only script any of them carries is the WhatsApp page's status poller.
//
// Colours come from tokens defined once on :root and redefined under
// prefers-color-scheme, so the console follows the operating system rather
// than insisting on a theme of its own.

import { escapeHtml } from "@toolbox/mcp-shared";

const STYLE = `
:root {
  --bg: #f6f7f9;
  --surface: #ffffff;
  --border: #dfe3e8;
  --border-strong: #c7cdd4;
  --text: #1c2126;
  --muted: #67717c;
  --accent: #2f6f4f;
  --accent-text: #ffffff;
  --ok: #2f6f4f;
  --ok-bg: #e6f1eb;
  --warn: #8a6116;
  --warn-bg: #fbf1dd;
  --err: #a3352b;
  --err-bg: #fbeae8;
  --radius: 10px;
  --shadow: 0 1px 2px rgba(16, 22, 28, .04);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171a;
    --surface: #1c2024;
    --border: #2c3238;
    --border-strong: #3d454d;
    --text: #e6e9ec;
    --muted: #9aa4ae;
    --accent: #4c9c72;
    --accent-text: #0f1214;
    --ok: #6fbf95;
    --ok-bg: #1b2b23;
    --warn: #d9ab5c;
    --warn-bg: #2c2519;
    --err: #e2857b;
    --err-bg: #2e1e1c;
    --shadow: none;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 54rem; margin: 0 auto; padding: 1.5rem 1.1rem 4rem; }

/* header ------------------------------------------------------------ */
.top {
  display: flex; flex-wrap: wrap; gap: .75rem 1rem;
  align-items: baseline; justify-content: space-between;
  padding-bottom: 1rem; margin-bottom: 1.4rem;
  border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: baseline; gap: .55rem; }
.brand strong { font-size: 1.15rem; font-weight: 600; letter-spacing: -.01em; }
.brand .sep { color: var(--border-strong); }
.brand span.page { font-size: 1.15rem; color: var(--muted); }
.top .who { display: flex; align-items: center; gap: .6rem; font-size: .875rem; color: var(--muted); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.back { display: inline-block; font-size: .875rem; margin-bottom: 1.1rem; }

/* cards -------------------------------------------------------------- */
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); box-shadow: var(--shadow);
  padding: 1.1rem 1.2rem; margin-bottom: 1.1rem;
}
.card > h2 {
  margin: 0 0 .2rem; font-size: .78rem; font-weight: 600;
  text-transform: uppercase; letter-spacing: .07em; color: var(--muted);
}
.card > h2 + .hint { margin-top: 0; }
.card > :last-child { margin-bottom: 0; }
.hint { color: var(--muted); font-size: .875rem; margin: .35rem 0 .9rem; }
.grid2 { display: grid; gap: 1.1rem; grid-template-columns: 1fr; }
@media (min-width: 46rem) { .grid2 { grid-template-columns: 1fr 1fr; } }

/* key/value readout --------------------------------------------------- */
.kv { display: grid; grid-template-columns: minmax(8rem, max-content) 1fr; gap: .3rem 1rem; margin: 0; }
.kv dt { color: var(--muted); font-size: .875rem; }
.kv dd { margin: 0; font-variant-numeric: tabular-nums; }

/* tables -------------------------------------------------------------- */
table { border-collapse: collapse; width: 100%; margin: .2rem 0 0; font-size: .9rem; }
thead th {
  text-align: left; font-size: .72rem; text-transform: uppercase; letter-spacing: .06em;
  color: var(--muted); font-weight: 600; padding: 0 .55rem .4rem; border-bottom: 1px solid var(--border);
}
td { padding: .5rem .55rem; border-bottom: 1px solid var(--border); vertical-align: top; }
tr:last-child td { border-bottom: none; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.scroll { overflow-x: auto; }

/* controls ------------------------------------------------------------ */
form { display: inline; }
.actions { display: flex; flex-wrap: wrap; gap: .45rem; align-items: center; margin-top: .9rem; }
button, .btn {
  font: inherit; font-size: .875rem; line-height: 1.3;
  padding: .4rem .85rem; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--border-strong); background: var(--surface); color: var(--text);
}
.btn { display: inline-block; }
button:hover, .btn:hover { border-color: var(--muted); text-decoration: none; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
button.primary:hover { filter: brightness(1.06); }
button.danger { color: var(--err); border-color: var(--err); background: transparent; }
button.danger:hover { background: var(--err-bg); }
input[type=text], input[type=tel], input:not([type]), select {
  font: inherit; font-size: .9rem; padding: .38rem .55rem;
  border: 1px solid var(--border-strong); border-radius: 7px;
  background: var(--surface); color: var(--text); min-width: 0;
}
input:focus, select:focus, button:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 1px;
}
label { font-size: .875rem; }
label.check { display: inline-flex; align-items: center; gap: .4rem; color: var(--muted); }
.field { display: flex; flex-wrap: wrap; gap: .45rem; align-items: center; }
/* Inside a table cell the control has to stay on one line, or the column
   collapses and the button drops beneath the select. */
td .field { flex-wrap: nowrap; }
td select { max-width: 14rem; }
td.nowrap, .nowrap { white-space: nowrap; }
.field > label.stack { display: flex; flex-direction: column; gap: .25rem; color: var(--muted); }

/* status ------------------------------------------------------------- */
.pill {
  display: inline-block; padding: .1rem .5rem; border-radius: 999px;
  font-size: .78rem; font-weight: 500; letter-spacing: .01em;
  background: var(--border); color: var(--muted);
}
.pill.ok { background: var(--ok-bg); color: var(--ok); }
.pill.warn { background: var(--warn-bg); color: var(--warn); }
.pill.err { background: var(--err-bg); color: var(--err); }
.muted { color: var(--muted); font-size: .875rem; }
.warn { color: var(--err); }
.mono, code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
code { font-size: .85em; background: var(--bg); padding: .1rem .3rem; border-radius: 4px; }
pre.log {
  margin: 0; padding: .7rem .8rem; max-height: 18rem; overflow: auto;
  background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
  font-size: .78rem; line-height: 1.5; color: var(--muted); white-space: pre-wrap;
}
.notice {
  padding: .6rem .85rem; border-radius: 8px; margin-bottom: 1.1rem; font-size: .9rem;
  background: var(--ok-bg); color: var(--ok); border: 1px solid transparent;
}
.notice.bad { background: var(--err-bg); color: var(--err); }
.secret {
  font-family: ui-monospace, monospace; font-size: 1.5rem; letter-spacing: .18em;
  margin: .8rem 0 .2rem; user-select: all;
}
.qr {
  display: block; width: 100%; max-width: 15rem; height: auto; margin: 0 auto .6rem;
  background: #fff; padding: .6rem; border-radius: 8px; border: 1px solid var(--border);
}
.stack-sm > * + * { margin-top: .75rem; }
`;

export interface PageOptions {
  status?: number;
  headers?: Record<string, string>;
  /** Rendered after the brand as "gateway / <section>". */
  section?: string;
  /** Trusted HTML for the header's right-hand side (identity, sign-out). */
  who?: string;
  /** Inline script appended to the body; the page's only JavaScript. */
  script?: string;
  /** data-* attributes for the body element, read by that script. */
  bodyData?: Record<string, string>;
}

export function page(title: string, body: string, options: PageOptions = {}): Response {
  const { status = 200, headers = {}, section, who = "", script, bodyData } = options;
  const dataAttrs = Object.entries(bodyData ?? {})
    .map(([key, value]) => ` data-${key}="${escapeHtml(value)}"`)
    .join("");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<style>${STYLE}</style></head>
<body${dataAttrs}><div class="wrap">
<header class="top"><div class="brand"><strong>gateway</strong>${
    section ? `<span class="sep">/</span><span class="page">${escapeHtml(section)}</span>` : ""
  }</div><div class="who">${who}</div></header>
${body}
</div>${script ? `<script>${script}</script>` : ""}</body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

/** A dismissible one-line result banner, styled by whether it reads as a failure. */
export function notice(message: string): string {
  if (!message) return "";
  const bad = /fail|error|refus|could not|does not|expired|not signed|burned/i.test(message);
  return `<p class="notice${bad ? " bad" : ""}">${escapeHtml(message)}</p>`;
}

export function pill(text: string, tone: "ok" | "warn" | "err" | "idle" = "idle"): string {
  return `<span class="pill${tone === "idle" ? "" : ` ${tone}`}">${escapeHtml(text)}</span>`;
}
