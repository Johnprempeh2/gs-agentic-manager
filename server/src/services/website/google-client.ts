import { readFileSync } from "node:fs";
import { WEBSITE_GOOGLE_SCOPES } from "@greatstone/shared";

// Website view (GRE-1087): the only code that talks to Google. Two
// implementations share one interface: the live client calls Google over
// HTTPS with the instance's own OAuth client, and the fixture client answers
// from recorded responses in ./fixtures so tests and sandboxes need no
// network. Nothing here stores data; callers keep tokens in the vault and
// reports in the instance database.

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GA4_DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const SEARCH_CONSOLE_API = "https://searchconsole.googleapis.com";

export interface GoogleTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

/** GA4 Data API `RunReportResponse` (the fields we read). */
export interface Ga4RunReportResponse {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string; type?: string }[];
  rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
  totals?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
  rowCount?: number;
}

export interface Ga4BatchRunReportsResponse {
  reports?: Ga4RunReportResponse[];
}

/** Search Console `searchAnalytics.query` response. */
export interface SearchAnalyticsResponse {
  rows?: { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }[];
}

/** Search Console `urlInspection.index.inspect` response (the fields we read). */
export interface UrlInspectionResponse {
  inspectionResult?: {
    indexStatusResult?: {
      verdict?: string;
      coverageState?: string;
      lastCrawlTime?: string | null;
    };
  };
}

export interface WebsiteGoogleClient {
  readonly mode: "live" | "fixtures";
  authorizationUrl(input: { redirectUri: string; state: string; codeChallenge: string }): string;
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<GoogleTokenResponse>;
  refreshAccessToken(refreshToken: string): Promise<string>;
  revoke(token: string): Promise<void>;
  batchRunReports(accessToken: string, ga4PropertyId: string, body: { requests: unknown[] }): Promise<Ga4BatchRunReportsResponse>;
  searchAnalyticsQuery(
    accessToken: string,
    siteUrl: string,
    body: { startDate: string; endDate: string; dimensions?: string[]; rowLimit?: number },
  ): Promise<SearchAnalyticsResponse>;
  inspectUrl(accessToken: string, siteUrl: string, inspectionUrl: string): Promise<UrlInspectionResponse>;
}

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** True when the grant is gone and the user must sign in again. */
    readonly authRevoked = false,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

export interface GoogleOAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * The instance's Google OAuth client, from the same env names the tool OAuth
 * flow uses for a provider (`GSAM_TOOL_OAUTH_GOOGLE_CLIENT_ID` / `_SECRET`).
 */
export function googleOAuthClientConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GoogleOAuthClientConfig | null {
  const clientId = env.GSAM_TOOL_OAUTH_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GSAM_TOOL_OAUTH_GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** `GSAM_WEBSITE_GOOGLE_FIXTURES=1` answers every Google call from ./fixtures. */
export function websiteGoogleFixturesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.GSAM_WEBSITE_GOOGLE_FIXTURES?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

function googleErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const error = record.error;
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) return message.trim().slice(0, 500);
    }
    if (typeof record.error_description === "string") return record.error_description.slice(0, 500);
    if (typeof error === "string") return error.slice(0, 200);
  }
  return fallback;
}

