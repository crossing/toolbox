// Sinks: where a transfer's bytes go. Only Drive takes a stream; the rest
// take the whole file in one request body (a MIME message, a bridge RPC, a
// base64 JSON field), so each declares the FILE_CAPS entry the transfer checks
// against stat() before any bytes are read.
//
//   drive:folder/<id>      resumable upload, streamed — or, when the source is
//                          already a Drive file in the same account, no bytes
//                          at all: out of `_Transit` it is moved (same file
//                          id), anything else is copied server-side.
//   gmail:draft/<id>       spliced into the stored draft, as gmail_attach_drive_file does.
//   wa:send/<recipient>    bridge.sendFile. Sending cannot be undone; the
//                          calling tool asks for confirm before it gets here.
//   freeagent:<target>/<id> PUT of { attachment: { data, file_name, content_type } },
//                          the shape the freeagent CLI's `attach` commands send.

import { DRIVE, FILE_FIELDS } from "../drive";
import { draftAttachRoom, loadDraftForAttach, saveDraftWithAttachment, type DraftForAttach } from "../gmail";
import { FREEAGENT_BASE_URL } from "../freeagentapi";
import { bytesToBase64 } from "../mime";
import { formatRef } from "./refs";
import { bridgeFailure, bytesStream, type FileContext } from "./sources";
import { ensureTransitFolder, findTransitFolder } from "./transit";
import {
  FileError,
  readAll,
  TRANSIT_FOLDER,
  type FileCap,
  type FileMeta,
  type FreeAgentTarget,
  type Sink,
  type SinkBody,
  type SinkRef,
  type SinkResult,
} from "./types";

/** Per-transfer extras some sinks use; ignored by the rest. */
export interface SinkOptions {
  /** WhatsApp: caption for an image or video. */
  caption?: string;
  /** WhatsApp: how the recipient's client presents it; inferred from the name when omitted. */
  mediaType?: "image" | "video" | "audio" | "document";
  /** FreeAgent: the attachment's description. */
  description?: string;
}

/** Drive file JSON fields a Drive sink returns; md5 so a caller can verify the bytes. */
export const DRIVE_RESULT_FIELDS = `${FILE_FIELDS},md5Checksum`;

interface DriveFileJson {
  id?: string;
  name?: string;
  size?: string;
  md5Checksum?: string;
}

function driveResult(file: DriveFileJson, account: string | undefined, fallback: FileMeta): SinkResult {
  if (!file.id) throw new FileError(502, "Drive accepted the file but returned no id");
  return {
    ref: formatRef({ kind: "drive", fileId: file.id, ...(account !== undefined && { account }) }),
    name: file.name ?? fallback.name,
    size: file.size !== undefined ? Number(file.size) : fallback.size,
    result: file,
  };
}

// ---- drive ----------------------------------------------------------------

class DriveFolderSink implements Sink {
  constructor(
    readonly ref: Extract<SinkRef, { kind: "drive-folder" }>,
    private ctx: FileContext,
  ) {}

  private async parentId(): Promise<string> {
    if (this.ref.parentId !== TRANSIT_FOLDER) return this.ref.parentId;
    // refs.ts refuses this too; the relay tools build sinks without parsing.
    if (this.ref.account !== undefined) {
      throw new FileError(400, "_Transit lives in the default Drive account; drop the account, or name a folder id in that account");
    }
    return ensureTransitFolder(await this.ctx.drive(), this.ctx.vault);
  }

  async put(meta: FileMeta, body: SinkBody): Promise<SinkResult> {
    const drive = await this.ctx.drive(this.ref.account);
    const parent = await this.parentId();
    const stream = body instanceof Uint8Array ? bytesStream(body) : body;
    const size = body instanceof Uint8Array ? body.byteLength : meta.size;
    const session = await drive.startResumableUpload(
      { name: meta.name, mimeType: meta.mimeType, parents: [parent] },
      meta.mimeType,
      size,
      { query: { fields: DRIVE_RESULT_FIELDS } },
    );
    const file = (await drive.uploadToSession(session, stream, size)) as DriveFileJson;
    return driveResult(file, this.ref.account, meta);
  }

  /**
   * Server-side, no bytes through the Worker. The caller has established the
   * source is in this sink's account. Out of `_Transit` the file is moved —
   * same id, so a ref handed out earlier still resolves; otherwise copied.
   * A move also untrashes: a file the sweep already trashed keeps its parents,
   * so it still reads as in `_Transit`, and reparenting alone would leave it
   * hidden in the PARA folder until Drive purged it.
   */
  async fromDrive(fileId: string, _account: string | undefined, meta: FileMeta, inTransit: boolean): Promise<SinkResult> {
    const drive = await this.ctx.drive(this.ref.account);
    const parent = await this.parentId();
    const id = encodeURIComponent(fileId);
    if (inTransit) {
      const transit = await findTransitFolder(drive, this.ctx.vault);
      // Already where it is going: at most a rename.
      const removeParents = transit && transit !== parent ? transit : undefined;
      const file = (await drive.sendJson(
        "PATCH",
        `${DRIVE}/files/${id}`,
        { name: meta.name, trashed: false },
        {
          ...(removeParents && { addParents: parent, removeParents }),
          fields: DRIVE_RESULT_FIELDS,
          supportsAllDrives: true,
        },
      )) as DriveFileJson;
      return driveResult(file, this.ref.account, meta);
    }
    const file = (await drive.sendJson(
      "POST",
      `${DRIVE}/files/${id}/copy`,
      { name: meta.name, parents: [parent] },
      { fields: DRIVE_RESULT_FIELDS, supportsAllDrives: true },
    )) as DriveFileJson;
    return driveResult(file, this.ref.account, meta);
  }
}

