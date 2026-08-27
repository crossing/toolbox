// /hooks/sms/<secret> — where AAISP delivers inbound text messages.
//
// AAISP does not authenticate this POST. There is no signature, no shared
// secret of theirs, and no published source range, so four cheap defences
// stand in for one real one:
//
//   1. The path is the credential — 32 random characters, compared in constant
//      time, held in 1Password and typed once into AAISP's control page.
//   2. Field validation — `da` must be one of our own numbers.
//   3. Idempotency — the store dedupes on a content hash, because AAISP's
//      retry behaviour is undocumented and a second delivery must be a no-op.
//   4. Nothing is ever acted on — this handler writes a row and returns. It
//      runs no rules, triggers no sends, and calls nothing.
//
// The contract with AAISP is narrow and worth stating: 200 means stored. A
// message that is dropped for any reason must not get one, because a retry we
// refuse to admit to is a message lost silently.

import type { Env } from "./env";
import { normalizePeer, type InboundFields } from "./smsstore";
import { inboxFor } from "./sms";

const HOOK_PREFIX = "/hooks/sms/";

/** Generous enough for a long concatenated set, tight enough to bound a row. */
const MAX_BODY = 4000;
const MAX_SENDER = 32;

const encoder = new TextEncoder();

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/** Constant-time over the digests, so neither the value nor its length leaks. */
async function secretMatches(given: string, expected: string): Promise<boolean> {
  if (!expected || !given) return false;
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function ownNumbers(env: Env): string[] {
  return (env.SMS_OWN_NUMBERS ?? "")
    .split(",")
    .map((n) => normalizePeer(n.trim()))
    .filter((n) => n.length > 0);
}

/**
 * AAISP sends ISO-8601. Normalising to UTC keeps the store's ordering
 * property — lexical order is chronological — even if a delivery ever arrives
 * with an offset, and an unparseable stamp falls back to arrival time rather
 * than poisoning the sort.
 */
function normalizeScts(raw: string | null, nowMs: number): string {
  if (raw) {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(nowMs).toISOString();
}

function fieldsFrom(params: URLSearchParams): {
  fields: InboundFields | null;
  reason?: string;
} {
  const oa = (params.get("oa") ?? "").trim();
  const da = (params.get("da") ?? "").trim();
  const ud = params.get("ud") ?? "";
  if (!oa || oa.length > MAX_SENDER) return { fields: null, reason: "bad oa" };
  if (!da) return { fields: null, reason: "missing da" };
  if (ud.length === 0 || ud.length > MAX_BODY) return { fields: null, reason: "bad ud" };
  const raw: Record<string, string> = {};
  for (const [key, value] of params) raw[key] = value;
  return {
    fields: {
      oa,
      da,
      ud,
      scts: params.get("scts") ?? "",
      udh: params.get("udh"),
      raw: JSON.stringify(raw),
    },
  };
}

/**
 * Returns null when the path is not ours, so the caller falls through to the
 * rest of the Worker's routes.
 */
export async function handleSmsHook(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith(HOOK_PREFIX)) return null;

  const rest = url.pathname.slice(HOOK_PREFIX.length);
  const [given] = rest.split("/", 1);
  // A wrong secret and a nonexistent route answer identically: this endpoint
  // should look like nothing to anyone who has not been told the path.
  if (!(await secretMatches(given ?? "", env.SMS_HOOK_SECRET ?? ""))) {
    return new Response("not found", { status: 404 });
  }

  // Configured as a POST target; AAISP switches to GET if the URL is given to
  // them ending in `?` or `&`, so both are accepted rather than one working
  // and the other failing mysteriously.
  let params: URLSearchParams;
  if (request.method === "POST") {
    const body = await request.text();
    params = new URLSearchParams(body);
  } else if (request.method === "GET") {
    params = url.searchParams;
  } else {
    return new Response("method not allowed", { status: 405 });
  }

  const nowMs = Date.now();
  const { fields, reason } = fieldsFrom(params);
  if (!fields) return new Response(reason ?? "bad request", { status: 400 });

  const allowed = ownNumbers(env);
  if (allowed.length > 0 && !allowed.includes(normalizePeer(fields.da))) {
    return new Response("unknown destination", { status: 400 });
  }

  const result = await inboxFor(env).receive({
    ...fields,
    scts: normalizeScts(fields.scts || null, nowMs),
  });

  // 200 only for what is now held — including a duplicate, which *is* held,
  // and including an incomplete concatenated set, whose parts are stored.
  if (!result.stored) return new Response("not stored", { status: 500 });
  return new Response("OK", { status: 200, headers: { "content-type": "text/plain" } });
}
