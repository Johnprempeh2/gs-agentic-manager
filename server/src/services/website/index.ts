import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { websiteProperties, websitePulls } from "@greatstone/db";
import {
  WEBSITE_PULL_INTERVAL_MS,
  type CreateWebsiteProperty,
  type UpdateWebsiteProperty,
  type WebsiteConnectionStatus,
  type WebsiteGa4Report,
  type WebsiteProperty,
  type WebsitePullError,
  type WebsitePullStatus,
  type WebsitePullSummary,
  type WebsitePullTrigger,
  type WebsiteReport,
  type WebsiteSearchConsoleReport,
} from "@greatstone/shared";
import { badRequest, conflict, notFound } from "../../errors.js";
import { secretService } from "../secrets.js";
import {
  GoogleApiError,
  createFixtureGoogleClient,
  createLiveGoogleClient,
  googleOAuthClientConfigFromEnv,
  websiteGoogleFixturesEnabled,
  type WebsiteGoogleClient,
} from "./google-client.js";
import {
  MAX_INSPECTED_PAGES,
  ga4BatchRequest,
  pageUrlForSite,
  parseGa4Batch,
  parseSearchConsole,
  reportRange,
  searchAnalyticsRequests,
} from "./reports.js";

// Website view (GRE-1087). Every read and write here is keyed by company:
// routes look a property up, check the caller's company access against the
// property's companyId, and only then call in. Google tokens never leave the
// secrets vault except to make a Google call; reports are stored only in this
// instance's database.

type PropertyRow = typeof websiteProperties.$inferSelect;
type PullRow = typeof websitePulls.$inferSelect;

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/** A pull row still "running" after this long was cut off by a restart. */
const STALE_RUNNING_PULL_MS = 30 * 60 * 1000;

interface PendingGoogleConnect {
  companyId: string;
  propertyId: string;
  userId: string;
  codeVerifier: string;
  redirectUri: string;
  returnTo: string | null;
  expiresAt: number;
}

// Pending sign-ins live in memory for ten minutes. A server restart drops
// them and the user simply starts the sign-in again.
const pendingConnects = new Map<string, PendingGoogleConnect>();
// One pull per property at a time, per process.
const pullsInFlight = new Set<string>();

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function prunePendingConnects(now: number) {
  for (const [state, pending] of pendingConnects) {
    if (pending.expiresAt <= now) pendingConnects.delete(state);
  }
}

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 500);
}

export interface WebsiteServiceOptions {
  /** Override the Google client (tests). Default: fixtures when enabled, else the live client when configured. */
  googleClient?: WebsiteGoogleClient | null;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export function resolveWebsiteGoogleClient(options: WebsiteServiceOptions = {}): WebsiteGoogleClient | null {
  if (options.googleClient !== undefined) return options.googleClient;
  const env = options.env ?? process.env;
  if (websiteGoogleFixturesEnabled(env)) return createFixtureGoogleClient();
  const config = googleOAuthClientConfigFromEnv(env);
  return config ? createLiveGoogleClient(config, options.fetchImpl ?? fetch) : null;
}

export function toWebsiteProperty(row: PropertyRow): WebsiteProperty {
  const connected = row.connectionStatus === "connected";
  const nextPullDueAt = connected
    ? new Date((row.lastPullAt?.getTime() ?? Date.now() - WEBSITE_PULL_INTERVAL_MS) + WEBSITE_PULL_INTERVAL_MS)
    : null;
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    siteUrl: row.siteUrl,
    ga4PropertyId: row.ga4PropertyId,
    connectionStatus: row.connectionStatus as WebsiteConnectionStatus,
    connectedAt: row.connectedAt?.toISOString() ?? null,
    lastPullAt: row.lastPullAt?.toISOString() ?? null,
    lastPullStatus: (row.lastPullStatus as WebsitePullStatus | null) ?? null,
    lastPullErrors: (row.lastPullErrors ?? []) as WebsitePullError[],
    nextPullDueAt: nextPullDueAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toPullSummary(row: PullRow): WebsitePullSummary {
  return {
    id: row.id,
    propertyId: row.propertyId,
    trigger: row.trigger as WebsitePullTrigger,
    status: row.status as WebsitePullStatus,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    range: { startDate: row.rangeStart, endDate: row.rangeEnd },
    errors: (row.errors ?? []) as WebsitePullError[],
  };
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown; cause?: { code?: unknown } })?.code
    ?? (err as { cause?: { code?: unknown } })?.cause?.code;
  return code === "23505";
}

