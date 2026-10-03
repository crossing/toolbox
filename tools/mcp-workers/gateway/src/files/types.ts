// The contract for moving files through the gateway: one ref syntax for
// every place a file can come from or go to, a Source/Sink pair that hides
// each service's API behind "stat, open, put", and the single table of byte
// caps those services impose.
//
// Refs are URI strings so a model can carry them between tools unchanged:
//
//   sources  drive:<fileId>[?account=]
//            gmail:<messageId>/<attachmentId>[?account=]
//            wa:<chatJid>/<messageId>
//   sinks    drive:folder/<parentId>[?account=]   (parentId may be _Transit or root)
//            gmail:draft/<draftId>[?account=]
//            wa:send/<recipient>
//            freeagent:bill|explanation|expense/<id>
//
// refs.ts parses and formats them; the Source and Sink implementations live
// beside this file and build on the shapes below.

import { WHATSAPP_SEND_BYTE_CAP } from "@toolbox/mcp-shared";
import { GMAIL_MESSAGE_BYTE_CAP, TOTAL_ATTACHMENT_BYTE_CAP } from "../mime";

export { WHATSAPP_SEND_BYTE_CAP };

const MB = 1024 * 1024;

/**
 * Every per-service limit on bytes moved by the file tools, in one place.
 * Sources and sinks that must buffer check against these up front (from
 * stat) so a refusal comes before the download, not after.
 */
export const FILE_CAPS = {
  /** Gmail attachments arrive as one base64url JSON field; Worker memory is the bound. */
  gmailAttachmentRead: 25 * MB,
  /** Gmail refuses a message over 25 MB, counted after base64 expansion. */
  gmailMessage: GMAIL_MESSAGE_BYTE_CAP,
  /** Source bytes that fit under gmailMessage once base64 has added its third. */
  gmailDraftAttachments: TOTAL_ATTACHMENT_BYTE_CAP,
  /** The bridge refuses larger outgoing files. */
  whatsappSend: WHATSAPP_SEND_BYTE_CAP,
  /**
   * FreeAgent takes attachments as base64 inside the JSON body and documents
   * no ceiling; 5 MB is a conservative guess that also bounds Worker memory.
   * Raise it once a larger upload has been seen to succeed.
   */
  freeagentAttachment: 5 * MB,
  /** Workers' request body limit on the Free/Pro plans. */
  signedPut: 100 * MB,
  /**
   * Drive's own ceiling on exporting a Google-native file. An export's size
   * is only known by doing it, so it is buffered, and read against the
   * sink's cap when there is one, this when there is not.
   */
  driveExport: 10 * MB,
} as const;

export type FileCap = keyof typeof FILE_CAPS;

/** Every file-layer failure: a bad ref, a cap, a missing file. Its message is safe to show. */
export class FileError extends Error {
  constructor(
    public status: number,
    message: string,
    /** What the upstream said, for a caller that reports more than the message (a bridge refusal). */
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Refuse a size over one of FILE_CAPS, naming both numbers. */
export function enforceCap(size: number, cap: FileCap, what = "file"): void {
  const limit = FILE_CAPS[cap];
  if (size > limit) {
    throw new FileError(413, `${what} is ${size} bytes; cap is ${limit} bytes (${Math.round(limit / MB)} MB) on this path`);
  }
}

// ---- refs -----------------------------------------------------------------

/** The sentinel parent id for the `_Transit` staging folder; resolved per user. */
export const TRANSIT_FOLDER = "_Transit";

export type SourceRef =
  | { kind: "drive"; fileId: string; account?: string }
  | { kind: "gmail"; messageId: string; attachmentId: string; account?: string }
  | { kind: "wa"; chatJid: string; messageId: string };

export type FreeAgentTarget = "bill" | "explanation" | "expense";

export type SinkRef =
  | { kind: "drive-folder"; parentId: string; account?: string }
  | { kind: "gmail-draft"; draftId: string; account?: string }
  | { kind: "wa-send"; recipient: string }
  | { kind: "freeagent"; target: FreeAgentTarget; id: string };

// ---- sources and sinks ----------------------------------------------------

export interface FileMeta {
  name: string;
  mimeType: string;
  /** Bytes. Known before the transfer for every source the gateway supports. */
  size: number;
  /** Drive's md5Checksum, when the file is (or has become) a Drive file. */
  md5?: string;
  /** Set when the bytes are an export of a Google-native file: the native type it came from. */
  exportedFrom?: string;
}

export interface OpenedFile {
  meta: FileMeta;
  body: ReadableStream<Uint8Array>;
}

export interface Source {
  readonly ref: SourceRef;
  /**
   * Set when the bytes already live in Drive, so a Drive sink can copy or move
   * server-side instead of streaming them through the Worker.
   */
  readonly driveFileId?: string;
  /** The Drive account that owns driveFileId; undefined is the default account. */
  readonly driveAccount?: string;
  /** Name, type and size without moving the bytes. */
  stat(): Promise<FileMeta>;
  /** The bytes, streamed. Consume or cancel `body` exactly once. */
  open(): Promise<OpenedFile>;
  /**
   * Release whatever stat() opened when open() is never going to follow (a
   * cap or precheck refused). Only sources whose stat() opens something
   * implement it.
   */
  dispose?(): Promise<void>;
}

/** A sink takes either a stream or bytes a source already had to buffer. */
export type SinkBody = ReadableStream<Uint8Array> | Uint8Array;

export interface SinkResult {
  /** Where the file landed, as a source ref, when it landed somewhere addressable. */
  ref?: string;
  name: string;
  size: number;
  /** The upstream service's own answer (Drive file JSON, send result, ...). */
  result?: unknown;
}

export interface Sink {
  readonly ref: SinkRef;
  /** The cap this sink enforces before reading any bytes; undefined means streamed, uncapped. */
  readonly cap?: FileCap;
  /**
   * Refusals that need the sink's own state (a draft's remaining room), run
   * after the cap check and before the source is opened, so they too come
   * before the download.
   */
  precheck?(meta: FileMeta): Promise<void>;
  put(meta: FileMeta, body: SinkBody): Promise<SinkResult>;
  /**
   * Server-side path for a Source with driveFileId: copy it (or, out of
   * `_Transit` into a Drive folder, move it, keeping the file id). Only Drive
   * sinks implement it; the transfer falls back to open() + put() otherwise.
   */
  fromDrive?(fileId: string, account: string | undefined, meta: FileMeta, inTransit: boolean): Promise<SinkResult>;
}

/**
 * Buffer a sink body, refusing past `cap` while reading rather than after, so
 * a source that understated its size cannot balloon Worker memory.
 */
export async function readAll(body: SinkBody, cap: FileCap, what = "file"): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    enforceCap(body.byteLength, cap, what);
    return body;
  }
  const limit = FILE_CAPS[cap];
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      enforceCap(total, cap, what);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
