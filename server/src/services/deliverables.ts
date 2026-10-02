import { buffer } from "node:stream/consumers";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  agents,
  assets,
  companies,
  heartbeatRuns,
  issueAttachments,
  issues,
  issueWorkProducts,
  projects,
} from "@greatstone/db";
import {
  DEFAULT_DELIVERABLE_BRAND,
  deliverableKeyFromTitle,
  deliverablesQuerySchema,
  type CreateDeliverable,
  type Deliverable,
  type DeliverableDetail,
  type DeliverableFacets,
  type DeliverableKind,
  type DeliverablesQuery,
  type DeliverablesResponse,
  type DeliverableStatus,
} from "@greatstone/shared";
import { isUniqueViolation } from "../db-errors.js";
import { notFound, unprocessable } from "../errors.js";
import type { StorageService } from "../storage/types.js";

// Deliverables (GRE-388): finished documents John asked for. Each version is
// an issue_work_products row of type "deliverable"; the key is external_id and
// the version number, kind, brand, status and search text live in metadata.

const DELIVERABLE_TYPE = "deliverable";
const VERSION_UNIQUE_INDEX = "issue_work_products_deliverable_version_uq";
const SEARCH_TEXT_SOURCE_MAX_BYTES = 5 * 1024 * 1024;
const SEARCH_TEXT_MAX_LENGTH = 20_000;
const FACET_SCAN_LIMIT = 2_000;
const TITLE_MAX_LENGTH = 200;
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

const DELIVERABLE_KINDS = new Set<DeliverableKind>(["report", "brief", "plan", "deck", "other"]);

type DeliverableRow = typeof issueWorkProducts.$inferSelect;

export type DeliverableAttachment = {
  id: string;
  companyId: string;
  issueId: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  originalFilename: string | null;
  createdByAgentId: string | null;
};

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

/** Visible text of an HTML document, for search. Scripts, styles and tags go. */
export function extractHtmlSearchText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (entity[0] === "#") {
        const code = entity[1]?.toLowerCase() === "x"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
      }
      return HTML_ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, " ")
    .trim();
  return text.length > SEARCH_TEXT_MAX_LENGTH ? text.slice(0, SEARCH_TEXT_MAX_LENGTH) : text;
}

/** The document's own <title>, as plain text, or null when it has none. */
export function extractHtmlTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const title = match ? extractHtmlSearchText(match[1]!) : "";
  return title ? title.slice(0, TITLE_MAX_LENGTH).trim() : null;
}

