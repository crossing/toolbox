// Stateless MCP serving for the OAuth-fronted workers.
//
// Each request builds its own McpServer from the grant's props and is then
// discarded: no session Durable Object, nothing held between calls. That is
// what agents' createMcpHandler expects (a factory, so concurrent requests
// never share a server), and it means a tool list always reflects the grant
// and configuration as they are now, not as they were when a session opened.
//
// Kept out of index.ts: agents/mcp/server and cloudflare:workers are
// worker-only, and the tests import index.ts under plain Node.

import type { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { DurableObject } from "cloudflare:workers";

/**
 * Browser Origins the handler accepts. createMcpHandler refuses a request
 * whose Origin is not on its list (default: localhost-class and workers.dev
 * only), where McpAgent allowed any. Requests without an Origin — claude.ai's
 * backend, Claude Code — are unaffected either way; these cover a client that
 * calls from the claude.ai page itself. Every request still needs a bearer
 * token from our OAuth provider, so this list is not the security boundary.
 */
export const CLIENT_ORIGIN_HOSTNAMES = ["claude.ai", "claude.com"];

/** Builds the server for one request from the worker env and the grant's props. */
export type BuildServer<E, P> = (env: E, props: P | undefined) => McpServer | Promise<McpServer>;

/**
 * The OAuthProvider `apiHandler` for `route`. The provider has already
 * verified the bearer token and put the grant's props on `ctx.props`.
 */
export function statelessMcpHandler<E, P>(route: string, build: BuildServer<E, P>) {
  return {
    // `env: unknown` because that is how OAuthProvider types its apiHandler;
    // it passes the worker's own env through untouched.
    fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
      const props = (ctx as ExecutionContext & { props?: P }).props;
      return createMcpHandler(() => build(env as E, props), {
        route,
        allowedOriginHostnames: CLIENT_ORIGIN_HOSTNAMES,
      })(request, env, ctx);
    },
  };
}

/**
 * The class each worker's sessions used to live in under McpAgent. Nothing
 * routes to it any more; it stays exported so that rolling back to the
 * McpAgent build needs no Durable Object migration. Delete it, with a
 * `deleted_classes` migration, once the stateless build has settled.
 */
export class RetiredSessionObject extends DurableObject {
  override fetch(): Response {
    return new Response("this MCP server no longer keeps sessions", { status: 410 });
  }
  // McpAgent could leave an alarm armed; let it fire into nothing.
  override alarm(): void {}
}
