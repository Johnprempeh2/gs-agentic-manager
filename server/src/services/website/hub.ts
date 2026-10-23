import { and, desc, eq, ilike, isNull, like, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { agents, assets, issueAttachments, issueComments, issueWorkProducts, issues } from "@greatstone/db";
import {
  WEBSITE_SITEMAP_PREFIX,
  type WebsiteHub,
  type WebsiteHubPreviewLink,
  type WebsiteHubSitemap,
  type WebsiteHubTask,
  type WebsiteHubWorkItem,
} from "@greatstone/shared";

// Website hub (23 Oct 2026): what the website project has made, read from
// rows GSAM already keeps. Everything is limited to visible tasks in the
// linked project, in the property's company.

const RECENT_WORK_LIMIT = 5;
const PREVIEW_LINK_LIMIT = 12;
const COMMENT_SCAN_LIMIT = 50;

/** Netlify site and deploy-preview links (`https://deploy-preview-12--site.netlify.app/path`). */
const NETLIFY_URL_RE = /https:\/\/[a-z0-9-]+(?:--[a-z0-9-]+)?\.netlify\.app(?:\/[^\s)<>\]"'`]*)?/gi;

export function findNetlifyUrls(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(NETLIFY_URL_RE)) {
    found.add(match[0].replace(/[.,;:!?]+$/, ""));
  }
  return [...found];
}

function attachmentContentPath(attachmentId: string) {
  return `/api/attachments/${attachmentId}/content`;
}