export function websiteService(db: Db, options: WebsiteServiceOptions = {}) {
  const secrets = secretService(db);
  const google = resolveWebsiteGoogleClient(options);

  function requireGoogle(): WebsiteGoogleClient {
    if (!google) {
      throw badRequest(
        "Google sign-in is not set up on this instance. Set GSAM_TOOL_OAUTH_GOOGLE_CLIENT_ID and GSAM_TOOL_OAUTH_GOOGLE_CLIENT_SECRET.",
        { code: "website_google_not_configured" },
      );
    }
    return google;
  }

  async function getPropertyRow(propertyId: string): Promise<PropertyRow | null> {
    const [row] = await db.select().from(websiteProperties).where(eq(websiteProperties.id, propertyId)).limit(1);
    return row ?? null;
  }

  async function updatePropertyRow(propertyId: string, patch: Partial<typeof websiteProperties.$inferInsert>) {
    const [row] = await db
      .update(websiteProperties)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(websiteProperties.id, propertyId))
      .returning();
    if (!row) throw notFound("Website property not found");
    return row;
  }

  async function storeRefreshToken(property: PropertyRow, refreshToken: string, userId: string) {
    if (property.googleTokenSecretId) {
      const existing = await secrets.getById(property.googleTokenSecretId);
      if (existing && existing.status === "active" && existing.companyId === property.companyId) {
        await secrets.rotate(existing.id, { value: refreshToken }, { userId });
        return existing.id;
      }
    }
    const created = await secrets.create(
      property.companyId,
      {
        name: `Website Google sign-in ${property.id.slice(0, 8)}`,
        provider: "local_encrypted",
        value: refreshToken,
        description: `Read-only Google Analytics and Search Console access for ${property.siteUrl} (Website view).`,
      },
      { userId },
    );
    return created.id;
  }

  async function readRefreshToken(property: PropertyRow): Promise<string> {
    if (!property.googleTokenSecretId) throw new GoogleApiError("Website is not connected to Google", null, true);
    return secrets.resolveSecretValue(property.companyId, property.googleTokenSecretId, "latest", {
      accessContext: {
        consumerType: "system",
        consumerId: `website-view:${property.id}`,
        configPath: "google.refresh_token",
        actorType: "system",
      },
    });
  }

  async function latestPullWith(propertyId: string, column: "ga4Report" | "searchConsoleReport") {
    const [row] = await db
      .select()
      .from(websitePulls)
      .where(and(eq(websitePulls.propertyId, propertyId), isNotNull(websitePulls[column])))
      .orderBy(desc(websitePulls.startedAt))
      .limit(1);
    return row ?? null;
  }

  async function pullSearchConsole(
    client: WebsiteGoogleClient,
    accessToken: string,
    property: PropertyRow,
    range: ReturnType<typeof reportRange>,
    ga4: WebsiteGa4Report | null,
  ): Promise<WebsiteSearchConsoleReport> {
    const requests = searchAnalyticsRequests(range);
    const [totals, queries, daily] = await Promise.all([
      client.searchAnalyticsQuery(accessToken, property.siteUrl, requests.totals),
      client.searchAnalyticsQuery(accessToken, property.siteUrl, requests.query),
      client.searchAnalyticsQuery(accessToken, property.siteUrl, requests.date),
    ]);
    const urls = (ga4?.topPages ?? [])
      .map((page) => pageUrlForSite(property.siteUrl, page.path))
      .filter((url): url is string => Boolean(url))
      .slice(0, MAX_INSPECTED_PAGES);
    const inspections = [];
    // Sequential: URL Inspection is rate limited per site.
    for (const url of urls) {
      inspections.push({ url, response: await client.inspectUrl(accessToken, property.siteUrl, url) });
    }
    return parseSearchConsole({ range, totals, queries, daily, inspections });
  }

  /** Pull GA4 and Search Console for one property and store the result. */
  async function pullProperty(propertyId: string, trigger: WebsitePullTrigger, now = new Date()): Promise<WebsitePullSummary> {
    if (pullsInFlight.has(propertyId)) throw conflict("A pull is already running for this website");
    pullsInFlight.add(propertyId);
    try {
      const property = await getPropertyRow(propertyId);
      if (!property) throw notFound("Website property not found");
      if (property.connectionStatus === "not_connected" || !property.googleTokenSecretId) {
        throw badRequest("Connect Google before pulling", { code: "website_not_connected" });
      }
      const range = reportRange(now);
      await db
        .update(websitePulls)
        .set({ status: "failed", finishedAt: now, errors: [{ source: "auth", message: "Pull was interrupted by a restart" }] })
        .where(and(eq(websitePulls.propertyId, propertyId), eq(websitePulls.status, "running")));
      const [pull] = await db
        .insert(websitePulls)
        .values({
          companyId: property.companyId,
          propertyId,
          trigger,
          status: "running",
          rangeStart: range.startDate,
          rangeEnd: range.endDate,
          startedAt: now,
        })
        .returning();

      const errors: WebsitePullError[] = [];
      let ga4: WebsiteGa4Report | null = null;
      let searchConsole: WebsiteSearchConsoleReport | null = null;
      let needsReconnect = false;
      const client = google;
      let accessToken: string | null = null;
      if (!client) {
        errors.push({ source: "auth", message: "Google sign-in is not set up on this instance" });
      } else {
        try {
          accessToken = await client.refreshAccessToken(await readRefreshToken(property));
        } catch (err) {
          needsReconnect = err instanceof GoogleApiError && err.authRevoked;
          errors.push({
            source: "auth",
            message: needsReconnect ? "Google access was removed. Connect Google again." : errorMessage(err),
          });
        }
      }
      if (client && accessToken) {
        try {
          ga4 = parseGa4Batch(
            await client.batchRunReports(accessToken, property.ga4PropertyId, ga4BatchRequest(range)),
            range,
          );
        } catch (err) {
          errors.push({ source: "ga4", message: errorMessage(err) });
        }
        try {
          searchConsole = await pullSearchConsole(client, accessToken, property, range, ga4);
        } catch (err) {
          errors.push({ source: "search_console", message: errorMessage(err) });
        }
      }
      const status: WebsitePullStatus =
        ga4 && searchConsole ? "succeeded" : ga4 || searchConsole ? "partial" : "failed";
      const finishedAt = new Date();
      const [finished] = await db
        .update(websitePulls)
        .set({
          status,
          ga4Report: ga4 as unknown as Record<string, unknown> | null,
          searchConsoleReport: searchConsole as unknown as Record<string, unknown> | null,
          errors,
          finishedAt,
        })
        .where(eq(websitePulls.id, pull!.id))
        .returning();
      await updatePropertyRow(propertyId, {
        lastPullAt: finishedAt,
        lastPullStatus: status,
        lastPullErrors: errors,
        ...(needsReconnect ? { connectionStatus: "needs_reconnect" } : {}),
      });
      return toPullSummary(finished!);
    } finally {
      pullsInFlight.delete(propertyId);
    }
  }

  return {
    googleSignInAvailable: () => google !== null,

    getPropertyRow,

    async listProperties(companyId: string): Promise<WebsiteProperty[]> {
      const rows = await db
        .select()
        .from(websiteProperties)
        .where(eq(websiteProperties.companyId, companyId))
        .orderBy(websiteProperties.createdAt);
      return rows.map(toWebsiteProperty);
    },

    async createProperty(companyId: string, input: CreateWebsiteProperty): Promise<WebsiteProperty> {
      try {
        const [row] = await db
          .insert(websiteProperties)
          .values({ companyId, name: input.name, siteUrl: input.siteUrl, ga4PropertyId: input.ga4PropertyId })
          .returning();
        return toWebsiteProperty(row!);
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict("This website is already set up for the company");
        throw err;
      }
    },

    async updateProperty(property: PropertyRow, patch: UpdateWebsiteProperty): Promise<WebsiteProperty> {
      try {
        return toWebsiteProperty(await updatePropertyRow(property.id, patch));
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict("This website is already set up for the company");
        throw err;
      }
    },

    /** Start Google sign-in; returns the consent URL. */
    startGoogleConnect(input: {
      property: PropertyRow;
      userId: string;
      redirectUri: string;
      returnTo: string | null;
      now?: number;
    }): string {
      const client = requireGoogle();
      const now = input.now ?? Date.now();
      prunePendingConnects(now);
      const state = base64Url(randomBytes(32));
      const codeVerifier = base64Url(randomBytes(48));
      const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
      pendingConnects.set(state, {
        companyId: input.property.companyId,
        propertyId: input.property.id,
        userId: input.userId,
        codeVerifier,
        redirectUri: input.redirectUri,
        returnTo: input.returnTo,
        expiresAt: now + OAUTH_STATE_TTL_MS,
      });
      return client.authorizationUrl({ redirectUri: input.redirectUri, state, codeChallenge });
    },

    /** Look at a pending sign-in without using it up. */
    peekGoogleConnect(state: string, now = Date.now()): PendingGoogleConnect | null {
      const pending = pendingConnects.get(state);
      if (!pending || pending.expiresAt <= now) return null;
      return pending;
    },

    /** Finish Google sign-in: swap the code for a refresh token and keep it in the vault. */
    async completeGoogleConnect(input: { state: string; code: string | null; error: string | null }) {
      const pending = pendingConnects.get(input.state);
      pendingConnects.delete(input.state);
      if (!pending || pending.expiresAt <= Date.now()) {
        throw badRequest("This Google sign-in has expired. Start it again from the Website page.", {
          code: "website_google_state_invalid",
        });
      }
      if (input.error) {
        throw badRequest(`Google sign-in was not completed: ${input.error.slice(0, 200)}`, {
          code: "website_google_consent_denied",
        });
      }
      if (!input.code) throw badRequest("Google sign-in returned no code", { code: "website_google_state_invalid" });
      const client = requireGoogle();
      const property = await getPropertyRow(pending.propertyId);
      if (!property || property.companyId !== pending.companyId) throw notFound("Website property not found");
      const tokens = await client.exchangeCode({
        code: input.code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
      });
      if (!tokens.refresh_token) {
        throw badRequest(
          "Google did not return a long-lived sign-in. Remove GS Agentic Manager from your Google account's third-party access, then connect again.",
          { code: "website_google_no_refresh_token" },
        );
      }
      const secretId = await storeRefreshToken(property, tokens.refresh_token, pending.userId);
      const updated = await updatePropertyRow(property.id, {
        googleTokenSecretId: secretId,
        connectionStatus: "connected",
        connectedAt: new Date(),
        connectedByUserId: pending.userId,
      });
      return { property: toWebsiteProperty(updated), returnTo: pending.returnTo, userId: pending.userId };
    },

    async disconnectGoogle(property: PropertyRow): Promise<WebsiteProperty> {
      const secretId = property.googleTokenSecretId;
      if (secretId && google) {
        // Best effort: also end the grant at Google.
        try {
          await google.revoke(await readRefreshToken(property));
        } catch {
          // The vault copy is removed below either way.
        }
      }
      const updated = await updatePropertyRow(property.id, {
        googleTokenSecretId: null,
        connectionStatus: "not_connected",
        connectedAt: null,
        connectedByUserId: null,
      });
      if (secretId) await secrets.remove(secretId);
      return toWebsiteProperty(updated);
    },

    isPullRunning: (propertyId: string) => pullsInFlight.has(propertyId),

    pullProperty,

    /** Daily pull: every connected property whose last pull is a day old (or never ran). */
    async tickDuePulls(now = new Date()) {
      const dueBefore = new Date(now.getTime() - WEBSITE_PULL_INTERVAL_MS);
      const due = await db
        .select({ id: websiteProperties.id })
        .from(websiteProperties)
        .where(
          and(
            eq(websiteProperties.connectionStatus, "connected"),
            or(isNull(websiteProperties.lastPullAt), lte(websiteProperties.lastPullAt, dueBefore)),
          ),
        );
      const results: { propertyId: string; status: WebsitePullStatus | "error"; error?: string }[] = [];
      for (const { id } of due) {
        if (pullsInFlight.has(id)) continue;
        try {
          const pull = await pullProperty(id, "schedule", now);
          results.push({ propertyId: id, status: pull.status });
        } catch (err) {
          results.push({ propertyId: id, status: "error", error: errorMessage(err) });
        }
      }
      return { evaluated: due.length, results };
    },

    async getReport(property: PropertyRow): Promise<WebsiteReport> {
      const [lastRow] = await db
        .select()
        .from(websitePulls)
        .where(eq(websitePulls.propertyId, property.id))
        .orderBy(desc(websitePulls.startedAt))
        .limit(1);
      const [ga4Row, scRow] = await Promise.all([
        latestPullWith(property.id, "ga4Report"),
        latestPullWith(property.id, "searchConsoleReport"),
      ]);
      let lastPull = lastRow ? toPullSummary(lastRow) : null;
      if (
        lastPull?.status === "running" &&
        !pullsInFlight.has(property.id) &&
        Date.now() - new Date(lastPull.startedAt).getTime() > STALE_RUNNING_PULL_MS
      ) {
        lastPull = { ...lastPull, status: "failed", errors: [{ source: "auth", message: "Pull was interrupted by a restart" }] };
      }
      return {
        property: toWebsiteProperty(property),
        lastPull,
        ga4: (ga4Row?.ga4Report as unknown as WebsiteGa4Report | null) ?? null,
        ga4PulledAt: ga4Row?.finishedAt?.toISOString() ?? null,
        searchConsole: (scRow?.searchConsoleReport as unknown as WebsiteSearchConsoleReport | null) ?? null,
        searchConsolePulledAt: scRow?.finishedAt?.toISOString() ?? null,
      };
    },
  };
}

export type WebsiteService = ReturnType<typeof websiteService>;

/** Test seam: forget pending sign-ins and in-flight pulls. */
export function resetWebsiteServiceStateForTests() {
  pendingConnects.clear();
  pullsInFlight.clear();
}
