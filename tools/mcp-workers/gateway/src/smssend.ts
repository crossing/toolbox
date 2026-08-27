// Dispatch to AAISP's SMS API — the only place in the gateway that sends.
//
// This lives in the Worker rather than in SmsInbox because the Durable Object
// holds no credentials: it stores what was asked for and what happened, and
// the secrets stay on the side that can read `env`.
//
// The API is a form POST whose reply is a single line of plain text starting
// `OK:` or `ERR:`. There is no JSON and no status-code contract worth relying
// on — a rejected message can still come back 200 — so the body is what
// decides, and an unrecognisable body is treated as a failure rather than
// optimistically as a success.

import type { Env } from "./env";

const SMS_CGI = "https://sms.aa.net.uk/sms.cgi";

/** AAISP splits longer text into parts and bills per part; this caps one
 *  request at a sane number of them rather than letting a runaway string
 *  become a runaway invoice. */
const MAX_PARTS = 4;

export interface DispatchResult {
  ok: boolean;
  detail: string;
}

export function smsCredentials(env: Env): { username: string; password: string } | null {
  const username = (env.AAISP_SMS_USERNAME ?? "").trim();
  const password = (env.AAISP_SMS_PASSWORD ?? "").trim();
  if (!username || !password) return null;
  return { username, password };
}

/**
 * The delivery-report URL AAISP will fetch. The pending-send id travels in it
 * because nothing in their report identifies which of our messages it
 * describes, and `%code` is substituted by them at delivery time.
 *
 * It carries the hook secret, exactly as the receive URL does — the path is
 * the credential for both.
 */
export function dlrUrl(env: Env, origin: string, sendId: string): string | null {
  if (!env.SMS_HOOK_SECRET) return null;
  return `${origin}/hooks/sms/${env.SMS_HOOK_SECRET}/dlr?id=${encodeURIComponent(sendId)}&code=%code`;
}

export async function dispatchSms(
  env: Env,
  to: string,
  body: string,
  srr: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<DispatchResult> {
  const creds = smsCredentials(env);
  if (!creds) {
    return { ok: false, detail: "AAISP_SMS_USERNAME/AAISP_SMS_PASSWORD are not set on this Worker" };
  }

  const form = new URLSearchParams();
  form.set("username", creds.username);
  form.set("password", creds.password);
  form.set("da", to);
  form.set("ud", body);
  form.set("oa", creds.username);
  form.set("limit", String(MAX_PARTS));
  if (srr) form.set("srr", srr);

  let response: Response;
  try {
    response = await fetchImpl(SMS_CGI, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch (err) {
    return { ok: false, detail: `could not reach AAISP: ${(err as Error).message}` };
  }

  const text = (await response.text()).trim();
  const line = text.split("\n", 1)[0] ?? "";
  if (line.startsWith("OK")) return { ok: true, detail: line };
  if (line.startsWith("ERR")) return { ok: false, detail: line };
  return { ok: false, detail: `unrecognised reply from AAISP (HTTP ${response.status}): ${line.slice(0, 200)}` };
}
