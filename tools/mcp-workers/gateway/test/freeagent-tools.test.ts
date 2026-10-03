// FreeAgent list paging, response sanitizing and the attachment tools, driven
// against a scripted FreeAgent API (fake fetch). Ids, hosts and names are fake.

import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { contactUrl, listPage, registerFreeagentReadTools, SORT_MAX_UPSTREAM_PAGES, registerFreeagentWriteTools } from "../src/freeagent";
import {
  attachmentUrl,
  FreeAgentApiError,
  parseLinkHeader,
  sanitizeFreeagent,
  staticClient,
} from "../src/freeagentapi";

const API = "https://api.freeagent.com/v2";
const STORAGE = "https://storage.example.test/attachments/FAKE";
const PRESIGNED = `${STORAGE}/receipt.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=FAKE&X-Amz-Expires=30&X-Amz-Signature=FAKEsig`;

interface Call {
  method: string;
  url: URL;
  auth?: string;
}

function bill(n: number) {
  const month = String(((n - 1) % 12) + 1).padStart(2, "0");
  return {
    url: `${API}/bills/${n}`,
    reference: `FAKE-${n}`,
    dated_on: `${2010 + Math.floor((n - 1) / 12)}-${month}-01`,
    is_locked: n < 5,
    ...(n < 5 && { locked_reason: "FAKE period locked" }),
    attachment: {
      url: `${API}/attachments/${900 + n}`,
      content_src: PRESIGNED,
      content_src_medium: PRESIGNED,
      content_src_small: PRESIGNED,
      expires_at: "2026-10-03T12:00:30Z",
      content_type: "application/pdf",
      file_name: `bill-${n}.pdf`,
      file_size: 3,
    },
  };
}

/**
 * A FreeAgent API holding `count` bills (bill n dated later than bill n-1),
 * paged the way the API docs describe (Link + X-Total-Count), plus attachment
 * 901 and its storage. By default the upstream order is by date; `order`
 * replaces it, as the live API (not ordered by date) does. `growAfter` adds
 * that many bills once the first list page has been served, to simulate a
 * record arriving mid-read.
 */
function fakeApi(
  count: number,
  opts: { headers?: boolean; storageBytes?: Uint8Array; order?: number[]; growAfterFirstPage?: number } = {},
) {
  const calls: Call[] = [];
  const bills = (opts.order ?? Array.from({ length: count }, (_, i) => i + 1)).map(bill);
  let grown = false;
  const storage = opts.storageBytes ?? new TextEncoder().encode("abc");
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    calls.push({ method, url, ...(auth !== undefined && { auth }) });
    if (url.origin === "https://storage.example.test") return new Response(storage);
    if (url.pathname === "/v2/bills") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const per = Number(url.searchParams.get("per_page") ?? "25");
      const slice = bills.slice((page - 1) * per, page * per);
      if (opts.growAfterFirstPage && !grown) {
        grown = true;
        for (let i = 0; i < opts.growAfterFirstPage; i++) bills.unshift(bill(count + 1 + i));
      }
      const last = Math.max(1, Math.ceil(bills.length / per));
      const headers = new Headers();
      if (opts.headers !== false) {
        const link = (p: number, rel: string) => `<${API}/bills?page=${p}&per_page=${per}>; rel="${rel}"`;
        const parts = [link(1, "first"), link(last, "last")];
        if (page < last) parts.push(link(page + 1, "next"));
        headers.set("link", parts.join(", "));
        headers.set("x-total-count", String(bills.length));
      }
      return new Response(JSON.stringify({ bills: slice }), { headers });
    }
    if (url.pathname === "/v2/attachments/901") {
      if (method === "DELETE") return new Response("", { status: 200 });
      return new Response(JSON.stringify({ attachment: bill(1).attachment }));
    }
    return new Response(JSON.stringify({ errors: [{ message: "not found" }] }), { status: 404 });
  };
  return { calls, fetcher };
}

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function tools(fetcher: Parameters<typeof staticClient>[1]) {
  const map = new Map<string, Handler>();
  const server = { registerTool: (n: string, _c: unknown, h: Handler) => map.set(n, h) } as unknown as McpServer;
  const client = staticClient("FAKEtoken", fetcher);
  registerFreeagentReadTools(server, async () => client);
  registerFreeagentWriteTools(server, async () => client);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const result = await map.get(name)!(args);
    const raw = result.content[0]!.text ?? "null";
    return { ...result, body: (result.isError ? { error: raw } : JSON.parse(raw)) as Record<string, unknown> };
  };
}

