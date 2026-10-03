// transfer(): any source to any sink, in the cheapest way the pair allows.
//
//   1. Drive to a Drive folder in the same account: no bytes move. Out of
//      `_Transit` the file is moved (same id), anything else copied.
//   2. Otherwise stat, check the sink's cap against the size (and the sink's
//      own precheck), then open and hand the stream to the sink. A refusal on
//      size comes before the download, never after it — except where a size
//      only exists once the bytes do (a Drive export, a Gmail attachment id
//      the message no longer lists): there the sink's cap is passed down and
//      the read stops at it. Whatever stat() opened is released on refusal.
//
// Accounts are compared as given: a ref with no ?account= and one naming the
// default account by label count as different, and fall to the streamed path.
// That costs bandwidth, never correctness — a server-side copy across Drive
// accounts would fail on permissions anyway.

import { exportedFilename } from "../drive";
import { makeSink, type SinkOptions } from "./sinks";
import { getDriveFileMeta, makeSource, type FileContext, type SourceOptions } from "./sources";
import { findTransitFolder, isInTransit } from "./transit";
import { enforceCap, type SinkRef, type SinkResult, type SourceRef } from "./types";
import { formatRef } from "./refs";

export interface TransferOptions extends SinkOptions, SourceOptions {
  /**
   * Name at the destination; defaults to the source's. On an export, and on
   * every WhatsApp send, the type's extension is appended when missing,
   * because WhatsApp and mail clients pick the type from the name.
   */
  name?: string;
  /** Overrides the source's mime type (the deprecated Gmail relay took one). */
  mimeType?: string;
}

export interface TransferResult extends SinkResult {
  from: string;
  to: string;
  /** moved: same Drive file, new parent. copied: server-side Drive copy. streamed: bytes went through the Worker. */
  mode: "moved" | "copied" | "streamed";
  mimeType: string;
}

export async function transfer(
  from: SourceRef,
  to: SinkRef,
  ctx: FileContext,
  opts: TransferOptions = {},
): Promise<TransferResult> {
  const sink = makeSink(to, ctx, opts);
  const source = makeSource(from, ctx, { ...opts, ...(sink.cap && { cap: sink.cap }) });
  const labels = { from: formatRef(from), to: formatRef(to) };

  const sinkAccount = to.kind === "drive-folder" ? to.account : undefined;
  if (source.driveFileId && sink.fromDrive && to.kind === "drive-folder" && source.driveAccount === sinkAccount) {
    const drive = await ctx.drive(source.driveAccount);
    const raw = await getDriveFileMeta(drive, source.driveFileId, source.driveAccount);
    // `_Transit` is the default account's alone, so a labelled source is never in it.
    const transit = source.driveAccount === undefined ? await findTransitFolder(drive, ctx.vault) : null;
    const inTransit = isInTransit(raw.parents, transit);
    const meta = { name: opts.name ?? raw.name, mimeType: raw.mimeType, size: raw.size ?? 0, ...(raw.md5 && { md5: raw.md5 }) };
    const result = await sink.fromDrive(source.driveFileId, source.driveAccount, meta, inTransit);
    return { ...labels, ...result, mode: inTransit ? "moved" : "copied", mimeType: meta.mimeType };
  }

  const stat = await source.stat();
  try {
    if (sink.cap) enforceCap(stat.size, sink.cap, `"${stat.name}"`);
    await sink.precheck?.(stat);
  } catch (err) {
    // Refused before open(): a WhatsApp stat already holds the bridge's stream.
    await source.dispose?.().catch(() => {});
    throw err;
  }
  const opened = await source.open();
  const named = opts.name ?? opened.meta.name;
  const mimeType = opts.mimeType ?? opened.meta.mimeType;
  // The bridge derives the type the recipient sees from the extension.
  const withExtension = opened.meta.exportedFrom !== undefined || to.kind === "wa-send";
  const meta = {
    ...opened.meta,
    name: withExtension ? exportedFilename(named, mimeType) : named,
    mimeType,
  };
  try {
    const result = await sink.put(meta, opened.body);
    return { ...labels, ...result, mode: "streamed", mimeType: meta.mimeType };
  } catch (err) {
    // A sink that refused before reading leaves the body open; release it.
    await opened.body.cancel().catch(() => {});
    throw err;
  }
}
