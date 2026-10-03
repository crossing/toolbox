// Parsing and formatting for file refs (syntax in types.ts). Strict on
// purpose: a ref is typed or pasted by a model, and a near-miss should come
// back as a message that says what the right shape is, not as a 404 from
// whichever API the garbled id reached.
//
// The only query parameter is `account`, and only on refs for multi-account
// services (Drive, Gmail). WhatsApp has one bridge and FreeAgent one company.
// FreeAgent is a sink (bill/explanation/expense) and, for attachments, a source.

import { FileError, TRANSIT_FOLDER, type FreeAgentTarget, type SinkRef, type SourceRef } from "./types";

// Drive file ids, Gmail message/attachment/draft ids: base64url-ish tokens.
const TOKEN = /^[A-Za-z0-9_-]{1,512}$/;
// user@server, where user may carry a device suffix (123:4@s.whatsapp.net)
// and server is one of WhatsApp's domains (s.whatsapp.net, g.us, lid, ...).
const JID = /^[A-Za-z0-9._:-]{1,128}@[a-z][a-z.]{0,63}$/;
const PHONE = /^\+?[0-9]{6,15}$/;
const WA_MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const NUMERIC_ID = /^[0-9]{1,20}$/;
const FREEAGENT_TARGETS: readonly FreeAgentTarget[] = ["bill", "explanation", "expense"];

const SOURCE_SHAPES =
  "drive:<fileId>[?account=], gmail:<messageId>/<attachmentId>[?account=], wa:<chatJid>/<messageId>, freeagent:attachment/<id>";
const SINK_SHAPES =
  "drive:folder/<parentId>[?account=], gmail:draft/<draftId>[?account=], wa:send/<recipient>, freeagent:bill|explanation|expense/<id>";

function fail(message: string): never {
  throw new FileError(400, message);
}

interface Split {
  scheme: string;
  path: string;
  account?: string;
}

function split(ref: string, kind: "source" | "sink", shapes: string): Split {
  if (typeof ref !== "string" || ref.trim() !== ref || ref === "") {
    fail(`empty or padded ${kind} ref; expected one of ${shapes}`);
  }
  const colon = ref.indexOf(":");
  if (colon <= 0) fail(`"${ref}" is not a ${kind} ref; expected one of ${shapes}`);
  const scheme = ref.slice(0, colon);
  let path = ref.slice(colon + 1);
  let account: string | undefined;
  const q = path.indexOf("?");
  if (q >= 0) {
    const query = path.slice(q + 1);
    path = path.slice(0, q);
    // Not URLSearchParams: it reads "+" as a space, and labels are emails,
    // which may legitimately contain one.
    const match = /^account=([^&=]*)$/.exec(query);
    if (!match) fail(`"${ref}": the only query parameter a ref takes is ?account=<label>`);
    try {
      account = decodeURIComponent(match[1] ?? "");
    } catch {
      fail(`"${ref}": ?account= is not valid percent-encoding`);
    }
    if (account === "" || /\s/.test(account)) fail(`"${ref}": ?account= needs a non-empty label without spaces`);
  }
  return { scheme, path, account };
}

function noAccount(ref: string, s: Split, service: string): void {
  if (s.account !== undefined) fail(`"${ref}": ${service} refs take no ?account= — there is only one ${service} link`);
}

function twoParts(ref: string, path: string, shape: string): [string, string] {
  // WhatsApp JIDs and Google ids never contain "/", so the split is unambiguous.
  const parts = path.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) fail(`"${ref}" is malformed; expected ${shape}`);
  return [parts[0], parts[1]];
}

export function parseSourceRef(ref: string): SourceRef {
  const s = split(ref, "source", SOURCE_SHAPES);
  switch (s.scheme) {
    case "drive": {
      if (s.path.startsWith("folder/")) fail(`"${ref}" is a sink (a destination folder), not a file to read`);
      if (!TOKEN.test(s.path)) fail(`"${ref}" is malformed; expected drive:<fileId>`);
      return { kind: "drive", fileId: s.path, ...(s.account !== undefined && { account: s.account }) };
    }
    case "gmail": {
      if (s.path.startsWith("draft/")) fail(`"${ref}" is a sink (a draft to attach to), not a file to read`);
      const [messageId, attachmentId] = twoParts(ref, s.path, "gmail:<messageId>/<attachmentId>");
      if (!TOKEN.test(messageId) || !TOKEN.test(attachmentId)) {
        fail(`"${ref}" is malformed; expected gmail:<messageId>/<attachmentId> (ids from gmail_get_message)`);
      }
      return { kind: "gmail", messageId, attachmentId, ...(s.account !== undefined && { account: s.account }) };
    }
    case "wa": {
      if (s.path.startsWith("send/")) fail(`"${ref}" is a sink (a recipient), not a file to read`);
      noAccount(ref, s, "WhatsApp");
      const [chatJid, messageId] = twoParts(ref, s.path, "wa:<chatJid>/<messageId>");
      if (!JID.test(chatJid)) fail(`"${ref}": "${chatJid}" is not a chat JID (like 447700900000@s.whatsapp.net)`);
      if (!WA_MESSAGE_ID.test(messageId)) fail(`"${ref}": "${messageId}" is not a WhatsApp message id`);
      return { kind: "wa", chatJid, messageId };
    }
    case "freeagent": {
      noAccount(ref, s, "FreeAgent");
      const [what, id] = twoParts(ref, s.path, "freeagent:attachment/<id>");
      if (what !== "attachment") {
        if ((FREEAGENT_TARGETS as readonly string[]).includes(what)) {
          fail(`"${ref}" is a sink (a record to attach to); to read a FreeAgent file use freeagent:attachment/<id>`);
        }
        fail(`"${ref}" is malformed; FreeAgent sources are freeagent:attachment/<id>`);
      }
      if (!NUMERIC_ID.test(id)) fail(`"${ref}": "${id}" is not a FreeAgent attachment id (the number at the end of its url)`);
      return { kind: "freeagent-attachment", id };
    }
    default:
      return fail(`"${ref}": unknown scheme "${s.scheme}"; expected one of ${SOURCE_SHAPES}`);
  }
}

