// Minimal consent page for the /authorize step. Pure string-in/string-out so
// it is unit-testable outside the Workers runtime.
//
// The OAuth request is round-tripped through the form as base64 JSON; the
// upstream-IdP flows added in later phases carry it through their state
// parameter instead.

export interface ApprovalPageOptions {
  serverName: string;
  clientName: string;
  redirectUri: string;
  requestedScopes: string[];
  encodedAuthRequest: string;
  offerWrite: boolean;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderApprovalPage(opts: ApprovalPageOptions): string {
  const scopes = opts.requestedScopes.length > 0 ? opts.requestedScopes.join(", ") : "(none requested)";
  const writeRow = opts.offerWrite
    ? `<label><input type="checkbox" name="allow_write" value="1"> allow write tools</label>`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(opts.serverName)} authorization</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui, sans-serif; max-width: 26rem; margin: 4rem auto; padding: 0 1rem; }
  dt { font-weight: 600; margin-top: .6rem; } dd { margin: 0; overflow-wrap: anywhere; }
  button { margin-top: 1.2rem; padding: .5rem 1.4rem; font-size: 1rem; }
  label { display: block; margin-top: .8rem; }
</style></head>
<body>
<h1>${escapeHtml(opts.serverName)}</h1>
<p>A client is asking to connect:</p>
<dl>
  <dt>Client</dt><dd>${escapeHtml(opts.clientName)}</dd>
  <dt>Redirect</dt><dd>${escapeHtml(opts.redirectUri)}</dd>
  <dt>Scopes</dt><dd>${escapeHtml(scopes)}</dd>
</dl>
<form method="post">
  <input type="hidden" name="auth_request" value="${escapeHtml(opts.encodedAuthRequest)}">
  ${writeRow}
  <button type="submit">Approve</button>
</form>
</body></html>`;
}

export function encodeAuthRequest(authRequest: unknown): string {
  return btoa(JSON.stringify(authRequest));
}

export function decodeAuthRequest<T>(encoded: string): T {
  return JSON.parse(atob(encoded)) as T;
}
