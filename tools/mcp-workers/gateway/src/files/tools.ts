// The `files` service: four tools over the file layer, so any file the
// gateway can reach moves by ref rather than by bytes in the conversation.
//
//   file_stat          name, type, size of a source ref; nothing moves
//   file_transfer      any source ref to any sink ref, server-side
//   file_upload_url    a signed PUT URL onto a fresh `_Transit` file, for a sandbox to curl into
//   file_download_url  a signed GET URL for a ref; non-Drive refs are staged into `_Transit` first
//
// Accounts follow the refs: `?account=` on a ref wins, otherwise each
// service's own pin on the management page, exactly as ctx.googleClient
// resolves it. Every resolver re-checks its service's toggle, so with Gmail
// switched off a gmail: ref fails closed even though `files` is on.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { attachExportFor, DRIVE } from "../drive";
import type { GatewayToolContext } from "../registry";
import { asError, needsConfirm, READ_ONLY, run, WRITE } from "../toolutil";
import { fileUrlTarget } from "./http";
import { formatRef, parseSinkRef, parseSourceRef } from "./refs";
import { getDriveFileMeta, makeSource, type FileContext } from "./sources";
import { ensureTransitFolder } from "./transit";
import { transfer } from "./transfer";
import { enforceCap, FileError, FILE_CAPS, TRANSIT_FOLDER, type SinkRef, type SourceRef } from "./types";

/** The file layer's view of a session: each resolver asserts its own service is enabled. */
export function fileContextFor(ctx: GatewayToolContext): FileContext {
  return {
    drive: (account) => ctx.googleClient("drive", account),
    gmail: (account) => ctx.googleClient("gmail", account),
    whatsapp: () => ctx.whatsappBridge(),
    freeagent: () => ctx.freeagentClient(),
    vault: ctx.transitCache,
  };
}

const SOURCE_REFS =
  "Source refs: drive:<fileId> · gmail:<messageId>/<attachmentId> · wa:<chatJid>/<messageId> · freeagent:attachment/<id>. " +
  "Append ?account=<label> to a drive: or gmail: ref to pick a linked account (gateway_list_accounts); " +
  "without it each service's default account is used.";

const SINK_REFS =
  "Sink refs: drive:folder/<folderId> (or drive:folder/_Transit, drive:folder/root) · gmail:draft/<draftId> · " +
  "wa:send/<phone or JID> · freeagent:bill/<id> · freeagent:explanation/<id> · freeagent:expense/<id>.";

const MB = 1024 * 1024;
const capsLine =
  `Caps: Gmail draft ${Math.round(FILE_CAPS.gmailDraftAttachments / MB)} MB, WhatsApp send ${Math.round(FILE_CAPS.whatsappSend / MB)} MB, ` +
  `FreeAgent ${Math.round(FILE_CAPS.freeagentAttachment / MB)} MB, Gmail attachment read ${Math.round(FILE_CAPS.gmailAttachmentRead / MB)} MB; ` +
  "Drive targets are streamed. A file over a cap is refused before any bytes move.";

function curlFor(method: "GET" | "PUT", url: string): string {
  return method === "PUT" ? `curl -T <path> "${url}"` : `curl -o <path> "${url}"`;
}

