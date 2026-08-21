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
import { GoogleApiError } from "./googleapi";
import type { GetClient } from "./gmail";
import { ACCOUNT_PARAM, DESTRUCTIVE, needsConfirm, READ_ONLY, run, WRITE } from "./toolutil";

const DRIVE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FILE_FIELDS = "id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink,trashed,owners(emailAddress)";
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

export function registerDriveWriteTools(server: McpServer, getClient: GetClient): void {
  server.registerTool(
    "drive_create_file",
    {
      description:
        "Create a Drive file or folder. Text content uploads as-is; set mime_type 'application/vnd.google-apps.document' to convert text into a Google Doc, 'application/vnd.google-apps.folder' for a folder.",
      inputSchema: {
        name: z.string(),
        parent_id: z.string().optional(),
        mime_type: z.string().optional().describe("Target mime type (default text/plain for content, folder otherwise)"),
        content: z.string().optional().describe("Text content; omit for an empty file or folder"),
        account: ACCOUNT_PARAM,
      },
      annotations: WRITE,
    },
    async ({ name, parent_id, mime_type, content, account }) =>
      run(async () => {
        const client = await getClient(account);
        const metadata: Record<string, unknown> = { name };
        if (parent_id) metadata.parents = [parent_id];
        if (content === undefined) {
          metadata.mimeType = mime_type ?? "application/vnd.google-apps.folder";
          return client.sendJson("POST", `${DRIVE}/files`, metadata, { fields: FILE_FIELDS });
        }
        if (mime_type) metadata.mimeType = mime_type;
        const boundary = "toolbox-mcp-" + crypto.randomUUID();
        const body = [
          `--${boundary}`,
          "Content-Type: application/json; charset=UTF-8",
          "",
          JSON.stringify(metadata),
          `--${boundary}`,
          'Content-Type: text/plain; charset="UTF-8"',
          "",
          content,
          `--${boundary}--`,
        ].join("\r\n");
        return client.sendBody("POST", `${DRIVE_UPLOAD}/files`, `multipart/related; boundary=${boundary}`, body, {
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
        account: ACCOUNT_PARAM,
      },
      annotations: WRITE,
    },
    async ({ file_id, name, description, add_parent_id, remove_parent_id, content, account }) =>
      run(async () => {
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
        if (result === null) throw new GoogleApiError(400, "nothing to update — pass name, parents, or content");
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
