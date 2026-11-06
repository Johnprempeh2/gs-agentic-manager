import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  agents,
  companies,
  issueWorkProducts,
  issues,
  pipelineCaseIssueLinks,
  pipelineCaseProjectLinks,
  pipelineCases,
  projects,
  sharedLinks,
} from "@greatstone/db";
import {
  LINK_STATUSES,
  LINK_TYPES,
  LINKS_IMPORT_MAX_ROWS,
  linksQuerySchema,
  normalizeLinkUrl,
  type CreateLink,
  type LinkItem,
  type LinkSource,
  type LinkStatus,
  type LinkType,
  type LinksBackfillResult,
  type LinksImportResult,
  type LinksQuery,
  type LinksResponse,
  type UpdateLink,
} from "@greatstone/shared";
import { notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { csvRecords } from "./pipedrive-export.js";

/**
 * The links register (GRE-4252): one searchable list of every link we share,
 * by client and project. Rows come from people and agents (POST), from
 * deliverables and previews as they are registered, and from a CSV import of
 * the old Notion register.
 */

export interface LinkActor {
  agentId: string | null;
  userId: string | null;
}

type LinkRow = typeof sharedLinks.$inferSelect;

/** Deliverable kinds mapped onto the register's types. */
const DELIVERABLE_KIND_TO_LINK_TYPE: Record<string, LinkType> = {
  report: "report",
  deck: "deck",
  proposal: "proposal",
  mockup: "demo",
};

/** Work product types that carry a shareable URL and are captured as previews. */
export const CAPTURED_PREVIEW_WORK_PRODUCT_TYPES = new Set(["preview_url", "runtime_service"]);

function isHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/** A dev server on this machine is not a link anyone else can open. */
function isLoopback(value: string) {
  const host = new URL(value).hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host) || host === "0.0.0.0";
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function toDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function linkService(db: Db) {
  async function companyPrefix(companyId: string) {
    const row = await db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Company not found");
    return row.issuePrefix;
  }

  /**
   * The client a task belongs to: a client case linked to the task, else one
   * linked to the task's project. The earliest link wins, as for deliverables.
   */
  async function clientCaseFor(companyId: string, issueId: string | null, projectId: string | null) {
    if (issueId) {
      const row = await db
        .select({ id: pipelineCases.id })
        .from(pipelineCaseIssueLinks)
        .innerJoin(pipelineCases, eq(pipelineCases.id, pipelineCaseIssueLinks.caseId))
        .where(and(
          eq(pipelineCaseIssueLinks.companyId, companyId),
          eq(pipelineCases.companyId, companyId),
          eq(pipelineCaseIssueLinks.issueId, issueId),
          isNull(pipelineCaseIssueLinks.retiredAt),
          isNull(pipelineCases.retiredAt),
        ))
        .orderBy(asc(pipelineCaseIssueLinks.createdAt), asc(pipelineCases.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (row) return row.id;
    }
    if (projectId) {
      const row = await db
        .select({ id: pipelineCases.id })
        .from(pipelineCaseProjectLinks)
        .innerJoin(pipelineCases, eq(pipelineCases.id, pipelineCaseProjectLinks.caseId))
        .where(and(
          eq(pipelineCaseProjectLinks.companyId, companyId),
          eq(pipelineCases.companyId, companyId),
          eq(pipelineCaseProjectLinks.projectId, projectId),
          isNull(pipelineCases.retiredAt),
        ))
        .orderBy(asc(pipelineCaseProjectLinks.createdAt), asc(pipelineCases.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (row) return row.id;
    }
    return null;
  }

  /** Every reference must belong to this company; one client never sees another's records. */
  async function assertReferences(companyId: string, input: { clientCaseId?: string | null; projectId?: string | null; sourceIssueId?: string | null }) {
    const checks: Array<Promise<void>> = [];
    if (input.clientCaseId) {
      checks.push(db.select({ id: pipelineCases.id }).from(pipelineCases)
        .where(and(eq(pipelineCases.id, input.clientCaseId), eq(pipelineCases.companyId, companyId)))
        .then((rows) => { if (!rows[0]) throw unprocessable("clientCaseId is not a client in this company"); }));
    }
    if (input.projectId) {
      checks.push(db.select({ id: projects.id }).from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.companyId, companyId)))
        .then((rows) => { if (!rows[0]) throw unprocessable("projectId is not a project in this company"); }));
    }
    if (input.sourceIssueId) {
      checks.push(db.select({ id: issues.id }).from(issues)
        .where(and(eq(issues.id, input.sourceIssueId), eq(issues.companyId, companyId)))
        .then((rows) => { if (!rows[0]) throw unprocessable("sourceIssueId is not a task in this company"); }));
    }
    await Promise.all(checks);
  }

  const selection = {
    link: sharedLinks,
    clientTitle: pipelineCases.title,
    projectName: projects.name,
    issueIdentifier: issues.identifier,
    issueTitle: issues.title,
    agentName: agents.name,
  };

  function baseQuery() {
    return db
      .select(selection)
      .from(sharedLinks)
      .leftJoin(pipelineCases, and(eq(pipelineCases.id, sharedLinks.clientCaseId), eq(pipelineCases.companyId, sharedLinks.companyId)))
      .leftJoin(projects, and(eq(projects.id, sharedLinks.projectId), eq(projects.companyId, sharedLinks.companyId)))
      .leftJoin(issues, and(eq(issues.id, sharedLinks.sourceIssueId), eq(issues.companyId, sharedLinks.companyId)))
      .leftJoin(agents, and(eq(agents.id, sharedLinks.addedByAgentId), eq(agents.companyId, sharedLinks.companyId)));
  }

  type JoinedRow = Awaited<ReturnType<ReturnType<typeof baseQuery>["execute"]>>[number];

  function toItem(row: JoinedRow, prefix: string): LinkItem {
    const { link } = row;
    const identifier = row.issueIdentifier ?? link.sourceIssueId;
    return {
      id: link.id,
      companyId: link.companyId,
      url: link.url,
      title: link.title,
      type: (LINK_TYPES as readonly string[]).includes(link.type) ? (link.type as LinkType) : "other",
      status: (LINK_STATUSES as readonly string[]).includes(link.status) ? (link.status as LinkStatus) : "live",
      source: link.source as LinkSource,
      clientCase: link.clientCaseId && row.clientTitle ? { id: link.clientCaseId, name: row.clientTitle } : null,
      clientName: link.clientName,
      project: link.projectId && row.projectName ? { id: link.projectId, name: row.projectName } : null,
      projectName: link.projectName,
      sourceIssue: link.sourceIssueId && row.issueTitle !== null
        ? {
          id: link.sourceIssueId,
          identifier: row.issueIdentifier,
          title: row.issueTitle,
          path: `/${encodeURIComponent(prefix)}/issues/${encodeURIComponent(identifier ?? link.sourceIssueId)}`,
        }
        : null,
      addedBy: link.addedByAgentId
        ? { type: "agent", id: link.addedByAgentId, name: row.agentName }
        : link.addedByUserId
          ? { type: "user", id: link.addedByUserId, name: null }
          : null,
      notes: link.notes,
      deployedAt: link.deployedAt?.toISOString() ?? null,
      createdAt: link.createdAt.toISOString(),
      updatedAt: link.updatedAt.toISOString(),
    };
  }

  async function get(companyId: string, id: string): Promise<LinkItem | null> {
    const [row] = await baseQuery().where(and(eq(sharedLinks.companyId, companyId), eq(sharedLinks.id, id)));
    return row ? toItem(row, await companyPrefix(companyId)) : null;
  }

  async function list(companyId: string, rawQuery: Partial<LinksQuery> = {}): Promise<LinksResponse> {
    const query = linksQuerySchema.parse(rawQuery);
    const prefix = await companyPrefix(companyId);
    const conditions: SQL[] = [eq(sharedLinks.companyId, companyId)];
    if (query.status) conditions.push(eq(sharedLinks.status, query.status));
    else if (!query.includeArchived) conditions.push(ne(sharedLinks.status, "archived"));
    if (query.type) conditions.push(eq(sharedLinks.type, query.type));
    if (query.clientCaseId) conditions.push(eq(sharedLinks.clientCaseId, query.clientCaseId));
    if (query.projectId) conditions.push(eq(sharedLinks.projectId, query.projectId));
    if (query.q) {
      const pattern = `%${escapeLike(query.q)}%`;
      conditions.push(or(
        ilike(sharedLinks.title, pattern),
        ilike(sharedLinks.url, pattern),
        ilike(sharedLinks.notes, pattern),
        ilike(sharedLinks.clientName, pattern),
        ilike(sharedLinks.projectName, pattern),
        ilike(pipelineCases.title, pattern),
        ilike(projects.name, pattern),
        ilike(issues.identifier, pattern),
      )!);
    }
    const where = and(...conditions);
    const limit = query.limit ?? 500;
    const [rows, totalRows, clientRows, projectRows] = await Promise.all([
      baseQuery().where(where).orderBy(desc(sharedLinks.updatedAt), asc(sharedLinks.id)).limit(limit),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(sharedLinks)
        .leftJoin(pipelineCases, and(eq(pipelineCases.id, sharedLinks.clientCaseId), eq(pipelineCases.companyId, sharedLinks.companyId)))
        .leftJoin(projects, and(eq(projects.id, sharedLinks.projectId), eq(projects.companyId, sharedLinks.companyId)))
        .leftJoin(issues, and(eq(issues.id, sharedLinks.sourceIssueId), eq(issues.companyId, sharedLinks.companyId)))
        .where(where),
      db
        .selectDistinct({ id: pipelineCases.id, name: pipelineCases.title })
        .from(sharedLinks)
        .innerJoin(pipelineCases, and(eq(pipelineCases.id, sharedLinks.clientCaseId), eq(pipelineCases.companyId, companyId)))
        .where(eq(sharedLinks.companyId, companyId))
        .orderBy(asc(pipelineCases.title), asc(pipelineCases.id)),
      db
        .selectDistinct({ id: projects.id, name: projects.name })
        .from(sharedLinks)
        .innerJoin(projects, and(eq(projects.id, sharedLinks.projectId), eq(projects.companyId, companyId)))
        .where(eq(sharedLinks.companyId, companyId))
        .orderBy(asc(projects.name), asc(projects.id)),
    ]);
    return {
      links: rows.map((row) => toItem(row, prefix)),
      total: Number(totalRows[0]?.count ?? 0),
      facets: { clients: clientRows, projects: projectRows },
    };
  }

  /**
   * Add a link, or update the row that already has this URL. Fields left out
   * keep their stored value; client and project are filled from the source
   * task when the caller does not name them.
   */
  async function upsert(
    companyId: string,
    input: CreateLink,
    actor: LinkActor,
    source: LinkSource = "manual",
  ): Promise<{ link: LinkItem; created: boolean }> {
    await assertReferences(companyId, input);
    let projectId = input.projectId;
    let clientCaseId = input.clientCaseId;
    if (input.sourceIssueId && (projectId === undefined || clientCaseId === undefined)) {
      const issue = await db
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(and(eq(issues.id, input.sourceIssueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (projectId === undefined) projectId = issue?.projectId ?? undefined;
      if (clientCaseId === undefined) {
        clientCaseId = (await clientCaseFor(companyId, input.sourceIssueId, projectId ?? null)) ?? undefined;
      }
    } else if (clientCaseId === undefined && projectId) {
      clientCaseId = (await clientCaseFor(companyId, null, projectId)) ?? undefined;
    }

    const now = new Date();
    const values = {
      title: input.title,
      type: input.type,
      status: input.status,
      clientCaseId,
      clientName: input.clientName,
      projectId,
      projectName: input.projectName,
      sourceIssueId: input.sourceIssueId,
      notes: input.notes,
      deployedAt: toDate(input.deployedAt),
    };
    const set = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
    const [row] = await db
      .insert(sharedLinks)
      .values({
        companyId,
        url: normalizeLinkUrl(input.url),
        source,
        addedByAgentId: actor.agentId,
        addedByUserId: actor.userId,
        ...set,
        title: input.title,
      })
      .onConflictDoUpdate({
        target: [sharedLinks.companyId, sharedLinks.url],
        set: { ...set, updatedAt: now },
      })
      .returning({ id: sharedLinks.id, created: sql<boolean>`(xmax = 0)` });
    const link = await get(companyId, row!.id);
    if (!link) throw notFound("Link not found");
    return { link, created: row!.created === true };
  }

  async function ownRow(companyId: string, id: string): Promise<LinkRow> {
    const [row] = await db
      .select()
      .from(sharedLinks)
      .where(and(eq(sharedLinks.companyId, companyId), eq(sharedLinks.id, id)));
    if (!row) throw notFound("Link not found");
    return row;
  }

  async function update(companyId: string, id: string, patch: UpdateLink): Promise<LinkItem> {
    await ownRow(companyId, id);
    await assertReferences(companyId, patch);
    const { deployedAt, ...rest } = patch;
    const set = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
    await db
      .update(sharedLinks)
      .set({ ...set, ...(deployedAt !== undefined ? { deployedAt: toDate(deployedAt) } : {}), updatedAt: new Date() })
      .where(and(eq(sharedLinks.companyId, companyId), eq(sharedLinks.id, id)));
    return (await get(companyId, id))!;
  }

  async function archive(companyId: string, id: string): Promise<LinkItem> {
    await ownRow(companyId, id);
    await db
      .update(sharedLinks)
      .set({ status: "archived", updatedAt: new Date() })
      .where(and(eq(sharedLinks.companyId, companyId), eq(sharedLinks.id, id)));
    return (await get(companyId, id))!;
  }

  /**
   * Automatic capture: a deliverable or preview with a web address lands in
   * the register with its client, project and source task, so agents do not
   * need a separate step. A failure here is logged and never fails the
   * deliverable or preview itself.
   */
  async function capture(input: {
    companyId: string;
    issueId: string;
    url: string | null | undefined;
    title: string;
    source: Extract<LinkSource, "deliverable" | "preview">;
    type: LinkType;
    agentId: string | null;
    userId?: string | null;
  }): Promise<LinkItem | null> {
    if (!isHttpUrl(input.url) || isLoopback(input.url)) return null;
    try {
      const { link } = await upsert(
        input.companyId,
        {
          url: input.url,
          title: input.title.trim().slice(0, 300) || input.url,
          type: input.type,
          sourceIssueId: input.issueId,
        },
        { agentId: input.agentId, userId: input.userId ?? null },
        input.source,
      );
      return link;
    } catch (error) {
      logger.warn(
        { err: error, companyId: input.companyId, issueId: input.issueId, source: input.source },
        "links register: automatic capture failed; add the link with POST /api/companies/:companyId/links",
      );
      return null;
    }
  }

  function linkTypeForDeliverableKind(kind: string | null | undefined): LinkType {
    return (kind && DELIVERABLE_KIND_TO_LINK_TYPE[kind]) || "other";
  }

  /**
   * One-off fill from what GSAM already holds: link deliverables (latest
   * version of each) and preview work products with a web address. Skips the
   * same rows capture() would: local-only addresses, and (like Deliverables)
   * work on hidden or test-harness tasks.
   */
  async function backfill(companyId: string, actor: LinkActor): Promise<LinksBackfillResult> {
    const rows = await db
      .select({
        issueId: issueWorkProducts.issueId,
        type: issueWorkProducts.type,
        title: issueWorkProducts.title,
        url: issueWorkProducts.url,
        metadata: issueWorkProducts.metadata,
        createdAt: issueWorkProducts.createdAt,
      })
      .from(issueWorkProducts)
      .innerJoin(issues, eq(issues.id, issueWorkProducts.issueId))
      .where(and(
        eq(issueWorkProducts.companyId, companyId),
        isNotNull(issueWorkProducts.url),
        inArray(issueWorkProducts.type, ["deliverable", ...CAPTURED_PREVIEW_WORK_PRODUCT_TYPES]),
        isNull(issues.hiddenAt),
        isNull(issues.harnessKind),
      ))
      .orderBy(asc(issueWorkProducts.createdAt));
    const result: LinksBackfillResult = { scanned: rows.length, created: 0, updated: 0 };
    for (const row of rows) {
      if (!isHttpUrl(row.url) || isLoopback(row.url)) continue;
      const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
      const isDeliverable = row.type === "deliverable";
      const { created } = await upsert(
        companyId,
        {
          url: row.url,
          title: row.title.trim().slice(0, 300) || row.url,
          type: isDeliverable ? linkTypeForDeliverableKind(metadata.kind as string | undefined) : "preview",
          sourceIssueId: row.issueId,
          deployedAt: row.createdAt.toISOString(),
        },
        actor,
        isDeliverable ? "deliverable" : "preview",
      );
      if (created) result.created += 1;
      else result.updated += 1;
    }
    return result;
  }

  /**
   * Load a CSV export of the Notion "Netlify Link Register". Client and
   * project names are matched to GSAM clients and projects by name (case does
   * not matter); unmatched names are kept as written.
   */
  async function importCsv(companyId: string, csv: string, actor: LinkActor): Promise<LinksImportResult> {
    let parsed: ReturnType<typeof csvRecords>;
    try {
      parsed = csvRecords(csv);
    } catch (error) {
      throw unprocessable(error instanceof Error ? error.message : "The CSV could not be read");
    }
    if (parsed.rows.length > LINKS_IMPORT_MAX_ROWS) {
      throw unprocessable(`The CSV has ${parsed.rows.length} rows; the limit is ${LINKS_IMPORT_MAX_ROWS}. Split it into smaller files.`);
    }
    const [clientRows, projectRows] = await Promise.all([
      db.select({ id: pipelineCases.id, title: pipelineCases.title }).from(pipelineCases)
        .where(and(eq(pipelineCases.companyId, companyId), isNull(pipelineCases.retiredAt))),
      db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.companyId, companyId)),
    ]);
    const clientsByName = new Map(clientRows.map((row) => [row.title.trim().toLowerCase(), row.id]));
    const projectsByName = new Map(projectRows.map((row) => [row.name.trim().toLowerCase(), row.id]));

    const result: LinksImportResult = { created: 0, updated: 0, skipped: [] };
    for (const [index, read] of parsed.rows.entries()) {
      const rowNumber = index + 2; // the header is row 1
      const rawUrl = read(["URL", "Link", "Netlify URL", "Live URL", "Site URL"]);
      if (!rawUrl || !isHttpUrl(rawUrl.trim())) {
        result.skipped.push({ row: rowNumber, reason: rawUrl ? "URL is not a web address" : "No URL" });
        continue;
      }
      const clientName = read(["Client", "Client name", "Customer"])?.trim() || null;
      const projectName = read(["Project", "Project name"])?.trim() || null;
      const rawType = read(["Type", "Kind", "Category"])?.trim().toLowerCase() ?? null;
      const rawStatus = read(["Status", "State"])?.trim().toLowerCase() ?? null;
      const rawDate = read(["Deploy Date", "Deploy date", "Deployed", "Date", "Created", "Created time", "Created date"]);
      const deployedAt = rawDate ? toDate(rawDate.trim()) : null;
      const clientCaseId = clientName ? clientsByName.get(clientName.toLowerCase()) ?? null : null;
      const projectId = projectName ? projectsByName.get(projectName.toLowerCase()) ?? null : null;
      try {
        const { created } = await upsert(
          companyId,
          {
            url: rawUrl.trim(),
            title: (read(["Name", "Title", "Page", "Site"])?.trim() || rawUrl.trim()).slice(0, 300),
            type: rawType && (LINK_TYPES as readonly string[]).includes(rawType) ? (rawType as LinkType) : "other",
            status: rawStatus && (LINK_STATUSES as readonly string[]).includes(rawStatus) ? (rawStatus as LinkStatus) : "live",
            clientCaseId,
            clientName: clientCaseId ? null : clientName,
            projectId,
            projectName: projectId ? null : projectName,
            notes: read(["Notes", "Note", "Description", "Comments"])?.trim().slice(0, 4000) || null,
            deployedAt: deployedAt ? deployedAt.toISOString() : null,
          },
          actor,
          "import",
        );
        if (created) result.created += 1;
        else result.updated += 1;
      } catch (error) {
        result.skipped.push({ row: rowNumber, reason: error instanceof Error ? error.message : "Could not save" });
      }
    }
    return result;
  }

  return { list, get, upsert, update, archive, capture, backfill, importCsv, linkTypeForDeliverableKind };
}
