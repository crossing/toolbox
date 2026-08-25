// Registers the Gmail tools against the *real* MCP server rather than a stub.
//
// Everything else in this directory drives handlers through a fake registerTool,
// which never exercises the zod -> JSON Schema conversion the SDK performs for
// tools/list. That conversion is where a schema the type checker is happy with
// can still fail at runtime — and because the catalog is assembled once per
// session, one bad schema does not break one tool, it breaks every tool in the
// gateway for the whole conversation.

import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGmailReadTools, registerGmailWriteTools } from "../src/gmail";

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
}

async function catalog() {
  const server = new McpServer({ name: "probe", version: "0" });
  const stub = (async () => ({}) as never) as never;
  registerGmailReadTools(server, stub);
  registerGmailWriteTools(server, stub, stub);
  // The same path tools/list takes.
  const listed = await (
    server.server as unknown as {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<{ tools: { name: string; inputSchema: JsonSchema }[] }>>;
    }
  )._requestHandlers.get("tools/list")!({ method: "tools/list", params: {} }, {});
  return new Map(listed.tools.map((t) => [t.name, t.inputSchema]));
}

describe("gmail catalog", () => {
  it("registers both relay directions under names an agent can find", async () => {
    const tools = await catalog();
    expect([...tools.keys()]).toContain("gmail_create_draft");
    expect([...tools.keys()]).toContain("gmail_attach_drive_file");
    // The guarantee, asserted rather than assumed.
    expect([...tools.keys()].filter((n) => /send/i.test(n))).toEqual([]);
  });

  it("converts the nested attachment schemas the SDK has to serialize", async () => {
    const draft = (await catalog()).get("gmail_create_draft")!;
    const props = draft.properties!;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["to", "subject", "body", "thread_id", "in_reply_to_message_id", "attachments", "drive_attachments"]),
    );

    // Arrays of objects are the part that silently degrades to `{}` if the
    // conversion cannot handle them — a schema the model then cannot fill in.
    expect(props.attachments!.type).toBe("array");
    expect(Object.keys(props.attachments!.items!.properties!).sort()).toEqual(["base64", "filename", "mime_type"]);
    expect(props.attachments!.items!.required!.sort()).toEqual(["base64", "filename", "mime_type"]);

    expect(props.drive_attachments!.type).toBe("array");
    expect(Object.keys(props.drive_attachments!.items!.properties!).sort()).toEqual([
      "export_mime_type",
      "file_id",
      "filename",
    ]);
    expect(props.drive_attachments!.items!.required).toEqual(["file_id"]);

    // subject stopped being required when replies started deriving it.
    expect(draft.required ?? []).not.toContain("subject");
    expect(draft.required).toContain("to");
  });

  it("gives the mirror tool the ids it needs and nothing more", async () => {
    const attach = (await catalog()).get("gmail_attach_drive_file")!;
    expect(Object.keys(attach.properties!).sort()).toEqual([
      "account",
      "draft_id",
      "drive_account",
      "export_mime_type",
      "file_id",
      "filename",
    ]);
    expect(attach.required!.sort()).toEqual(["draft_id", "file_id"]);
  });
});