function normalizeContentType(contentType: string) {
  return contentType.toLowerCase().split(";")[0]!.trim();
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function attachmentContentPath(attachmentId: string) {
  return `/api/attachments/${attachmentId}/content`;
}

function metadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function metadataNumber(metadata: Record<string, unknown> | null, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readKind(metadata: Record<string, unknown> | null): DeliverableKind {
  const kind = metadataString(metadata, "kind");
  return kind && DELIVERABLE_KINDS.has(kind as DeliverableKind) ? kind as DeliverableKind : "other";
}

function readStatus(metadata: Record<string, unknown> | null): DeliverableStatus {
  return metadataString(metadata, "deliverableStatus") === "draft" ? "draft" : "final";
}

const versionExpression = sql<number>`((${issueWorkProducts.metadata}->>'version')::integer)`;

/** Same issue, same key, a newer version exists: this row is not the latest. */
const latestVersionOnly = sql`NOT EXISTS (
  SELECT 1 FROM "issue_work_products" AS newer_deliverable
  WHERE newer_deliverable.company_id = ${issueWorkProducts.companyId}
    AND newer_deliverable.issue_id = ${issueWorkProducts.issueId}
    AND newer_deliverable.type = 'deliverable'
    AND newer_deliverable.external_id = ${issueWorkProducts.externalId}
    AND (newer_deliverable.metadata->>'version')::integer > ${versionExpression}
)`;

const versionCountExpression = sql<number>`(
  SELECT count(*)::integer FROM "issue_work_products" AS deliverable_version
  WHERE deliverable_version.company_id = ${issueWorkProducts.companyId}
    AND deliverable_version.issue_id = ${issueWorkProducts.issueId}
    AND deliverable_version.type = 'deliverable'
    AND deliverable_version.external_id = ${issueWorkProducts.externalId}
)`;

const agentJoinCondition = and(
  sql`${agents.id}::text = ${issueWorkProducts.metadata}->>'createdByAgentId'`,
  eq(agents.companyId, issueWorkProducts.companyId),
);

type ListRow = {
  row: DeliverableRow;
  issueIdentifier: string | null;
  issueTitle: string;
  projectId: string | null;
  projectName: string | null;
  agentId: string | null;
  agentName: string | null;
  versionCount: number;
};

function toDeliverable(input: ListRow, issuePrefix: string): Deliverable {
  const { row } = input;
  const metadata = (row.metadata as Record<string, unknown> | null) ?? null;
  const attachmentId = metadataString(metadata, "attachmentId") ?? "";
  const contentPath = attachmentContentPath(attachmentId);
  const identifier = input.issueIdentifier ?? row.issueId;
  return {
    id: row.id,
    companyId: row.companyId,
    key: row.externalId ?? "",
    version: metadataNumber(metadata, "version") ?? 1,
    versionCount: Number(input.versionCount) || 1,
    title: row.title,
    summary: row.summary ?? null,
    kind: readKind(metadata),
    brand: metadataString(metadata, "brand") ?? DEFAULT_DELIVERABLE_BRAND,
    status: readStatus(metadata),
    attachmentId,
    contentType: metadataString(metadata, "contentType") ?? "application/octet-stream",
    byteSize: metadataNumber(metadata, "byteSize") ?? 0,
    originalFilename: metadataString(metadata, "originalFilename"),
    contentPath,
    openPath: contentPath,
    downloadPath: `${contentPath}?download=1`,
    issue: { id: row.issueId, identifier, title: input.issueTitle },
    project: input.projectId && input.projectName ? { id: input.projectId, name: input.projectName } : null,
    createdByAgent: input.agentId && input.agentName ? { id: input.agentId, name: input.agentName } : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastOpenedAt: metadataString(metadata, "lastOpenedAt"),
    href: `/${encodeURIComponent(issuePrefix)}/issues/${encodeURIComponent(identifier)}#work-product-${row.id}`,
  };
}

/**
 * For each attachment that is any version of a deliverable, the id of that
 * deliverable's latest version. Lets the Artifacts page link to it.
 */
export async function latestDeliverableIdsByAttachment(
  db: Db,
  companyId: string,
  attachmentIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (attachmentIds.length === 0) return result;
  const attachmentIdExpression = sql<string>`${issueWorkProducts.metadata}->>'attachmentId'`;
  const matches = await db
    .select({ attachmentId: attachmentIdExpression, issueId: issueWorkProducts.issueId, key: issueWorkProducts.externalId })
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.companyId, companyId),
      eq(issueWorkProducts.type, DELIVERABLE_TYPE),
      inArray(attachmentIdExpression, [...new Set(attachmentIds)]),
    ));
  if (matches.length === 0) return result;
  const latest = await db
    .select({ id: issueWorkProducts.id, issueId: issueWorkProducts.issueId, key: issueWorkProducts.externalId })
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.companyId, companyId),
      eq(issueWorkProducts.type, DELIVERABLE_TYPE),
      inArray(issueWorkProducts.issueId, [...new Set(matches.map((row) => row.issueId))]),
      inArray(issueWorkProducts.externalId, [...new Set(matches.map((row) => row.key ?? ""))]),
      latestVersionOnly,
    ));
  const latestByKey = new Map(latest.map((row) => [`${row.issueId}:${row.key}`, row.id]));
  for (const match of matches) {
    const id = latestByKey.get(`${match.issueId}:${match.key}`);
    if (id && !result.has(match.attachmentId)) result.set(match.attachmentId, id);
  }
  return result;
}

