import { and, count, desc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  activityLog,
  agents,
  authUsers,
  websiteEntry,
  websitePage,
  websiteRelease,
  websiteSitemapOption,
} from "@greatstone/db";
import {
  WEBSITE_PAGE_STATUSES,
  type WebsiteHomeActivity,
  type WebsiteHomeRelease,
  type WebsiteHomeSummary,
  type WebsitePageStatus,
  type WebsitePublishApprovalPayload,
} from "@greatstone/shared";
import { websitePublishApprovals } from "./publish-approval.js";
import type { SiteRow } from "./module.js";

const ACTIVITY_LIMIT = 8;

type ReleaseRow = typeof websiteRelease.$inferSelect;
type Framing = WebsiteHomeSummary["liveFraming"];

/**
 * Whether a page with these headers lets GSAM show it in a frame. A browser
 * fires `load` on a refused frame too, so the page cannot tell; the headers can.
 * ponytail: any frame-ancestors list without `*` counts as refused, even one that names GSAM's own origin.
 */
export function framingFromHeaders(headers: Pick<Headers, "get">): Exclude<Framing, "unknown"> {
  if (headers.get("x-frame-options")) return "refused";
  const ancestors = /frame-ancestors([^;]*)/i.exec(headers.get("content-security-policy") ?? "")?.[1];
  if (ancestors !== undefined && !ancestors.trim().split(/\s+/).includes("*")) return "refused";
  return "allowed";
}

const FRAMING_TTL_MS = 10 * 60_000;
const framingCache = new Map<string, { at: number; value: Framing }>();

/** One HEAD request to the site's own domain (set by a person with Publish rights), cached ten minutes. */
async function liveFraming(domain: string): Promise<Framing> {
  const cached = framingCache.get(domain);
  if (cached && Date.now() - cached.at < FRAMING_TTL_MS) return cached.value;
  let value: Framing = "unknown";
  try {
    const res = await fetch(`https://${domain}/`, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(3_000) });
    value = framingFromHeaders(res.headers);
  } catch {
    // Unreachable or slow: the page falls back to its own load timer.
  }
  framingCache.set(domain, { at: Date.now(), value });
  return value;
}

/**
 * The Website Home (24 Oct 2026): page and entry counts, the sitemap and
 * release state, the open Publish proposal and the last website events, in
 * one company-scoped read. Counts only; the lists stay on their own routes.
 */
