// Who made a write call, for the audit log.
//
// MCP has no field a server can require a client to fill with its identity,
// and claude.ai's connector backend — which fronts every claude.ai chat,
// Cowork task and Claude Code session using the connector — decides which
// headers reach us. So the caller is pieced together from two kinds of
// evidence, and the audit row keeps them apart:
//
//  - observed: what the transport carried. Claude Code puts the tool_use id
//    in `_meta["claudecode/toolUseId"]`; that id appears verbatim in the
//    session's transcript, so it is the strongest pointer back to a session.
//    Headers and the OAuth client id say which surface called.
//  - declared: the `caller` argument every write tool requires. The model
//    writes it, so it is a claim, not proof — but it is the only field a
//    claude.ai chat can fill at all, and the server can insist on it.

import { z } from "zod";

/** The argument auditedServer adds to every write tool. */
export const CALLER_ARG = "caller";

export const CALLER_PARAM = z
  .string()
  .trim()
  .min(3)
  .max(300)
  .describe(
    "Required, for the audit log: who is making this call. In Claude Code, give the session id " +
      "(the CLAUDE_CODE_SESSION_ID environment variable) and the session title, e.g. " +
      '"claude-code 00000000-0000-0000-0000-000000000000 — tidy inbox". In a claude.ai chat or ' +
      'Cowork task, give the surface and the conversation title, e.g. "claude.ai chat — plan a trip".',
  );

export interface CallerInfo {
  /** The model-supplied `caller` argument. */
  declared?: string;
  /** Claude Code's tool_use id, from `_meta["claudecode/toolUseId"]`. */
  toolUseId?: string;
  /** A session id the transport carried, if any did. */
  sessionId?: string;
  /** The OAuth client the bearer token was issued to. */
  clientId?: string;
  /** `clientInfo` from the per-request envelope (MCP 2026-07-28 clients). */
  client?: string;
  userAgent?: string;
  /** Other string-valued `claudecode/*` and `anthropic/*` meta keys. */
  meta?: Record<string, string>;
}

// The shape of the SDK's ServerContext this reads; everything optional,
// because tests and older transports pass less (or nothing).
interface ContextLike {
  sessionId?: string;
  mcpReq?: { _meta?: Record<string, unknown>; envelope?: Record<string, unknown> };
  http?: { req?: Request; authInfo?: { clientId?: string } };
}

// Header names that, if any client ever sends them, identify a session.
// Checked in order; the first present wins.
const SESSION_HEADERS = ["x-claude-code-session-id", "x-claude-session-id", "mcp-session-id"];
const META_NAMESPACES = ["claudecode/", "anthropic/"];
const TOOL_USE_KEY = "claudecode/toolUseId";
const MAX_FIELD = 200;

function clip(value: string): string {
  return value.length > MAX_FIELD ? value.slice(0, MAX_FIELD) + "…" : value;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? clip(value) : undefined;
}

export function callerFromContext(extra: unknown, declared?: unknown): CallerInfo {
  const ctx = (typeof extra === "object" && extra !== null ? extra : {}) as ContextLike;
  const info: CallerInfo = {};
  const set = <K extends keyof CallerInfo>(key: K, value: CallerInfo[K] | undefined) => {
    if (value !== undefined) info[key] = value;
  };

  set("declared", str(declared));

  const meta = ctx.mcpReq?._meta ?? {};
  set("toolUseId", str(meta[TOOL_USE_KEY]));
  const extraMeta: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (key === TOOL_USE_KEY || !META_NAMESPACES.some((ns) => key.startsWith(ns))) continue;
    const text = str(value);
    if (text !== undefined) extraMeta[key] = text;
  }

  const headers = ctx.http?.req?.headers;
  let sessionId = str(ctx.sessionId);
  for (const name of SESSION_HEADERS) {
    if (sessionId) break;
    sessionId = str(headers?.get(name) ?? undefined);
  }
  // A meta key naming a session counts too, whatever its namespace.
  if (!sessionId) {
    const key = Object.keys(extraMeta).find((k) => /session/i.test(k));
    if (key) sessionId = extraMeta[key];
  }
  set("sessionId", sessionId);
  set("clientId", str(ctx.http?.authInfo?.clientId));

  const clientInfo = ctx.mcpReq?.envelope?.["io.modelcontextprotocol/clientInfo"] as
    | { name?: unknown; version?: unknown }
    | undefined;
  const clientName = str(clientInfo?.name);
  if (clientName) set("client", clip([clientName, str(clientInfo?.version)].filter(Boolean).join(" ")));
  set("userAgent", str(headers?.get("user-agent") ?? undefined));
  if (Object.keys(extraMeta).length > 0) info.meta = extraMeta;
  return info;
}
