// Looking someone up on WhatsApp: whether the number is registered, what they
// say about themselves, their picture, and — the case this exists for — their
// business profile, where an estate agent's website shows up under a name that
// gave nothing away.
//
// Live and unstored, on purpose. A profile is somebody else's data that changes
// under them; this version fetches what WhatsApp will show right now and hands
// it to the caller, and writes none of it down. (Baileys may note a LID ↔ number
// mapping in its own key store while resolving one. That is session plumbing,
// not a profile.)
//
// Every field is fetched separately and fails soft. WhatsApp answers each
// according to the other person's privacy settings — a hidden picture is a 401,
// a hidden About is an empty status — so one refusal must not cost the rest.
// What could not be fetched is named in `errors`, never silently left out.

import { jidDecode, jidNormalizedUser } from "baileys";
import type { ProfileResult } from "@toolbox/mcp-shared";
import { toJid } from "./normalize";
import { stanzaErrorCode } from "./groups";

/** Picture lookups have no server-side deadline; one that never answers must not hold the socket. */
const PICTURE_TIMEOUT_MS = 10_000;

interface BusinessProfileLike {
  wid?: string;
  address?: string;
  description?: string;
  website?: string[];
  email?: string;
  category?: string;
  business_hours?: { timezone?: string; business_config?: Record<string, string>[] };
}

/** The slice of a Baileys socket a profile lookup needs; faked in the tests. */
export interface ProfileSocket {
  onWhatsApp(...phoneNumbers: string[]): Promise<{ jid: string; exists: boolean }[] | undefined>;
  fetchStatus(...jids: string[]): Promise<{ id: string; status?: unknown }[] | undefined>;
  profilePictureUrl(jid: string, type?: "preview" | "image", timeoutMs?: number): Promise<string | undefined>;
  getBusinessProfile(jid: string): Promise<BusinessProfileLike | void>;
  signalRepository?: {
    lidMapping?: {
      getLIDForPN(pn: string): Promise<string | null>;
      getPNForLID(lid: string): Promise<string | null>;
    };
  };
}

export interface ProfileTarget {
  requested: string;
  jid: string;
  kind: "pn" | "lid";
}

/**
 * A person, as a JID. Same refusal as group creation for a national-format
 * number: `07700 900111` would silently become a lookup of whoever owns
 * 07700900111 abroad, and a confident profile of a stranger is worse than none.
 * A `…@lid` is accepted as it is — a group member often arrives as nothing else.
 */
export function prepareProfileTarget(jidOrPhone: string): ProfileTarget {
  const trimmed = (jidOrPhone ?? "").trim();
  if (!trimmed) throw new Error("give a phone number in international format, or a user JID");
  if (!trimmed.includes("@") && (/^\+?\s*0/.test(trimmed) || trimmed.includes("(0)"))) {
    throw new Error(`"${jidOrPhone}" has a national-format 0 in it — give the number in international format, e.g. 447700900111`);
  }
  const jid = jidNormalizedUser(toJid(trimmed));
  const server = jidDecode(jid)?.server;
  if (server === "s.whatsapp.net") return { requested: jidOrPhone, jid, kind: "pn" };
  if (server === "lid") return { requested: jidOrPhone, jid, kind: "lid" };
  throw new Error(`"${jidOrPhone}" is not a person — profiles exist for phone numbers and user JIDs; use whatsapp_group_info for a group`);
}

function reason(err: unknown): string {
  const code = stanzaErrorCode(err);
  const message = err instanceof Error ? err.message : String(err);
  return code ? `${message} (${code})` : message;
}

/** WhatsApp's way of saying "there is one, and you may not see it". */
function isPrivacyRefusal(err: unknown): boolean {
  const code = stanzaErrorCode(err);
  return code === 401 || code === 403;
}

function isNotFound(err: unknown): boolean {
  const code = stanzaErrorCode(err);
  const message = err instanceof Error ? err.message : "";
  return code === 404 || /item-not-found/.test(message);
}

/**
 * @param knownName what the store already calls this person — a chat name or
 *   their latest pushName — looked up by the caller, which owns the store.
 */
