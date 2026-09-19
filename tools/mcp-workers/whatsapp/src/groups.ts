// Creating a WhatsApp group, kept apart from the socket so every decision in it
// can be unit-tested against a recorded stanza instead of a live connection.
//
// Why this does not simply call Baileys' `sock.groupCreate`: that helper pipes
// the server's reply through `extractGroupMetadata`, which maps each
// <participant> to `{ id, phoneNumber, lid, admin }` and throws the rest away.
// The part it throws away is the whole point here. WhatsApp creates the group
// and *then* answers per member, so someone whose privacy settings forbid being
// added by a non-contact comes back as
//
//     <participant jid="…" error="403"><add_request code="…" expiration="…"/></participant>
//
// and through `groupCreate` that person is indistinguishable from a member who
// was added. So the stanza is sent with `sock.query` — byte for byte the one
// `groupCreate` builds (Socket/groups.js) — and the reply is read here, where
// the `error` attribute survives.

import { generateMessageIDV2, getBinaryNodeChild, getBinaryNodeChildren, jidDecode, jidNormalizedUser } from "baileys";
import type { BinaryNode } from "baileys";
import type { CreateGroupResult, GroupParticipantResult } from "@toolbox/mcp-shared";
import { toJid } from "./normalize";

/** WhatsApp's own limit on a group subject. */
export const MAX_GROUP_SUBJECT = 100;

// WhatsApp allows far more, but a tool call that adds dozens of people to a new
// group at once is how an account gets flagged, and nothing this bridge is for
// needs it. Add the rest from the phone.
export const MAX_GROUP_PARTICIPANTS = 32;

/** The slice of a Baileys socket group creation needs; faked in the tests. */
export interface GroupSocket {
  query(node: BinaryNode, timeoutMs?: number): Promise<BinaryNode>;
  groupInviteCode(jid: string): Promise<string | undefined>;
}

export interface PreparedParticipant {
  requested: string;
  jid: string;
}

export interface PreparedGroupRequest {
  subject: string;
  participants: PreparedParticipant[];
}

/**
 * Validate and normalise a create request. Throws with a message fit to show
 * the caller; nothing has touched WhatsApp at this point.
 */
export function prepareGroupRequest(
  subject: string,
  participants: string[],
  meId: string | null,
): PreparedGroupRequest {
  const cleanSubject = (subject ?? "").replace(/\s+/g, " ").trim();
  if (!cleanSubject) throw new Error("a group needs a subject");
  if ([...cleanSubject].length > MAX_GROUP_SUBJECT) {
    throw new Error(`the subject is ${[...cleanSubject].length} characters; WhatsApp allows ${MAX_GROUP_SUBJECT}`);
  }

  const me = meId ? jidNormalizedUser(meId) : null;
  const seen = new Set<string>();
  const prepared: PreparedParticipant[] = [];
  for (const requested of participants ?? []) {
    const trimmed = (requested ?? "").trim();
    if (!trimmed) continue;
    // The send path turns bare digits into a JID without looking at them, and a
    // national-format number ("07700 900111") would become a JID for whoever
    // owns 07700900111 internationally. Adding a stranger to a group is not a
    // mistake to make quietly.
    if (!trimmed.includes("@") && (/^\+?\s*0/.test(trimmed) || trimmed.includes("(0)"))) {
      throw new Error(`"${requested}" has a national-format 0 in it — give the number in international format, e.g. 447700900111`);
    }
    const jid = jidNormalizedUser(toJid(trimmed));
    const server = jidDecode(jid)?.server;
    if (server !== "s.whatsapp.net" && server !== "lid") {
      throw new Error(`"${requested}" is not a person: only phone numbers and user JIDs can be group members`);
    }
    // The creator is a member already; WhatsApp rejects a create that lists them.
    if (jid === me || seen.has(jid)) continue;
    seen.add(jid);
    prepared.push({ requested, jid });
  }
  if (prepared.length === 0) throw new Error("a group needs at least one participant other than this account");
  if (prepared.length > MAX_GROUP_PARTICIPANTS) {
    throw new Error(`${prepared.length} participants is over this tool's limit of ${MAX_GROUP_PARTICIPANTS}`);
  }
  return { subject: cleanSubject, participants: prepared };
}

