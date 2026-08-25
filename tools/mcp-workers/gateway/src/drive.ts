// Drive tool surface (ported from gws-mcp, plus the gateway's `account`
// parameter). Reads need only drive.readonly on the linked account. Writes
// need the full drive scope (drive.file would only cover files this app
// created).
//
// Destructiveness model (recorded in docs/plans/mcp-workers.md): content
// updates are recoverable via revisions for Google-native files (full
// history) and for ~30 days on uploaded binaries, so drive_update_file is a
// plain write. Deletion is trash-only (30-day recovery, no permanent-delete
// tool exists here) and still marked destructive + confirm-gated.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GoogleApiError, type GoogleClient } from "./googleapi";
import type { GetClient } from "./gmail";
import { bytesToBase64 } from "./mime";
import { ACCOUNT_PARAM, DESTRUCTIVE, needsConfirm, READ_ONLY, run, WRITE } from "./toolutil";

export const DRIVE = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const FILE_FIELDS = "id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink,trashed,owners(emailAddress)";
const READ_BYTE_CAP = 1_000_000;

// Export mapping for Google-native formats (unit-tested).
export function exportMimeFor(mimeType: string): string | undefined {
  switch (mimeType) {
    case "application/vnd.google-apps.document":
      return "text/plain";
    case "application/vnd.google-apps.spreadsheet":
      return "text/csv";
    case "application/vnd.google-apps.presentation":
      return "text/plain";
    default:
      return undefined;
  }
}

// Google-native files have no bytes to attach, so they have to be exported.
// This mapping is deliberately *not* exportMimeFor's: that one serves
// drive_read_file, where a model wants text it can read. An email attachment
// wants the document, so a Doc becomes a PDF rather than a stripped-down
// text/plain, and a Sheet becomes a real spreadsheet rather than CSV.
export function attachExportFor(mimeType: string): { mimeType: string; extension: string } | undefined {
  switch (mimeType) {
    case "application/vnd.google-apps.document":
    case "application/vnd.google-apps.presentation":
    case "application/vnd.google-apps.drawing":
      return { mimeType: "application/pdf", extension: "pdf" };
    case "application/vnd.google-apps.spreadsheet":
      return {
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        extension: "xlsx",
      };
    default:
      return undefined;
  }
}

const EXTENSION_FOR_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/html": "html",
};

