import {
  WEBSITE_REPORT_RANGE_DAYS,
  type WebsiteDateRange,
  type WebsiteGa4Report,
  type WebsitePageNotIndexed,
  type WebsiteSearchConsoleReport,
} from "@greatstone/shared";
import type {
  Ga4BatchRunReportsResponse,
  Ga4RunReportResponse,
  SearchAnalyticsResponse,
  UrlInspectionResponse,
} from "./google-client.js";

// Website view (GRE-1087): the Google requests a pull makes and the parsers
// that turn Google's responses into the shared report types. Pure functions,
// so the recorded fixtures test them directly.

const TOP_ROWS = 10;
const TOP_QUERIES = 25;
/** URL Inspection has a daily quota; check only the GA4 top pages. */
export const MAX_INSPECTED_PAGES = TOP_ROWS;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The last `WEBSITE_REPORT_RANGE_DAYS` full days in UTC, ending yesterday. */
export function reportRange(now: Date): WebsiteDateRange {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (WEBSITE_REPORT_RANGE_DAYS - 1));
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

/**
 * One GA4 `batchRunReports` call (max five requests). GA4 renamed
 * "conversions" to "key events"; we read `keyEvents` and call it conversions.
 */
export function ga4BatchRequest(range: WebsiteDateRange) {
  const dateRanges = [{ startDate: range.startDate, endDate: range.endDate }];
  return {
    requests: [
      {
        dateRanges,
        dimensions: [{ name: "date" }],
        metrics: [{ name: "totalUsers" }, { name: "sessions" }, { name: "keyEvents" }],
        orderBys: [{ dimension: { dimensionName: "date" } }],
        limit: 400,
      },
      {
        dateRanges,
        dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }],
        metrics: [{ name: "sessions" }, { name: "totalUsers" }],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: TOP_ROWS,
      },
      {
        dateRanges,
        dimensions: [{ name: "pagePath" }, { name: "pageTitle" }],
        metrics: [{ name: "screenPageViews" }, { name: "totalUsers" }],
        orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
        limit: TOP_ROWS,
      },
      {
        dateRanges,
        dimensions: [{ name: "eventName" }],
        metrics: [{ name: "keyEvents" }],
        metricFilter: {
          filter: { fieldName: "keyEvents", numericFilter: { operation: "GREATER_THAN", value: { int64Value: "0" } } },
        },
        orderBys: [{ metric: { metricName: "keyEvents" }, desc: true }],
        limit: TOP_ROWS,
      },
      {
        dateRanges,
        metrics: [{ name: "totalUsers" }, { name: "sessions" }, { name: "screenPageViews" }, { name: "keyEvents" }],
      },
    ],
  };
}

function num(value: string | number | undefined | null): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ga4Rows(report: Ga4RunReportResponse | undefined) {
  return (report?.rows ?? []).map((row) => ({
    dims: (row.dimensionValues ?? []).map((value) => value.value ?? ""),
    mets: (row.metricValues ?? []).map((value) => num(value.value)),
  }));
}

/** GA4 `date` dimension is YYYYMMDD. */
function ga4Date(value: string): string {
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value;
}

export function parseGa4Batch(response: Ga4BatchRunReportsResponse, range: WebsiteDateRange): WebsiteGa4Report {
  const [daily, sources, pages, conversions, totals] = response.reports ?? [];
  const totalRow = ga4Rows(totals)[0]?.mets ?? [0, 0, 0, 0];
  return {
    range,
    totals: {
      visitors: totalRow[0] ?? 0,
      sessions: totalRow[1] ?? 0,
      pageViews: totalRow[2] ?? 0,
      conversions: totalRow[3] ?? 0,
    },
    sources: ga4Rows(sources).map(({ dims, mets }) => ({
      source: dims[0] ?? "",
      medium: dims[1] ?? "",
      sessions: mets[0] ?? 0,
      visitors: mets[1] ?? 0,
    })),
    topPages: ga4Rows(pages).map(({ dims, mets }) => ({
      path: dims[0] ?? "",
      title: dims[1] ?? "",
      views: mets[0] ?? 0,
      visitors: mets[1] ?? 0,
    })),
    conversions: ga4Rows(conversions).map(({ dims, mets }) => ({
      eventName: dims[0] ?? "",
      count: mets[0] ?? 0,
    })),
    dailyTrend: ga4Rows(daily)
      .map(({ dims, mets }) => ({
        date: ga4Date(dims[0] ?? ""),
        visitors: mets[0] ?? 0,
        sessions: mets[1] ?? 0,
        conversions: mets[2] ?? 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export function searchAnalyticsRequests(range: WebsiteDateRange) {
  return {
    totals: { startDate: range.startDate, endDate: range.endDate },
    query: { startDate: range.startDate, endDate: range.endDate, dimensions: ["query"], rowLimit: TOP_QUERIES },
    date: { startDate: range.startDate, endDate: range.endDate, dimensions: ["date"], rowLimit: 400 },
  };
}

/** Turn a GA4 page path into the URL Search Console knows. */
export function pageUrlForSite(siteUrl: string, path: string): string | null {
  const base = siteUrl.startsWith("sc-domain:") ? `https://${siteUrl.slice("sc-domain:".length)}/` : siteUrl;
  try {
    const url = new URL(path, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function parseSearchConsole(input: {
  range: WebsiteDateRange;
  totals: SearchAnalyticsResponse;
  queries: SearchAnalyticsResponse;
  daily: SearchAnalyticsResponse;
  inspections: { url: string; response: UrlInspectionResponse }[];
}): WebsiteSearchConsoleReport {
  const total = input.totals.rows?.[0];
  const pagesNotIndexed: WebsitePageNotIndexed[] = [];
  for (const { url, response } of input.inspections) {
    const status = response.inspectionResult?.indexStatusResult;
    if (!status || status.verdict === "PASS") continue;
    pagesNotIndexed.push({
      url,
      verdict: status.verdict ?? "VERDICT_UNSPECIFIED",
      coverageState: status.coverageState ?? null,
      lastCrawlTime: status.lastCrawlTime ?? null,
    });
  }
  return {
    range: input.range,
    totals: {
      clicks: num(total?.clicks),
      impressions: num(total?.impressions),
      ctr: num(total?.ctr),
      averagePosition: num(total?.position),
    },
    queries: (input.queries.rows ?? []).map((row) => ({
      query: row.keys?.[0] ?? "",
      clicks: num(row.clicks),
      impressions: num(row.impressions),
      ctr: num(row.ctr),
      position: num(row.position),
    })),
    dailyTrend: (input.daily.rows ?? [])
      .map((row) => ({
        date: row.keys?.[0] ?? "",
        clicks: num(row.clicks),
        impressions: num(row.impressions),
        position: num(row.position),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    pagesInspected: input.inspections.length,
    pagesNotIndexed,
  };
}