export function parseSinkRef(ref: string): SinkRef {
  const s = split(ref, "sink", SINK_SHAPES);
  switch (s.scheme) {
    case "drive": {
      const [what, parentId] = twoParts(ref, s.path, "drive:folder/<parentId>");
      if (what !== "folder") fail(`"${ref}" is malformed; Drive destinations are drive:folder/<parentId>`);
      if (parentId !== TRANSIT_FOLDER && !TOKEN.test(parentId)) fail(`"${ref}": "${parentId}" is not a Drive folder id`);
      // One `_Transit`, in the default Drive account: that is the folder the
      // expiry sweep cleans, so a labelled one would never be emptied.
      if (parentId === TRANSIT_FOLDER && s.account !== undefined) {
        fail(`"${ref}": _Transit lives in the default Drive account; drop ?account=, or name a folder id in that account`);
      }
      return { kind: "drive-folder", parentId, ...(s.account !== undefined && { account: s.account }) };
    }
    case "gmail": {
      const [what, draftId] = twoParts(ref, s.path, "gmail:draft/<draftId>");
      if (what !== "draft") fail(`"${ref}" is malformed; Gmail destinations are gmail:draft/<draftId>`);
      if (!TOKEN.test(draftId)) fail(`"${ref}": "${draftId}" is not a Gmail draft id`);
      return { kind: "gmail-draft", draftId, ...(s.account !== undefined && { account: s.account }) };
    }
    case "wa": {
      noAccount(ref, s, "WhatsApp");
      const [what, recipient] = twoParts(ref, s.path, "wa:send/<recipient>");
      if (what !== "send") fail(`"${ref}" is malformed; WhatsApp destinations are wa:send/<recipient>`);
      if (!PHONE.test(recipient) && !JID.test(recipient)) {
        fail(`"${ref}": "${recipient}" is neither an international phone number nor a JID`);
      }
      return { kind: "wa-send", recipient };
    }
    case "freeagent": {
      noAccount(ref, s, "FreeAgent");
      const [target, id] = twoParts(ref, s.path, "freeagent:bill|explanation|expense/<id>");
      if (target === "attachment") fail(`"${ref}" is a source (a file to read), not a record to attach to`);
      if (!(FREEAGENT_TARGETS as readonly string[]).includes(target)) {
        fail(`"${ref}": FreeAgent destinations are bill, explanation or expense, not "${target}"`);
      }
      if (!NUMERIC_ID.test(id)) fail(`"${ref}": "${id}" is not a FreeAgent id (the number at the end of its url)`);
      return { kind: "freeagent", target: target as FreeAgentTarget, id };
    }
    default:
      return fail(`"${ref}": unknown scheme "${s.scheme}"; expected one of ${SINK_SHAPES}`);
  }
}

// Labels are usually emails; "@" reads better unescaped and is legal in a query.
function accountSuffix(account: string | undefined): string {
  return account === undefined ? "" : `?account=${encodeURIComponent(account).replace(/%40/g, "@")}`;
}

/** The canonical string for a parsed ref; parse(format(r)) deep-equals r. */
export function formatRef(ref: SourceRef | SinkRef): string {
  switch (ref.kind) {
    case "drive":
      return `drive:${ref.fileId}${accountSuffix(ref.account)}`;
    case "gmail":
      return `gmail:${ref.messageId}/${ref.attachmentId}${accountSuffix(ref.account)}`;
    case "wa":
      return `wa:${ref.chatJid}/${ref.messageId}`;
    case "freeagent-attachment":
      return `freeagent:attachment/${ref.id}`;
    case "drive-folder":
      return `drive:folder/${ref.parentId}${accountSuffix(ref.account)}`;
    case "gmail-draft":
      return `gmail:draft/${ref.draftId}${accountSuffix(ref.account)}`;
    case "wa-send":
      return `wa:send/${ref.recipient}`;
    case "freeagent":
      return `freeagent:${ref.target}/${ref.id}`;
  }
}
