// whatsapp_get_profile against a fake socket. What matters is that each field
// stands alone: a privacy refusal or a failure in one must not cost the others,
// and must be reported rather than quietly left out.

import { describe, expect, it } from "vitest";
import { fetchProfileOnSocket, prepareProfileTarget, type ProfileSocket } from "../src/profile";

const ADA = "447700900111@s.whatsapp.net";
const ADA_LID = "199900000000001@lid";

function boom(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { output: { statusCode } });
}

function fakeSocket(overrides: Partial<ProfileSocket> = {}) {
  const calls: string[] = [];
  const sock: ProfileSocket = {
    async onWhatsApp(...numbers) {
      calls.push(`onWhatsApp:${numbers.join(",")}`);
      return [{ jid: ADA, exists: true }];
    },
    async fetchStatus(...jids) {
      calls.push(`fetchStatus:${jids.join(",")}`);
      return [{ id: jids[0]!, status: { status: "Lettings negotiator", setAt: new Date("2026-05-01T09:00:00.000Z") } }];
    },
    async profilePictureUrl(jid, type) {
      calls.push(`picture:${type}`);
      return `https://pps.whatsapp.net/${type}.jpg`;
    },
    async getBusinessProfile(jid) {
      calls.push(`business:${jid}`);
      return {
        wid: jid,
        description: "Sales and lettings across Reading",
        category: "Estate agent",
        website: ["https://agency.example"],
        email: "hello@agency.example",
        address: "1 High Street",
        business_hours: {
          timezone: "Europe/London",
          business_config: [{ day_of_week: "mon", mode: "specific_hours", open_time: "540", close_time: "1050" }],
        },
      };
    },
    signalRepository: {
      lidMapping: {
        getLIDForPN: async () => ADA_LID,
        getPNForLID: async () => ADA,
      },
    },
    ...overrides,
  };
  return { sock, calls };
}

describe("prepareProfileTarget", () => {
  it("accepts international digits, a user JID and a participant LID", () => {
    expect(prepareProfileTarget("+44 7700 900111")).toMatchObject({ jid: ADA, kind: "pn" });
    expect(prepareProfileTarget("447700900111:4@s.whatsapp.net")).toMatchObject({ jid: ADA, kind: "pn" });
    expect(prepareProfileTarget(ADA_LID)).toMatchObject({ jid: ADA_LID, kind: "lid" });
  });

  it("refuses a national-format number, as group creation does", () => {
    expect(() => prepareProfileTarget("07700 900111")).toThrow(/national-format 0/);
    expect(() => prepareProfileTarget("+44 (0)7700 900111")).toThrow(/national-format 0/);
  });

  it("refuses a group, pointing at the tool that reads one", () => {
    expect(() => prepareProfileTarget("120363000000000001@g.us")).toThrow(/whatsapp_group_info/);
  });
});

describe("fetchProfileOnSocket", () => {
  it("returns everything WhatsApp gave, with the business profile that motivated the tool", async () => {
    const { sock } = fakeSocket();
    const profile = await fetchProfileOnSocket(sock, prepareProfileTarget("447700900111"), (jid) =>
      jid === ADA ? "Ada L" : null,
    );
    expect(profile).toEqual({
      ok: true,
      requested: "447700900111",
      jid: ADA,
      phoneNumber: ADA,
      lid: ADA_LID,
      exists: true,
      name: "Ada L",
      about: { text: "Lettings negotiator", setAt: "2026-05-01T09:00:00.000Z" },
      picture: { preview: "https://pps.whatsapp.net/preview.jpg", full: "https://pps.whatsapp.net/image.jpg" },
      isBusiness: true,
      business: {
        description: "Sales and lettings across Reading",
        category: "Estate agent",
        website: ["https://agency.example"],
        email: "hello@agency.example",
        address: "1 High Street",
        hours: { timezone: "Europe/London", days: [{ day: "mon", mode: "specific_hours", openMinute: 540, closeMinute: 1050 }] },
      },
    });
  });

  it("stops at 'not on WhatsApp' without asking for anything else", async () => {
    const { sock, calls } = fakeSocket({ onWhatsApp: async () => [] });
    const profile = await fetchProfileOnSocket(sock, prepareProfileTarget("447700900999"), () => null);
    expect(profile).toMatchObject({ ok: true, exists: false });
    expect(calls).toEqual([]);
  });

  it("looks a LID up directly: no existence check, and the number from the session's mapping", async () => {
    const { sock, calls } = fakeSocket();
    const profile = await fetchProfileOnSocket(sock, prepareProfileTarget(ADA_LID), (jid) => (jid === ADA ? "Ada L" : null));
    expect(calls.some((call) => call.startsWith("onWhatsApp"))).toBe(false);
    expect(calls).toContain(`business:${ADA_LID}`);
    expect(profile).toMatchObject({ jid: ADA_LID, lid: ADA_LID, phoneNumber: ADA, exists: null, name: "Ada L" });
  });

  it("treats a private picture and an empty About as withheld, not as errors", async () => {
    const { sock, calls } = fakeSocket({
      fetchStatus: async () => [{ id: ADA, status: { status: "", setAt: new Date(0) } }],
      profilePictureUrl: async (_jid, type) => {
        calls.push(`picture:${type}`);
        throw boom("not-authorized", 401);
      },
      getBusinessProfile: async () => undefined,
    });
    const profile = await fetchProfileOnSocket(sock, prepareProfileTarget(ADA), () => null);
    expect(profile.about).toBeNull();
    expect(profile.picture).toEqual({ preview: null, full: null, hidden: true });
    expect(profile.isBusiness).toBe(false);
    expect(profile.errors).toBeUndefined();
    // One refusal is enough; the full-size picture is not asked for.
    expect(calls.filter((call) => call.startsWith("picture"))).toEqual(["picture:preview"]);
  });

  it("does not call a personal account a business because WhatsApp sent an empty profile node", async () => {
    const { sock } = fakeSocket({ getBusinessProfile: async () => ({ wid: ADA, description: "", website: [] }) });
    const profile = await fetchProfileOnSocket(sock, prepareProfileTarget(ADA), () => null);
    expect(profile).toMatchObject({ isBusiness: false, business: null });
  });

  it("keeps what worked when other fields fail, and names the failures", async () => {
    const { sock } = fakeSocket({
      onWhatsApp: async () => {
        throw new Error("timed out");
      },
      fetchStatus: async () => {
        throw boom("rate-overlimit", 429);
      },
    });
    const profile = await fetchProfileOnSocket(sock, prepareProfileTarget(ADA), () => null);
    expect(profile.ok).toBe(true);
    expect(profile.exists).toBeNull();
    expect(profile.errors).toEqual({ exists: "timed out", about: "rate-overlimit (429)" });
    expect(profile.business?.website).toEqual(["https://agency.example"]);
    expect(profile.picture?.preview).toBe("https://pps.whatsapp.net/preview.jpg");
  });
});
