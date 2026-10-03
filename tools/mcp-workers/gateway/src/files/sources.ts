// Sources: where a file ref's bytes come from. Each one answers stat() from
// metadata alone wherever its API allows, so caps are enforced before a byte
// moves, and open() streams wherever its API allows:
//
//   drive  streamed (alt=media). Google-native files have no bytes, so they
//          are exported — Docs/Slides/Drawings to PDF, Sheets to xlsx, the
//          same mapping as gmail_attach_drive_file — and an export's size is
//          only known by doing it, so stat() runs the export and keeps it.
//          The export is read against the sink's cap (SourceOptions.cap) and
//          refused the moment it passes it, so the buffer never outgrows the
//          cap; Drive's own 10 MB export limit bounds it otherwise.
//   gmail  buffered: an attachment is one base64url field in a JSON body.
//          Its size is read from the message first and capped up front.
//   wa     streamed through the bridge's openMedia; a bridge deployed before
//          openMedia existed is detected by the RPC's own refusal and falls
//          back to downloadMedia and its inline caps.

import type { FreeAgentClient } from "../freeagentapi";
import { attachExportFor, DRIVE, exportedFilename } from "../drive";
import { GMAIL, parsePayload, type GmailPart } from "../gmail";
import { GoogleApiError, type GoogleClient } from "../googleapi";
import { base64UrlToBytes } from "../mime";
import type { WhatsAppBridgeApi } from "@toolbox/mcp-shared";
import { formatRef } from "./refs";
import type { TransitCache } from "./transit";
import { enforceCap, FileError, readAll, type FileCap, type FileMeta, type OpenedFile, type Source, type SourceRef } from "./types";

/** Everything sources and sinks resolve through; built per tool call from the gateway context. */
export interface FileContext {
  drive(account?: string): Promise<GoogleClient>;
  gmail(account?: string): Promise<GoogleClient>;
  whatsapp(): Promise<WhatsAppBridgeApi>;
  freeagent(): Promise<FreeAgentClient>;
  /** Where the `_Transit` folder id is cached (the user's vault). */
  vault: TransitCache;
}

/**
 * A FileContext for a tool that was handed only some resolvers (the
 * deprecated pair tools): anything else fails with a plain message rather
 * than reaching a service the tool was never meant to touch.
 */
export function partialFileContext(parts: Partial<FileContext>): FileContext {
  const missing = (what: string) => () => Promise.reject(new FileError(501, `${what} is not available to this tool; use file_transfer`));
  return {
    drive: parts.drive ?? missing("Drive"),
    gmail: parts.gmail ?? missing("Gmail"),
    whatsapp: parts.whatsapp ?? missing("WhatsApp"),
    freeagent: parts.freeagent ?? missing("FreeAgent"),
    vault: parts.vault ?? {
      getSetting: missing("the _Transit folder"),
      setSetting: missing("the _Transit folder"),
    },
  };
}

/** Per-source extras; ignored by sources they do not apply to. */
export interface SourceOptions {
  /** Drive: export format for a Google-native file, instead of the PDF/xlsx default. */
  exportMimeType?: string;
  /**
   * The sink's cap, for a source that has to buffer bytes just to learn their
   * size (a Drive export): it stops reading past this rather than finishing
   * the download only for transfer() to refuse it.
   */
  cap?: FileCap;
}

/**
 * A bridge call that threw: only its message survives the RPC hop. A
 * FileError is already a finished answer and passes through as-is.
 */
export function bridgeFailure(err: unknown): unknown {
  if (err instanceof FileError || !(err instanceof Error)) return err;
  return new FileError(502, `the WhatsApp bridge failed: ${err.message}`);
}

/** One chunk, one stream: for bytes a source already had to hold. */
export function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

function accountHint(account: string | undefined, service: string): string {
  return account ? `the "${account}" ${service} account` : `the default ${service} account`;
}

// ---- drive ----------------------------------------------------------------