export function registerFileReadTools(server: McpServer, ctx: GatewayToolContext): void {
  server.registerTool(
    "file_stat",
    {
      description:
        `Name, mime type and size of a file by ref, without moving its bytes — use it to check a file against a cap before file_transfer. ${SOURCE_REFS} ` +
        "Google Docs/Sheets/Slides report their export (PDF, xlsx), which means exporting them once.",
      inputSchema: { ref: z.string().describe("Source ref, e.g. drive:<fileId> or gmail:<messageId>/<attachmentId>") },
      annotations: READ_ONLY,
    },
    async ({ ref }) =>
      run(async () => {
        const parsed = parseSourceRef(ref);
        const source = makeSource(parsed, fileContextFor(ctx));
        try {
          return { ref: formatRef(parsed), ...(await source.stat()) };
        } finally {
          // A WhatsApp stat opens the media stream; nobody is going to read it.
          await source.dispose?.().catch(() => {});
        }
      }),
  );

  server.registerTool(
    "file_download_url",
    {
      description:
        "A signed URL that downloads one file with plain curl, for a sandbox that cannot call MCP tools with bytes. " +
        `Returns {ref, url, expires_at, curl}; run the curl line with <path> replaced. The URL is a bearer credential valid for 15 minutes — do not paste it anywhere public. ${SOURCE_REFS} ` +
        "Drive files are served directly (Docs/Slides as PDF, Sheets as xlsx). Any other ref (gmail:, wa:, freeagent:attachment/) is first copied into the Drive _Transit folder (needs write access); the returned ref is that copy, which is trashed after 7 days. " +
        "The sandbox must be allowed to reach the gateway host (egress allowlist).",
      inputSchema: { ref: z.string().describe("Source ref to download") },
      // Not read-only: a non-Drive ref (gmail:, wa:, freeagent:) is staged into Drive, which a
      // client auto-approving read-only tools must not do unasked. It stays
      // registered with the reads so a read-only session can still fetch
      // drive: refs; the staging branch checks the write grant itself.
      annotations: WRITE,
    },
    async ({ ref }) =>
      run(async () => {
        const parsed = parseSourceRef(ref);
        const files = fileContextFor(ctx);
        let staged = false;
        let drive: { fileId: string; account?: string };
        let name: string;
        let mimeType: string;
        let size: number;
        let target: string;

        if (parsed.kind === "drive") {
          drive = { fileId: parsed.fileId, ...(parsed.account !== undefined && { account: parsed.account }) };
          const meta = await getDriveFileMeta(await files.drive(parsed.account), parsed.fileId, parsed.account);
          name = meta.name;
          const native = meta.mimeType.startsWith("application/vnd.google-apps.");
          const exportMime = native ? attachExportFor(meta.mimeType)?.mimeType : undefined;
          if (native && !exportMime) {
            throw new FileError(415, `"${meta.name}" is a ${meta.mimeType.slice("application/vnd.google-apps.".length)}, which has no file content to download`);
          }
          mimeType = exportMime ?? meta.mimeType;
          // An export has no size until Drive renders it; the route skips the check for one.
          size = exportMime ? 0 : (meta.size ?? 0);
          target = fileUrlTarget(parsed.fileId, exportMime);
        } else {
          // Staging writes a Drive file, so it needs the write grant even
          // though this tool is otherwise a read.
          if (!ctx.canWrite) {
            throw new FileError(403, `downloading a ${parsed.kind.split("-")[0]}: ref stages it in Drive first, which needs write access; ask for a drive: ref instead`);
          }
          const result = await transfer(parsed, { kind: "drive-folder", parentId: TRANSIT_FOLDER }, files);
          await ctx.audit("file_download_url", `staged ${result.from} -> ${result.ref ?? "?"}`, "ok").catch(() => {});
          if (!result.ref) throw new FileError(502, "staging into _Transit returned no Drive file");
          const landed = parseSourceRef(result.ref);
          if (landed.kind !== "drive") throw new FileError(502, "staging into _Transit returned no Drive file");
          drive = { fileId: landed.fileId };
          staged = true;
          name = result.name;
          mimeType = result.mimeType;
          size = result.size;
          target = fileUrlTarget(landed.fileId);
        }

        const { url, expiresAt } = await ctx.signFileUrl({
          account: drive.account ?? null,
          method: "GET",
          target,
          maxBytes: size,
        });
        return {
          ref: formatRef({ kind: "drive", ...drive }),
          ...(staged && { source: formatRef(parsed), staged: true }),
          name,
          mimeType,
          size,
          url,
          expires_at: new Date(expiresAt).toISOString(),
          curl: curlFor("GET", url),
        };
      }),
  );
}