export function createLiveGoogleClient(
  config: GoogleOAuthClientConfig,
  fetchImpl: typeof fetch = fetch,
): WebsiteGoogleClient {
  async function postForm(url: string, form: Record<string, string>): Promise<unknown> {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const revoked = response.status === 400 && (body as { error?: unknown } | null)?.error === "invalid_grant";
      throw new GoogleApiError(
        `Google sign-in failed: ${googleErrorMessage(body, `HTTP ${response.status}`)}`,
        response.status,
        revoked,
      );
    }
    return body;
  }

  async function postJson<T>(url: string, accessToken: string, payload: unknown, label: string): Promise<T> {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new GoogleApiError(
        `${label}: ${googleErrorMessage(body, `HTTP ${response.status}`)}`,
        response.status,
        response.status === 401,
      );
    }
    return body as T;
  }

  return {
    mode: "live",
    authorizationUrl({ redirectUri, state, codeChallenge }) {
      const url = new URL(GOOGLE_AUTHORIZE_URL);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", WEBSITE_GOOGLE_SCOPES.join(" "));
      url.searchParams.set("access_type", "offline");
      // Always ask for consent so Google returns a refresh token on reconnect.
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("include_granted_scopes", "false");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },
    async exchangeCode({ code, codeVerifier, redirectUri }) {
      return (await postForm(GOOGLE_TOKEN_URL, {
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      })) as GoogleTokenResponse;
    },
    async refreshAccessToken(refreshToken) {
      const body = (await postForm(GOOGLE_TOKEN_URL, {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      })) as GoogleTokenResponse;
      if (!body?.access_token) throw new GoogleApiError("Google sign-in returned no access token", null);
      return body.access_token;
    },
    async revoke(token) {
      await fetchImpl(GOOGLE_REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
      });
    },
    batchRunReports(accessToken, ga4PropertyId, body) {
      return postJson<Ga4BatchRunReportsResponse>(
        `${GA4_DATA_API}/properties/${encodeURIComponent(ga4PropertyId)}:batchRunReports`,
        accessToken,
        body,
        "Google Analytics",
      );
    },
    searchAnalyticsQuery(accessToken, siteUrl, body) {
      return postJson<SearchAnalyticsResponse>(
        `${SEARCH_CONSOLE_API}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        accessToken,
        body,
        "Search Console",
      );
    },
    inspectUrl(accessToken, siteUrl, inspectionUrl) {
      return postJson<UrlInspectionResponse>(
        `${SEARCH_CONSOLE_API}/v1/urlInspection/index:inspect`,
        accessToken,
        { inspectionUrl, siteUrl },
        "Search Console URL Inspection",
      );
    },
  };
}

function readFixture<T>(name: string): T {
  // Fixtures live next to the source; they are read on demand so a built
  // server that never turns fixtures on never needs them.
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  try {
    return JSON.parse(readFileSync(url, "utf8")) as T;
  } catch (err) {
    throw new GoogleApiError(
      `Website fixtures are missing (${name}); GSAM_WEBSITE_GOOGLE_FIXTURES needs a source checkout: ${(err as Error).message}`,
      null,
    );
  }
}

export const FIXTURE_AUTH_CODE = "fixture-auth-code";
export const FIXTURE_REFRESH_TOKEN = "fixture-refresh-token";

/**
 * Answers from recorded Google responses. Consent is skipped: the
 * authorization URL points straight at our own callback with a fixture code.
 */
export function createFixtureGoogleClient(): WebsiteGoogleClient {
  return {
    mode: "fixtures",
    authorizationUrl({ redirectUri, state }) {
      const url = new URL(redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("code", FIXTURE_AUTH_CODE);
      url.searchParams.set("scope", WEBSITE_GOOGLE_SCOPES.join(" "));
      return url.toString();
    },
    async exchangeCode({ code }) {
      if (code !== FIXTURE_AUTH_CODE) throw new GoogleApiError("Google sign-in failed: invalid_grant", 400, true);
      return readFixture<GoogleTokenResponse>("oauth-token.json");
    },
    async refreshAccessToken(refreshToken) {
      if (refreshToken !== FIXTURE_REFRESH_TOKEN) throw new GoogleApiError("Google sign-in failed: invalid_grant", 400, true);
      return readFixture<GoogleTokenResponse>("oauth-token.json").access_token;
    },
    async revoke() {},
    async batchRunReports() {
      return readFixture<Ga4BatchRunReportsResponse>("ga4-batch-run-reports.json");
    },
    async searchAnalyticsQuery(_accessToken, _siteUrl, body) {
      const recorded = readFixture<Record<string, SearchAnalyticsResponse>>("search-console-search-analytics.json");
      return recorded[body.dimensions?.[0] ?? "none"] ?? { rows: [] };
    },
    async inspectUrl(_accessToken, _siteUrl, inspectionUrl) {
      const recorded = readFixture<Record<string, UrlInspectionResponse>>("search-console-url-inspection.json");
      const path = new URL(inspectionUrl).pathname;
      return recorded[path] ?? recorded["*"]!;
    },
  };
}
