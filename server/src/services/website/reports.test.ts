import { describe, expect, it } from "vitest";
import { WEBSITE_GOOGLE_SCOPES } from "@greatstone/shared";
import { createLiveGoogleClient } from "./google-client.js";
import { ga4BatchRequest, pageUrlForSite, parseGa4Batch, parseSearchConsole, reportRange } from "./reports.js";

describe("website reports", () => {
  it("covers the last 28 full UTC days, ending yesterday", () => {
    expect(reportRange(new Date("2026-10-09T00:30:00Z"))).toEqual({ startDate: "2026-09-11", endDate: "2026-10-08" });
    expect(reportRange(new Date("2026-03-01T23:59:00Z"))).toEqual({ startDate: "2026-02-01", endDate: "2026-02-28" });
  });

  it("builds Search Console URLs for URL-prefix and domain properties", () => {
    expect(pageUrlForSite("https://www.example.com/", "/about")).toBe("https://www.example.com/about");
    expect(pageUrlForSite("sc-domain:example.com", "/about")).toBe("https://example.com/about");
    expect(pageUrlForSite("https://www.example.com/", "javascript:alert(1)")).toBeNull();
  });

  it("keeps GA4 to five requests in one batch call", () => {
    expect(ga4BatchRequest({ startDate: "2026-09-11", endDate: "2026-10-08" }).requests).toHaveLength(5);
  });

  it("reads empty Google responses as zeros, not errors", () => {
    const range = { startDate: "2026-09-11", endDate: "2026-10-08" };
    expect(parseGa4Batch({}, range)).toEqual({
      range,
      totals: { visitors: 0, sessions: 0, pageViews: 0, conversions: 0 },
      sources: [],
      topPages: [],
      conversions: [],
      dailyTrend: [],
    });
    const sc = parseSearchConsole({ range, totals: {}, queries: {}, daily: {}, inspections: [] });
    expect(sc.totals).toEqual({ clicks: 0, impressions: 0, ctr: 0, averagePosition: 0 });
    expect(sc.pagesNotIndexed).toEqual([]);
  });

  it("asks Google for the read-only scopes only, with PKCE and offline access", () => {
    const client = createLiveGoogleClient({ clientId: "client-1", clientSecret: "secret-1" }, async () => {
      throw new Error("no network in tests");
    });
    const url = new URL(
      client.authorizationUrl({ redirectUri: "https://app.example/api/website/google/callback", state: "s1", codeChallenge: "c1" }),
    );
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")).toBe(WEBSITE_GOOGLE_SCOPES.join(" "));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.has("client_secret")).toBe(false);
  });
});