export function deliverableService(db: Db, storage?: StorageService) {
  async function companyPrefix(companyId: string) {
    const company = await db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) throw notFound("Company not found");
    return company.issuePrefix;
  }

  function selectListRows() {
    return db
      .select({
        row: issueWorkProducts,
        issueIdentifier: issues.identifier,
        issueTitle: issues.title,
        projectId: projects.id,
        projectName: projects.name,
        agentId: agents.id,
        agentName: agents.name,
        versionCount: versionCountExpression,
      })
      .from(issueWorkProducts)
      .innerJoin(issues, and(eq(issueWorkProducts.issueId, issues.id), eq(issues.companyId, issueWorkProducts.companyId)))
      .leftJoin(projects, and(eq(issues.projectId, projects.id), eq(projects.companyId, issues.companyId)))
      .leftJoin(agents, agentJoinCondition);
  }

  async function readHtml(attachment: DeliverableAttachment): Promise<string | null> {
    if (!storage) return null;
    if (!HTML_TYPES.has(normalizeContentType(attachment.contentType))) return null;
    if (attachment.byteSize <= 0 || attachment.byteSize > SEARCH_TEXT_SOURCE_MAX_BYTES) return null;
    try {
      const object = await storage.getObject(attachment.companyId, attachment.objectKey);
      return (await buffer(object.stream)).toString("utf8");
    } catch {
      return null;
    }
  }

  async function readSearchText(attachment: DeliverableAttachment): Promise<string | null> {
    const html = await readHtml(attachment);
    return html ? extractHtmlSearchText(html) || null : null;
  }

  async function getAttachment(companyId: string, attachmentId: string): Promise<DeliverableAttachment | null> {
    return db
      .select({
        id: issueAttachments.id,
        companyId: issueAttachments.companyId,
        issueId: issueAttachments.issueId,
        objectKey: assets.objectKey,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        originalFilename: assets.originalFilename,
        createdByAgentId: assets.createdByAgentId,
      })
      .from(issueAttachments)
      .innerJoin(assets, and(eq(issueAttachments.assetId, assets.id), eq(assets.companyId, issueAttachments.companyId)))
      .where(and(eq(issueAttachments.id, attachmentId), eq(issueAttachments.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
  }

  async function getListRow(companyId: string, id: string): Promise<ListRow | null> {
    return selectListRows()
      .where(and(
        eq(issueWorkProducts.id, id),
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.type, DELIVERABLE_TYPE),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function getDetail(companyId: string, id: string): Promise<DeliverableDetail | null> {
    const listRow = await getListRow(companyId, id);
    if (!listRow) return null;
    const prefix = await companyPrefix(companyId);
    const versionRows = await db
      .select()
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.issueId, listRow.row.issueId),
        eq(issueWorkProducts.type, DELIVERABLE_TYPE),
        eq(issueWorkProducts.externalId, listRow.row.externalId ?? ""),
      ))
      .orderBy(desc(versionExpression));
    return {
      ...toDeliverable(listRow, prefix),
      versions: versionRows.map((row) => {
        const metadata = (row.metadata as Record<string, unknown> | null) ?? null;
        const contentPath = attachmentContentPath(metadataString(metadata, "attachmentId") ?? "");
        return {
          id: row.id,
          version: metadataNumber(metadata, "version") ?? 1,
          title: row.title,
          status: readStatus(metadata),
          contentPath,
          downloadPath: `${contentPath}?download=1`,
          createdAt: row.createdAt.toISOString(),
        };
      }),
    };
  }

  return {
    getAttachment,
    getDetail,

    /** The <title> of an HTML attachment, or null for other files or no title. */
    readHtmlTitle: async (attachment: DeliverableAttachment): Promise<string | null> => {
      const html = await readHtml(attachment);
      return html ? extractHtmlTitle(html) : null;
    },

    /** The deliverable whose latest version is this attachment, if any. */
    findLatestByAttachment: async (companyId: string, attachmentId: string): Promise<DeliverableDetail | null> => {
      const row = await db
        .select({ id: issueWorkProducts.id })
        .from(issueWorkProducts)
        .where(and(
          eq(issueWorkProducts.companyId, companyId),
          eq(issueWorkProducts.type, DELIVERABLE_TYPE),
          sql`${issueWorkProducts.metadata}->>'attachmentId' = ${attachmentId}`,
          latestVersionOnly,
        ))
        .orderBy(desc(issueWorkProducts.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return row ? getDetail(companyId, row.id) : null;
    },

    /**
     * Register a deliverable on an issue. The same key on the same issue makes
     * the next version; fields the caller leaves out carry over from the
     * previous version.
     */
    register: async (input: {
      issue: { id: string; companyId: string; projectId: string | null };
      attachment: DeliverableAttachment;
      fields: Omit<CreateDeliverable, "attachmentId">;
      createdByAgentId: string | null;
      createdByRunId: string | null;
    }): Promise<DeliverableDetail> => {
      const { issue, attachment, fields } = input;
      if (attachment.companyId !== issue.companyId || attachment.issueId !== issue.id) {
        throw unprocessable("attachmentId must be an attachment on this issue");
      }
      const key = fields.key ?? deliverableKeyFromTitle(fields.title);
      const searchText = await readSearchText(attachment);
      const createdByAgentId = input.createdByAgentId ?? attachment.createdByAgentId;
      const createdByRunId = input.createdByRunId
        ? await db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.id, input.createdByRunId), eq(heartbeatRuns.companyId, issue.companyId)))
          .then((rows) => rows[0]?.id ?? null)
        : null;

      for (let attempt = 0; ; attempt += 1) {
        try {
          const id = await db.transaction(async (tx) => {
            const previous = await tx
              .select()
              .from(issueWorkProducts)
              .where(and(
                eq(issueWorkProducts.companyId, issue.companyId),
                eq(issueWorkProducts.issueId, issue.id),
                eq(issueWorkProducts.type, DELIVERABLE_TYPE),
                eq(issueWorkProducts.externalId, key),
              ))
              .orderBy(desc(versionExpression))
              .limit(1)
              .then((rows) => rows[0] ?? null);
            const previousMetadata = (previous?.metadata as Record<string, unknown> | null) ?? null;
            const version = (metadataNumber(previousMetadata, "version") ?? 0) + 1;
            const contentPath = attachmentContentPath(attachment.id);
            const [row] = await tx
              .insert(issueWorkProducts)
              .values({
                companyId: issue.companyId,
                issueId: issue.id,
                projectId: issue.projectId,
                type: DELIVERABLE_TYPE,
                provider: "paperclip",
                externalId: key,
                title: fields.title,
                summary: fields.summary === undefined ? previous?.summary ?? null : fields.summary,
                status: "active",
                createdByRunId,
                metadata: {
                  attachmentId: attachment.id,
                  contentType: attachment.contentType,
                  byteSize: attachment.byteSize,
                  contentPath,
                  openPath: contentPath,
                  downloadPath: `${contentPath}?download=1`,
                  originalFilename: attachment.originalFilename,
                  version,
                  kind: fields.kind ?? (previous ? readKind(previousMetadata) : "report"),
                  brand: fields.brand ?? metadataString(previousMetadata, "brand") ?? DEFAULT_DELIVERABLE_BRAND,
                  deliverableStatus: fields.status ?? (previous ? readStatus(previousMetadata) : "final"),
                  createdByAgentId,
                  searchText,
                },
              })
              .returning({ id: issueWorkProducts.id });
            return row!.id;
          });
          const detail = await getDetail(issue.companyId, id);
          if (!detail) throw notFound("Deliverable not found");
          return detail;
        } catch (error) {
          // Two writers took the same version number; the loser re-reads and
          // takes the next one.
          if (attempt < 3 && isUniqueViolation(error, VERSION_UNIQUE_INDEX)) continue;
          throw error;
        }
      }
    },

    list: async (
      companyId: string,
      rawQuery: Partial<DeliverablesQuery> = {},
    ): Promise<DeliverablesResponse> => {
      const query = deliverablesQuerySchema.parse(rawQuery);
      const prefix = await companyPrefix(companyId);
      const baseConditions: SQL[] = [
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.type, DELIVERABLE_TYPE),
        isNull(issues.hiddenAt),
        isNull(issues.harnessKind),
        latestVersionOnly,
      ];
      const conditions: SQL[] = [...baseConditions];
      if (query.kind) conditions.push(sql`${issueWorkProducts.metadata}->>'kind' = ${query.kind}`);
      if (query.brand) conditions.push(sql`lower(coalesce(${issueWorkProducts.metadata}->>'brand', ${DEFAULT_DELIVERABLE_BRAND})) = lower(${query.brand})`);
      if (query.projectId) conditions.push(eq(issues.projectId, query.projectId));
      if (query.agentId) conditions.push(sql`${issueWorkProducts.metadata}->>'createdByAgentId' = ${query.agentId}`);
      if (query.from) conditions.push(gte(issueWorkProducts.createdAt, new Date(query.from)));
      if (query.to) conditions.push(lte(issueWorkProducts.createdAt, new Date(query.to)));
      if (query.q) {
        const q = `%${escapeLikePattern(query.q)}%`;
        conditions.push(sql`(
          ${issueWorkProducts.title} ILIKE ${q} ESCAPE '\\'
          OR coalesce(${issueWorkProducts.summary}, '') ILIKE ${q} ESCAPE '\\'
          OR coalesce(${issues.identifier}, '') ILIKE ${q} ESCAPE '\\'
          OR ${issues.title} ILIKE ${q} ESCAPE '\\'
          OR coalesce(${agents.name}, '') ILIKE ${q} ESCAPE '\\'
          OR coalesce(${issueWorkProducts.metadata}->>'brand', '') ILIKE ${q} ESCAPE '\\'
          OR coalesce(${issueWorkProducts.metadata}->>'searchText', '') ILIKE ${q} ESCAPE '\\'
        )`);
      }

      const order = query.sort === "title"
        ? [asc(sql`lower(${issueWorkProducts.title})`), desc(issueWorkProducts.createdAt), desc(issueWorkProducts.id)]
        : query.sort === "recently_opened"
          ? [
            sql`(${issueWorkProducts.metadata}->>'lastOpenedAt')::timestamptz DESC NULLS LAST`,
            desc(issueWorkProducts.createdAt),
            desc(issueWorkProducts.id),
          ]
          : [desc(issueWorkProducts.createdAt), desc(issueWorkProducts.id)];

      const [rows, totalRow, facetRows] = await Promise.all([
        selectListRows()
          .where(and(...conditions))
          .orderBy(...order)
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ count: sql<number>`count(*)::integer` })
          .from(issueWorkProducts)
          .innerJoin(issues, and(eq(issueWorkProducts.issueId, issues.id), eq(issues.companyId, issueWorkProducts.companyId)))
          .leftJoin(agents, agentJoinCondition)
          .where(and(...conditions))
          .then((result) => result[0]),
        db
          .select({
            brand: sql<string | null>`${issueWorkProducts.metadata}->>'brand'`,
            agentId: agents.id,
            agentName: agents.name,
            projectId: projects.id,
            projectName: projects.name,
          })
          .from(issueWorkProducts)
          .innerJoin(issues, and(eq(issueWorkProducts.issueId, issues.id), eq(issues.companyId, issueWorkProducts.companyId)))
          .leftJoin(projects, and(eq(issues.projectId, projects.id), eq(projects.companyId, issues.companyId)))
          .leftJoin(agents, agentJoinCondition)
          .where(and(...baseConditions))
          .limit(FACET_SCAN_LIMIT),
      ]);

      const total = Number(totalRow?.count ?? 0);
      const brands = new Map<string, string>();
      const facetAgents = new Map<string, string>();
      const facetProjects = new Map<string, string>();
      for (const row of facetRows) {
        const brand = row.brand ?? DEFAULT_DELIVERABLE_BRAND;
        if (!brands.has(brand.toLowerCase())) brands.set(brand.toLowerCase(), brand);
        if (row.agentId && row.agentName) facetAgents.set(row.agentId, row.agentName);
        if (row.projectId && row.projectName) facetProjects.set(row.projectId, row.projectName);
      }
      const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
      const facets: DeliverableFacets = {
        brands: [...brands.values()].sort((a, b) => a.localeCompare(b)),
        agents: [...facetAgents].map(([id, name]) => ({ id, name })).sort(byName),
        projects: [...facetProjects].map(([id, name]) => ({ id, name })).sort(byName),
      };

      const nextOffset = query.offset + rows.length < total ? query.offset + rows.length : null;
      return {
        deliverables: rows.map((row) => toDeliverable(row, prefix)),
        total,
        nextOffset,
        facets,
      };
    },

    /** Record that someone opened the deliverable, for the "Recently opened" sort. */
    markOpened: async (companyId: string, id: string): Promise<boolean> => {
      const target = await db
        .select({ issueId: issueWorkProducts.issueId, key: issueWorkProducts.externalId })
        .from(issueWorkProducts)
        .where(and(
          eq(issueWorkProducts.id, id),
          eq(issueWorkProducts.companyId, companyId),
          eq(issueWorkProducts.type, DELIVERABLE_TYPE),
        ))
        .then((rows) => rows[0] ?? null);
      if (!target) return false;
      const openedAt = new Date().toISOString();
      await db
        .update(issueWorkProducts)
        .set({
          metadata: sql`jsonb_set(coalesce(${issueWorkProducts.metadata}, '{}'::jsonb), '{lastOpenedAt}', to_jsonb(${openedAt}::text))`,
        })
        .where(and(
          eq(issueWorkProducts.companyId, companyId),
          eq(issueWorkProducts.issueId, target.issueId),
          eq(issueWorkProducts.type, DELIVERABLE_TYPE),
          eq(issueWorkProducts.externalId, target.key ?? ""),
        ));
      return true;
    },
  };
}
