// freeagent-mcp — Phase 0 spike.
//
// A hello-world McpAgent behind the full workers-oauth-provider handshake, so
// the claude.ai / Claude Desktop connector flow (dynamic client registration,
// authorize, token, streamable HTTP) is proven before any real FreeAgent OAuth
// or API work lands. Phase 1 replaces the local consent page with the
// FreeAgent upstream login and the ping tools with the real tool surface.

import { OAuthProvider, type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import {
  decodeAuthRequest,
  encodeAuthRequest,
  grantedScopes,
  hasScope,
  renderApprovalPage,
  requireWrite,
  WRITE_SCOPE,
  type OwnerProps,
} from "@toolbox/mcp-shared";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  FREEAGENT_READ_MCP: DurableObjectNamespace;
  FREEAGENT_RW_MCP: DurableObjectNamespace;
}

const SERVER_NAME = "freeagent";
const SERVER_VERSION = "0.1.0";

export class FreeagentReadMCP extends McpAgent<Env, unknown, OwnerProps> {
  server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  async init() {
    this.server.registerTool(
      "ping",
      {
        description: "Connectivity spike: echoes back its input with the grant's scopes.",
        inputSchema: { message: z.string() },
      },
      async ({ message }) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ echo: message, scopes: this.props?.scopes ?? [] }),
          },
        ],
      }),
    );
    if (hasScope(this.props, WRITE_SCOPE)) {
      this.server.registerTool(
        "ping_write",
        {
          description: "Connectivity spike for the write endpoint: pretends to write.",
          inputSchema: { message: z.string() },
        },
        async ({ message }) => ({
          content: [{ type: "text", text: JSON.stringify({ wrote: message }) }],
        }),
      );
    }
  }
}

// Same agent code; a separate DO class so read and rw sessions never share
// instances and the wrangler binding names the split explicitly.
export class FreeagentRwMCP extends FreeagentReadMCP {}

const readHandler = FreeagentReadMCP.serve("/mcp", { binding: "FREEAGENT_READ_MCP" });
const rwHandler = requireWrite(FreeagentRwMCP.serve("/rw", { binding: "FREEAGENT_RW_MCP" }));

// Phase 0 consent flow: no upstream IdP yet, just an explicit human approval
// page. Phase 1 swaps this for the FreeAgent login redirect + company check.
const authHandler = {
  async fetch(request: Request, rawEnv: unknown, _ctx: ExecutionContext): Promise<Response> {
    const env = rawEnv as Env;
    const url = new URL(request.url);
    if (url.pathname !== "/authorize") {
      return new Response("not found", { status: 404 });
    }

    if (request.method === "GET") {
      const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
      const page = renderApprovalPage({
        serverName: SERVER_NAME,
        clientName: client?.clientName ?? authRequest.clientId,
        redirectUri: authRequest.redirectUri,
        requestedScopes: authRequest.scope,
        encodedAuthRequest: encodeAuthRequest(authRequest),
        offerWrite: true,
      });
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (request.method === "POST") {
      const form = await request.formData();
      const encoded = form.get("auth_request");
      if (typeof encoded !== "string") {
        return new Response("missing auth_request", { status: 400 });
      }
      const authRequest = decodeAuthRequest<AuthRequest>(encoded);
      const scopes = grantedScopes(authRequest.scope, form.get("allow_write") === "1");
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: authRequest,
        userId: "owner",
        metadata: { phase: "spike" },
        scope: scopes,
        props: { userId: "owner", scopes } satisfies OwnerProps,
      });
      return Response.redirect(redirectTo, 302);
    }

    return new Response("method not allowed", { status: 405 });
  },
};

export default new OAuthProvider({
  apiHandlers: {
    "/mcp": readHandler,
    "/rw": rwHandler,
  },
  defaultHandler: authHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["read", "write"],
});
