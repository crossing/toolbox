// Creating and administering WhatsApp groups, kept apart from the socket so
// every decision can be unit-tested against a recorded stanza instead of a live
// connection.
//
// The rule for choosing between a Baileys helper and a hand-built stanza: use
// the helper unless it throws away an outcome. `groupCreate` and `groupLeave`
// both do (see below and leaveGroupOnSocket); `groupParticipantsUpdate` keeps
// the per-participant status but returns it keyed by whatever JID the server
// chose to answer with, so that reply is read here too, with the same matcher
// as create. `groupMetadata`, `groupUpdateSubject` and `groupRevokeInvite` lose
// nothing and are called as they are.
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
import type {
  CreateGroupResult,
  GroupInfoResult,
  GroupMember,
  GroupParticipantAction,
  GroupParticipantResult,
  UpdateParticipantsResult,
} from "@toolbox/mcp-shared";
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

/** A subject as WhatsApp will take it, or a throw that says why not. */
export function prepareSubject(subject: string): string {
  const cleanSubject = (subject ?? "").replace(/\s+/g, " ").trim();
  if (!cleanSubject) throw new Error("a group needs a subject");
  if ([...cleanSubject].length > MAX_GROUP_SUBJECT) {
    throw new Error(`the subject is ${[...cleanSubject].length} characters; WhatsApp allows ${MAX_GROUP_SUBJECT}`);
  }
  return cleanSubject;
}

/** Group tools act on groups only: a phone number here is always a mistake. */
export function requireGroupJid(groupJid: string): string {
  const trimmed = (groupJid ?? "").trim();
  if (!/^[0-9-]+@g\.us$/.test(trimmed)) {
    throw new Error(`"${groupJid}" is not a group JID — it should look like 120363…@g.us (see whatsapp_list_chats)`);
  }
  return trimmed;
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
  return { subject: prepareSubject(subject), participants: prepareParticipants(participants, meId, "skip") };
}

/**
 * The member list shared by create and whatsapp_group_update_participants.
 * `self` says what to do when this account is on the list: a create drops it
 * (the creator is a member already), an update refuses, because "remove me" is
 * leaving and "demote me" is not something to do by accident.
 */
export function prepareParticipants(
  participants: string[],
  meId: string | null,
  self: "skip" | "refuse",
): PreparedParticipant[] {
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
    if (jid === me) {
      // The creator is a member already; WhatsApp rejects a create that lists them.
      if (self === "skip") continue;
      throw new Error("that is this account itself — use whatsapp_leave_group to leave a group");
    }
    if (seen.has(jid)) continue;
    seen.add(jid);
    prepared.push({ requested, jid });
  }
  if (prepared.length === 0) throw new Error("a group needs at least one participant other than this account");
  if (prepared.length > MAX_GROUP_PARTICIPANTS) {
    throw new Error(`${prepared.length} participants is over this tool's limit of ${MAX_GROUP_PARTICIPANTS}`);
  }
  return prepared;
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

function describeRefusal(code: number, action: GroupParticipantAction = "add"): string {
  if (action === "add") {
    if (code === 403) {
      return "their privacy settings do not allow being added directly — send them the invite link";
    }
    if (code === 409) return "WhatsApp says they are already a member";
  } else {
    if (code === 404) return "WhatsApp says they are not a member of this group";
    if (code === 403) return "WhatsApp refused: this account is not allowed to do that to them";
  }
  return `WhatsApp refused this participant (code ${code})`;
}

const SUCCESS_STATUS: Record<GroupParticipantAction, GroupParticipantResult["status"]> = {
  add: "added",
  remove: "removed",
  promote: "promoted",
  demote: "demoted",
};

/**
 * One requested member against the <participant> nodes of a reply. A group is
 * usually LID-addressed, in which case `jid` is the member's LID and the number
 * we asked for is in `phone_number` — so match on all three spellings, never on
 * `jid` alone.
 */
