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