/** The same stanza Baileys' groupCreate sends (Socket/groups.js). */
export function groupCreateNode(subject: string, jids: string[], key: string): BinaryNode {
  return {
    tag: "iq",
    attrs: { type: "set", xmlns: "w:g2", to: "@g.us" },
    content: [
      {
        tag: "create",
        attrs: { subject, key },
        content: jids.map((jid) => ({ tag: "participant", attrs: { jid } })),
      },
    ],
  };
}

function describeRefusal(code: number): string {
  if (code === 403) {
    return "their privacy settings do not allow being added directly — send them the invite link";
  }
  if (code === 409) return "WhatsApp says they are already a member";
  return `WhatsApp refused this participant (code ${code})`;
}

function sameUser(a: string | undefined, b: string): boolean {
  return Boolean(a) && jidNormalizedUser(a) === b;
}

export interface ParsedGroupCreate {
  groupJid: string;
  subject: string;
  /** Seconds since the epoch, as WhatsApp reports it; null when absent. */
  creation: number | null;
  participants: GroupParticipantResult[];
}

/**
 * Read the reply to a create. Throws when it holds no group — the caller must
 * not report a group it cannot name.
 */
export function parseGroupCreateResult(result: BinaryNode, request: PreparedGroupRequest): ParsedGroupCreate {
  const group = getBinaryNodeChild(result, "group");
  if (!group?.attrs?.id) {
    const error = getBinaryNodeChild(result, "error");
    if (error) {
      throw new Error(`WhatsApp refused to create the group (${error.attrs.code ?? "?"}: ${error.attrs.text ?? "no reason given"})`);
    }
    throw new Error("WhatsApp's reply to the create held no group");
  }
  const id = group.attrs.id;
  const groupJid = id.includes("@") ? id : `${id}@g.us`;
  const nodes = getBinaryNodeChildren(group, "participant");

  const participants = request.participants.map(({ requested, jid }): GroupParticipantResult => {
    // A new group is usually LID-addressed, in which case `jid` is the member's
    // LID and the number we asked for is in `phone_number` — so match on all
    // three spellings, never on `jid` alone.
    const node = nodes.find(
      ({ attrs }) => sameUser(attrs.jid, jid) || sameUser(attrs.phone_number, jid) || sameUser(attrs.lid, jid),
    );
    if (!node) {
      return { requested, jid, status: "unknown", code: null, detail: "WhatsApp's reply did not mention this participant" };
    }
    if (!node.attrs.error) return { requested, jid, status: "added", code: 200 };
    const code = Number(node.attrs.error);
    return {
      requested,
      jid,
      status: code === 403 ? "invite_required" : "failed",
      code: Number.isFinite(code) ? code : null,
      detail: describeRefusal(code),
    };
  });

  const creation = Number(group.attrs.creation);
  return {
    groupJid,
    subject: group.attrs.subject ?? request.subject,
    creation: Number.isFinite(creation) && creation > 0 ? creation : null,
    participants,
  };
}

export const inviteLinkFor = (code: string): string => `https://chat.whatsapp.com/${code}`;

/**
 * Create the group on an open socket. Once WhatsApp has answered with a group,
 * this never throws: the group exists, and an error after that point would hide
 * its JID from the one caller who needs it.
 */
export async function createGroupOnSocket(
  sock: GroupSocket,
  request: PreparedGroupRequest,
  newKey: () => string = () => generateMessageIDV2(),
): Promise<CreateGroupResult & { creation: number | null }> {
  const reply = await sock.query(
    groupCreateNode(request.subject, request.participants.map((p) => p.jid), newKey()),
  );
  const parsed = parseGroupCreateResult(reply, request);

  let inviteLink: string | null = null;
  let detail: string | undefined;
  if (parsed.participants.some((p) => p.status !== "added")) {
    try {
      const code = await sock.groupInviteCode(parsed.groupJid);
      if (code) inviteLink = inviteLinkFor(code);
      else detail = "the group was created, but WhatsApp returned no invite code";
    } catch (err) {
      detail = `the group was created, but its invite link could not be fetched: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return {
    ok: true,
    groupJid: parsed.groupJid,
    subject: parsed.subject,
    participants: parsed.participants,
    inviteLink,
    ...(detail ? { detail } : {}),
    creation: parsed.creation,
  };
}
