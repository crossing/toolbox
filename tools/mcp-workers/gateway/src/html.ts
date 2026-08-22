// The management interface's page chrome, shared by /manage and its
// sub-pages so they cannot drift apart visually.

import { escapeHtml } from "@toolbox/mcp-shared";

export function page(
  title: string,
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
  table { border-collapse: collapse; width: 100%; margin: .8rem 0 1.6rem; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid #ddd; vertical-align: top; }
  form { display: inline; }
  button { padding: .25rem .9rem; }
  .muted { color: #666; font-size: .9rem; }
  .linkbox { border: 1px solid #ddd; padding: .8rem 1rem; margin: .8rem 0 1.6rem; }
  .code { font-family: ui-monospace, monospace; font-size: 1.6rem; letter-spacing: .2rem; }
  .warn { color: #a00; }
</style></head>
<body>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}