export async function fetchProfileOnSocket(
  sock: ProfileSocket,
  target: ProfileTarget,
  knownName: (jid: string) => string | null,
): Promise<ProfileResult> {
  const errors: Record<string, string> = {};
  const mapping = sock.signalRepository?.lidMapping;

  let phoneJid: string | null = target.kind === "pn" ? target.jid : null;
  let lid: string | null = target.kind === "lid" ? target.jid : null;
  let exists: boolean | null = null;

  if (target.kind === "pn") {
    try {
      const found = await sock.onWhatsApp(target.jid);
      const hit = found?.find((entry) => entry.exists);
      exists = Boolean(hit);
      if (hit?.jid) phoneJid = jidNormalizedUser(hit.jid);
    } catch (err) {
      errors.exists = reason(err);
    }
    if (exists === false) {
      return {
        ok: true,
        requested: target.requested,
        jid: target.jid,
        phoneNumber: target.jid,
        lid: null,
        exists: false,
        name: knownName(target.jid),
        detail: "WhatsApp says this number is not registered",
      };
    }
  }

  // The other name for the same person, when the session knows it. Never
  // fatal: every lookup below works on whichever JID the caller gave.
  try {
    if (target.kind === "pn" && mapping) {
      const found = await mapping.getLIDForPN(target.jid);
      lid = found ? jidNormalizedUser(found) : null;
    } else if (target.kind === "lid" && mapping) {
      const found = await mapping.getPNForLID(target.jid);
      phoneJid = found ? jidNormalizedUser(found) : null;
    }
  } catch (err) {
    errors.mapping = reason(err);
  }

  const jid = target.jid;

  let about: ProfileResult["about"] = null;
  try {
    const list = await sock.fetchStatus(jid);
    const status = list?.[0]?.status as { status?: string | null; setAt?: Date | string } | undefined;
    if (status && typeof status.status === "string" && status.status !== "") {
      const setAt = status.setAt ? new Date(status.setAt) : null;
      about = {
        text: status.status,
        setAt: setAt && setAt.getTime() > 0 ? setAt.toISOString() : null,
      };
    }
  } catch (err) {
    errors.about = reason(err);
  }

  const picture: NonNullable<ProfileResult["picture"]> = { preview: null, full: null };
  for (const [field, type] of [["preview", "preview"], ["full", "image"]] as const) {
    try {
      picture[field] = (await sock.profilePictureUrl(jid, type, PICTURE_TIMEOUT_MS)) ?? null;
    } catch (err) {
      if (isPrivacyRefusal(err)) {
        picture.hidden = true;
      } else if (!isNotFound(err)) {
        errors[`picture.${field}`] = reason(err);
      }
      // No picture, or none we may see: the larger size will answer the same.
      break;
    }
  }

  let business: ProfileResult["business"] = null;
  try {
    const profile = await sock.getBusinessProfile(jid);
    // A personal account can come back as a profile node with nothing in it.
    const filled =
      profile &&
      Boolean(
        profile.description || profile.category || profile.email || profile.address || profile.website?.length ||
          profile.business_hours?.business_config?.length,
      );
    if (profile && filled) {
      business = {
        description: profile.description || null,
        category: profile.category ?? null,
        website: profile.website ?? [],
        email: profile.email ?? null,
        address: profile.address ?? null,
        hours: profile.business_hours?.business_config?.length
          ? {
              timezone: profile.business_hours.timezone ?? null,
              days: profile.business_hours.business_config.map((day) => ({
                day: day.day_of_week ?? null,
                mode: day.mode ?? null,
                openMinute: day.open_time != null ? Number(day.open_time) : null,
                closeMinute: day.close_time != null ? Number(day.close_time) : null,
              })),
            }
          : null,
      };
    }
  } catch (err) {
    if (!isNotFound(err)) errors.business = reason(err);
  }

  return {
    ok: true,
    requested: target.requested,
    jid,
    phoneNumber: phoneJid,
    lid,
    exists,
    name: knownName(phoneJid ?? jid) ?? (lid ? knownName(lid) : null),
    about,
    picture,
    isBusiness: business !== null,
    business,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };
}
