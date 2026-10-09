// Website view (GRE-1085 / GRE-1087): a read-only view of a company's
// website, built from Google Analytics 4 and Search Console. Google sign-in
// uses read-only scopes only; the refresh token stays in the company secrets
// vault. A daily pull stores the reports in the instance database, and the
// page reads only what was stored. The whole surface sits behind the
// `enableWebsiteView` feature switch: when it is off, every Website route
// answers `403` with `code: "not_entitled"`.

/** Google OAuth scopes the Website view asks for. Read-only, nothing else. */
export const WEBSITE_GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
] as const;

/** Error `code` every Website route returns (with HTTP 403) when the switch is off. */
export const WEBSITE_NOT_ENTITLED_CODE = "not_entitled" as const;

/** Error `code` when the instance has no Google OAuth client configured. */
export const WEBSITE_GOOGLE_NOT_CONFIGURED_CODE = "website_google_not_configured" as const;

/** How often the scheduler pulls each connected property. */
export const WEBSITE_PULL_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Days covered by each pull, ending yesterday (UTC). */
export const WEBSITE_REPORT_RANGE_DAYS = 28;

/**
 * Website API routes, relative to `/api`. All are company-scoped and gated
 * by the `enableWebsiteView` switch.
 */
export const WEBSITE_API_ROUTES = {
  /** GET → `WebsiteOverview`. */
  overview: "/companies/:companyId/website",
  /** POST `CreateWebsiteProperty` → 201 `WebsiteProperty`. Owner or admin. */
  createProperty: "/companies/:companyId/website/properties",
  /** PATCH `UpdateWebsiteProperty` → `WebsiteProperty`. Owner or admin. */
  property: "/companies/:companyId/website/properties/:propertyId",
  /** GET → `WebsiteReport` (latest stored pull, last pull time and errors). */
  report: "/companies/:companyId/website/properties/:propertyId/report",
  /** POST `StartWebsiteGoogleConnect` → `WebsiteGoogleConnectStart`. Owner or admin. */
  connectGoogle: "/companies/:companyId/website/properties/:propertyId/google/connect",
  /** POST → `WebsiteProperty`. Removes the token from the vault. Owner or admin. */
  disconnectGoogle: "/companies/:companyId/website/properties/:propertyId/google/disconnect",
  /** POST → `WebsitePullSummary`. Runs a pull now. Board users. */
  pull: "/companies/:companyId/website/properties/:propertyId/pull",
  /** GET, called by Google after consent. Redirects back to the app. */
  googleCallback: "/website/google/callback",
} as const;

export type WebsiteConnectionStatus = "not_connected" | "connected" | "needs_reconnect";

export type WebsitePullStatus = "running" | "succeeded" | "partial" | "failed";

export type WebsitePullTrigger = "schedule" | "manual";

export type WebsitePullErrorSource = "auth" | "ga4" | "search_console";

export interface WebsitePullError {
  source: WebsitePullErrorSource;
  message: string;
}

export interface WebsiteDateRange {
  /** YYYY-MM-DD, inclusive. */
  startDate: string;
  /** YYYY-MM-DD, inclusive. */
  endDate: string;
}

export interface WebsiteProperty {
  id: string;
  companyId: string;
  name: string;
  /** Search Console property: `https://example.com/` or `sc-domain:example.com`. */
  siteUrl: string;
  /** GA4 property id, digits only (for example `"123456789"`). */
  ga4PropertyId: string;
  connectionStatus: WebsiteConnectionStatus;
  connectedAt: string | null;
  lastPullAt: string | null;
  lastPullStatus: WebsitePullStatus | null;
  lastPullErrors: WebsitePullError[];
  /** When the scheduler will pull next; null while not connected. */
  nextPullDueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebsiteOverview {
  /** True when the instance can start a Google sign-in (client configured or fixtures on). */
  googleSignInAvailable: boolean;
  properties: WebsiteProperty[];
}

export interface WebsiteGa4Totals {
  visitors: number;
  sessions: number;
  pageViews: number;
  conversions: number;
}

export interface WebsiteGa4Source {
  source: string;
  medium: string;
  sessions: number;
  visitors: number;
}

export interface WebsiteGa4Page {
  path: string;
  title: string;
  views: number;
  visitors: number;
}

export interface WebsiteGa4Conversion {
  eventName: string;
  count: number;
}

export interface WebsiteGa4DailyPoint {
  date: string;
  visitors: number;
  sessions: number;
  conversions: number;
}

export interface WebsiteGa4Report {
  range: WebsiteDateRange;
  totals: WebsiteGa4Totals;
  sources: WebsiteGa4Source[];
  topPages: WebsiteGa4Page[];
  conversions: WebsiteGa4Conversion[];
  dailyTrend: WebsiteGa4DailyPoint[];
}

export interface WebsiteSearchTotals {
  clicks: number;
  impressions: number;
  /** 0..1 */
  ctr: number;
  averagePosition: number;
}

export interface WebsiteSearchQuery {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface WebsiteSearchDailyPoint {
  date: string;
  clicks: number;
  impressions: number;
  position: number;
}

export interface WebsitePageNotIndexed {
  url: string;
  /** Google's verdict, for example `"NEUTRAL"` or `"FAIL"`. */
  verdict: string;
  /** Google's coverage text, for example `"Crawled - currently not indexed"`. */
  coverageState: string | null;
  lastCrawlTime: string | null;
}

export interface WebsiteSearchConsoleReport {
  range: WebsiteDateRange;
  totals: WebsiteSearchTotals;
  queries: WebsiteSearchQuery[];
  dailyTrend: WebsiteSearchDailyPoint[];
  /** URLs checked with the URL Inspection API (the GA4 top pages). */
  pagesInspected: number;
  pagesNotIndexed: WebsitePageNotIndexed[];
}

export interface WebsitePullSummary {
  id: string;
  propertyId: string;
  trigger: WebsitePullTrigger;
  status: WebsitePullStatus;
  startedAt: string;
  finishedAt: string | null;
  range: WebsiteDateRange;
  errors: WebsitePullError[];
}

export interface WebsiteReport {
  property: WebsiteProperty;
  /** The most recent pull attempt, whatever its result. */
  lastPull: WebsitePullSummary | null;
  /** GA4 data from the most recent pull that returned it. */
  ga4: WebsiteGa4Report | null;
  ga4PulledAt: string | null;
  /** Search Console data from the most recent pull that returned it. */
  searchConsole: WebsiteSearchConsoleReport | null;
  searchConsolePulledAt: string | null;
}

export interface WebsiteGoogleConnectStart {
  /** Open this URL in the browser to give consent. */
  authorizationUrl: string;
}