export function websiteHomeService(db: Db) {
  const publishApprovals = websitePublishApprovals(db);

  async function userNames(ids: string[]) {
    const unique = [...new Set(ids)].filter((id) => id !== "local-board");
    const rows = unique.length
      ? await db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, unique))
      : [];
    const names = new Map(rows.map((row) => [row.id, row.name]));
    names.set("local-board", "Board");
    return names;
  }

  function releaseView(row: ReleaseRow | undefined, names: Map<string, string>): WebsiteHomeRelease | null {
    if (!row) return null;
    return {
      id: row.id,
      number: row.number,
      kind: row.kind as WebsiteHomeRelease["kind"],
      status: row.status as WebsiteHomeRelease["status"],
      liveAt: row.liveAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      publishedByName: row.publishedByUserId ? names.get(row.publishedByUserId) ?? null : null,
    };
  }

  async function activity(site: SiteRow): Promise<WebsiteHomeActivity[]> {
    const rows = await db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, site.companyId),
        or(like(activityLog.action, "website.%"), eq(activityLog.action, "approval.created")),
        or(eq(activityLog.entityId, site.id), sql`${activityLog.details}->>'siteId' = ${site.id}`),
      ))
      .orderBy(desc(activityLog.createdAt))
      .limit(ACTIVITY_LIMIT);

    const idsOf = (type: string) => rows.filter((row) => row.entityType === type).map((row) => row.entityId);
    const subjects = new Map<string, string>();
    const pageIds = idsOf("website_page");
    if (pageIds.length) {
      for (const row of await db.select({ id: websitePage.id, title: websitePage.title }).from(websitePage).where(and(eq(websitePage.companyId, site.companyId), inArray(websitePage.id, pageIds)))) {
        subjects.set(row.id, row.title);
      }
    }
    const entryIds = idsOf("website_entry");
    if (entryIds.length) {
      for (const row of await db.select({ id: websiteEntry.id, collection: websiteEntry.collection, key: websiteEntry.entryKey }).from(websiteEntry).where(and(eq(websiteEntry.companyId, site.companyId), inArray(websiteEntry.id, entryIds)))) {
        subjects.set(row.id, `${row.collection}/${row.key}`);
      }
    }
    const optionIds = idsOf("website_sitemap_option");
    if (optionIds.length) {
      for (const row of await db.select({ id: websiteSitemapOption.id, name: websiteSitemapOption.name }).from(websiteSitemapOption).where(and(eq(websiteSitemapOption.companyId, site.companyId), inArray(websiteSitemapOption.id, optionIds)))) {
        subjects.set(row.id, row.name);
      }
    }
    const releaseIds = idsOf("website_release");
    if (releaseIds.length) {
      for (const row of await db.select({ id: websiteRelease.id, number: websiteRelease.number }).from(websiteRelease).where(and(eq(websiteRelease.companyId, site.companyId), inArray(websiteRelease.id, releaseIds)))) {
        subjects.set(row.id, `Release ${row.number}`);
      }
    }

    const agentIds = [...new Set(rows.filter((row) => row.actorType === "agent").map((row) => row.agentId ?? row.actorId))];
    const agentNames = new Map(
      (agentIds.length
        ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, site.companyId), inArray(agents.id, agentIds)))
        : []
      ).map((row) => [row.id, row.name]),
    );
    const people = await userNames(rows.filter((row) => row.actorType === "user").map((row) => row.actorId));

    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      actorType: row.actorType,
      actorName: row.actorType === "agent"
        ? agentNames.get(row.agentId ?? row.actorId) ?? null
        : row.actorType === "user"
          ? people.get(row.actorId) ?? null
          : null,
      subject: subjects.get(row.entityId) ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async function summary(site: SiteRow): Promise<WebsiteHomeSummary> {
    const { companyId } = site;
    const pageCounts = await db
      .select({ status: websitePage.status, n: count() })
      .from(websitePage)
      .where(and(eq(websitePage.companyId, companyId), eq(websitePage.siteId, site.id), isNull(websitePage.archivedAt)))
      .groupBy(websitePage.status);
    const pages = Object.fromEntries(WEBSITE_PAGE_STATUSES.map((status) => [status, 0])) as Record<WebsitePageStatus, number>;
    for (const row of pageCounts) {
      if (row.status in pages) pages[row.status as WebsitePageStatus] = Number(row.n);
    }

    const entryCounts = await db
      .select({ collection: websiteEntry.collection, n: count() })
      .from(websiteEntry)
      .where(and(eq(websiteEntry.companyId, companyId), eq(websiteEntry.siteId, site.id), isNull(websiteEntry.archivedAt)))
      .groupBy(websiteEntry.collection);
    const collections = Object.fromEntries(
      entryCounts.filter((row) => row.collection !== "media").map((row) => [row.collection, Number(row.n)]),
    );

    const options = await db
      .select({
        id: websiteSitemapOption.id,
        name: websiteSitemapOption.name,
        status: websiteSitemapOption.status,
        approvedAt: websiteSitemapOption.approvedAt,
        updatedAt: websiteSitemapOption.updatedAt,
      })
      .from(websiteSitemapOption)
      .where(and(
        eq(websiteSitemapOption.companyId, companyId),
        eq(websiteSitemapOption.siteId, site.id),
        inArray(websiteSitemapOption.status, ["draft", "approved"]),
      ));
    // At most one approved option per site (unique index).
    const approved = options.find((option) => option.status === "approved");

    const [latest] = await db
      .select()
      .from(websiteRelease)
      .where(and(eq(websiteRelease.companyId, companyId), eq(websiteRelease.siteId, site.id)))
      .orderBy(desc(websiteRelease.number))
      .limit(1);
    const live = site.liveReleaseId && site.liveReleaseId !== latest?.id
      ? (await db.select().from(websiteRelease).where(and(eq(websiteRelease.companyId, companyId), eq(websiteRelease.id, site.liveReleaseId))))[0]
      : site.liveReleaseId ? latest : undefined;
    const names = await userNames([latest?.publishedByUserId, live?.publishedByUserId].filter((id): id is string => !!id));

    const open = await publishApprovals.openProposal(companyId, site.id);
    const payload = (open?.payload ?? {}) as Partial<WebsitePublishApprovalPayload>;

    return {
      pages,
      sitemap: {
        approved: approved
          ? {
            id: approved.id,
            name: approved.name,
            approvedAt: approved.approvedAt?.toISOString() ?? null,
            changedSinceApproval: !!approved.approvedAt && approved.updatedAt.getTime() > approved.approvedAt.getTime(),
          }
          : null,
        awaitingReview: options.filter((option) => option.status === "draft").length,
      },
      releases: { latest: releaseView(latest, names), live: releaseView(live, names) },
      publishApproval: open && open.status === "pending"
        ? { id: open.id, title: payload.title ?? "Publish the approved changes", changeCount: payload.changeCount ?? 0, createdAt: open.createdAt.toISOString() }
        : null,
      collections,
      activity: await activity(site),
      liveFraming: await liveFraming(site.domain),
    };
  }

  return { summary };
}
