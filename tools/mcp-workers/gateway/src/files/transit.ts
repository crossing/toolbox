// The `_Transit` staging folder: a plain Drive folder at the root of the Drive
// account, where signed uploads land and where non-Drive files are parked when
// a sandbox asks to download them. Two rules give it its meaning:
//
//   - A file sent out of `_Transit` into another Drive folder is *moved*
//     (parents swapped, same file id), not copied. Ingested means moved.
//   - Anything left behind is trashed after 7 days by the gateway's cron.
//     Trashed, never deleted: Drive keeps it recoverable for 30 more days.
//
// There is one `_Transit`, at the root of the user's *default* Drive account
// (refs.ts refuses `drive:folder/_Transit?account=`): that is the folder the
// sweep cleans. It is found by name once and its id cached in the user's
// vault. The cache is checked on use (one metadata read), so a folder that
// was trashed or renamed by hand is simply found or created again.
//
// Find-or-create has no lock, so two first uses at once can each create one.
// ensureTransitFolder re-lists after creating and adopts the oldest, trashing
// its own if it lost; and the sweep cleans every root-level `_Transit`, so a
// duplicate that slipped past both still never keeps files beyond 7 days.

import type { GoogleClient } from "../googleapi";
import { GoogleApiError } from "../googleapi";
import { DRIVE } from "../drive";
import { TRANSIT_FOLDER } from "./types";

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const TRANSIT_MAX_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where the folder id is cached: the UserVault stub (whose RPC methods come
 * back as promises) or a VaultStore directly (in tests).
 */
export interface TransitCache {
  getSetting(key: string): Promise<string | null> | string | null;
  setSetting(key: string, value: string): Promise<void> | void;
}

/**
 * The vault setting holding the folder id. The account slot is always "" —
 * whichever account is the default — and stays in the key so ids cached
 * under it keep working.
 */
export function transitCacheKey(): string {
  return "files.transit:";
}

interface DriveFolder {
  id?: string;
  name?: string;
  mimeType?: string;
  trashed?: boolean;
  parents?: string[];
}

async function stillValid(drive: GoogleClient, id: string): Promise<boolean> {
  try {
    const meta = (await drive.getJson(`${DRIVE}/files/${encodeURIComponent(id)}`, {
      fields: "id,name,mimeType,trashed",
      supportsAllDrives: true,
    })) as DriveFolder;
    return meta.trashed !== true && meta.mimeType === FOLDER_MIME && meta.name === TRANSIT_FOLDER;
  } catch (err) {
    // 404: gone, or the default account changed to one that cannot see it.
    if (err instanceof GoogleApiError && (err.status === 404 || err.status === 403)) return false;
    throw err;
  }
}

/** Every untrashed `_Transit` folder at the Drive root, oldest first; normally one. */
export async function listTransitFolders(drive: GoogleClient): Promise<string[]> {
  const listed = (await drive.getJson(`${DRIVE}/files`, {
    q: `name = '${TRANSIT_FOLDER}' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`,
    fields: "files(id,createdTime)",
    orderBy: "createdTime",
    pageSize: 10,
  })) as { files?: { id?: string }[] };
  return (listed.files ?? []).flatMap((f) => (typeof f.id === "string" ? [f.id] : []));
}

async function findByName(drive: GoogleClient): Promise<string | null> {
  // Oldest wins if a race ever made two: the one earlier transfers used.
  return (await listTransitFolders(drive))[0] ?? null;
}

/**
 * The `_Transit` folder's id, or null when it does not exist. Never creates
 * it: the expiry cron and the move-vs-copy check only need to know where it is.
 */
export async function findTransitFolder(drive: GoogleClient, cache: TransitCache): Promise<string | null> {
  const key = transitCacheKey();
  const cached = await cache.getSetting(key);
  if (cached && (await stillValid(drive, cached))) return cached;
  const found = await findByName(drive);
  if (found !== cached) await cache.setSetting(key, found ?? "");
  return found;
}

/**
 * The `_Transit` folder's id, creating the folder at the Drive root on first
 * use. Nothing is cached or handed out until the post-create re-list has
 * settled which folder is the one, so a race's loser is never used.
 */
export async function ensureTransitFolder(drive: GoogleClient, cache: TransitCache): Promise<string> {
  const existing = await findTransitFolder(drive, cache);
  if (existing) return existing;
  const created = (await drive.sendJson(
    "POST",
    `${DRIVE}/files`,
    { name: TRANSIT_FOLDER, mimeType: FOLDER_MIME, parents: ["root"] },
    { fields: "id" },
  )) as DriveFolder;
  if (!created.id) throw new GoogleApiError(502, "Drive created the _Transit folder but returned no id");
  const oldest = (await findByName(drive)) ?? created.id;
  if (oldest !== created.id) {
    // Another first use got there earlier. Ours is still empty: trash it
    // (best effort — the sweep cleans every root `_Transit` regardless).
    await drive
      .sendJson("PATCH", `${DRIVE}/files/${encodeURIComponent(created.id)}`, { trashed: true }, { fields: "id" })
      .catch(() => {});
  }
  await cache.setSetting(transitCacheKey(), oldest);
  return oldest;
}

/** True when a file whose parents are `parents` sits directly in `_Transit`. */
export function isInTransit(parents: readonly string[] | undefined, transitId: string | null | undefined): boolean {
  return !!transitId && (parents ?? []).includes(transitId);
}

export interface TransitFile {
  id: string;
  name: string;
  createdTime: string;
}

/** Untrashed files in `_Transit` created before `olderThan` (epoch ms), every page. */
export async function listExpired(drive: GoogleClient, transitId: string, olderThan: number): Promise<TransitFile[]> {
  const cutoff = new Date(olderThan).toISOString();
  const out: TransitFile[] = [];
  let pageToken: string | undefined;
  do {
    const page = (await drive.getJson(`${DRIVE}/files`, {
      q: `'${transitId}' in parents and trashed = false and createdTime < '${cutoff}'`,
      fields: "nextPageToken,files(id,name,createdTime)",
      orderBy: "createdTime",
      pageSize: 100,
      pageToken,
    })) as { nextPageToken?: string; files?: Partial<TransitFile>[] };
    for (const f of page.files ?? []) {
      if (f.id) out.push({ id: f.id, name: f.name ?? "", createdTime: f.createdTime ?? "" });
    }
    pageToken = page.nextPageToken || undefined;
  } while (pageToken);
  return out;
}

export interface TrashReport {
  trashed: TransitFile[];
  /** Files that could not be trashed, with Drive's reason; the next run retries them. */
  failed: { id: string; name: string; error: string }[];
}

/**
 * Trash (never delete) every `_Transit` file older than `maxAgeDays`. One
 * failure does not stop the sweep; it is reported and retried next run.
 */
export async function trashExpired(
  drive: GoogleClient,
  transitId: string,
  now: number = Date.now(),
  maxAgeDays: number = TRANSIT_MAX_AGE_DAYS,
): Promise<TrashReport> {
  const report: TrashReport = { trashed: [], failed: [] };
  for (const file of await listExpired(drive, transitId, now - maxAgeDays * DAY_MS)) {
    try {
      await drive.sendJson("PATCH", `${DRIVE}/files/${encodeURIComponent(file.id)}`, { trashed: true }, { fields: "id" });
      report.trashed.push(file);
    } catch (err) {
      report.failed.push({ id: file.id, name: file.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}
