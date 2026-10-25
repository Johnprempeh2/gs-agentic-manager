import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { assets, companySecrets, documentRevisions, documents, websiteEntry, websitePage, websiteSite } from "@greatstone/db";
import {
  WEBSITE_CONTENT_MAX_BYTES,
  type CreateWebsiteEntry,
  type CreateWebsitePage,
  type CreateWebsiteSite,
  type UpdateWebsiteEntry,
  type UpdateWebsitePage,
  type UpdateWebsiteSite,
  type WebsiteEntry,
  type WebsiteEntryStatus,
  type WebsiteMediaItem,
  type WebsitePage,
  type WebsitePageEditorLoad,
  type WebsitePageMenu,
  type WebsitePageSeo,
  type WebsitePageStatus,
  type WebsiteRevision,
  type WebsiteSaveResult,
  type WebsiteSite,
} from "@greatstone/shared";
import { conflict, notFound, unprocessable } from "../../errors.js";
import { secretService } from "../secrets.js";
import { WEBSITE_MESSAGES } from "./messages.js";

// Website module (GRE-2105, ADR GRE-1914). Every function takes the company
// id and reads rows by (company_id, id): a row of another company is simply
// not found. Routes check company access and the website permission first.

export type SiteRow = typeof websiteSite.$inferSelect;
export type PageRow = typeof websitePage.$inferSelect;
export type EntryRow = typeof websiteEntry.$inferSelect;
type DocumentRow = typeof documents.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface WebsiteActor {
  agentId: string | null;
  userId: string | null;
}

