import { afterEach, describe, expect, it, vi } from "vitest";
import { callProjectTool, projectToolDefinitions } from "../services/project-tools.js";

const SITE = "8c1d7c2e-4f0a-4a51-9f4e-0d9c2b7a1e33";
const BASE = `http://gsam.test/api/companies/c1/website/sites/${SITE}`;

function call(name: string, args: Record<string, unknown>) {
  return callProjectTool({ name, arguments: { siteId: SITE, ...args }, apiUrl: "http://gsam.test/api", token: "t",
    companyId: "c1", issueId: "i1", agentId: "a1", conversation: false });
}

// GRE-2354 2c(a): website_data_list / website_data_get take the commerce resources and go through GSAM's commerce
// route, so its website:view check and the signed read apply. The tools only ever GET.
describe("website data tools: commerce reads", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("routes commerce resources, fx and payments to the commerce route, and customer records to the data route", async () => {
    const fetchMock = vi.fn(async () => Response.json({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    await call("website_data_list", { resource: "pricing-rules", limit: 5 });
    await call("website_data_list", { resource: "fx" });
    await call("website_data_list", { resource: "payments", from: "2026-10-01", to: "2026-10-31" });
    await call("website_data_get", { resource: "imports", id: "j1", cursor: "c2" });
    await call("website_data_get", { resource: "vendors", id: "v1", cursor: "ignored" });
    await call("website_data_list", { resource: "orders", customer: "x" });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${BASE}/commerce/pricing-rules?limit=5`,
      `${BASE}/commerce/fx`,
      `${BASE}/commerce/payments?from=2026-10-01&to=2026-10-31`,
      `${BASE}/commerce/imports/j1?cursor=c2`,
      `${BASE}/commerce/vendors/v1`,
      `${BASE}/data/orders?customer=x`,
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => !(init as RequestInit | undefined)?.method)).toBe(true);
  });

  it("has no get for the reports, and no tool can write", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(call("website_data_get", { resource: "payments", id: "x" })).rejects.toThrow(/use website_data_list/);
    await expect(call("website_data_list", { resource: "users" })).rejects.toThrow();
    const tools = projectToolDefinitions("standard").filter((tool) => tool.name.startsWith("website_data"));
    expect(tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint])).toEqual([["website_data_list", true], ["website_data_get", true]]);
    const getEnum = (tools[1]!.inputSchema as { properties: { resource: { enum: string[] } } }).properties.resource.enum;
    expect(getEnum).toContain("offerings");
    expect(getEnum).not.toContain("payments");
  });
});

// GRE-2354 2c(b), Everest's Q5 answer (GRE-2550): agents draft through GSAM's commerce routes. No tool can publish,
// archive, change FX, apply an import, issue an invoice or decide a refund.
describe("website commerce tools: drafts", () => {
  afterEach(() => vi.unstubAllGlobals());
  const ROW = "c0ffee00-0000-4000-8000-000000000001";
  const ROW2 = "c0ffee00-0000-4000-8000-000000000002";

  it("sends each draft to its typed route with an idempotency key the same agent's retry repeats", async () => {
    const fetchMock = vi.fn(async () => Response.json({ item: { id: ROW } }));
    vi.stubGlobal("fetch", fetchMock);
    await call("commerce_draft_create", { resource: "offerings", fields: { type: "product", slug: "w", name: "W" }, idempotencyKey: "k1" });
    await call("commerce_draft_create", { resource: "offerings", parentId: ROW, child: "variants", fields: { name: "V" }, idempotencyKey: "k2" });
    await call("commerce_draft_edit", { resource: "quotes", id: ROW, expectedRowVersion: 3, fields: { poReference: "PO-1" }, idempotencyKey: "k3" });
    await call("commerce_draft_delete", { resource: "offerings", id: ROW, child: "specs", childId: ROW2, idempotencyKey: "k4" });
    await call("commerce_convert_quote", { quoteId: ROW, idempotencyKey: "k5" });
    await call("commerce_import_dry_run", { filename: "f.csv", type: "offerings", rows: [{ rowNumber: 1, raw: {}, action: "skip" }], idempotencyKey: "k6" });
    await call("commerce_request_refund", { orderId: ROW, amountMinor: 500, reason: "Cancelled", idempotencyKey: "k7" });
    await call("commerce_draft_create", { resource: "offerings", fields: { type: "product", slug: "w", name: "W" }, idempotencyKey: "k1" });
    const sent = fetchMock.mock.calls.map(([url, init]) => {
      const req = init as RequestInit;
      return [req.method, String(url).replace(BASE, ""), req.body === undefined ? undefined : JSON.parse(String(req.body))];
    });
    expect(sent).toEqual([
      ["POST", "/commerce/offerings", { type: "product", slug: "w", name: "W" }],
      ["POST", `/commerce/offerings/${ROW}/variants`, { name: "V" }],
      ["PATCH", `/commerce/quotes/${ROW}`, { poReference: "PO-1", expectedRowVersion: 3 }],
      ["DELETE", `/commerce/offerings/${ROW}/specs/${ROW2}`, undefined],
      ["POST", `/commerce/quotes/${ROW}/convert`, undefined],
      ["POST", "/commerce/imports", { filename: "f.csv", type: "offerings", rows: [{ rowNumber: 1, raw: {}, action: "skip" }] }],
      ["POST", "/commerce/refund-requests", { orderId: ROW, amountMinor: 500, reason: "Cancelled" }],
      ["POST", "/commerce/offerings", { type: "product", slug: "w", name: "W" }],
    ]);
    const keys = fetchMock.mock.calls.map(([, init]) => ((init as RequestInit).headers as Record<string, string>)["Idempotency-Key"]);
    expect(keys.every((k) => /^[A-Za-z0-9_-]{22}$/.test(k!))).toBe(true);
    expect(new Set(keys.slice(0, 7)).size).toBe(7);
    expect(keys[7]).toBe(keys[0]);
  });

  it("cannot reach a people-only operation, set a draft's status, or name a non-uuid row", async () => {
    const fetchMock = vi.fn(async () => Response.json({ item: {} }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(call("commerce_draft_create", { resource: "offerings", fields: { status: "published" }, idempotencyKey: "k" })).rejects.toThrow(/no status/);
    await expect(call("commerce_draft_edit", { resource: "fx", id: ROW, expectedRowVersion: 1, fields: {}, idempotencyKey: "k" })).rejects.toThrow();
    await expect(call("commerce_draft_edit", { resource: "offerings", id: "x", expectedRowVersion: 1, fields: {}, idempotencyKey: "k" })).rejects.toThrow();
    await expect(call("commerce_draft_delete", { resource: "offerings", id: ROW, child: "specs", idempotencyKey: "k" })).rejects.toThrow(/go together/);
    expect(fetchMock).not.toHaveBeenCalled();
    const names = projectToolDefinitions("standard").map((tool) => tool.name).filter((name) => name.startsWith("commerce_"));
    expect(names).toEqual(["commerce_draft_create", "commerce_draft_edit", "commerce_draft_delete", "commerce_convert_quote",
      "commerce_import_dry_run", "commerce_request_refund"]);
    expect(names.some((name) => /publish|archive|fx|apply|issue|decide/.test(name))).toBe(false);
  });

  it("passes a stale row's current version back to the agent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { error: "The record changed on the website", code: "website_bridge_conflict", details: { current: { id: ROW, row_version: 9 } } }, { status: 409 })));
    await expect(call("commerce_draft_edit", { resource: "vendors", id: ROW, expectedRowVersion: 1, fields: { name: "N" }, idempotencyKey: "k" }))
      .rejects.toThrow(/row_version":9/);
  });
});