/** Drive's own view of a file, before any export: what a server-side copy or move needs. */
export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  /** Absent for Google-native files, which have no stored bytes. */
  size?: number;
  md5?: string;
  parents: string[];
}

export const DRIVE_META_FIELDS = "id,name,mimeType,size,md5Checksum,parents";

/**
 * One Drive file's metadata. A 404 or 403 is rewritten to name the account
 * that was asked and how to pick another — the likeliest mistake on a gateway
 * with several Drive accounts linked (see fetchDriveAttachment).
 */
export async function getDriveFileMeta(client: GoogleClient, fileId: string, account?: string): Promise<DriveFileMeta> {
  let meta: { id?: string; name?: string; mimeType?: string; size?: string; md5Checksum?: string; parents?: string[] };
  try {
    meta = (await client.getJson(`${DRIVE}/files/${encodeURIComponent(fileId)}`, {
      fields: DRIVE_META_FIELDS,
      supportsAllDrives: true,
    })) as typeof meta;
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 404) {
      throw new FileError(
        404,
        `Drive file "${fileId}" was not found in ${accountHint(account, "Drive")}. It may belong to another ` +
          "linked account — add ?account=<label> to the ref, or drive_account on the older relay tools (see gateway_list_accounts).",
      );
    }
    if (err instanceof GoogleApiError && err.status === 403) {
      throw new FileError(
        403,
        `Drive file "${fileId}" exists but ${accountHint(account, "Drive")} may not read it. Share it with that ` +
          "account, or add ?account=<label> for one that can.",
      );
    }
    throw err;
  }
  return {
    id: meta.id ?? fileId,
    name: meta.name ?? fileId,
    mimeType: meta.mimeType ?? "application/octet-stream",
    ...(meta.size !== undefined && { size: Number(meta.size) }),
    ...(meta.md5Checksum !== undefined && { md5: meta.md5Checksum }),
    parents: meta.parents ?? [],
  };
}

class DriveSource implements Source {
  readonly driveFileId: string;
  readonly driveAccount?: string;
  private client?: Promise<GoogleClient>;
  private meta?: Promise<FileMeta>;
  /** A native file's export, held between stat() and open(). */
  private exported?: Uint8Array;

  constructor(
    readonly ref: Extract<SourceRef, { kind: "drive" }>,
    private ctx: FileContext,
    private opts: SourceOptions = {},
  ) {
    this.driveFileId = ref.fileId;
    this.driveAccount = ref.account;
  }

  private drive(): Promise<GoogleClient> {
    return (this.client ??= this.ctx.drive(this.ref.account));
  }

  stat(): Promise<FileMeta> {
    return (this.meta ??= this.loadMeta());
  }

  private async loadMeta(): Promise<FileMeta> {
    const drive = await this.drive();
    const raw = await getDriveFileMeta(drive, this.ref.fileId, this.ref.account);
    // A caller's export format wins over the default mapping, but only ever
    // applies to a Google-native file: real bytes are never converted.
    const googleNative = raw.mimeType.startsWith("application/vnd.google-apps.");
    const chosen = googleNative ? (this.opts.exportMimeType ?? attachExportFor(raw.mimeType)?.mimeType) : undefined;
    if (chosen) {
      const name = exportedFilename(raw.name, chosen);
      const stream = await drive.getStream(`${DRIVE}/files/${encodeURIComponent(raw.id)}/export`, { mimeType: chosen });
      this.exported = await readAll(stream, this.opts.cap ?? "driveExport", `the export of "${name}"`);
      return { name, mimeType: chosen, size: this.exported.byteLength, exportedFrom: raw.mimeType };
    }
    if (googleNative) {
      // Folders, forms, shortcuts, sites: nothing to download or export.
      throw new FileError(415, `"${raw.name}" is a ${raw.mimeType.slice("application/vnd.google-apps.".length)}, which has no file content to transfer`);
    }
    return { name: raw.name, mimeType: raw.mimeType, size: raw.size ?? 0, ...(raw.md5 && { md5: raw.md5 }) };
  }

