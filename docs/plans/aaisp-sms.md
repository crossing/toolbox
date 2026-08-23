# AAISP SMS — receive hook and MCP surface

Text messages as a first-class gateway service: AAISP delivers inbound SMS to a
URL on `mcp.xing.works`, the gateway stores them, and MCP tools read the store
and send replies through AAISP's outbound gateway.

**Not started.** This is the plan; nothing below is built.

## Shape

```
AAISP ──POST──→ gateway-mcp (mcp.xing.works)
                  /hooks/sms/<secret>  → SmsInbox (DO)
                  /hooks/sms/<secret>/dlr    ↑  SQLite: messages, parts, meta
                  /manage/sms → health, hook URL, test send
                  /mcp        → sms_* tools ─┘
                                     │
                                     └─ POST → sms.aa.net.uk/sms.cgi
```

One Worker, unlike WhatsApp. The reason the bridge got its own script was a live
Baileys session that must survive gateway deploys; an SMS store has no session
and no socket, so a deploy evicting the Durable Object costs nothing — SQLite
persists, and the next request re-hydrates it. `SmsInbox` therefore lives inside
`gateway-mcp`.

## What AAISP actually provides

From [support.aa.net.uk/SMS_API](https://support.aa.net.uk/SMS_API):

**Outbound** — `POST https://sms.aa.net.uk/sms.cgi`, form-encoded or JSON.
Required: `username` (a VoIP number in international format), `password` (the
outgoing password from the control pages), `da` (destination — international or
national, or a SIP2SIM ICCID), `ud` (message text, UTF-8). Useful optionals:
`oa` (sending number, defaults to `username`), `limit` (cap the number of parts),
`srr` (an email address *or a URL* for the delivery report), `costcentre`,
`private`, `xml`. The response is plain text beginning `OK:` or `ERR:`.

**Inbound** — a URL is configured per number in AAISP's control pages. If it
ends in `?` or `&` they use GET; otherwise **POST with URL-encoded form data**.
Fields: `scts` (service-centre timestamp, ISO-8601), `da` (our number), `oa`
(sender), `ud` (text, UTF-8), and when present `via`, `udh` (hex), `dcs`, `pid`.
Prefixing the URL with `*` switches to the legacy field names — we want the
modern ones.

**Delivery reports** — `srr` may be a URL containing `%code` (1 delivered,
2 rejected, 4 buffered, 8 accepted by SMSC, 16 rejected by SMSC) and other `%`
substitutions.

## The security problem, and the answer

**AAISP does not authenticate the inbound POST.** There is no signature, no
shared secret, no documented source range. Anyone who learns the URL can inject
messages into the store, and the store is read by a model. Four defences, all
cheap:

1. **The path is the credential.** `/hooks/sms/<32 random chars>`, held in
   1Password and typed once into AAISP's control page. Compared in constant
   time against a Worker secret; rotating it is a secret update plus one edit
   upstream.
2. **Field validation.** Reject unless `da` is one of the configured own
   numbers, `oa` looks like a number, and `ud` is within a sane length.
3. **Idempotency.** Dedupe on `(oa, da, scts, udh-part, sha256(ud))`. AAISP's
   retry behaviour is undocumented, so assume messages can arrive twice and
   make a second delivery a no-op.
4. **Nothing is ever acted on.** The hook writes a row and returns 200. It runs
   no rules, triggers no sends, and calls nothing. Everything downstream is a
   model reading a tool result, which is untrusted content by construction.

An IP allowlist would be a fifth, but A&A do not publish a range for this
specifically — worth asking them before relying on it, and worth having as a
config option rather than a hardcoded constant either way.

### The sharper risk: one-time codes

An SMS store is, in practice, a store of 2FA codes. Exposing it through MCP
means a model — and anything that has managed to influence that model — can
read them. This is a design decision, not a detail, and the options are:

- **Store everything, expose everything.** Simplest, and the most dangerous.
- **Store everything, expose selectively:** a per-sender allowlist or blocklist
  on the *tool* side, so codes are stored (the manage page can show them) but
  `sms_list_messages` never returns them.
- **Redact on read:** pattern-match likely OTPs (`\b\d{4,8}\b` near words like
  "code", "OTP", "verification") and replace them in tool output.
- **Time-box:** tools only return messages older than N minutes, so a live code
  has expired by the time a model can see it.

Recommendation: blocklist by sender, plus redaction, both configurable on
`/manage/sms`. Decide before phase 2 — it changes the store's read path.

## Concatenated messages

Long texts arrive as several POSTs, each with a `udh` carrying the multipart
header: IEI `0x00` (8-bit reference: ref, total, seq) or `0x08` (16-bit
reference). The hook parses it, stores parts keyed by `(oa, ref)`, and joins
them once `total` parts are present. Incomplete sets expire after an hour and
are surfaced as-is rather than silently dropped — a half-message is information
too.

## Store

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,          -- sha256(oa|da|scts|ud), so retries collapse
  direction TEXT NOT NULL,      -- 'in' | 'out'
  peer TEXT NOT NULL,           -- the other end, normalised to +44…
  own_number TEXT NOT NULL,     -- which of ours it came to / went from
  body TEXT NOT NULL,
  timestamp TEXT NOT NULL,      -- ISO-8601 UTC, like the WhatsApp store
  parts INTEGER NOT NULL DEFAULT 1,
  status TEXT,                  -- outbound: queued | sent | delivered | failed
  dlr_code INTEGER,             -- AAISP's %code, when a report arrives
  raw TEXT                      -- the original form fields, for forensics
);
CREATE TABLE parts (…);         -- incomplete concatenated sets
CREATE TABLE meta (key, value); -- hook counters, last receipt, config
```

Timestamps ISO-8601 UTC for the same reason as the WhatsApp store: lexical
order is chronological and range filters are string comparisons.

## Tools

Prefixed `sms_`, consistent with the rest of the catalog:

| Tool | Kind | Notes |
| --- | --- | --- |
| `sms_list_messages` | read | `after`, `before`, `peer`, `query`, `limit`, `page` |
| `sms_get_thread` | read | everything to and from one number, in order |
| `sms_status` | read | hook health, last receipt, counts, configured numbers |
| `sms_send` | write | `to`, `message`; audited |

`sms_send` costs money and reaches a stranger's phone. WhatsApp's
`whatsapp_send_message` is not confirm-gated, and parity argues for the same
here — but an optional recipient allowlist and a per-hour cap are worth having,
and are the kind of thing that is much easier to add before the tool exists.
**Open decision.**

## Management page

`/manage/sms`, in the same idiom as `/manage/whatsapp`:

- the hook URL, revealed on click and never in a redirect (the path *is* the
  credential — same reasoning as the WhatsApp import code, which is rendered
  into the response body rather than put in a query string, because Workers
  Logs record request URLs);
- configured own numbers, and the AAISP username the sends go out as;
- last received / last sent, with counts and the recent-message table
  (metadata only, matching the WhatsApp page's rule);
- a test send;
- the OTP policy switches.

## Secrets

Added to `secrets.manifest.json` under `gateway`:

```
AAISP_SMS_USERNAME  op://Private/AAISP/sms_username
AAISP_SMS_PASSWORD  op://Private/AAISP/sms_password
SMS_HOOK_SECRET     op://Private/AAISP/sms_hook_secret
SMS_OWN_NUMBERS     op://Private/AAISP/sms_own_numbers   (comma-separated)
```

## Phases

1. **Receive.** Hook route, `SmsInbox` DO, store, concatenation, `/manage/sms`
   showing arrivals. Verifiable end to end by texting the number — no MCP
   involvement at all, which makes the first failure easy to localise.
2. **Read.** `sms_list_messages`, `sms_get_thread`, `sms_status`, behind a new
   catalog toggle defaulting to off. OTP policy lands here.
3. **Send.** `sms_send` plus delivery reports through `srr` pointing back at
   `/hooks/sms/<secret>/dlr`, updating `status` and `dlr_code`.

## Open questions

- **Which number?** A VoIP number, a SIP2SIM SIM, or both — this decides what
  goes in `SMS_OWN_NUMBERS` and which control page gets the hook URL.
- **Does AAISP retry a failed POST?** Undocumented. Until it is known, the hook
  must be fast, must return 200 for anything it has stored, and must never
  return 200 for something it dropped.
- **Source ranges** for an IP allowlist, if A&A will state them.
- **OTP policy** — see above. The one decision that should not be deferred past
  phase 2.

## Why not Twilio-style middleware

Because the number already exists and the bill is already paid. AAISP's API is
two endpoints and a form post; the whole of phase 1 is smaller than the
configuration a third-party gateway would need, and no message leaves the
account it arrived on.
