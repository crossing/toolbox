// Thin FreeAgent API client for the read tools, mirroring
// tools/freeagent/internal/freeagent/client.go: bearer auth, JSON accept,
// mandatory User-Agent, list endpoints capped at per_page=100 (single page,
// same as the CLI).

import { boundFetch, FREEAGENT_BASE_URL, USER_AGENT, type Fetcher } from "./upstream";

export class FreeAgentApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// Detail tools take an API URL (FreeAgent's canonical resource identifier).
// The client only ever fetches URLs on the API host — a bearer token must
// never be sent to an arbitrary URL a model supplied.
export function isApiUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.origin === "https://api.freeagent.com" && url.pathname.startsWith("/v2/");
}

function errorMessage(status: number, body: string): string {
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    const errors = payload.errors ?? payload.error ?? payload.message;
    if (errors !== undefined) return `FreeAgent API error (status ${status}): ${JSON.stringify(errors)}`;
  } catch {
    // fall through — never echo a non-JSON body
  }
  return `FreeAgent API error (status ${status})`;
}

export class FreeAgentClient {
  constructor(
    private accessToken: string,
    private fetcher: Fetcher = boundFetch,
    private baseUrl: string = FREEAGENT_BASE_URL,
  ) {}

  async get(path: string, params?: Record<string, string | undefined>): Promise<unknown> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, value);
    }
    return this.request(url);
  }

  async getUrl(rawUrl: string): Promise<unknown> {
    if (!isApiUrl(rawUrl)) {
      throw new FreeAgentApiError(400, `url must be a FreeAgent API URL under ${FREEAGENT_BASE_URL}/`);
    }
    return this.request(new URL(rawUrl));
  }

  private async request(url: URL): Promise<unknown> {
    const response = await this.fetcher(url.toString(), {
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
    });
    const text = await response.text();
    if (!response.ok) throw new FreeAgentApiError(response.status, errorMessage(response.status, text));
    try {
      return JSON.parse(text);
    } catch {
      throw new FreeAgentApiError(response.status, "unparseable FreeAgent API response");
    }
  }
}

// Owner gate: only the configured company may bind this worker to its
// FreeAgent account — without this, any FreeAgent user who finds the
// connector URL could complete the flow and mint themselves a grant.
export async function fetchCompanySubdomain(client: FreeAgentClient): Promise<string> {
  const body = (await client.get("/company")) as { company?: { subdomain?: unknown } };
  const subdomain = body?.company?.subdomain;
  return typeof subdomain === "string" ? subdomain : "";
}
