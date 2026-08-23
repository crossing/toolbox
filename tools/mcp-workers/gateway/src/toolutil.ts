// Result/error plumbing shared by the gateway's service tool modules, plus
// the gateway-specific failure modes every tool call can hit: a service
// toggled off on the management page, or an account parameter that matches
// no linked account. Both surface as clean tool errors pointing at /manage.

import { z } from "zod";
import { FreeAgentApiError, FreeAgentUpstreamError } from "./freeagentapi";
import { GoogleApiError } from "./googleapi";
import { UpstreamError } from "./google";

// Multi-account tools all take the same optional selector.
export const ACCOUNT_PARAM = z
  .string()
  .optional()
  .describe("Linked account to use (an email label from gateway_list_accounts); omit for the default account");

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
        ? `no linked ${service} account labelled "${label}" — check gateway_list_accounts, or link it on the management page`
        : `no ${service} account is linked yet — link one on the management page`,
    );
  }
}

export function asResult(body: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}

/**
 * Media results carry bytes. Images go back as an MCP image block — the model
 * sees the picture and pays image tokens for it. Anything else is described,
 * plus its bytes as base64 when the bridge judged it small enough to inline
 * (32 KB), because base64 in a text block costs ~1.37 characters per byte.
 */
export function asMedia(result: {
  ok: boolean;
  base64?: string;
  mimeType?: string;
  filename?: string | null;
  size?: number;
  detail?: string;
}) {
  const summary = JSON.stringify({
    ok: result.ok,
    mimeType: result.mimeType,
    filename: result.filename,
    size: result.size,
    detail: result.detail,
  });
  if (!result.ok || !result.base64) {
    return { content: [{ type: "text" as const, text: summary }], isError: !result.ok };
  }
  if (result.mimeType?.startsWith("image/")) {
    return {
      content: [
        { type: "image" as const, data: result.base64, mimeType: result.mimeType },
        { type: "text" as const, text: summary },
      ],
    };
  }
  return {
    content: [
      { type: "text" as const, text: summary },
      { type: "text" as const, text: result.base64 },
    ],
  };
}

/**
 * A result-typed call whose `ok: false` must reach the audit log as a failure.
 * `run()` cannot tell: it only sees a value that was returned rather than
 * thrown, and `auditedServer` reads `isError`.
 */
export async function runChecked(fn: () => Promise<{ ok: boolean; detail?: string | null }>) {
  try {
    const result = await fn();
    const body = { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    return result.ok ? body : { ...body, isError: true };
  } catch (err) {
    return asError(err);
  }
}

export class BridgeError extends Error {}

export function asError(err: unknown) {
  let text: string;
  if (err instanceof GoogleApiError && err.status === 401) {
    text = "Google rejected the access token (401). Re-link this account on the management page.";
  } else if (err instanceof FreeAgentApiError && err.status === 401) {
    text = "FreeAgent rejected the access token (401). Re-link this account on the management page.";
  } else if (
    err instanceof GoogleApiError ||
    err instanceof FreeAgentApiError ||
    err instanceof UpstreamError ||
    err instanceof FreeAgentUpstreamError ||
    err instanceof ServiceDisabledError ||
    err instanceof NoLinkedAccountError ||
    err instanceof BridgeError
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