export function registerFileWriteTools(server: McpServer, ctx: GatewayToolContext): void {
  server.registerTool(
    "file_transfer",
    {
      description:
        "Move a file from any source to any sink inside the gateway, without its bytes entering this conversation. " +
        `${SOURCE_REFS} ${SINK_REFS} ` +
        "Drive to a Drive folder in the same account is server-side: a file in _Transit is moved (same file id — this is how an upload is ingested into a PARA folder), anything else copied. " +
        "Google Docs/Sheets/Slides are exported (PDF, xlsx) when the sink is not Drive. " +
        `${capsLine} Sending to wa:send/ cannot be undone, so it needs confirm: true. Returns the new ref when the file landed in Drive.`,
      inputSchema: {
        from: z.string().describe("Source ref"),
        to: z.string().describe("Sink ref"),
        name: z.string().optional().describe("Name at the destination; defaults to the source's"),
        caption: z.string().optional().describe("wa:send only: caption for an image or video"),
        media_type: z
          .enum(["image", "video", "audio", "document"])
          .optional()
          .describe("wa:send only: how WhatsApp presents it; inferred from the name when omitted"),
        description: z.string().optional().describe("freeagent: only: the attachment's description"),
        export_mime_type: z
          .string()
          .optional()
          .describe("Export format for a Google-native source; defaults to PDF for Docs/Slides, xlsx for Sheets"),
        confirm: z.boolean().optional().describe("Must be true when the sink is wa:send/ — a send is not reversible"),
      },
      annotations: WRITE,
    },
    async ({ from, to, name, caption, media_type, description, export_mime_type, confirm }) => {
      let source: SourceRef;
      let sink: SinkRef;
      try {
        source = parseSourceRef(from);
        sink = parseSinkRef(to);
      } catch (err) {
        return asError(err);
      }
      if (sink.kind === "wa-send" && confirm !== true) return needsConfirm();
      return run(() =>
        transfer(source, sink, fileContextFor(ctx), {
          ...(name !== undefined && { name }),
          ...(caption !== undefined && { caption }),
          ...(media_type !== undefined && { mediaType: media_type }),
          ...(description !== undefined && { description }),
          ...(export_mime_type !== undefined && { exportMimeType: export_mime_type }),
        }),
      );
    },
  );

  server.registerTool(
    "file_upload_url",
    {
      description:
        "Get a signed URL a sandbox can upload one file to with plain curl, so its bytes never pass through this conversation. " +
        "Creates an empty file named `name` in the Drive _Transit folder and returns {ref, url, method: 'PUT', expires_at, curl}; run the curl line with <path> replaced by the local file. " +
        "The URL works once, for 15 minutes, and refuses a body larger than `size`; a failed upload needs a new URL. " +
        `After the upload, \`ref\` (drive:<id>) works anywhere a source ref does — file_transfer it into a PARA folder to ingest it (a move, same id), or onward to Gmail, WhatsApp or FreeAgent. Files left in _Transit are trashed after 7 days. Ceiling ${Math.round(FILE_CAPS.signedPut / MB)} MB. ` +
        "The sandbox must be allowed to reach the gateway host (egress allowlist).",
      inputSchema: {
        name: z.string().min(1).describe("File name in Drive — use 'YYYY-MM-DD <description>.<ext>'"),
        mime_type: z.string().min(1).describe("e.g. application/pdf"),
        size: z.number().int().nonnegative().describe("Exact size in bytes (e.g. from `stat -c %s` or `wc -c`)"),
      },
      annotations: WRITE,
    },
    async ({ name, mime_type, size }) =>
      run(async () => {
        enforceCap(size, "signedPut", `"${name}"`);
        const files = fileContextFor(ctx);
        // The default Drive account: that is where _Transit lives and what the
        // expiry sweep cleans.
        const drive = await files.drive();
        const parent = await ensureTransitFolder(drive, files.vault);
        const created = (await drive.sendJson(
          "POST",
          `${DRIVE}/files`,
          { name, mimeType: mime_type, parents: [parent] },
          { fields: "id,name,mimeType", supportsAllDrives: true },
        )) as { id?: string };
        if (!created.id) throw new FileError(502, "Drive created the upload target but returned no id");
        const { url, expiresAt } = await ctx.signFileUrl({ account: null, method: "PUT", target: created.id, maxBytes: size });
        return {
          ref: formatRef({ kind: "drive", fileId: created.id }),
          url,
          method: "PUT",
          expires_at: new Date(expiresAt).toISOString(),
          max_bytes: size,
          curl: curlFor("PUT", url),
        };
      }),
  );
}
