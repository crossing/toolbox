// Fakes for the file-layer tests: a GoogleClient that answers from a script
// and records every call, and a FileContext wired to them. Ids are obviously
// fake; nothing here touches a network.

import type { FileContext } from "../src/files/sources";
import { VaultStore } from "../src/vaultstore";
import { makeFakeSql } from "./sqlfake";

export interface GCall {
  op: "getJson" | "getRaw" | "getStream" | "sendJson" | "startResumableUpload" | "uploadToSession" | "sendBody";
  method: string;
  url: string;
  query?: Record<string, unknown>;
  body?: unknown;
  /** uploadToSession: the bytes actually streamed. */
  bytes?: Uint8Array;
  size?: number;
  options?: unknown;
}

export type Responder = (call: GCall) => unknown;

/** A GoogleClient look-alike: each call is recorded and answered by `respond` (throw to fail it). */
export function fakeGoogle(respond: Responder) {
  const calls: GCall[] = [];
  const answer = async (call: GCall) => {
    calls.push(call);
    return respond(call);
  };
  const client = {
    getJson: (url: string, query?: Record<string, unknown>) => answer({ op: "getJson", method: "GET", url, query }),
    async getRaw(url: string, query?: Record<string, unknown>) {
      const out = (await answer({ op: "getRaw", method: "GET", url, query })) as Uint8Array;
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    },
    async getStream(url: string, query?: Record<string, unknown>) {
      const out = (await answer({ op: "getStream", method: "GET", url, query })) as Uint8Array;
      return new Response(out).body!;
    },
    sendJson: (method: string, url: string, body: unknown, query?: Record<string, unknown>) =>
      answer({ op: "sendJson", method, url, body, query }),
    sendBody: (method: string, url: string, _ct: string, body: string, query?: Record<string, unknown>) =>
      answer({ op: "sendBody", method, url, body, query }),
    startResumableUpload: (metadata: unknown, mimeType: string, size?: number, options?: unknown) =>
      answer({ op: "startResumableUpload", method: "POST", url: mimeType, body: metadata, size, options }),
    async uploadToSession(url: string, body: ReadableStream<Uint8Array>, size: number) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      return answer({ op: "uploadToSession", method: "PUT", url, bytes, size });
    },
  };
  return { client, calls };
}

export function fakeVault() {
  const sql = makeFakeSql();
  return new VaultStore(sql);
}

export function fakeContext(parts: {
  drive?: ReturnType<typeof fakeGoogle>["client"];
  /** Per-account Drive clients, keyed by label ("" for the default). */
  drives?: Record<string, ReturnType<typeof fakeGoogle>["client"]>;
  gmail?: ReturnType<typeof fakeGoogle>["client"];
  whatsapp?: unknown;
  freeagent?: unknown;
  vault?: VaultStore;
}): FileContext & { driveAccounts: (string | undefined)[] } {
  const driveAccounts: (string | undefined)[] = [];
  return {
    driveAccounts,
    async drive(account?: string) {
      driveAccounts.push(account);
      const c = parts.drives?.[account ?? ""] ?? parts.drive;
      if (!c) throw new Error(`no fake drive for ${account ?? "default"}`);
      return c as never;
    },
    async gmail() {
      if (!parts.gmail) throw new Error("no fake gmail");
      return parts.gmail as never;
    },
    async whatsapp() {
      return parts.whatsapp as never;
    },
    async freeagent() {
      return parts.freeagent as never;
    },
    vault: parts.vault ?? fakeVault(),
  };
}

export const bytes = (text: string) => new TextEncoder().encode(text);
export const text = (b: Uint8Array) => new TextDecoder().decode(b);
