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
      "commerce_import_dry_run", "commerce_request_refund", "commerce_request_publish"]);
    // only asks: no tool publishes, archives or decides
    expect(names.filter((name) => !name.startsWith("commerce_request_")).some((name) => /publish|archive|fx|apply|issue|decide/.test(name))).toBe(false);
  });

  // GRE-4089: the agent asks; the route opens a card on its task and publishes nothing.
  it("asks to publish through the publish-requests route, linked to the agent's task, never the write route", async () => {
    const ISSUE = "1550e000-0000-4000-8000-000000000001";
    const fetchMock = vi.fn(async () => Response.json({ approval: { id: "a" } }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await callProjectTool({ name: "commerce_request_publish", arguments: { siteId: SITE, resource: "offerings", id: ROW, action: "publish", note: "Ready" },
      apiUrl: "http://gsam.test/api", token: "t", companyId: "c1", issueId: ISSUE, agentId: "a1", conversation: false });
    await call("commerce_request_publish", { resource: "vendors", id: ROW, action: "archive" });
    const sent = fetchMock.mock.calls.map(([url, init]) => [(init as RequestInit).method, String(url).replace(BASE, ""), JSON.parse(String((init as RequestInit).body))]);
    expect(sent).toEqual([
      ["POST", "/commerce/publish-requests", { resource: "offerings", id: ROW, action: "publish", note: "Ready", issueId: ISSUE }],
      ["POST", "/commerce/publish-requests", { resource: "vendors", id: ROW, action: "archive" }],
    ]);
    await expect(call("commerce_request_publish", { resource: "fx", id: ROW, action: "publish" })).rejects.toThrow();
    await expect(call("commerce_request_publish", { resource: "offerings", id: ROW, action: "delete" })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("passes a stale row's current version back to the agent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { error: "The record changed on the website", code: "website_bridge_conflict", details: { current: { id: ROW, row_version: 9 } } }, { status: 409 })));
    await expect(call("commerce_draft_edit", { resource: "vendors", id: ROW, expectedRowVersion: 1, fields: { name: "N" }, idempotencyKey: "k" }))
      .rejects.toThrow(/row_version":9/);
  });
});

// GRE-4085 (John, 5 Nov: "a person approves every access change"): agents read access and ask for a change; the ask
// opens a card. No tool calls a change route.
describe("website access tools", () => {
  afterEach(() => vi.unstubAllGlobals());
  const STAFF = "a0000000-0000-4000-8000-000000000002";
  const CLIENT = "c0000000-0000-4000-8000-000000000001";
  const MEMBER = "d0000000-0000-4000-8000-000000000001";
  const ISSUE = "1550e000-0000-4000-8000-000000000001";

  it("reads staff, portal approvers and a client's members with GETs only", async () => {
    const fetchMock = vi.fn(async () => Response.json({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    await call("website_access_list", { list: "staff" });
    await call("website_access_list", { list: "portal-approvers" });
    await call("website_access_list", { list: "client-members", customerId: CLIENT });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${BASE}/access/staff`, `${BASE}/access/portal-approvers`, `${BASE}/access/clients/${CLIENT}/members`,
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => !(init as RequestInit | undefined)?.method)).toBe(true);
    await expect(call("website_access_list", { list: "client-members" })).rejects.toThrow(/customerId/);
    await expect(call("website_access_list", { list: "staff", customerId: CLIENT })).rejects.toThrow(/customerId/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("asks through change-requests, linked to the agent's task, with a key the same ask repeats", async () => {
    const fetchMock = vi.fn(async () => Response.json({ approval: { id: "a" } }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const ask = (args: Record<string, unknown>) => callProjectTool({ name: "website_access_request_change", arguments: { siteId: SITE, ...args },
      apiUrl: "http://gsam.test/api", token: "t", companyId: "c1", issueId: ISSUE, agentId: "a1", conversation: false });
    await ask({ kind: "approver_set", staffId: STAFF, label: "Finance lead", note: "Runs finance" });
    await ask({ kind: "member_add", customerId: CLIENT, email: "New@Client.example.test", name: "Nia", role: "member" });
    await ask({ kind: "member_remove", customerId: CLIENT, membershipId: MEMBER });
    await ask({ kind: "approver_set", staffId: STAFF, label: "Finance lead", note: "Runs finance" });
    const sent = fetchMock.mock.calls.map(([url, init]) => [(init as RequestInit).method, String(url).replace(BASE, ""), JSON.parse(String((init as RequestInit).body))]);
    expect(sent.slice(0, 3)).toEqual([
      ["POST", "/access/change-requests", { change: { kind: "approver_set", staffId: STAFF, label: "Finance lead" }, note: "Runs finance", issueId: ISSUE }],
      ["POST", "/access/change-requests", { change: { kind: "member_add", customerId: CLIENT, email: "new@client.example.test", name: "Nia", role: "member" }, issueId: ISSUE }],
      ["POST", "/access/change-requests", { change: { kind: "member_remove", customerId: CLIENT, membershipId: MEMBER }, issueId: ISSUE }],
    ]);
    const keys = fetchMock.mock.calls.map(([, init]) => ((init as RequestInit).headers as Record<string, string>)["Idempotency-Key"]);
    expect(keys[3]).toBe(keys[0]);
    expect(new Set(keys.slice(0, 3)).size).toBe(3);
  });

  it("refuses a malformed ask before any call, and no access tool can change access itself", async () => {
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    await expect(call("website_access_request_change", { kind: "staff_role", staffId: STAFF, role: "god" })).rejects.toThrow();
    await expect(call("website_access_request_change", { kind: "staff_role", staffId: STAFF, role: "admin", label: "x" })).rejects.toThrow();
    await expect(call("website_access_request_change", { kind: "member_role", customerId: CLIENT, role: "admin" })).rejects.toThrow();
    await expect(call("website_access_request_change", { kind: "delete_everyone" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    const tools = projectToolDefinitions("standard").filter((tool) => tool.name.startsWith("website_access"));
    expect(tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint])).toEqual([["website_access_list", true], ["website_access_request_change", false]]);
  });

  it("passes the route's refusal back to the agent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { error: "Access changes are off for this site: no write key is set up", code: "capability_not_configured" }, { status: 409 })));
    await expect(call("website_access_request_change", { kind: "approver_remove", staffId: STAFF })).rejects.toThrow(/Access changes are off/);
  });
});

// GRE-4083: agents draft portal documents through GSAM's portal document routes. No tool approves and publishes or
// withdraws: those are a person's click.
describe("website portal document tools", () => {
  afterEach(() => vi.unstubAllGlobals());
  const CLIENT = "c0000000-0000-4000-8000-000000000001";
  const DOC = "d0c00000-0000-4000-8000-000000000001";
  const body = { sections: [{ id: "intro", title: "Intro", html: "<p>Hello <a href=\"https://greatstone.test\">us</a></p>" }] };

  it("sends create, edit, submit and return to draft to their routes, with a key the same agent's retry repeats", async () => {
    const fetchMock = vi.fn(async () => Response.json({ item: { id: DOC } }));
    vi.stubGlobal("fetch", fetchMock);
    await call("portal_document_create", { customerId: CLIENT, kind: "engagement_pack", title: "Pack", body, action: "accept",
      confirmationText: "I accept", idempotencyKey: "k1" });
    await call("portal_document_edit", { documentId: DOC, expectedRowVersion: 1, summary: null, title: "Pack 2", idempotencyKey: "k2" });
    await call("portal_document_submit", { documentId: DOC, expectedRowVersion: 2, idempotencyKey: "k3" });
    await call("portal_document_return_to_draft", { documentId: DOC, expectedRowVersion: 3, idempotencyKey: "k4" });
    await call("portal_document_create", { customerId: CLIENT, kind: "engagement_pack", title: "Pack", body, action: "accept",
      confirmationText: "I accept", idempotencyKey: "k1" });
    const sent = fetchMock.mock.calls.map(([url, init]) => [(init as RequestInit).method, String(url).replace(BASE, ""), JSON.parse(String((init as RequestInit).body))]);
    expect(sent.slice(0, 4)).toEqual([
      ["POST", "/portal-documents", { customerId: CLIENT, kind: "engagement_pack", title: "Pack", body, action: "accept", confirmationText: "I accept" }],
      ["PATCH", `/portal-documents/${DOC}`, { expectedRowVersion: 1, summary: null, title: "Pack 2" }],
      ["POST", `/portal-documents/${DOC}/submit`, { expectedRowVersion: 2 }],
      ["POST", `/portal-documents/${DOC}/return-to-draft`, { expectedRowVersion: 3 }],
    ]);
    const keys = fetchMock.mock.calls.map(([, init]) => ((init as RequestInit).headers as Record<string, string>)["Idempotency-Key"]);
    expect(keys.every((k) => /^[A-Za-z0-9_-]{22}$/.test(k!))).toBe(true);
    expect(new Set(keys.slice(0, 4)).size).toBe(4);
    expect(keys[4]).toBe(keys[0]);
  });

  it("refuses bad fields and HTML before any call, and has no tool to approve, publish or withdraw", async () => {
    const fetchMock = vi.fn(async () => Response.json({ item: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const create = (args: Record<string, unknown>) => call("portal_document_create", { customerId: CLIENT, kind: "nda", title: "NDA", idempotencyKey: "k", ...args });
    await expect(create({ kind: "contract" })).rejects.toThrow();
    await expect(create({ status: "published" })).rejects.toThrow();
    await expect(create({ body: { sections: [{ id: "a", title: "A", html: "<script>x</script>" }] } })).rejects.toThrow(/<script> is not allowed/);
    await expect(create({ body: { sections: [{ id: "a", title: "A", html: "<a href=\"javascript:x\">x</a>" }] } })).rejects.toThrow(/https:/);
    await expect(create({ demos: [{ label: "Demo", url: "http://insecure.test" }] })).rejects.toThrow(/https/);
    await expect(call("portal_document_edit", { documentId: DOC, expectedRowVersion: 1, idempotencyKey: "k" })).rejects.toThrow(/at least one/);
    await expect(call("portal_document_submit", { documentId: "x", expectedRowVersion: 1, idempotencyKey: "k" })).rejects.toThrow();
    await expect(call("portal_document_submit", { expectedRowVersion: 1, idempotencyKey: "k" })).rejects.toThrow(/documentId/);
    expect(fetchMock).not.toHaveBeenCalled();
    const names = projectToolDefinitions("standard").map((tool) => tool.name).filter((name) => name.startsWith("portal_"));
    expect(names).toEqual(["portal_document_create", "portal_document_edit", "portal_document_submit", "portal_document_return_to_draft"]);
    expect(names.some((name) => /approv|publish|withdraw/.test(name))).toBe(false);
  });

  it("passes the route's refusal and a stale document back to the agent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { error: "The record changed on the website", code: "website_bridge_conflict", details: { current: { id: DOC, row_version: 4 } } }, { status: 409 })));
    await expect(call("portal_document_submit", { documentId: DOC, expectedRowVersion: 1, idempotencyKey: "k" })).rejects.toThrow(/row_version":4/);
  });
});
