import { describe, expect, it } from "vitest";
import {
  ensureTransitFolder,
  findTransitFolder,
  FOLDER_MIME,
  isInTransit,
  listExpired,
  listTransitFolders,
  transitCacheKey,
  trashExpired,
} from "../src/files/transit";
import { GoogleApiError } from "../src/googleapi";
import { fakeGoogle, fakeVault, type GCall } from "./files-fake";

const TRANSIT = "FAKEtransit01";
const folderMeta = { id: TRANSIT, name: "_Transit", mimeType: FOLDER_MIME, trashed: false };

describe("_Transit folder resolution", () => {
  it("finds the folder by name at the root and caches its id", async () => {
    const vault = fakeVault();
    const { client, calls } = fakeGoogle((c) => {
      if (c.op === "getJson" && c.url.endsWith("/files")) return { files: [{ id: TRANSIT }] };
      throw new Error(`unexpected ${c.op} ${c.url}`);
    });
    expect(await ensureTransitFolder(client as never, vault)).toBe(TRANSIT);
    const q = String(calls[0]!.query!.q);
    expect(q).toContain("name = '_Transit'");
    expect(q).toContain(`mimeType = '${FOLDER_MIME}'`);
    expect(q).toContain("'root' in parents");
    expect(q).toContain("trashed = false");
    expect(vault.getSetting(transitCacheKey())).toBe(TRANSIT);
  });

  it("trusts a cached id after one metadata check, without listing", async () => {
    const vault = fakeVault();
    vault.setSetting(transitCacheKey(), TRANSIT);
    const { client, calls } = fakeGoogle((c) => {
      if (c.url.endsWith(`/files/${TRANSIT}`)) return folderMeta;
      throw new Error(`unexpected ${c.op} ${c.url}`);
    });
    expect(await ensureTransitFolder(client as never, vault)).toBe(TRANSIT);
    expect(calls).toHaveLength(1);
  });

  it("re-finds when the cached folder was trashed", async () => {
    const vault = fakeVault();
    vault.setSetting(transitCacheKey(), "FAKEstale01");
    const { client } = fakeGoogle((c) => {
      if (c.url.endsWith("/files/FAKEstale01")) return { ...folderMeta, id: "FAKEstale01", trashed: true };
      if (c.url.endsWith("/files")) return { files: [{ id: TRANSIT }] };
      throw new Error(`unexpected ${c.op} ${c.url}`);
    });
    expect(await ensureTransitFolder(client as never, vault)).toBe(TRANSIT);
    expect(vault.getSetting(transitCacheKey())).toBe(TRANSIT);
  });

  it("re-finds when the cached id 404s (another default account)", async () => {
    const vault = fakeVault();
    vault.setSetting(transitCacheKey(), "FAKEother01");
    const { client } = fakeGoogle((c) => {
      if (c.url.endsWith("/files/FAKEother01")) throw new GoogleApiError(404, "File not found");
      if (c.url.endsWith("/files")) return { files: [] };
      throw new Error(`unexpected ${c.op} ${c.url}`);
    });
    expect(await findTransitFolder(client as never, vault)).toBeNull();
    expect(vault.getSetting(transitCacheKey())).toBeNull();
  });

  it("creates the folder at the root when none exists, and caches it", async () => {
    const vault = fakeVault();
    const { client, calls } = fakeGoogle((c) => {
      if (c.op === "getJson") return { files: [] };
      if (c.op === "sendJson") return { id: "FAKEnew01" };
      throw new Error(`unexpected ${c.op}`);
    });
    expect(await ensureTransitFolder(client as never, vault)).toBe("FAKEnew01");
    const create = calls.find((c) => c.op === "sendJson")!;
    expect(create.method).toBe("POST");
    expect(create.body).toEqual({ name: "_Transit", mimeType: FOLDER_MIME, parents: ["root"] });
    expect(vault.getSetting(transitCacheKey())).toBe("FAKEnew01");
  });

  it("loses a find-or-create race gracefully: adopts the older folder and trashes its own", async () => {
    const vault = fakeVault();
    let created = false;
    const { client, calls } = fakeGoogle((c) => {
      // Empty before our create; afterwards a concurrent caller's older folder shows up first.
      if (c.op === "getJson") return { files: created ? [{ id: "FAKEolder01" }, { id: "FAKEnew01" }] : [] };
      if (c.op === "sendJson" && c.method === "POST") {
        created = true;
        return { id: "FAKEnew01" };
      }
      if (c.op === "sendJson" && c.method === "PATCH") return { id: "FAKEnew01" };
      throw new Error(`unexpected ${c.op}`);
    });
    expect(await ensureTransitFolder(client as never, vault)).toBe("FAKEolder01");
    expect(vault.getSetting(transitCacheKey())).toBe("FAKEolder01");
    const trash = calls.find((c) => c.method === "PATCH")!;
    expect(trash.url).toMatch(/\/files\/FAKEnew01$/);
    expect(trash.body).toEqual({ trashed: true });
  });

  it("listTransitFolders returns every root-level _Transit, oldest first", async () => {
    const { client } = fakeGoogle(() => ({ files: [{ id: "FAKEa" }, {}, { id: "FAKEb" }] }));
    expect(await listTransitFolders(client as never)).toEqual(["FAKEa", "FAKEb"]);
  });

  it("findTransitFolder never creates", async () => {
    const { client, calls } = fakeGoogle(() => ({ files: [] }));
    expect(await findTransitFolder(client as never, fakeVault())).toBeNull();
    expect(calls.every((c) => c.op === "getJson")).toBe(true);
  });

  it("isInTransit reads the parents list", () => {
    expect(isInTransit([TRANSIT], TRANSIT)).toBe(true);
    expect(isInTransit(["FAKEfolder01"], TRANSIT)).toBe(false);
    expect(isInTransit(undefined, TRANSIT)).toBe(false);
    expect(isInTransit([TRANSIT], null)).toBe(false);
  });
});

