// Result/error plumbing shared by the gmail and drive tool modules.

import { GoogleApiError } from "./api";
import { UpstreamError } from "./upstream";

export const READ_ONLY = { readOnlyHint: true } as const;
export const WRITE = { readOnlyHint: false } as const;
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;

export function asResult(body: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}

export function asError(err: unknown) {
  let text: string;
  if (err instanceof GoogleApiError && err.status === 401) {
    text = "Google rejected the access token (401). Reconnect this connector to re-authorize.";
  } else if (err instanceof GoogleApiError || err instanceof UpstreamError) {
    text = err.message;
  } else {
    text = "unexpected error calling Google";
  }
  return { content: [{ type: "text" as const, text }], isError: true };
}

export async function run(fn: () => Promise<unknown>) {
  try {
    return asResult(await fn());
  } catch (err) {
    return asError(err);
  }
}

export function needsConfirm() {
  return {
    content: [
      { type: "text" as const, text: "refusing without confirm: true — this action is destructive" },
    ],
    isError: true,
  };
}