// ---- gmail ----------------------------------------------------------------

class GmailDraftSink implements Sink {
  readonly cap: FileCap = "gmailDraftAttachments";
  /** Loaded once: precheck reads it to measure the room, put writes it back. */
  private draft?: Promise<DraftForAttach>;

  constructor(
    readonly ref: Extract<SinkRef, { kind: "gmail-draft" }>,
    private ctx: FileContext,
  ) {}

  private load(): Promise<DraftForAttach> {
    return (this.draft ??= this.ctx.gmail(this.ref.account).then((gmail) => loadDraftForAttach(gmail, this.ref.draftId)));
  }

  /** The draft's own size narrows the cap; refused before the source is opened. */
  async precheck(meta: FileMeta): Promise<void> {
    const room = draftAttachRoom(await this.load());
    if (meta.size > room) {
      throw new FileError(
        413,
        `"${meta.name}" is ${meta.size} bytes; draft "${this.ref.draftId}" has room for ${room} more before Gmail's ` +
          "25 MB message limit. Send a Drive link in the body instead.",
      );
    }
  }

  async put(meta: FileMeta, body: SinkBody): Promise<SinkResult> {
    const gmail = await this.ctx.gmail(this.ref.account);
    try {
      await this.precheck(meta);
    } catch (err) {
      // Called without the transfer's precheck: release the bytes unread.
      if (!(body instanceof Uint8Array)) await body.cancel();
      throw err;
    }
    const draft = await this.load();
    const bytes = await readAll(body, this.cap, `"${meta.name}"`);
    const { result, messageBytes } = await saveDraftWithAttachment(gmail, this.ref.draftId, draft, {
      filename: meta.name,
      mimeType: meta.mimeType,
      base64: bytesToBase64(bytes),
    });
    return { name: meta.name, size: bytes.byteLength, result: { ...result, messageBytes } };
  }
}

// ---- whatsapp -------------------------------------------------------------

class WhatsAppSendSink implements Sink {
  readonly cap: FileCap = "whatsappSend";

  constructor(
    readonly ref: Extract<SinkRef, { kind: "wa-send" }>,
    private ctx: FileContext,
    private opts: SinkOptions,
  ) {}

  async put(meta: FileMeta, body: SinkBody): Promise<SinkResult> {
    const bytes = await readAll(body, this.cap, `"${meta.name}"`);
    const bridge = await this.ctx.whatsapp();
    let sent: Awaited<ReturnType<typeof bridge.sendFile>>;
    try {
      sent = await bridge.sendFile(this.ref.recipient, meta.name, bytesToBase64(bytes), this.opts.mediaType, this.opts.caption);
    } catch (err) {
      throw bridgeFailure(err);
    }
    if (!sent.ok) {
      // The bridge's answer rides along, so a caller can say what was fetched as well as why it was refused.
      throw new FileError(502, sent.detail ?? "the WhatsApp bridge refused the file", {
        ...sent,
        filename: meta.name,
        size: bytes.byteLength,
        mimeType: meta.mimeType,
      });
    }
    return { name: meta.name, size: bytes.byteLength, result: sent };
  }
}

// ---- freeagent ------------------------------------------------------------

/** Resource path and request-body key per attachable FreeAgent record. */
export const FREEAGENT_RESOURCES: Record<FreeAgentTarget, { path: string; key: string }> = {
  bill: { path: "bills", key: "bill" },
  explanation: { path: "bank_transaction_explanations", key: "bank_transaction_explanation" },
  expense: { path: "expenses", key: "expense" },
};

/** The PUT body that attaches a file, matching the freeagent CLI's Attachment struct. */
export function freeagentAttachmentBody(
  target: FreeAgentTarget,
  meta: Pick<FileMeta, "name" | "mimeType">,
  bytes: Uint8Array,
  description?: string,
): Record<string, unknown> {
  return {
    [FREEAGENT_RESOURCES[target].key]: {
      attachment: {
        data: bytesToBase64(bytes),
        file_name: meta.name,
        content_type: meta.mimeType || "application/octet-stream",
        ...(description !== undefined && { description }),
      },
    },
  };
}

class FreeAgentSink implements Sink {
  readonly cap: FileCap = "freeagentAttachment";

  constructor(
    readonly ref: Extract<SinkRef, { kind: "freeagent" }>,
    private ctx: FileContext,
    private opts: SinkOptions,
  ) {}

  async put(meta: FileMeta, body: SinkBody): Promise<SinkResult> {
    const bytes = await readAll(body, this.cap, `"${meta.name}"`);
    const url = `${FREEAGENT_BASE_URL}/${FREEAGENT_RESOURCES[this.ref.target].path}/${this.ref.id}`;
    const client = await this.ctx.freeagent();
    const result = await client.putUrl(url, freeagentAttachmentBody(this.ref.target, meta, bytes, this.opts.description));
    return { name: meta.name, size: bytes.byteLength, result };
  }
}

export function makeSink(ref: SinkRef, ctx: FileContext, opts: SinkOptions = {}): Sink {
  switch (ref.kind) {
    case "drive-folder":
      return new DriveFolderSink(ref, ctx);
    case "gmail-draft":
      return new GmailDraftSink(ref, ctx);
    case "wa-send":
      return new WhatsAppSendSink(ref, ctx, opts);
    case "freeagent":
      return new FreeAgentSink(ref, ctx, opts);
  }
}