describe("_Transit expiry", () => {
  const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);

  it("lists untrashed files older than the cutoff across pages", async () => {
    const { client, calls } = fakeGoogle((c) =>
      c.query!.pageToken
        ? { files: [{ id: "FAKEold02", name: "b.pdf", createdTime: "2026-09-02T00:00:00Z" }] }
        : { nextPageToken: "FAKEpage2", files: [{ id: "FAKEold01", name: "a.pdf", createdTime: "2026-09-01T00:00:00Z" }] },
    );
    const files = await listExpired(client as never, TRANSIT, NOW);
    expect(files.map((f) => f.id)).toEqual(["FAKEold01", "FAKEold02"]);
    expect(calls).toHaveLength(2);
    const q = String(calls[0]!.query!.q);
    expect(q).toBe(`'${TRANSIT}' in parents and trashed = false and createdTime < '2026-10-03T12:00:00.000Z'`);
    expect(calls[1]!.query!.pageToken).toBe("FAKEpage2");
  });

  it("trashes (never deletes) files older than 7 days and reports failures", async () => {
    const writes: GCall[] = [];
    const { client, calls } = fakeGoogle((c) => {
      if (c.op === "getJson") {
        return {
          files: [
            { id: "FAKEold01", name: "a.pdf", createdTime: "2026-09-01T00:00:00Z" },
            { id: "FAKEold02", name: "b.pdf", createdTime: "2026-09-02T00:00:00Z" },
          ],
        };
      }
      writes.push(c);
      if (c.url.endsWith("FAKEold02")) throw new GoogleApiError(403, "Google API error (status 403): nope");
      return { id: "FAKEold01" };
    });
    const report = await trashExpired(client as never, TRANSIT, NOW);
    expect(String(calls[0]!.query!.q)).toContain("createdTime < '2026-09-26T12:00:00.000Z'");
    expect(writes.every((w) => w.op === "sendJson" && w.method === "PATCH")).toBe(true);
    expect(writes.map((w) => w.body)).toEqual([{ trashed: true }, { trashed: true }]);
    expect(report.trashed.map((f) => f.id)).toEqual(["FAKEold01"]);
    expect(report.failed).toEqual([{ id: "FAKEold02", name: "b.pdf", error: "Google API error (status 403): nope" }]);
  });

  it("honours a custom max age", async () => {
    const { client, calls } = fakeGoogle(() => ({ files: [] }));
    await trashExpired(client as never, TRANSIT, NOW, 1);
    expect(String(calls[0]!.query!.q)).toContain("createdTime < '2026-10-02T12:00:00.000Z'");
  });
});

describe("vault settings", () => {
  it("round-trips and clears with an empty value", () => {
    const vault = fakeVault();
    expect(vault.getSetting("k")).toBeNull();
    vault.setSetting("k", "v1");
    vault.setSetting("k", "v2");
    expect(vault.getSetting("k")).toBe("v2");
    vault.setSetting("k", "");
    expect(vault.getSetting("k")).toBeNull();
  });
});
