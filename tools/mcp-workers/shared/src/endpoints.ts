import { WRITE_SCOPE, hasScope } from "./scopes";

interface FetchHandler {
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response>;
}

// The OAuth provider attaches the grant's props to the execution context
// before invoking an API handler.
type PropsCtx = ExecutionContext & { props?: unknown };

// Wraps an MCP endpoint handler so that only tokens whose grant carries the
// required scope get through. This is the server-side half of the read/rw
// split; conditional tool registration in the agent is the UX half.
export function requireScope(scope: string, inner: FetchHandler): FetchHandler {
  return {
    async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
      if (!hasScope((ctx as PropsCtx).props, scope)) {
        return new Response(
          JSON.stringify({ error: "insufficient_scope", scope }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
      return inner.fetch(request, env, ctx);
    },
  };
}

export function requireWrite(inner: FetchHandler): FetchHandler {
  return requireScope(WRITE_SCOPE, inner);
}
