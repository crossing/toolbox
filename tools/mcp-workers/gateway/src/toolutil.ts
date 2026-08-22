// Result/error plumbing shared by the gateway's service tool modules, plus
// the gateway-specific failure modes every tool call can hit: a service
// toggled off on the management page, or an account parameter that matches
// no linked account. Both surface as clean tool errors pointing at /manage.

import { z } from "zod";
import { GoogleApiError } from "./googleapi";
import { UpstreamError } from "./google";

// Multi-account tools all take the same optional selector.
export const ACCOUNT_PARAM = z
  .string()
  .optional()
  .describe("Linked account to use (an email label from list_accounts); omit for the default account");

export const READ_ONLY = { readOnlyHint: true } as const;
export const WRITE = { readOnlyHint: false } as const;
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;

export class ServiceDisabledError extends Error {
  constructor(public service: string) {
    super(`the ${service} service is disabled for this gateway; enable it on the management page`);
  }
}

export class NoLinkedAccountError extends Error {
  constructor(service: string, label?: string) {
    super(
      label
        ? `no linked ${service} account labelled "${label}" — check list_accounts, or link it on the management page`
        : `no ${service} account is linked yet — link one on the management page`,
    );
  }
}

export function asResult(body: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}

export function asError(err: unknown) {
  let text: string;
  if (err instanceof GoogleApiError && err.status === 401) {
    text = "Google rejected the access token (401). Re-link this account on the management page.";
  } else if (
    err instanceof GoogleApiError ||
    err instanceof UpstreamError ||
    err instanceof ServiceDisabledError ||
    err instanceof NoLinkedAccountError
  ) {
    text = err.message;
  } else {
    text = "unexpected error calling the upstream service";
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