function metaString(metadata: unknown, key: string): string | null {
  const value = (metadata as Record<string, unknown> | null)?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function metaNumber(metadata: unknown, key: string): number | null {
  const value = (metadata as Record<string, unknown> | null)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const taskColumns = { taskId: issues.id, taskIdentifier: issues.identifier, taskTitle: issues.title };

function toTask(row: { taskId: string; taskIdentifier: string | null; taskTitle: string }): WebsiteHubTask {
  return { id: row.taskId, identifier: row.taskIdentifier, title: row.taskTitle };
}

export async function buildWebsiteHub(
  db: Db,
  input: { companyId: string; propertyId: string; projectId: string | null },
): Promise<WebsiteHub> {
  const { companyId, propertyId, projectId } = input;
  const empty: WebsiteHub = { propertyId, projectId, recentWork: [], sitemap: null, previewLinks: [] };
  if (!projectId) return empty;

  const inProject = and(
    eq(issues.companyId, companyId),
    eq(issues.projectId, projectId),
    isNull(issues.hiddenAt),
  );

  const [workProducts, screenshots, sitemapDeliverables, sitemapAttachments, comments] = await Promise.all([
    db
      .select({ row: issueWorkProducts, ...taskColumns })
      .from(issueWorkProducts)
      .innerJoin(issues, eq(issueWorkProducts.issueId, issues.id))
      .where(and(inProject, eq(issueWorkProducts.companyId, companyId)))
      .orderBy(desc(issueWorkProducts.createdAt))
      .limit(COMMENT_SCAN_LIMIT),
    db
      .select({
        id: issueAttachments.id,
        filename: assets.originalFilename,
        contentType: assets.contentType,
        createdAt: issueAttachments.createdAt,
        ...taskColumns,
      })
      .from(issueAttachments)
      .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
      .innerJoin(issues, eq(issueAttachments.issueId, issues.id))
      .where(and(inProject, eq(issueAttachments.companyId, companyId), like(assets.contentType, "image/%")))
      .orderBy(desc(issueAttachments.createdAt))
      .limit(RECENT_WORK_LIMIT),
    db
      .select({ row: issueWorkProducts, ...taskColumns })
      .from(issueWorkProducts)
      .innerJoin(issues, eq(issueWorkProducts.issueId, issues.id))
      .where(and(
        inProject,
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.type, "deliverable"),
        or(
          ilike(issueWorkProducts.title, `${WEBSITE_SITEMAP_PREFIX}%`),
          ilike(issueWorkProducts.externalId, `${WEBSITE_SITEMAP_PREFIX}%`),
          ilike(sql<string>`${issueWorkProducts.metadata}->>'originalFilename'`, `${WEBSITE_SITEMAP_PREFIX}%`),
        ),
      ))
      .orderBy(desc(issueWorkProducts.createdAt))
      .limit(1),
    db
      .select({
        id: issueAttachments.id,
        filename: assets.originalFilename,
        contentType: assets.contentType,
        createdAt: issueAttachments.createdAt,
        ...taskColumns,
      })
      .from(issueAttachments)
      .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
      .innerJoin(issues, eq(issueAttachments.issueId, issues.id))
      .where(and(
        inProject,
        eq(issueAttachments.companyId, companyId),
        ilike(assets.originalFilename, `${WEBSITE_SITEMAP_PREFIX}%`),
      ))
      .orderBy(desc(issueAttachments.createdAt))
      .limit(1),
    db
      .select({
        id: issueComments.id,
        body: issueComments.body,
        createdAt: issueComments.createdAt,
        authorType: issueComments.authorType,
        agentName: agents.name,
        ...taskColumns,
      })
      .from(issueComments)
      .innerJoin(issues, eq(issueComments.issueId, issues.id))
      .leftJoin(agents, eq(issueComments.authorAgentId, agents.id))
      .where(and(
        inProject,
        eq(issueComments.companyId, companyId),
        isNull(issueComments.deletedAt),
        ilike(issueComments.body, "%.netlify.app%"),
      ))
      .orderBy(desc(issueComments.createdAt))
      .limit(COMMENT_SCAN_LIMIT),
  ]);

  const recentWork: WebsiteHubWorkItem[] = [
    ...workProducts.map(({ row, ...task }): WebsiteHubWorkItem => {
      const attachmentId = metaString(row.metadata, "attachmentId");
      const external = (row.metadata as Record<string, unknown> | null)?.external === true;
      return {
        id: row.id,
        type: row.type,
        title: row.title,
        url: row.url,
        contentPath: attachmentId && !external ? attachmentContentPath(attachmentId) : null,
        contentType: metaString(row.metadata, "contentType"),
        status: row.status,
        reviewState: row.reviewState,
        task: toTask(task),
        createdAt: row.createdAt.toISOString(),
      };
    }),
    ...screenshots.map((shot): WebsiteHubWorkItem => ({
      id: shot.id,
      type: "screenshot",
      title: shot.filename ?? "Screenshot",
      url: null,
      contentPath: attachmentContentPath(shot.id),
      contentType: shot.contentType,
      status: null,
      reviewState: null,
      task: toTask(shot),
      createdAt: shot.createdAt.toISOString(),
    })),
  ]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, RECENT_WORK_LIMIT);

  let sitemap: WebsiteHubSitemap | null = null;
  const deliverable = sitemapDeliverables[0];
  if (deliverable) {
    const { row } = deliverable;
    const attachmentId = metaString(row.metadata, "attachmentId");
    const [{ count } = { count: 1 }] = row.externalId
      ? await db
        .select({ count: sql<number>`count(*)::int` })
        .from(issueWorkProducts)
        .where(and(
          eq(issueWorkProducts.companyId, companyId),
          eq(issueWorkProducts.issueId, row.issueId),
          eq(issueWorkProducts.type, "deliverable"),
          eq(issueWorkProducts.externalId, row.externalId),
        ))
      : [{ count: 1 }];
    sitemap = {
      source: "deliverable",
      title: row.title,
      filename: metaString(row.metadata, "originalFilename"),
      contentPath: attachmentId ? attachmentContentPath(attachmentId) : row.url ?? "",
      contentType: metaString(row.metadata, "contentType") ?? "text/html",
      version: metaNumber(row.metadata, "version") ?? 1,
      versionCount: Math.max(1, Number(count) || 1),
      status: metaString(row.metadata, "deliverableStatus") === "draft" ? "draft" : "final",
      reviewState: row.reviewState,
      task: toTask(deliverable),
      createdAt: row.createdAt.toISOString(),
    };
  } else if (sitemapAttachments[0]) {
    const file = sitemapAttachments[0];
    sitemap = {
      source: "attachment",
      title: file.filename ?? "Sitemap",
      filename: file.filename,
      contentPath: attachmentContentPath(file.id),
      contentType: file.contentType,
      version: 1,
      versionCount: 1,
      status: null,
      reviewState: null,
      task: toTask(file),
      createdAt: file.createdAt.toISOString(),
    };
  }

  // Newest first; each URL once, from the newest place it was posted.
  const links = new Map<string, WebsiteHubPreviewLink>();
  const candidates: WebsiteHubPreviewLink[] = [
    ...workProducts.flatMap(({ row, ...task }) =>
      findNetlifyUrls(row.url ?? "").map((url) => ({
        url,
        source: "work_product" as const,
        label: row.title,
        task: toTask(task),
        postedAt: row.createdAt.toISOString(),
      }))),
    ...comments.flatMap((comment) =>
      findNetlifyUrls(comment.body).map((url) => ({
        url,
        source: "comment" as const,
        label: comment.agentName ?? (comment.authorType === "user" ? "A board user" : "A comment"),
        task: toTask(comment),
        postedAt: comment.createdAt.toISOString(),
      }))),
  ].sort((a, b) => b.postedAt.localeCompare(a.postedAt));
  for (const link of candidates) {
    if (!links.has(link.url)) links.set(link.url, link);
  }

  return {
    ...empty,
    recentWork,
    sitemap,
    previewLinks: [...links.values()].slice(0, PREVIEW_LINK_LIMIT),
  };
}