const refs = (body: Record<string, unknown>) => (body.bills as { reference: string }[]).map((b) => b.reference);

describe("parseLinkHeader", () => {
  it("reads page numbers per rel", () => {
    expect(
      parseLinkHeader(`<${API}/bills?page=2&per_page=5>; rel="prev", <${API}/bills?page=4&per_page=5>; rel="next", <${API}/bills?page=9>; rel="last"`),
    ).toEqual({ prev: 2, next: 4, last: 9 });
    expect(parseLinkHeader(null)).toEqual({});
    expect(parseLinkHeader("garbage")).toEqual({});
  });
});

describe("listPage", () => {
  it("upstream: one request, page/per_page passed, next_page from the Link header", async () => {
    const { calls, fetcher } = fakeApi(12);
    const out = await listPage(staticClient("t", fetcher), "/bills", "bills", { view: "paid" }, { page: 2, perPage: 5, order: "upstream" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("page")).toBe("2");
    expect(calls[0]!.url.searchParams.get("per_page")).toBe("5");
    expect(calls[0]!.url.searchParams.get("view")).toBe("paid");
    expect(refs(out)).toEqual(["FAKE-6", "FAKE-7", "FAKE-8", "FAKE-9", "FAKE-10"]);
    expect(out).toMatchObject({ page: 2, per_page: 5, next_page: 3, order: "upstream", total: 12 });
    const last = await listPage(staticClient("t", fetcher), "/bills", "bills", {}, { page: 3, perPage: 5, order: "upstream" });
    expect(last.next_page).toBeNull();
  });

  it("upstream without pagination headers: a full page implies a next one", async () => {
    const { fetcher } = fakeApi(10, { headers: false });
    const client = staticClient("t", fetcher);
    expect((await listPage(client, "/bills", "bills", {}, { page: 1, perPage: 5, order: "upstream" })).next_page).toBe(2);
    expect((await listPage(client, "/bills", "bills", {}, { page: 2, perPage: 6, order: "upstream" })).next_page).toBeNull();
  });

  it("newest sorts on the date whatever FreeAgent's own order is, and pages agree", async () => {
    // Upstream order deliberately not by date, as the live expenses list is.
    const order = [7, 2, 12, 1, 9, 4, 11, 3, 10, 6, 8, 5];
    const { calls, fetcher } = fakeApi(12, { order });
    const client = staticClient("t", fetcher);
    const p1 = await listPage(client, "/bills", "bills", {}, { page: 1, perPage: 5, order: "newest", dateField: "dated_on" });
    expect(refs(p1)).toEqual(["FAKE-12", "FAKE-11", "FAKE-10", "FAKE-9", "FAKE-8"]);
    expect(p1).toMatchObject({ page: 1, per_page: 5, next_page: 2, order: "newest", total: 12 });
    expect(p1.note).toBeUndefined();
    // One read of the whole filtered list, 100 at a time.
    expect(calls.map((c) => `${c.url.searchParams.get("page")}/${c.url.searchParams.get("per_page")}`)).toEqual(["1/100"]);

    const p2 = await listPage(client, "/bills", "bills", {}, { page: 2, perPage: 5, order: "newest", dateField: "dated_on" });
    expect(refs(p2)).toEqual(["FAKE-7", "FAKE-6", "FAKE-5", "FAKE-4", "FAKE-3"]);
    const p3 = await listPage(client, "/bills", "bills", {}, { page: 3, perPage: 5, order: "newest", dateField: "dated_on" });
    expect(refs(p3)).toEqual(["FAKE-2", "FAKE-1"]);
    expect(p3.next_page).toBeNull();

    const past = await listPage(client, "/bills", "bills", {}, { page: 4, perPage: 5, order: "newest", dateField: "dated_on" });
    expect(past.bills).toEqual([]);
    expect(past.next_page).toBeNull();
  });

  it("oldest sorts ascending on the date", async () => {
    const { fetcher } = fakeApi(6, { order: [4, 6, 1, 5, 2, 3] });
    const out = await listPage(staticClient("t", fetcher), "/bills", "bills", {}, { page: 1, perPage: 4, order: "oldest", dateField: "dated_on" });
    expect(refs(out)).toEqual(["FAKE-1", "FAKE-2", "FAKE-3", "FAKE-4"]);
    expect(out).toMatchObject({ order: "oldest", next_page: 2, total: 6 });
  });

  it("reads every upstream page of 100 before sorting", async () => {
    const { calls, fetcher } = fakeApi(230);
    const out = await listPage(staticClient("t", fetcher), "/bills", "bills", {}, { page: 1, perPage: 3, order: "newest", dateField: "dated_on" });
    expect(refs(out)).toEqual(["FAKE-230", "FAKE-229", "FAKE-228"]);
    expect(calls.map((c) => c.url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(out.total).toBe(230);
  });

  it("past the sort ceiling, falls back to FreeAgent's order and says so", async () => {
    const { calls, fetcher } = fakeApi(SORT_MAX_UPSTREAM_PAGES * 100 + 1);
    const out = await listPage(staticClient("t", fetcher), "/bills", "bills", {}, { page: 1, perPage: 25, order: "newest", dateField: "dated_on" });
    expect(out.order).toBe("upstream");
    expect(out.note).toMatch(/too many to sort/);
    expect(calls).toHaveLength(SORT_MAX_UPSTREAM_PAGES + 1);
  });

  it("notes when the list changed while it was read", async () => {
    const { fetcher } = fakeApi(150, { growAfterFirstPage: 1 });
    const out = await listPage(staticClient("t", fetcher), "/bills", "bills", {}, { page: 1, perPage: 5, order: "newest", dateField: "dated_on" });
    expect(out.note).toMatch(/changed while it was being read/);
    // The bill pushed onto page 2 by the insert is not listed twice.
    const urls = (out.bills as { url: string }[]).map((b) => b.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("an empty list makes one request", async () => {
    const { calls, fetcher } = fakeApi(0);
    const out = await listPage(staticClient("t", fetcher), "/bills", "bills", {}, { page: 1, perPage: 25, order: "newest", dateField: "dated_on" });
    expect(out).toMatchObject({ bills: [], next_page: null, total: 0 });
    expect(calls).toHaveLength(1);
  });

  it("sorts without pagination headers, stopping at a short page", async () => {
    const { calls, fetcher } = fakeApi(3, { headers: false, order: [2, 3, 1] });
    const out = await listPage(staticClient("t", fetcher), "/bills", "bills", {}, { page: 1, perPage: 25, order: "newest", dateField: "dated_on" });
    expect(refs(out)).toEqual(["FAKE-3", "FAKE-2", "FAKE-1"]);
    expect(out.note).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe("freeagent_bills_list", () => {
  it("defaults to newest first, 25 per page, and passes the filters", async () => {
    const { calls, fetcher } = fakeApi(30);
    const call = tools(fetcher);
    const { body } = await call("freeagent_bills_list", {});
    expect((body.bills as unknown[]).length).toBe(25);
    expect(refs(body)[0]).toBe("FAKE-30");
    expect(body).toMatchObject({ page: 1, per_page: 25, next_page: 2, order: "newest" });

    calls.length = 0;
    await call("freeagent_bills_list", {
      view: "open_or_overdue",
      from_date: "2026-01-01",
      to_date: "2026-09-30",
      updated_since: "2026-09-01T00:00:00Z",
      contact: "123",
      sort: "upstream",
      page: 2,
      per_page: 10,
    });
    expect(calls).toHaveLength(1);
    const q = calls[0]!.url.searchParams;
    expect(Object.fromEntries(q)).toEqual({
      view: "open_or_overdue",
      from_date: "2026-01-01",
      to_date: "2026-09-30",
      updated_since: "2026-09-01T00:00:00Z",
      contact: `${API}/contacts/123`,
      page: "2",
      per_page: "10",
    });
  });

  it("never returns presigned attachment URLs, and leads with the lock state", async () => {
    const { fetcher } = fakeApi(3);
    const result = await tools(fetcher)("freeagent_bills_list", {});
    const text = result.content[0]!.text!;
    expect(text).not.toMatch(/content_src|X-Amz|storage\.example|expires_at/);
    const first = (result.body.bills as Record<string, unknown>[])[2]!;
    expect(Object.keys(first).slice(0, 3)).toEqual(["url", "is_locked", "locked_reason"]);
    expect(first.attachment).toEqual({
      id: "901",
      url: `${API}/attachments/901`,
      content_type: "application/pdf",
      file_name: "bill-1.pdf",
      file_size: 3,
    });
  });
});

describe("contactUrl", () => {
  it("accepts an id or a contact API URL, nothing else", () => {
    expect(contactUrl("42")).toBe(`${API}/contacts/42`);
    expect(contactUrl(`${API}/contacts/42`)).toBe(`${API}/contacts/42`);
    expect(() => contactUrl(`${API}/bills/42`)).toThrow(FreeAgentApiError);
    expect(() => contactUrl("https://evil.example/v2/contacts/42")).toThrow(FreeAgentApiError);
  });
});

describe("sanitizeFreeagent", () => {
  it("strips every content_src field and presigned URL at any depth", () => {
    const out = sanitizeFreeagent({
      bank_transaction: {
        url: `${API}/bank_transactions/1`,
        bank_transaction_explanations: [
          {
            url: `${API}/bank_transaction_explanations/2`,
            is_locked: true,
            locked_reason: "FAKE",
            attachment: bill(1).attachment,
          },
        ],
        receipt_preview: PRESIGNED,
        note: "https://example.test/plain",
      },
      attachments: [{ url: `${API}/attachments/7`, content_src: PRESIGNED, expires_at: "x", file_name: "a.pdf" }],
    }) as Record<string, any>;
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/content_src|X-Amz|expires_at/);
    expect(out.bank_transaction.note).toBe("https://example.test/plain");
    expect(out.bank_transaction.bank_transaction_explanations[0].attachment.id).toBe("901");
    expect(out.attachments[0]).toEqual({ id: "7", url: `${API}/attachments/7`, file_name: "a.pdf" });
  });

  it("drops presigned URL strings inside arrays too", () => {
    expect(sanitizeFreeagent({ files: [PRESIGNED, "kept", { href: PRESIGNED, name: "x" }] })).toEqual({
      files: ["kept", { name: "x" }],
    });
    expect(sanitizeFreeagent([PRESIGNED, `${API}/bills/1`])).toEqual([`${API}/bills/1`]);
  });

});

describe("attachment tools", () => {
  it("attachmentUrl takes an id or the API URL only", () => {
    expect(attachmentUrl("901")).toBe(`${API}/attachments/901`);
    expect(attachmentUrl(`${API}/attachments/901`)).toBe(`${API}/attachments/901`);
    expect(() => attachmentUrl(`${API}/bills/901`)).toThrow(FreeAgentApiError);
    expect(() => attachmentUrl("https://evil.example/v2/attachments/901")).toThrow(FreeAgentApiError);
  });

  it("freeagent_attachment_get returns sanitized metadata", async () => {
    const { fetcher } = fakeApi(0);
    const result = await tools(fetcher)("freeagent_attachment_get", { attachment_id: `${API}/attachments/901` });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).not.toMatch(/content_src|X-Amz/);
    expect(result.body.attachment).toMatchObject({ id: "901", file_name: "bill-1.pdf", file_size: 3 });
  });

  it("freeagent_attachment_delete refuses without confirm and sends nothing", async () => {
    const { calls, fetcher } = fakeApi(0);
    const result = await tools(fetcher)("freeagent_attachment_delete", { attachment_id: "901" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/confirm: true/);
    expect(calls).toHaveLength(0);
  });

  it("freeagent_attachment_delete with confirm sends DELETE /v2/attachments/:id", async () => {
    const { calls, fetcher } = fakeApi(0);
    const result = await tools(fetcher)("freeagent_attachment_delete", { attachment_id: "901", confirm: true });
    expect(result.body).toEqual({ deleted: true, id: "901" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url.toString()).toBe(`${API}/attachments/901`);
  });

  it("openAttachment fetches the presigned URL without the bearer token", async () => {
    const { calls, fetcher } = fakeApi(0);
    const { attachment, body } = await staticClient("FAKEtoken", fetcher).openAttachment("901");
    expect(new TextDecoder().decode(await new Response(body).arrayBuffer())).toBe("abc");
    expect(JSON.stringify(attachment)).not.toMatch(/content_src|X-Amz/);
    const storage = calls.find((c) => c.url.origin === "https://storage.example.test")!;
    expect(storage.auth).toBeUndefined();
    expect(calls[0]!.auth).toBe("Bearer FAKEtoken");
  });
});