  async open(): Promise<OpenedFile> {
    const meta = await this.stat();
    if (this.exported) {
      const bytes = this.exported;
      this.exported = undefined;
      return { meta, body: bytesStream(bytes) };
    }
    const body = await (await this.drive()).getStream(`${DRIVE}/files/${encodeURIComponent(this.ref.fileId)}`, {
      alt: "media",
      supportsAllDrives: true,
    });
    return { meta, body };
  }
}

// ---- gmail ----------------------------------------------------------------

class GmailSource implements Source {
  private client?: Promise<GoogleClient>;
  private meta?: Promise<FileMeta>;
  /** The id to download by: the message's current one when it matched, else the ref's own. */
  private attachmentId: string;
  /** Data already downloaded by stat() for an id the message no longer lists (see loadMeta). */
  private prefetched?: string;

  constructor(
    readonly ref: Extract<SourceRef, { kind: "gmail" }>,
    private ctx: FileContext,
  ) {
    this.attachmentId = ref.attachmentId;
  }

  private gmail(): Promise<GoogleClient> {
    return (this.client ??= this.ctx.gmail(this.ref.account));
  }

  stat(): Promise<FileMeta> {
    return (this.meta ??= this.loadMeta());
  }

  private async loadMeta(): Promise<FileMeta> {
    let message: { payload?: GmailPart };
    try {
      message = (await (await this.gmail()).getJson(`${GMAIL}/messages/${encodeURIComponent(this.ref.messageId)}`, {
        format: "full",
      })) as typeof message;
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 404) {
        throw new FileError(
          404,
          `Gmail message "${this.ref.messageId}" was not found in ${accountHint(this.ref.account, "Gmail")}; ` +
            "add ?account=<label> if it is in another mailbox.",
        );
      }
      throw err;
    }
    const attachments = parsePayload(message.payload).attachments;
    // Gmail can re-issue attachment ids between reads of the same message, so
    // an id from an earlier gmail_get_message may not match this one. A lone
    // attachment is unambiguous.
    const part =
      attachments.find((a) => a.attachmentId === this.ref.attachmentId) ??
      (attachments.length === 1 ? attachments[0] : undefined);
    if (part) {
      this.attachmentId = part.attachmentId;
      enforceCap(part.size, "gmailAttachmentRead", `"${part.filename}"`);
      return { name: part.filename, mimeType: part.mimeType || "application/octet-stream", size: part.size };
    }
    // Otherwise the old id usually still works — Gmail keeps serving it — so
    // ask for it directly. Its size comes back with it; the name and type are
    // the part of that size when exactly one matches, else generic. The cap
    // can only bite after this download, which the cap itself bounds.
    const att = await this.download(this.ref.attachmentId);
    const size = att.size ?? 0;
    const sameSize = attachments.filter((a) => a.size === size);
    const named = sameSize.length === 1 ? sameSize[0] : undefined;
    const name = named?.filename || `gmail-attachment-${this.ref.messageId}`;
    enforceCap(size, "gmailAttachmentRead", `"${name}"`);
    this.prefetched = att.data;
    return { name, mimeType: named?.mimeType || "application/octet-stream", size };
  }

  private async download(attachmentId: string): Promise<{ size?: number; data: string }> {
    let att: { size?: number; data?: string };
    try {
      att = (await (await this.gmail()).getJson(
        `${GMAIL}/messages/${encodeURIComponent(this.ref.messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      )) as typeof att;
    } catch (err) {
      if (err instanceof GoogleApiError && (err.status === 404 || err.status === 400)) {
        throw new FileError(
          404,
          `message "${this.ref.messageId}" has no attachment with that id; read the message again with ` +
            "gmail_get_message for current attachment ids",
        );
      }
      throw err;
    }
    if (!att.data) throw new FileError(404, "Gmail returned no attachment data");
    return { ...(att.size !== undefined && { size: att.size }), data: att.data };
  }

  async open(): Promise<OpenedFile> {
    const meta = await this.stat();
    let data = this.prefetched;
    this.prefetched = undefined;
    if (data === undefined) {
      const att = await this.download(this.attachmentId);
      // Checked again before decoding: the size stat() read may be stale.
      enforceCap(att.size ?? 0, "gmailAttachmentRead", `"${meta.name}"`);
      data = att.data;
    }
    // Only the base64 string and the decoded bytes are live together here;
    // base64UrlToBytes decodes in slices rather than in whole-string copies.
    const bytes = base64UrlToBytes(data);
    return { meta: { ...meta, size: bytes.byteLength }, body: bytesStream(bytes) };
  }
}

// ---- whatsapp -------------------------------------------------------------

/** workerd's refusal for an RPC method the callee does not define, as distinct from one that ran and failed. */
export function isMissingRpcMethod(err: unknown, method: string): boolean {
  if (!(err instanceof Error)) return false;
  return (
    /does not implement (the )?method/i.test(err.message) ||
    err.message.includes(`${method} is not a function`) ||
    /method not found/i.test(err.message)
  );
}

class WhatsAppSource implements Source {
  private opened?: Promise<OpenedFile>;

  constructor(
    readonly ref: Extract<SourceRef, { kind: "wa" }>,
    private ctx: FileContext,
  ) {}

  /**
   * The bridge reports size only alongside the stream, so stat() opens it and
   * keeps it for the open() that follows. A stat with no open must be
   * followed by dispose(), or the bridge's CDN download stays open.
   */
  async stat(): Promise<FileMeta> {
    return (await (this.opened ??= this.load())).meta;
  }

  async dispose(): Promise<void> {
    const pending = this.opened;
    this.opened = undefined;
    if (!pending) return;
    try {
      await (await pending).body.cancel();
    } catch {
      // A load that failed has nothing to release; a cancel that failed has nothing left to do.
    }
  }

  async open(): Promise<OpenedFile> {
    const pending = this.opened ?? this.load();
    this.opened = undefined;
    return pending;
  }

  private async load(): Promise<OpenedFile> {
    const bridge = await this.ctx.whatsapp();
    try {
      return await this.fetch(bridge);
    } catch (err) {
      throw bridgeFailure(err);
    }
  }

  private async fetch(bridge: WhatsAppBridgeApi): Promise<OpenedFile> {
    const { chatJid, messageId } = this.ref;
    // A Durable Object stub answers every property with a callable, so
    // `bridge.openMedia` is always truthy in production; only the call itself
    // shows whether the deployed bridge has the method. (A plain object, as in
    // tests, simply lacks it.)
    if (typeof bridge.openMedia === "function") {
      try {
        const media = await bridge.openMedia(messageId, chatJid);
        return {
          meta: { name: media.filename, mimeType: media.mimeType || "application/octet-stream", size: media.size },
          body: media.body,
        };
      } catch (err) {
        if (!isMissingRpcMethod(err, "openMedia")) throw err;
      }
    }
    // Older bridge: the inline path, with its 2 MB image / 32 KB other caps.
    const media = await bridge.downloadMedia(messageId, chatJid);
    if (!media.ok || !media.base64) {
      throw new FileError(400, media.detail ?? `the bridge returned no media for ${formatRef(this.ref)}`);
    }
    const bytes = base64UrlToBytes(media.base64);
    return {
      meta: {
        name: media.filename ?? `whatsapp-${messageId}`,
        mimeType: media.mimeType ?? "application/octet-stream",
        size: bytes.byteLength,
      },
      body: bytesStream(bytes),
    };
  }
}

export function makeSource(ref: SourceRef, ctx: FileContext, opts: SourceOptions = {}): Source {
  switch (ref.kind) {
    case "drive":
      return new DriveSource(ref, ctx, opts);
    case "gmail":
      return new GmailSource(ref, ctx);
    case "wa":
      return new WhatsAppSource(ref, ctx);
  }
}