function readParticipant(
  nodes: BinaryNode[],
  { requested, jid }: PreparedParticipant,
  action: GroupParticipantAction,
): GroupParticipantResult {
  const node = nodes.find(
    ({ attrs }) => sameUser(attrs.jid, jid) || sameUser(attrs.phone_number, jid) || sameUser(attrs.lid, jid),
  );
  if (!node) {
    return { requested, jid, status: "unknown", code: null, detail: "WhatsApp's reply did not mention this participant" };
  }
  if (!node.attrs.error) return { requested, jid, status: SUCCESS_STATUS[action], code: 200 };
  const code = Number(node.attrs.error);
  return {
    requested,
    jid,
    status: action === "add" && code === 403 ? "invite_required" : "failed",
    code: Number.isFinite(code) ? code : null,
    detail: describeRefusal(code, action),
  };
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

  const participants = request.participants.map((wanted) => readParticipant(nodes, wanted, "add"));

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

// --- after creation ----------------------------------------------------------

/** The stanza Baileys' groupParticipantsUpdate sends (Socket/groups.js). */
export function participantsUpdateNode(groupJid: string, action: GroupParticipantAction, jids: string[]): BinaryNode {
  return {
    tag: "iq",
    attrs: { type: "set", xmlns: "w:g2", to: groupJid },
    content: [{ tag: action, attrs: {}, content: jids.map((jid) => ({ tag: "participant", attrs: { jid } })) }],
  };
}

export function parseParticipantsUpdate(
  reply: BinaryNode,
  action: GroupParticipantAction,
  wanted: PreparedParticipant[],
): GroupParticipantResult[] {
  const nodes = getBinaryNodeChildren(getBinaryNodeChild(reply, action), "participant");
  return wanted.map((participant) => readParticipant(nodes, participant, action));
}

/**
 * Add, remove, promote or demote. As with create, a per-participant refusal is
 * a status, not a failed call — the others on the list went through. The
 * invite link is fetched only when an add was refused with 403.
 */
export async function updateParticipantsOnSocket(
  sock: GroupSocket,
  groupJid: string,
  action: GroupParticipantAction,
  wanted: PreparedParticipant[],
): Promise<UpdateParticipantsResult> {
  const reply = await sock.query(participantsUpdateNode(groupJid, action, wanted.map((p) => p.jid)));
  const participants = parseParticipantsUpdate(reply, action, wanted);

  let inviteLink: string | null = null;
  let detail: string | undefined;
  if (participants.some((p) => p.status === "invite_required")) {
    try {
      const code = await sock.groupInviteCode(groupJid);
      if (code) inviteLink = inviteLinkFor(code);
      else detail = "WhatsApp returned no invite code for the group";
    } catch (err) {
      detail = `the invite link could not be fetched: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { ok: true, groupJid, action, participants, inviteLink, ...(detail ? { detail } : {}) };
}

/** The stanza Baileys' groupLeave sends (Socket/groups.js). */
export function leaveNode(groupJid: string): BinaryNode {
  return {
    tag: "iq",
    attrs: { type: "set", xmlns: "w:g2", to: "@g.us" },
    content: [{ tag: "leave", attrs: {}, content: [{ tag: "group", attrs: { id: groupJid } }] }],
  };
}

/**
 * Leave a group. Baileys' `groupLeave` awaits the reply and discards it, and a
 * leave — like a create — is answered per item: `<leave><group id=… error=…/>`.
 * `sock.query` already throws on an `<iq type="error">`; this reads the inner
 * node as well, so a leave WhatsApp refused is never recorded as one that
 * happened.
 */
export async function leaveGroupOnSocket(sock: Pick<GroupSocket, "query">, groupJid: string): Promise<void> {
  const reply = await sock.query(leaveNode(groupJid));
  const groups = getBinaryNodeChildren(getBinaryNodeChild(reply, "leave"), "group");
  const mine = groups.find((group) => group.attrs.id === groupJid || `${group.attrs.id}@g.us` === groupJid);
  if (mine?.attrs.error) {
    const code = mine.attrs.error;
    throw new Error(
      code === "404" || code === "403"
        ? `WhatsApp says this account is not a member of ${groupJid} (code ${code})`
        : `WhatsApp refused the leave (code ${code})`,
    );
  }
}

/** What groupMetadata hands back, as far as this module reads it. */
export interface GroupMetadataLike {
  id: string;
  subject?: string | null;
  desc?: string | null;
  owner?: string | null;
  ownerPn?: string | null;
  creation?: number | null;
  size?: number | null;
  addressingMode?: string | null;
  announce?: boolean;
  restrict?: boolean;
  participants: { id: string; phoneNumber?: string | null; lid?: string | null; admin?: string | null }[];
}

export interface GroupInfoSocket {
  groupMetadata(jid: string): Promise<GroupMetadataLike>;
  groupInviteCode(jid: string): Promise<string | undefined>;
}

/** This account under both of its names: a LID-addressed group lists the LID. */
export interface Me {
  id: string | null;
  lid?: string | null;
}

function isMe(member: { id: string; phoneNumber?: string | null; lid?: string | null }, me: Me): boolean {
  const mine = [me.id, me.lid].filter((jid): jid is string => Boolean(jid)).map((jid) => jidNormalizedUser(jid));
  return [member.id, member.phoneNumber, member.lid].some((jid) => Boolean(jid) && mine.includes(jidNormalizedUser(jid!)));
}

/**
 * Subject, members and admins, with the phone number wherever WhatsApp gave
 * one. The invite link is only asked for when this account is an admin —
 * WhatsApp refuses it to anyone else, and the refusal would read as a fault.
 */
export async function groupInfoOnSocket(
  sock: GroupInfoSocket,
  groupJid: string,
  me: Me,
  knownName: (jid: string) => string | null = () => null,
): Promise<GroupInfoResult> {
  const meta = await sock.groupMetadata(groupJid);
  const participants = meta.participants.map((member): GroupMember => {
    const id = jidNormalizedUser(member.id);
    const phone = member.phoneNumber ? jidNormalizedUser(member.phoneNumber) : id.endsWith("@s.whatsapp.net") ? id : null;
    const lid = member.lid ? jidNormalizedUser(member.lid) : id.endsWith("@lid") ? id : null;
    const admin = member.admin === "admin" || member.admin === "superadmin" ? member.admin : null;
    // The store files people by number, so that is where a name is likeliest.
    const name = (phone ? knownName(phone) : null) ?? knownName(id);
    return { jid: id, phoneNumber: phone, lid, admin, isMe: isMe(member, me), name };
  });
  const iAmAdmin = participants.some((member) => member.isMe && member.admin !== null);

  let inviteLink: string | null = null;
  let detail: string | undefined;
  if (iAmAdmin) {
    try {
      const code = await sock.groupInviteCode(groupJid);
      if (code) inviteLink = inviteLinkFor(code);
      else detail = "WhatsApp returned no invite code";
    } catch (err) {
      detail = `the invite link could not be fetched: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const creation = Number(meta.creation);
  return {
    ok: true,
    groupJid: meta.id,
    subject: meta.subject ?? null,
    description: meta.desc ?? null,
    owner: meta.ownerPn ?? meta.owner ?? null,
    createdAt: Number.isFinite(creation) && creation > 0 ? new Date(creation * 1000).toISOString() : null,
    size: meta.size ?? participants.length,
    addressingMode: meta.addressingMode === "lid" ? "lid" : "pn",
    announce: Boolean(meta.announce),
    restrict: Boolean(meta.restrict),
    participants,
    admins: participants.filter((member) => member.admin !== null).map((member) => member.phoneNumber ?? member.jid),
    iAmAdmin,
    inviteLink,
    ...(detail ? { detail } : {}),
  };
}

/**
 * Is this account still in the group? Used before deleting a group chat with
 * `leave_first`, where the bridge's own "left" flag cannot be trusted to be
 * complete — a group left from the phone never told the bridge. WhatsApp
 * answers a metadata query from a non-member with 403/404 (or a 401
 * not-authorized); anything else is a real failure and is rethrown.
 */
export async function isMember(sock: Pick<GroupInfoSocket, "groupMetadata">, groupJid: string, me: Me): Promise<boolean> {
  try {
    const meta = await sock.groupMetadata(groupJid);
    return meta.participants.some((member) => isMe(member, me));
  } catch (err) {
    const code = (err as { output?: { statusCode?: number } })?.output?.statusCode;
    if (code === 401 || code === 403 || code === 404) return false;
    throw err;
  }
}