/** Appends the export format's extension unless the name already carries it. */
export function exportedFilename(name: string, mimeType: string): string {
  const extension = EXTENSION_FOR_MIME[mimeType];
  if (!extension) return name;
  return name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`;
}

export interface DriveAttachment {
  filename: string;
  mimeType: string;
  base64: string;
  bytes: number;
}

/**
 * Fetches one Drive file as attachment-ready bytes, for the Gmail draft relay.
 *
 * The 404 rewrite is the point of this function existing. Drive answers a file
 * id belonging to a *different* linked account with a bare "File not found",
 * which reads as "you made the id up" when the truth is "you used the wrong
 * credentials" — the single most likely mistake on a gateway where the mail
 * account and the Drive account are routinely different people's. We name the
 * account we actually used and the parameter that changes it, and we do not go
 * looking through the other linked accounts: silently finding the file under
 * another identity is a confused deputy, not a convenience.
 */
export async function fetchDriveAttachment(
  client: GoogleClient,
  fileId: string,
  opts: { accountHint: string; filename?: string; exportMimeType?: string; byteCap: number },
): Promise<DriveAttachment> {
  let meta: { name?: string; mimeType?: string; size?: string };
  try {
    meta = (await client.getJson(`${DRIVE}/files/${fileId}`, {
      fields: "id,name,mimeType,size",
      supportsAllDrives: true,
    })) as { name?: string; mimeType?: string; size?: string };
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 404) {
      throw new GoogleApiError(
        404,
        `Drive file "${fileId}" was not found in ${opts.accountHint}. It may belong to another linked account — ` +
          "pass drive_account with the label that owns it (see gateway_list_accounts).",
      );
    }
    if (err instanceof GoogleApiError && err.status === 403) {
      throw new GoogleApiError(
        403,
        `Drive file "${fileId}" exists but ${opts.accountHint} may not read it. Share it with that account, ` +
          "or pass drive_account with a label that can.",
      );
    }
    throw err;
  }

  const nativeExport = attachExportFor(meta.mimeType ?? "");
  const exportMime = opts.exportMimeType ?? nativeExport?.mimeType;
  const sourceName = opts.filename ?? meta.name ?? fileId;

  if (nativeExport || (exportMime && (meta.mimeType ?? "").startsWith("application/vnd.google-apps"))) {
    const buffer = await client.getRaw(`${DRIVE}/files/${fileId}/export`, { mimeType: exportMime! });
    if (buffer.byteLength > opts.byteCap) {
      throw new GoogleApiError(413, `"${sourceName}" exports to ${buffer.byteLength} bytes; cap is ${opts.byteCap}`);
    }
    return {
      filename: opts.filename ?? exportedFilename(sourceName, exportMime!),
      mimeType: exportMime!,
      base64: bytesToBase64(buffer),
      bytes: buffer.byteLength,
    };
  }

  // Refuse on the declared size before spending memory on the download.
  const declared = Number(meta.size ?? 0);
  if (declared > opts.byteCap) {
    throw new GoogleApiError(413, `"${sourceName}" is ${declared} bytes; cap is ${opts.byteCap}`);
  }
  const buffer = await client.getRaw(`${DRIVE}/files/${fileId}`, { alt: "media", supportsAllDrives: true });
  if (buffer.byteLength > opts.byteCap) {
    throw new GoogleApiError(413, `"${sourceName}" is ${buffer.byteLength} bytes; cap is ${opts.byteCap}`);
  }
  return {
    filename: sourceName,
    mimeType: meta.mimeType ?? "application/octet-stream",
    base64: bytesToBase64(buffer),
    bytes: buffer.byteLength,
  };
}

export function bytesToText(buffer: ArrayBuffer): { text: string } | { base64: string } {
  const bytes = new Uint8Array(buffer);
  try {
    // workers-types requires both option fields.
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes) };
  } catch {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return { base64: btoa(bin) };
  }
}

export function registerDriveReadTools(server: McpServer, getClient: GetClient): void {
  server.registerTool(
    "drive_search",
    {
      description:
        "Search Drive with the files.list query syntax, e.g. name contains 'report', fullText contains 'foo', mimeType = 'application/pdf', 'FOLDER_ID' in parents. Omit query to list recent files.",
      inputSchema: {
        query: z.string().optional().describe("Drive q syntax"),
        max_results: z.number().int().min(1).max(50).optional().describe("Default 20"),
        order_by: z.string().optional().describe("e.g. modifiedTime desc (default), name"),
        account: ACCOUNT_PARAM,
      },
      annotations: READ_ONLY,
    },
    async ({ query, max_results, order_by, account }) =>
      run(async () =>
        (await getClient(account)).getJson(`${DRIVE}/files`, {
          q: query,
          pageSize: max_results ?? 20,
          orderBy: order_by ?? "modifiedTime desc",
          fields: `files(${FILE_FIELDS})`,
        }),
      ),
  );

  server.registerTool(
    "drive_get_file",
    {
      description: "Get one Drive file's metadata.",
      inputSchema: { file_id: z.string(), account: ACCOUNT_PARAM },
      annotations: READ_ONLY,
    },
    async ({ file_id, account }) =>
      run(async () => (await getClient(account)).getJson(`${DRIVE}/files/${file_id}`, { fields: FILE_FIELDS })),
  );

  server.registerTool(
    "drive_read_file",
    {
      description:
        "Read a Drive file's content. Google Docs export as text, Sheets as CSV; other files download raw (utf-8 text when possible, else base64). Capped at ~1MB.",
      inputSchema: { file_id: z.string(), account: ACCOUNT_PARAM },
      annotations: READ_ONLY,
    },
    async ({ file_id, account }) =>
      run(async () => {
        const client = await getClient(account);
        const meta = (await client.getJson(`${DRIVE}/files/${file_id}`, {
          fields: "id,name,mimeType,size",
        })) as { name?: string; mimeType?: string; size?: string };
        const exportMime = exportMimeFor(meta.mimeType ?? "");
        if (exportMime) {
          const buffer = await client.getRaw(`${DRIVE}/files/${file_id}/export`, { mimeType: exportMime });
          if (buffer.byteLength > READ_BYTE_CAP) {
            throw new GoogleApiError(413, `export is ${buffer.byteLength} bytes; cap is ${READ_BYTE_CAP}`);
          }
          return { name: meta.name, mimeType: exportMime, ...bytesToText(buffer) };
        }
        const size = Number(meta.size ?? 0);
        if (size > READ_BYTE_CAP) {
          throw new GoogleApiError(413, `file is ${size} bytes; cap is ${READ_BYTE_CAP}`);
        }
        const buffer = await client.getRaw(`${DRIVE}/files/${file_id}`, { alt: "media" });
        return { name: meta.name, mimeType: meta.mimeType, ...bytesToText(buffer) };
      }),
  );
}

// Gmail and Drive resolve to *different Google accounts* here — work mailbox,
// personal Drive — so there is no server-side "save to Drive" between them. An
// attachment has to come down as base64 and go back up as bytes, which is only
// possible if the upload can carry something other than text.
//
// Google's multipart upload takes the media part verbatim, so base64 handed to
// a text/plain part is stored as a text file full of base64 — a PDF that opens
// in a text editor. Declaring `Content-Transfer-Encoding: base64` makes Drive
// decode it instead.
export function multipartBody(
  metadata: Record<string, unknown>,
  media: { text: string; base64?: undefined; mimeType: string } | { base64: string; text?: undefined; mimeType: string },
): { contentType: string; body: string } {
  const boundary = "toolbox-mcp-" + crypto.randomUUID();
  const mediaPart =
    media.base64 !== undefined
      ? [`Content-Type: ${media.mimeType}`, "Content-Transfer-Encoding: base64", "", media.base64]
      : [`Content-Type: ${media.mimeType}`, "", media.text];
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    ...mediaPart,
    `--${boundary}--`,
  ].join("\r\n");
  return { contentType: `multipart/related; boundary=${boundary}`, body };
}

export function registerDriveWriteTools(server: McpServer, getClient: GetClient): void {
  server.registerTool(
    "drive_create_file",
    {
      description:
        "Create a Drive file or folder. Text goes in `content`; binary (a Gmail attachment, a scan) goes in `base64` with its real mime_type — Gmail and Drive are different accounts here, so an attachment must be downloaded and re-uploaded rather than saved across. Set mime_type 'application/vnd.google-apps.document' to convert text into a Google Doc, 'application/vnd.google-apps.folder' for a folder.",
      inputSchema: {
        name: z.string(),
        parent_id: z.string().optional(),
        mime_type: z.string().optional().describe("Target mime type (default text/plain for content, folder otherwise)"),
        content: z.string().optional().describe("Text content; omit for an empty file or folder"),
        base64: z
          .string()
          .optional()
          .describe("Binary content, base64-encoded (e.g. straight from gmail_get_attachment). Give mime_type too; not combinable with content."),
        account: ACCOUNT_PARAM,
      },
      annotations: WRITE,
    },
    async ({ name, parent_id, mime_type, content, base64, account }) =>
      run(async () => {
        if (content !== undefined && base64 !== undefined) {
          throw new GoogleApiError(400, "pass content or base64, not both");
        }
        const client = await getClient(account);
        const metadata: Record<string, unknown> = { name };
        if (parent_id) metadata.parents = [parent_id];
        if (content === undefined && base64 === undefined) {
          metadata.mimeType = mime_type ?? "application/vnd.google-apps.folder";
          return client.sendJson("POST", `${DRIVE}/files`, metadata, { fields: FILE_FIELDS });
        }
        if (mime_type) metadata.mimeType = mime_type;
        const { contentType, body } =
          base64 !== undefined
            ? multipartBody(metadata, { base64, mimeType: mime_type ?? "application/octet-stream" })
            : multipartBody(metadata, { text: content!, mimeType: 'text/plain; charset="UTF-8"' });
        return client.sendBody("POST", `${DRIVE_UPLOAD}/files`, contentType, body, {
          uploadType: "multipart",
          fields: FILE_FIELDS,
        });
      }),
  );

  server.registerTool(
    "drive_update_file",
    {
      description:
        "Update a Drive file: rename, move (add/remove parent), or replace text content. Content of Google-native files keeps full version history; uploaded binaries keep prior versions ~30 days.",
      inputSchema: {
        file_id: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        add_parent_id: z.string().optional(),
        remove_parent_id: z.string().optional(),
        content: z.string().optional().describe("New text content (replaces the file body)"),
        base64: z
          .string()
          .optional()
          .describe("New binary content, base64-encoded; give mime_type too. Not combinable with content."),
        mime_type: z.string().optional().describe("Mime type for base64 content"),
        account: ACCOUNT_PARAM,
      },
      annotations: WRITE,
    },
    async ({ file_id, name, description, add_parent_id, remove_parent_id, content, base64, mime_type, account }) =>
      run(async () => {
        if (content !== undefined && base64 !== undefined) {
          throw new GoogleApiError(400, "pass content or base64, not both");
        }
        const client = await getClient(account);
        let result: unknown = null;
        if (name !== undefined || description !== undefined || add_parent_id || remove_parent_id) {
          const metadata: Record<string, unknown> = {};
          if (name !== undefined) metadata.name = name;
          if (description !== undefined) metadata.description = description;
          result = await client.sendJson("PATCH", `${DRIVE}/files/${file_id}`, metadata, {
            addParents: add_parent_id,
            removeParents: remove_parent_id,
            fields: FILE_FIELDS,
          });
        }
        if (content !== undefined) {
          result = await client.sendBody(
            "PATCH",
            `${DRIVE_UPLOAD}/files/${file_id}`,
            'text/plain; charset="UTF-8"',
            content,
            { uploadType: "media", fields: FILE_FIELDS },
          );
        }
        if (base64 !== undefined) {
          const { contentType, body } = multipartBody({}, { base64, mimeType: mime_type ?? "application/octet-stream" });
          result = await client.sendBody("PATCH", `${DRIVE_UPLOAD}/files/${file_id}`, contentType, body, {
            uploadType: "multipart",
            fields: FILE_FIELDS,
          });
        }
        if (result === null) throw new GoogleApiError(400, "nothing to update — pass name, parents, content or base64");
        return result;
      }),
  );

  server.registerTool(
    "drive_trash_file",
    {
      description:
        "Move a Drive file to trash (recoverable for 30 days; there is no permanent-delete tool). Requires confirm: true.",
      inputSchema: { file_id: z.string(), confirm: z.boolean().optional(), account: ACCOUNT_PARAM },
      annotations: DESTRUCTIVE,
    },
    async ({ file_id, confirm, account }) => {
      if (confirm !== true) return needsConfirm();
      return run(async () =>
        (await getClient(account)).sendJson("PATCH", `${DRIVE}/files/${file_id}`, { trashed: true }, { fields: FILE_FIELDS }),
      );
    },
  );
}
