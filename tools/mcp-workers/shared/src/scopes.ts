// Scope model shared by every toolbox MCP worker.
//
// Each worker exposes two MCP endpoints as distinct claude.ai connectors:
// a read endpoint (scope "read") and a read-write endpoint (scope "write",
// which implies read). Enforcement happens server-side in the endpoint
// handler; the scopes a token carries are fixed at consent time.

export const READ_SCOPE = "read";
export const WRITE_SCOPE = "write";

export interface OwnerProps {
  userId: string;
  scopes: string[];
  [key: string]: unknown;
}

export function hasScope(props: unknown, scope: string): boolean {
  if (typeof props !== "object" || props === null) return false;
  const scopes = (props as OwnerProps).scopes;
  return Array.isArray(scopes) && scopes.includes(scope);
}

// The scopes a grant should carry, given what the client asked for and
// whether the human ticked "allow writes" on the consent page. Unknown
// requested scopes are dropped; read is always granted (a token that can
// do nothing is useless), write only with explicit approval.
export function grantedScopes(requested: string[], writeApproved: boolean): string[] {
  const scopes = [READ_SCOPE];
  if (writeApproved && (requested.length === 0 || requested.includes(WRITE_SCOPE))) {
    scopes.push(WRITE_SCOPE);
  }
  return scopes;
}