/** `secretName` is the linked secret's name (never its value). */
export function toWebsiteSite(row: SiteRow, secretName: string | null = null): WebsiteSite {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    domain: row.domain,
    repoUrl: row.repoUrl,
    netlifySiteId: row.netlifySiteId,
    hasNetlifyToken: Boolean(row.netlifyTokenSecretId),
    netlifyTokenSource: row.netlifyTokenSecretId ? (row.netlifyTokenSecretOwned ? "own" : "shared") : null,
    netlifyTokenSecretName: row.netlifyTokenSecretId ? secretName : null,
    blobsStoreName: row.blobsStoreName,
    engineVersion: row.engineVersion,
    releaseSchemaVersion: row.releaseSchemaVersion,
    propertyId: row.propertyId,
    editorOrigins: row.editorOrigins,
    editorFrameOrigin: row.editorFrameOrigin,
    livePreviewUrl: row.livePreviewUrl,
    devPreviewUrl: row.devPreviewUrl,
    checkPaths: row.checkPaths,
    liveReleaseId: row.liveReleaseId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function contentRow(row: PageRow | EntryRow, doc: Pick<DocumentRow, "latestRevisionId" | "latestRevisionNumber">) {
  return {
    id: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    documentId: row.documentId,
    latestRevisionId: doc.latestRevisionId,
    latestRevisionNumber: doc.latestRevisionNumber,
    approvedRevisionId: row.approvedRevisionId,
    publishedRevisionId: row.publishedRevisionId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toWebsitePage(row: PageRow, doc: Pick<DocumentRow, "latestRevisionId" | "latestRevisionNumber">): WebsitePage {
  return {
    ...contentRow(row, doc),
    slug: row.slug,
    title: row.title,
    navOrder: row.navOrder,
    parentPageId: row.parentPageId,
    menu: row.menu as WebsitePageMenu,
    menuOrder: row.menuOrder,
    status: row.status as WebsitePageStatus,
    seo: (row.seo ?? {}) as WebsitePageSeo,
  };
}

export function toWebsiteEntry(row: EntryRow, doc: Pick<DocumentRow, "latestRevisionId" | "latestRevisionNumber">): WebsiteEntry {
  return {
    ...contentRow(row, doc),
    collection: row.collection,
    entryKey: row.entryKey,
    orgId: row.orgId,
    status: row.status as WebsiteEntryStatus,
    sortOrder: row.sortOrder,
  };
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/** Serialise content for storage; `null` when it is too large or not JSON. */
export function serialiseWebsiteContent(content: unknown): { body: string } | { error: string } {
  let body: string | undefined;
  try {
    body = JSON.stringify(content);
  } catch {
    return { error: "The content is not valid JSON." };
  }
  if (body === undefined) return { error: "The content is not valid JSON." };
  if (Buffer.byteLength(body, "utf8") > WEBSITE_CONTENT_MAX_BYTES) {
    return { error: "The content is larger than 2 MB. Split the page or remove large inline data." };
  }
  return { body };
}

/**
 * Page and entry JSON in `documents` + `document_revisions` (ADR section 3).
 * Website documents are never linked to an issue, so they stay out of company
 * search and task document lists.
 */
export function websiteDocumentStore(db: Db) {
  async function createDocument(
    tx: Tx,
    input: { companyId: string; title: string; format: "puck-json" | "entry-json"; body: string; actor: WebsiteActor },
  ) {
    const now = new Date();
    const [doc] = await tx
      .insert(documents)
      .values({
        companyId: input.companyId,
        title: input.title,
        format: input.format,
        latestBody: input.body,
        latestRevisionNumber: 1,
        createdByAgentId: input.actor.agentId,
        createdByUserId: input.actor.userId,
        updatedByAgentId: input.actor.agentId,
        updatedByUserId: input.actor.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [revision] = await tx
      .insert(documentRevisions)
      .values({
        companyId: input.companyId,
        documentId: doc.id,
        revisionNumber: 1,
        title: input.title,
        format: input.format,
        body: input.body,
        changeSummary: "Created",
        createdByAgentId: input.actor.agentId,
        createdByUserId: input.actor.userId,
        createdAt: now,
      })
      .returning();
    await tx.update(documents).set({ latestRevisionId: revision.id }).where(eq(documents.id, doc.id));
    return { ...doc, latestRevisionId: revision.id };
  }

  /** One new revision if `baseRevisionId` is still the latest; otherwise a conflict and nothing written. */
  async function saveRevision(input: {
    companyId: string;
    documentId: string;
    content: unknown;
    baseRevisionId: string;
    changeSummary?: string | null;
    actor: WebsiteActor;
    afterSave?: (tx: Tx) => Promise<void>;
  }): Promise<WebsiteSaveResult> {
    const serialised = serialiseWebsiteContent(input.content);
    if ("error" in serialised) return { state: "failed", message: serialised.error };
    try {
      return await db.transaction(async (tx) => {
        const [doc] = await tx
          .select()
          .from(documents)
          .where(and(eq(documents.id, input.documentId), eq(documents.companyId, input.companyId)))
          .for("update");
        if (!doc) return { state: "failed", message: "The page is gone." } as const;
        if (doc.latestRevisionId !== input.baseRevisionId) {
          return {
            state: "conflict",
            latestRevisionId: doc.latestRevisionId,
            latestRevisionNumber: doc.latestRevisionNumber,
            message: "Someone saved a newer version first. Load it, then make your change again.",
          } as const;
        }
        const now = new Date();
        const revisionNumber = doc.latestRevisionNumber + 1;
        const [revision] = await tx
          .insert(documentRevisions)
          .values({
            companyId: input.companyId,
            documentId: doc.id,
            revisionNumber,
            title: doc.title,
            format: doc.format,
            body: serialised.body,
            changeSummary: input.changeSummary ?? null,
            createdByAgentId: input.actor.agentId,
            createdByUserId: input.actor.userId,
            createdAt: now,
          })
          .returning();
        await tx
          .update(documents)
          .set({
            latestBody: serialised.body,
            latestRevisionId: revision.id,
            latestRevisionNumber: revisionNumber,
            updatedByAgentId: input.actor.agentId,
            updatedByUserId: input.actor.userId,
            updatedAt: now,
          })
          .where(eq(documents.id, doc.id));
        await input.afterSave?.(tx);
        return { state: "saved", revisionId: revision.id, revisionNumber } as const;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return { state: "conflict", latestRevisionId: null, latestRevisionNumber: 0, message: "Someone saved at the same moment. Load the latest version and try again." };
      }
      return { state: "failed", message: "The save did not complete. Your edits are kept; try again." };
    }
  }

  async function listRevisions(companyId: string, documentId: string): Promise<WebsiteRevision[]> {
    const rows = await db
      .select({
        id: documentRevisions.id,
        revisionNumber: documentRevisions.revisionNumber,
        changeSummary: documentRevisions.changeSummary,
        createdByAgentId: documentRevisions.createdByAgentId,
        createdByUserId: documentRevisions.createdByUserId,
        createdAt: documentRevisions.createdAt,
      })
      .from(documentRevisions)
      .where(and(eq(documentRevisions.companyId, companyId), eq(documentRevisions.documentId, documentId)))
      .orderBy(desc(documentRevisions.revisionNumber));
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  async function readRevision(companyId: string, documentId: string, revisionId: string) {
    const [revision] = await db.select({ body: documentRevisions.body, revisionNumber: documentRevisions.revisionNumber })
      .from(documentRevisions)
      .where(and(eq(documentRevisions.companyId, companyId), eq(documentRevisions.documentId, documentId), eq(documentRevisions.id, revisionId)));
    return revision ? { revisionNumber: revision.revisionNumber, content: parseBody(revision.body) } : null;
  }

  async function readDocument(companyId: string, documentId: string) {
    const [doc] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.companyId, companyId)));
    return doc ?? null;
  }

  /** The whole revision row (id, author, time), for page history and restore. */
  async function readRevisionRow(companyId: string, documentId: string, revisionId: string) {
    const [row] = await db
      .select()
      .from(documentRevisions)
      .where(
        and(
          eq(documentRevisions.companyId, companyId),
          eq(documentRevisions.documentId, documentId),
          eq(documentRevisions.id, revisionId),
        ),
      );
    return row ?? null;
  }

  return { createDocument, saveRevision, listRevisions, readRevision, readRevisionRow, readDocument };
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

const EMPTY_PAGE = { root: { props: {} }, content: [], zones: {} };

export function websiteModuleService(db: Db) {
  const store = websiteDocumentStore(db);
  const secrets = secretService(db);

  // ---- sites ----

  async function listSites(companyId: string) {
    return db
      .select()
      .from(websiteSite)
      .where(eq(websiteSite.companyId, companyId))
      .orderBy(asc(websiteSite.createdAt));
  }

  async function getSite(companyId: string, siteId: string) {
    const [row] = await db
      .select()
      .from(websiteSite)
      .where(and(eq(websiteSite.companyId, companyId), eq(websiteSite.id, siteId)));
    return row ?? null;
  }

  /** Company secrets a site can use as its Netlify token: active, company scope, names only. */
  async function listTokenSecrets(companyId: string) {
    return db
      .select({ id: companySecrets.id, name: companySecrets.name })
      .from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.scope, "company"), eq(companySecrets.status, "active")))
      .orderBy(asc(companySecrets.name));
  }

  /** The name of a site's linked token secret, or null. Never the value. */
  async function tokenSecretName(site: Pick<SiteRow, "companyId" | "netlifyTokenSecretId">) {
    if (!site.netlifyTokenSecretId) return null;
    const [row] = await db
      .select({ name: companySecrets.name })
      .from(companySecrets)
      .where(and(eq(companySecrets.companyId, site.companyId), eq(companySecrets.id, site.netlifyTokenSecretId)));
    return row?.name ?? null;
  }

  /**
   * A shared token secret must be one the Publish job can read: this company's, company scope, active.
   * Another company's secret (or a person's own secret) is simply not found.
   */
  async function assertLinkableSecret(companyId: string, secretId: string) {
    const secret = await secrets.getById(secretId);
    if (!secret || secret.companyId !== companyId || secret.scope !== "company" || secret.status === "deleted") {
      throw notFound("That secret is not in this company", { code: "website_token_secret_not_found" });
    }
    if (secret.status !== "active") {
      throw unprocessable("That secret is not active. Choose an active secret or paste a token.", { code: "website_token_secret_inactive" });
    }
  }

  /**
   * Store a pasted token. Rotates the site's secret only when the site owns it; when the site uses a
   * shared secret, a new site-owned secret is created and the shared one is left untouched.
   */
  async function storeNetlifyToken(
    companyId: string,
    site: Pick<SiteRow, "id" | "domain" | "netlifyTokenSecretId" | "netlifyTokenSecretOwned">,
    token: string,
    userId: string | null,
  ) {
    if (site.netlifyTokenSecretId && site.netlifyTokenSecretOwned) {
      const existing = await secrets.getById(site.netlifyTokenSecretId);
      if (existing && existing.status === "active" && existing.companyId === companyId) {
        await secrets.rotate(existing.id, { value: token }, { userId });
        return existing.id;
      }
    }
    // A site that switched to a shared secret may have left its earlier own secret behind: never reuse that name.
    const base = `Website Netlify token ${site.id.slice(0, 8)}`;
    let name = base;
    for (let n = 2; await secrets.getByName(companyId, name); n += 1) name = `${base} ${n}`;
    const created = await secrets.create(
      companyId,
      {
        name,
        provider: "local_encrypted",
        value: token,
        description: `Netlify token for ${site.domain}, used only to publish this site (Website module).`,
      },
      { userId },
    );
    return created.id;
  }

  async function createSite(companyId: string, input: CreateWebsiteSite, actor: WebsiteActor) {
    if (input.netlifyTokenSecretId) await assertLinkableSecret(companyId, input.netlifyTokenSecretId);
    let row: SiteRow;
    try {
      [row] = await db
        .insert(websiteSite)
        .values({
          companyId,
          name: input.name,
          domain: input.domain,
          repoUrl: input.repoUrl ?? null,
          netlifySiteId: input.netlifySiteId,
          ...(input.netlifyTokenSecretId ? { netlifyTokenSecretId: input.netlifyTokenSecretId, netlifyTokenSecretOwned: false } : {}),
          propertyId: input.propertyId ?? null,
          editorOrigins: input.editorOrigins ?? [],
          editorFrameOrigin: input.editorFrameOrigin ?? null,
          livePreviewUrl: input.livePreviewUrl ?? null,
          devPreviewUrl: input.devPreviewUrl ?? null,
          checkPaths: input.checkPaths ?? ["/"],
        })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("This company already has a site with that domain", { code: "website_site_domain_taken" });
      throw err;
    }
    if (input.netlifyToken) {
      // The secret lives in its own store, so a failure removes the new site row rather than leaving it without a token.
      try {
        const secretId = await storeNetlifyToken(companyId, row, input.netlifyToken, actor.userId);
        [row] = await db.update(websiteSite).set({ netlifyTokenSecretId: secretId, netlifyTokenSecretOwned: true }).where(eq(websiteSite.id, row.id)).returning();
      } catch (err) {
        await db.delete(websiteSite).where(and(eq(websiteSite.companyId, companyId), eq(websiteSite.id, row.id)));
        throw err;
      }
    }
    return row;
  }

  async function updateSite(site: SiteRow, input: UpdateWebsiteSite, actor: WebsiteActor) {
    const { netlifyToken, netlifyTokenSecretId, archived, ...rest } = input;
    const patch: Partial<typeof websiteSite.$inferInsert> = { ...rest, updatedAt: new Date() };
    if (archived !== undefined) patch.archivedAt = archived ? new Date() : null;
    if (netlifyToken) {
      patch.netlifyTokenSecretId = await storeNetlifyToken(site.companyId, site, netlifyToken, actor.userId);
      patch.netlifyTokenSecretOwned = true;
    } else if (netlifyTokenSecretId === null) {
      // Unlink only. The secret stays in the company's secrets, shared or not.
      patch.netlifyTokenSecretId = null;
      patch.netlifyTokenSecretOwned = true;
    } else if (netlifyTokenSecretId && netlifyTokenSecretId !== site.netlifyTokenSecretId) {
      await assertLinkableSecret(site.companyId, netlifyTokenSecretId);
      patch.netlifyTokenSecretId = netlifyTokenSecretId;
      patch.netlifyTokenSecretOwned = false;
    }
    try {
      const [row] = await db
        .update(websiteSite)
        .set(patch)
        .where(and(eq(websiteSite.companyId, site.companyId), eq(websiteSite.id, site.id)))
        .returning();
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("This company already has a site with that domain", { code: "website_site_domain_taken" });
      throw err;
    }
  }

  // ---- pages ----

  const pageWithDoc = {
    page: websitePage,
    latestRevisionId: documents.latestRevisionId,
    latestRevisionNumber: documents.latestRevisionNumber,
  };

  async function listPages(companyId: string, siteId: string, includeArchived = false) {
    const rows = await db
      .select(pageWithDoc)
      .from(websitePage)
      .innerJoin(documents, eq(documents.id, websitePage.documentId))
      .where(
        and(
          eq(websitePage.companyId, companyId),
          eq(websitePage.siteId, siteId),
          includeArchived ? undefined : isNull(websitePage.archivedAt),
        ),
      )
      .orderBy(asc(websitePage.slug));
    return rows.map((row) => toWebsitePage(row.page, row));
  }

  async function getPageRow(companyId: string, siteId: string, pageId: string) {
    const [row] = await db
      .select()
      .from(websitePage)
      .where(and(eq(websitePage.companyId, companyId), eq(websitePage.siteId, siteId), eq(websitePage.id, pageId)));
    return row ?? null;
  }

  async function pageDetail(row: PageRow) {
    const doc = await store.readDocument(row.companyId, row.documentId);
    if (!doc) return null;
    return { ...toWebsitePage(row, doc), content: parseBody(doc.latestBody) };
  }

  /** The parent must be a live page of the same site, and not the page itself or one of its descendants. */
  async function assertParent(companyId: string, siteId: string, pageId: string | null, parentPageId: string | null | undefined) {
    if (!parentPageId) return;
    let cursor: string | null = parentPageId;
    for (let depth = 0; cursor && depth < 50; depth += 1) {
      if (cursor === pageId) throw unprocessable("A page cannot sit under itself or one of its own sub-pages", { code: "website_page_parent_cycle" });
      const parent = await getPageRow(companyId, siteId, cursor);
      if (!parent || parent.archivedAt) throw unprocessable("The parent page is not a page of this site", { code: "website_page_parent_not_found" });
      cursor = parent.parentPageId;
    }
  }

  async function createPage(companyId: string, siteId: string, input: CreatePageInput, actor: WebsiteActor) {
    await assertParent(companyId, siteId, null, input.parentPageId);
    const serialised = serialiseWebsiteContent(input.content ?? EMPTY_PAGE);
    if ("error" in serialised) throw unprocessable(serialised.error, { code: "website_content_invalid" });
    try {
      return await db.transaction(async (tx) => {
        const doc = await store.createDocument(tx, { companyId, title: input.title, format: "puck-json", body: serialised.body, actor });
        const [row] = await tx
          .insert(websitePage)
          .values({
            companyId,
            siteId,
            slug: input.slug,
            title: input.title,
            status: input.status ?? "draft",
            seo: input.seo ?? {},
            parentPageId: input.parentPageId ?? null,
            menu: input.menu ?? "none",
            menuOrder: input.menuOrder ?? null,
            navOrder: input.navOrder ?? null,
            documentId: doc.id,
          })
          .returning();
        return { ...toWebsitePage(row, doc), content: parseBody(serialised.body) };
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A page with the path ${input.slug} already exists on this site`, { code: "website_page_slug_taken" });
      throw err;
    }
  }

  async function updatePage(row: PageRow, input: UpdateWebsitePage) {
    const { archived, ...fields } = input;
    if (fields.parentPageId !== undefined) await assertParent(row.companyId, row.siteId, row.id, fields.parentPageId);
    const slug = fields.slug ?? row.slug;
    try {
      const [updated] = await db
        .update(websitePage)
        .set({ ...fields, ...(archived === false ? { archivedAt: null } : {}), updatedAt: new Date() })
        .where(and(eq(websitePage.companyId, row.companyId), eq(websitePage.id, row.id)))
        .returning();
      if (fields.title !== undefined) {
        await db.update(documents).set({ title: fields.title }).where(and(eq(documents.id, row.documentId), eq(documents.companyId, row.companyId)));
      }
      return updated;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A page with the path ${slug} already exists on this site`, { code: "website_page_slug_taken" });
      throw err;
    }
  }

  /** Archive, never delete (old releases still name the page). Sub-pages move up to the archived page's parent. */
  async function archivePage(row: PageRow) {
    return db.transaction(async (tx) => {
      await tx
        .update(websitePage)
        .set({ parentPageId: row.parentPageId, updatedAt: new Date() })
        .where(and(eq(websitePage.companyId, row.companyId), eq(websitePage.siteId, row.siteId), eq(websitePage.parentPageId, row.id)));
      const [updated] = await tx
        .update(websitePage)
        .set({ archivedAt: row.archivedAt ?? new Date(), parentPageId: null, updatedAt: new Date() })
        .where(and(eq(websitePage.companyId, row.companyId), eq(websitePage.id, row.id)))
        .returning();
      return updated;
    });
  }

  // ---- review (GRE-2109): submit is website:edit; approve and send back are website:publish, people only ----

  function assertReviewable(row: PageRow | EntryRow) {
    if (row.archivedAt) throw unprocessable(WEBSITE_MESSAGES["review.archived"], { code: "website_review_archived" });
    if (row.status === "planned") throw unprocessable(WEBSITE_MESSAGES["review.planned"], { code: "website_review_planned" });
  }

  async function setPageReview(row: PageRow, patch: Partial<typeof websitePage.$inferInsert>) {
    const [updated] = await db
      .update(websitePage)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(websitePage.companyId, row.companyId), eq(websitePage.id, row.id)))
      .returning();
    return updated;
  }

  async function setEntryReview(row: EntryRow, patch: Partial<typeof websiteEntry.$inferInsert>) {
    const [updated] = await db
      .update(websiteEntry)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(websiteEntry.companyId, row.companyId), eq(websiteEntry.id, row.id)))
      .returning();
    return updated;
  }

  /** The approved revision is the latest one at the moment a person approves. */
  async function latestRevisionId(row: PageRow | EntryRow) {
    const doc = await store.readDocument(row.companyId, row.documentId);
    if (!doc?.latestRevisionId) throw unprocessable("There is no saved version to approve.", { code: "website_review_no_revision" });
    return doc.latestRevisionId;
  }

  async function submitPage(row: PageRow) {
    assertReviewable(row);
    return setPageReview(row, { status: "review" });
  }

  async function approvePage(row: PageRow) {
    assertReviewable(row);
    return setPageReview(row, { status: "approved", approvedRevisionId: await latestRevisionId(row) });
  }

  async function sendBackPage(row: PageRow) {
    if (row.status !== "review") throw unprocessable(WEBSITE_MESSAGES["review.not_in_review"], { code: "website_review_not_in_review" });
    return setPageReview(row, { status: "draft" });
  }

  async function submitEntry(row: EntryRow) {
    assertReviewable(row);
    return setEntryReview(row, { status: "review" });
  }

  async function approveEntry(row: EntryRow) {
    assertReviewable(row);
    if (row.status !== "review") throw unprocessable(WEBSITE_MESSAGES["review.not_in_review"], { code: "website_review_not_in_review" });
    return setEntryReview(row, { status: "approved", approvedRevisionId: await latestRevisionId(row) });
  }

  async function sendBackEntry(row: EntryRow) {
    if (row.status !== "review") throw unprocessable(WEBSITE_MESSAGES["review.not_in_review"], { code: "website_review_not_in_review" });
    return setEntryReview(row, { status: "draft" });
  }

  async function withDoc<T extends PageRow | EntryRow>(row: T) {
    const doc = await store.readDocument(row.companyId, row.documentId);
    return { row, doc: doc ?? { latestRevisionId: null, latestRevisionNumber: 0 } };
  }

  // ---- entries ----

  async function listEntries(companyId: string, siteId: string, collection?: string, includeArchived = false) {
    const rows = await db
      .select({ entry: websiteEntry, latestRevisionId: documents.latestRevisionId, latestRevisionNumber: documents.latestRevisionNumber })
      .from(websiteEntry)
      .innerJoin(documents, eq(documents.id, websiteEntry.documentId))
      .where(
        and(
          eq(websiteEntry.companyId, companyId),
          eq(websiteEntry.siteId, siteId),
          collection ? eq(websiteEntry.collection, collection) : undefined,
          includeArchived ? undefined : isNull(websiteEntry.archivedAt),
        ),
      )
      .orderBy(asc(websiteEntry.collection), sql`${websiteEntry.sortOrder} asc nulls last`, asc(websiteEntry.entryKey));
    return rows.map((row) => toWebsiteEntry(row.entry, row));
  }

  async function getEntryRow(companyId: string, siteId: string, entryId: string) {
    const [row] = await db
      .select()
      .from(websiteEntry)
      .where(and(eq(websiteEntry.companyId, companyId), eq(websiteEntry.siteId, siteId), eq(websiteEntry.id, entryId)));
    return row ?? null;
  }

  async function entryDetail(row: EntryRow) {
    const doc = await store.readDocument(row.companyId, row.documentId);
    if (!doc) return null;
    return { ...toWebsiteEntry(row, doc), content: parseBody(doc.latestBody) };
  }

  async function createEntry(companyId: string, siteId: string, input: CreateWebsiteEntry, actor: WebsiteActor) {
    const serialised = serialiseWebsiteContent(input.content ?? {});
    if ("error" in serialised) throw unprocessable(serialised.error, { code: "website_content_invalid" });
    try {
      return await db.transaction(async (tx) => {
        const doc = await store.createDocument(tx, {
          companyId,
          title: `${input.collection}/${input.entryKey}`,
          format: "entry-json",
          body: serialised.body,
          actor,
        });
        const [row] = await tx
          .insert(websiteEntry)
          .values({
            companyId,
            siteId,
            collection: input.collection,
            entryKey: input.entryKey,
            orgId: input.orgId ?? null,
            sortOrder: input.sortOrder ?? null,
            documentId: doc.id,
          })
          .returning();
        return { ...toWebsiteEntry(row, doc), content: parseBody(serialised.body) };
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`${input.collection} already has an entry ${input.entryKey}`, { code: "website_entry_key_taken" });
      throw err;
    }
  }

  async function updateEntry(row: EntryRow, input: UpdateWebsiteEntry) {
    const { archived, ...fields } = input;
    try {
      const [updated] = await db
        .update(websiteEntry)
        .set({ ...fields, ...(archived === false ? { archivedAt: null } : {}), updatedAt: new Date() })
        .where(and(eq(websiteEntry.companyId, row.companyId), eq(websiteEntry.id, row.id)))
        .returning();
      return updated;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`${row.collection} already has an entry ${fields.entryKey ?? row.entryKey}`, { code: "website_entry_key_taken" });
      throw err;
    }
  }

  async function archiveEntry(row: EntryRow) {
    const [updated] = await db
      .update(websiteEntry)
      .set({ archivedAt: row.archivedAt ?? new Date(), updatedAt: new Date() })
      .where(and(eq(websiteEntry.companyId, row.companyId), eq(websiteEntry.id, row.id)))
      .returning();
    return updated;
  }

  // ---- editor ----

  /** A revision of this page's own document, or null (another page's or company's revision is not found). */
  async function pageRevision(row: PageRow, revisionId: string) {
    const revision = await store.readRevisionRow(row.companyId, row.documentId, revisionId);
    if (!revision) return null;
    return {
      revision: {
        id: revision.id,
        revisionNumber: revision.revisionNumber,
        changeSummary: revision.changeSummary,
        createdByAgentId: revision.createdByAgentId,
        createdByUserId: revision.createdByUserId,
        createdAt: revision.createdAt.toISOString(),
      },
      body: revision.body,
    };
  }

  /** Restore = a new revision with the old content, so restoring can itself be undone. */
  async function restorePageRevision(row: PageRow, revisionId: string, baseRevisionId: string, actor: WebsiteActor): Promise<WebsiteSaveResult | null> {
    const found = await pageRevision(row, revisionId);
    if (!found) return null;
    return store.saveRevision({
      companyId: row.companyId,
      documentId: row.documentId,
      content: parseBody(found.body),
      baseRevisionId,
      changeSummary: `Restored version ${found.revision.revisionNumber}`,
      actor,
    });
  }

  /**
   * The site's media entries whose asset is in the same company (ADR section 2:
   * `{ assetId, alt, caption, focalPoint }`). An entry naming another
   * company's asset, or none, is left out.
   */
  async function listMedia(companyId: string, siteId: string): Promise<WebsiteMediaItem[]> {
    const rows = await db
      .select({ entry: websiteEntry, body: documents.latestBody })
      .from(websiteEntry)
      .innerJoin(documents, and(eq(documents.id, websiteEntry.documentId), eq(documents.companyId, companyId)))
      .where(
        and(
          eq(websiteEntry.companyId, companyId),
          eq(websiteEntry.siteId, siteId),
          eq(websiteEntry.collection, "media"),
          isNull(websiteEntry.archivedAt),
        ),
      )
      .orderBy(sql`${websiteEntry.sortOrder} asc nulls last`, asc(websiteEntry.entryKey));
    const parsed = rows.map((row) => ({ entry: row.entry, fields: asRecord(parseBody(row.body)) }));
    const assetIds = [...new Set(parsed.map((row) => row.fields.assetId).filter(isUuid))];
    if (assetIds.length === 0) return [];
    const assetRows = await db
      .select({ id: assets.id, contentType: assets.contentType, byteSize: assets.byteSize })
      .from(assets)
      .where(and(eq(assets.companyId, companyId), inArray(assets.id, assetIds)));
    const byId = new Map(assetRows.map((row) => [row.id, row]));
    const media: WebsiteMediaItem[] = [];
    for (const { entry, fields } of parsed) {
      const asset = isUuid(fields.assetId) ? byId.get(fields.assetId) : undefined;
      if (!asset) continue;
      media.push({
        entryId: entry.id,
        entryKey: entry.entryKey,
        assetId: asset.id,
        alt: typeof fields.alt === "string" ? fields.alt : "",
        caption: typeof fields.caption === "string" ? fields.caption : null,
        contentType: asset.contentType,
        byteSize: asset.byteSize,
        width: positiveInt(fields.width),
        height: positiveInt(fields.height),
        contentPath: `/api/assets/${asset.id}/content`,
      });
    }
    return media;
  }

  async function editorLoad(site: SiteRow, row: PageRow, editorFrameOrigin: string): Promise<WebsitePageEditorLoad | null> {
    const doc = await store.readDocument(row.companyId, row.documentId);
    if (!doc || !doc.latestRevisionId) return null;
    const pages = await listPages(site.companyId, site.id);
    return {
      page: toWebsitePage(row, doc),
      revisionId: doc.latestRevisionId,
      data: parseBody(doc.latestBody),
      theme: site.theme ?? {},
      site: {
        name: site.name,
        settings: { domain: site.domain },
        navigation: pages
          .filter((page) => page.menu !== "none")
          .map((page) => ({ pageId: page.id, title: page.title, slug: page.slug, menu: page.menu, menuOrder: page.menuOrder })),
      },
      editorFrameOrigin,
      media: await listMedia(site.companyId, site.id),
    };
  }

  async function saveEntryRevision(row: EntryRow, input: {
    content: unknown; baseRevisionId: string; changeSummary?: string; actor: WebsiteActor;
  }) {
    return store.saveRevision({
      companyId: row.companyId,
      documentId: row.documentId,
      ...input,
      afterSave: async (tx) => {
        await tx.update(websiteEntry)
          .set({ status: "draft", approvedRevisionId: null, updatedAt: new Date() })
          .where(and(eq(websiteEntry.companyId, row.companyId), eq(websiteEntry.id, row.id)));
      },
    });
  }

  return {
    store,
    pageRevision,
    restorePageRevision,
    listMedia,
    editorLoad,
    listSites,
    listTokenSecrets,
    tokenSecretName,
    getSite,
    createSite,
    updateSite,
    listPages,
    getPageRow,
    pageDetail,
    createPage,
    updatePage,
    archivePage,
    submitPage,
    approvePage,
    sendBackPage,
    withDoc,
    listEntries,
    getEntryRow,
    entryDetail,
    createEntry,
    updateEntry,
    archiveEntry,
    saveEntryRevision,
    submitEntry,
    approveEntry,
    sendBackEntry,
  };
}

type CreatePageInput = CreateWebsitePage & { status?: WebsitePageStatus };
