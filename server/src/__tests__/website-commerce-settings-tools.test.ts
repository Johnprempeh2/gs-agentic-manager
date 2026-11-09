import { afterEach, describe, expect, it, vi } from "vitest";
import { callProjectTool, projectToolDefinitions } from "../services/project-tools.js";

const SITE = "8c1d7c2e-4f0a-4a51-9f4e-0d9c2b7a1e33";
const ISSUE = "1550e000-0000-4000-8000-000000000001";
const BASE = `http://gsam.test/api/companies/c1/website/sites/${SITE}`;
const ROW = "c0ffee00-0000-4000-8000-000000000001";
const LEAD = `fd-${ROW}`;

function call(name: string, args: Record<string, unknown>) {
  return callProjectTool({ name, arguments: { siteId: SITE, ...args }, apiUrl: "http://gsam.test/api", token: "t",
    companyId: "c1", issueId: ISSUE, agentId: "a1", conversation: false });
}

const sentOf = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map(([url, init]) => {
  const req = init as RequestInit;
  return [req.method, String(url).replace(BASE, ""), req.body === undefined ? undefined : JSON.parse(String(req.body))];
});

// GRE-4783 (John, 5 Nov): agents may change every commerce setting, but anything that emails a client, changes money,
// or issues or revokes a licence key goes through a person's approval card. A plain edit goes to the write route; a
// people-only one goes only to change-requests, which opens a card and changes nothing.
describe("website commerce settings tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("makes plain status and record edits on their typed routes, with a key the same agent's retry repeats", async () => {
    const fetchMock = vi.fn(async () => Response.json({ item: { id: ROW } }));
    vi.stubGlobal("fetch", fetchMock);
    await call("commerce_order_set_status", { orderId: ROW, status: "fulfilled", expectedRowVersion: 2, idempotencyKey: "k1" });
    await call("commerce_enquiry_set_status", { enquiryId: `si-${ROW}`, status: "contacted", idempotencyKey: "k2" });
    await call("commerce_client_save", { fields: { name: "Acme" }, idempotencyKey: "k3" });
    await call("commerce_client_save", { customerId: ROW, fields: { notes: "Pays late" }, expectedRowVersion: 4, idempotencyKey: "k4" });
    await call("commerce_timeline_save", { customerId: ROW, fields: { title: "Kick-off" }, idempotencyKey: "k5" });
    await call("commerce_timeline_delete", { engagementId: ROW, expectedRowVersion: 1, idempotencyKey: "k6" });
    await call("commerce_licence_edit", { licenceId: ROW, fields: { seats: 5 }, expectedRowVersion: 3, idempotencyKey: "k7" });
    await call("commerce_tier_save", { fields: { slug: "gold", name: "Gold" }, idempotencyKey: "k8" });
    await call("commerce_tier_save", { tierId: ROW, fields: { rank: 2 }, idempotencyKey: "k9" });
    await call("commerce_activation_steps_set", { vendorId: ROW, activationSteps: "Open the app", expectedRowVersion: 1, idempotencyKey: "k10" });
    await call("commerce_order_set_status", { orderId: ROW, status: "fulfilled", expectedRowVersion: 2, idempotencyKey: "k1" });
    expect(sentOf(fetchMock)).toEqual([
      ["PATCH", `/commerce/orders/${ROW}`, { status: "fulfilled", expectedRowVersion: 2 }],
      ["PATCH", `/commerce/enquiries/si-${ROW}`, { status: "contacted" }],
      ["POST", "/commerce/customers", { name: "Acme" }],
      ["PATCH", `/commerce/customers/${ROW}`, { notes: "Pays late", expectedRowVersion: 4 }],
      ["POST", `/commerce/customers/${ROW}/engagements`, { title: "Kick-off" }],
      ["DELETE", `/commerce/engagements/${ROW}`, { expectedRowVersion: 1 }],
      ["PATCH", `/commerce/licences/${ROW}`, { seats: 5, expectedRowVersion: 3 }],
      ["POST", "/commerce/customer-tiers", { slug: "gold", name: "Gold" }],
      ["PATCH", `/commerce/customer-tiers/${ROW}`, { rank: 2 }],
      ["PUT", `/commerce/vendors/${ROW}/activation-steps`, { activationSteps: "Open the app", expectedRowVersion: 1 }],
      ["PATCH", `/commerce/orders/${ROW}`, { status: "fulfilled", expectedRowVersion: 2 }],
    ]);
    const keys = fetchMock.mock.calls.map(([, init]) => ((init as RequestInit).headers as Record<string, string>)["Idempotency-Key"]);
    expect(new Set(keys.slice(0, 10)).size).toBe(10);
    expect(keys[10]).toBe(keys[0]);
  });

  it("turns a people-only change into a card on the task, and never calls its write route", async () => {
    const fetchMock = vi.fn(async () => Response.json({ approval: { id: "card" } }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const results = [
      await call("commerce_client_save", { customerId: ROW, fields: { tierId: ROW }, expectedRowVersion: 4, note: "Agreed", idempotencyKey: "k1" }),
      await call("commerce_licence_edit", { licenceId: ROW, fields: { licenceKey: "AAAA-BBBB-CCCC-1234" }, idempotencyKey: "k2" }),
      await call("commerce_request_change", { action: "notify_licence", id: ROW }),
      await call("commerce_request_change", { action: "delete_lead", id: LEAD, note: "Asked to be forgotten" }),
      await call("commerce_request_change", { action: "issue_licence", id: ROW, fields: { offeringName: "Aspose.Total", downloadUrl: "https://x.test/f" } }),
      await call("commerce_request_change", { action: "revoke_licence", id: ROW, expectedRowVersion: 3 }),
      await call("commerce_request_change", { action: "reissue_licence", id: ROW }),
      await call("commerce_request_change", { action: "share_timeline_item", id: ROW, expectedRowVersion: 1 }),
      await call("commerce_request_change", { action: "unshare_timeline_item", id: ROW }),
      await call("commerce_request_change", { action: "resend_receipt", id: ROW }),
    ];
    expect(results.every((r) => r.changed === false && r.approval.id === "card")).toBe(true);
    const sent = sentOf(fetchMock);
    expect(sent.every(([method, path]) => method === "POST" && path === "/commerce/change-requests")).toBe(true);
    expect(sent.map(([, , body]) => body)).toEqual([
      { method: "PATCH", path: `customers/${ROW}`, body: { tierId: ROW, expectedRowVersion: 4 }, note: "Agreed", issueId: ISSUE },
      { method: "PATCH", path: `licences/${ROW}`, body: { licenceKey: "AAAA-BBBB-CCCC-1234" }, issueId: ISSUE },
      { method: "POST", path: `orders/${ROW}/notify-licence`, issueId: ISSUE },
      { method: "DELETE", path: `enquiries/${LEAD}`, note: "Asked to be forgotten", issueId: ISSUE },
      { method: "POST", path: `customers/${ROW}/licences`, body: { offeringName: "Aspose.Total", downloadUrl: "https://x.test/f" }, issueId: ISSUE },
      { method: "POST", path: `licences/${ROW}/revoke`, body: { expectedRowVersion: 3 }, issueId: ISSUE },
      { method: "POST", path: `licences/${ROW}/reissue`, issueId: ISSUE },
      { method: "POST", path: `engagements/${ROW}/share`, body: { expectedRowVersion: 1 }, issueId: ISSUE },
      { method: "POST", path: `engagements/${ROW}/unshare`, issueId: ISSUE },
      { method: "POST", path: `portal-acceptances/${ROW}/resend`, issueId: ISSUE },
    ]);
  });

  it("asks for a card when the site says a timeline item is shared", async () => {
    const fetchMock = vi.fn(async (url: string) => String(url).endsWith("/change-requests")
      ? Response.json({ approval: { id: "card" } }, { status: 201 })
      : Response.json({ error: "The website refused this change: only a person can do it.", code: "website_bridge_denied" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await call("commerce_timeline_save", { engagementId: ROW, fields: { title: "New" }, expectedRowVersion: 2, idempotencyKey: "k" });
    expect(result).toMatchObject({ changed: false, approval: { id: "card" } });
    expect(sentOf(fetchMock)).toEqual([
      ["PATCH", `/commerce/engagements/${ROW}`, { title: "New", expectedRowVersion: 2 }],
      ["POST", "/commerce/change-requests", { method: "PATCH", path: `engagements/${ROW}`, body: { title: "New", expectedRowVersion: 2 }, issueId: ISSUE }],
    ]);
    // any other refusal is the agent's to read, with no card
    fetchMock.mockImplementation(async () => Response.json({ error: "The record changed", code: "website_bridge_conflict" }, { status: 409 }));
    await expect(call("commerce_order_set_status", { orderId: ROW, status: "confirmed", idempotencyKey: "k2" })).rejects.toThrow(/record changed/);
  });

  it("refuses bad ids and shapes before any call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(call("commerce_request_change", { action: "delete_lead", id: `si-${ROW}` })).rejects.toThrow(/does not fit/);
    await expect(call("commerce_request_change", { action: "notify_licence", id: "x" })).rejects.toThrow(/does not fit/);
    await expect(call("commerce_request_change", { action: "revoke_licence", id: ROW, fields: { a: 1 } })).rejects.toThrow(/issue_licence only/);
    await expect(call("commerce_enquiry_set_status", { enquiryId: "x", status: "new", idempotencyKey: "k" })).rejects.toThrow();
    await expect(call("commerce_timeline_save", { fields: { title: "x" }, idempotencyKey: "k" })).rejects.toThrow(/customerId/);
    await expect(call("commerce_timeline_save", { customerId: ROW, fields: { status: "shared" }, idempotencyKey: "k" })).rejects.toThrow(/no status/);
    await expect(call("commerce_order_set_status", { orderId: ROW, status: "refunded", idempotencyKey: "k" })).rejects.toThrow();
    await expect(call("commerce_licence_edit", { licenceId: ROW, fields: { orderId: ROW }, idempotencyKey: "k" })).rejects.toThrow(/order/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists the settings tools with write hints, and the request tool only asks", () => {
    const tools = projectToolDefinitions("standard").filter((tool) => tool.name.startsWith("commerce_") && !/draft|convert|import|refund|publish/.test(tool.name));
    expect(tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint])).toEqual([
      ["commerce_order_set_status", false], ["commerce_enquiry_set_status", false], ["commerce_client_save", false],
      ["commerce_timeline_save", false], ["commerce_timeline_delete", false], ["commerce_licence_edit", false], ["commerce_tier_save", false],
      ["commerce_activation_steps_set", false], ["commerce_request_change", false],
    ]);
    expect(tools.find((tool) => tool.name === "commerce_request_change")!.description).toMatch(/changes nothing/);
  });
});
