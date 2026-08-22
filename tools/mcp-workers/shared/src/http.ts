// HTTP helpers shared by the workers' upstream OAuth clients.

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

// Never default to a bare `fetch` reference: calling it detached from
// globalThis throws "Illegal invocation" in workerd (Node is tolerant, so
// tests won't catch it).
export const boundFetch: Fetcher = (input, init) => fetch(input, init);

// Only the OAuth error/error_description fields surface, never a raw
// response body that could echo a credential.
export function sanitizedTokenError(body: string): string {
  try {
    const payload: unknown = JSON.parse(body);
    if (typeof payload !== "object" || payload === null) throw new Error();
    const record = payload as Record<string, unknown>;
    const error = typeof record.error === "string" ? record.error : "unknown";
    const description =
      typeof record.error_description === "string" ? record.error_description : "no description";
    return `${error}: ${description}`;
  } catch {
    return "unparseable token endpoint response";
  }
}
