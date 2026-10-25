import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { companies, companyMemberships, organisations, pipelineCaseIssueLinks, pipelineCases, pipelines, websiteFeature, websiteProperties, websiteSite } from "@greatstone/db";
import { pipelineService } from "../pipelines.js";
import { logActivity } from "../activity-log.js";
import { issueService } from "../issues.js";
import { logger } from "../../middleware/logger.js";

/** The read-only shape supplied by the website admin bridge. */
export interface WebsiteEnquiry {
  id: string;
  name: string;
  email: string;
  organisationName?: string | null;
  phone?: string | null;
  message?: string | null;
  source?: string | null;
  page?: string | null;
  utm?: Record<string, string | null>;
  consent?: Record<string, boolean | string | null>;
  createdAt: string;
}

export interface WebsiteEnquiryReader {
  /** A cursor is opaque to GSAM. An empty nextCursor ends the read. */
  listEnquiries(siteId: string, cursor?: string): Promise<{ items: WebsiteEnquiry[]; nextCursor?: string | null }>;
}

export type WebsiteEnquiryCopy = (input: {
  companyId: string;
  siteId: string;
  caseId: string;
  enquiry: WebsiteEnquiry;
}) => Promise<unknown>;

export const WEBSITE_ENQUIRIES_PIPELINE_KEY = "website-enquiries";
const PERSONAL_DOMAINS = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "aol.com", "proton.me", "protonmail.com"]);
const MAX_PAGES = 200;

export function enquiryCaseKey(siteId: string, enquiryId: string) {
  return `website-enquiry:${siteId}:${enquiryId}`;
}

export function enquiryEmailDomain(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const domain = trimmed.slice(at + 1);
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(domain) ? domain : null;
}

function organisationName(enquiry: WebsiteEnquiry, domain: string | null) {
  const supplied = enquiry.organisationName?.trim();
  if (supplied) return supplied;
  if (domain && !PERSONAL_DOMAINS.has(domain)) return domain;
  return enquiry.email.trim().toLowerCase();
}

function isUniqueViolation(error: unknown) {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

export function websiteEnquiryService(db: Db, copyToPipedrive?: WebsiteEnquiryCopy) {
  const pipeline = pipelineService(db);
  const issues = issueService(db);

  async function ensureInboxItem(companyId: string, siteId: string, caseId: string, name: string) {
    const [linked] = await db.select({ id: pipelineCaseIssueLinks.id }).from(pipelineCaseIssueLinks).where(and(
      eq(pipelineCaseIssueLinks.companyId, companyId), eq(pipelineCaseIssueLinks.caseId, caseId),
      eq(pipelineCaseIssueLinks.role, "origin"),
    )).limit(1);
    if (linked) return;
    const [site] = await db.select({ propertyId: websiteSite.propertyId }).from(websiteSite).where(and(
      eq(websiteSite.companyId, companyId), eq(websiteSite.id, siteId),
    )).limit(1);
    if (!site) return; // Service tests may import against a fake site id.
    const [feature] = await db.select({ ownerUserId: websiteFeature.ownerUserId, projectId: websiteFeature.projectId })
      .from(websiteFeature).where(and(
        eq(websiteFeature.companyId, companyId), eq(websiteFeature.siteId, siteId),
        eq(websiteFeature.key, "front-door"), isNull(websiteFeature.archivedAt),
      )).limit(1);
    const [property] = site.propertyId
      ? await db.select({ projectId: websiteProperties.projectId }).from(websiteProperties).where(and(
        eq(websiteProperties.companyId, companyId), eq(websiteProperties.id, site.propertyId),
      )).limit(1)
      : [];
    const [company] = await db.select({ defaultResponsibleUserId: companies.defaultResponsibleUserId })
      .from(companies).where(eq(companies.id, companyId)).limit(1);
    const ownerCandidates = [feature?.ownerUserId, company?.defaultResponsibleUserId].filter((id): id is string => Boolean(id));
    let ownerUserId: string | null = null;
    for (const candidate of ownerCandidates) {
      const [member] = await db.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
        eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, candidate), eq(companyMemberships.status, "active"),
      )).limit(1);
      if (member) { ownerUserId = candidate; break; }
    }
    const safeName = name.replace(/[\r\n\t]+/g, " ").trim().slice(0, 80);
    const issue = await issues.create(companyId, {
      title: `Website enquiry: ${safeName}`,
      description: `A new website enquiry is filed in [GSAM's Pipeline](/pipelines/${(await ensurePipeline(companyId))}/cases/${caseId}). Review it there.`,
      status: "todo",
      priority: "medium",
      assigneeUserId: ownerUserId,
      projectId: feature?.projectId ?? property?.projectId ?? null,
      originKind: "website_enquiry",
      originId: caseId,
      idempotencyKey: `website-enquiry-inbox:${caseId}`,
    });
    await db.insert(pipelineCaseIssueLinks).values({
      companyId, caseId, issueId: issue.id, role: "origin",
    }).onConflictDoNothing();
  }

  async function ensurePipeline(companyId: string) {
    const find = () => db.select().from(pipelines).where(and(
      eq(pipelines.companyId, companyId), eq(pipelines.key, WEBSITE_ENQUIRIES_PIPELINE_KEY),
    )).then((rows) => rows[0] ?? null);
    const existing = await find();
    if (existing) return existing.id;
    try {
      const created = await pipeline.createPipeline({
        companyId,
        key: WEBSITE_ENQUIRIES_PIPELINE_KEY,
        name: "Website enquiries",
        description: "Enquiries read from the website admin bridge.",
        stages: [
          { key: "new", name: "New", kind: "working", position: 100 },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
        actor: { type: "system" },
      });
      return created.id;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await find();
      if (!raced) throw error;
      return raced.id;
    }
  }

  async function organisationFor(companyId: string, enquiry: WebsiteEnquiry) {
    const domain = enquiryEmailDomain(enquiry.email);
    const companyDomain = domain && !PERSONAL_DOMAINS.has(domain) ? domain : null;
    // The email address is stable for personal mailboxes, so unrelated people
    // with the same public mail provider are never filed under one company.
    const name = organisationName(enquiry, domain);
    const matchKey = `${companyId}:${companyDomain ?? name.toLowerCase()}`;
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${matchKey}, 0))`);
      if (companyDomain) {
        const [matched] = await tx.select({ id: organisations.id }).from(organisations).where(and(
          eq(organisations.companyId, companyId),
          isNull(organisations.archivedAt),
          sql`lower(${organisations.domain}) = ${companyDomain}`,
        )).orderBy(organisations.createdAt).limit(1);
        if (matched) return matched.id;
      }
      const [matchedByName] = await tx.select({ id: organisations.id }).from(organisations).where(and(
        eq(organisations.companyId, companyId),
        isNull(organisations.archivedAt),
        sql`lower(${organisations.name}) = ${name.toLowerCase()}`,
      )).orderBy(organisations.createdAt).limit(1);
      if (matchedByName) return matchedByName.id;
      const [created] = await tx.insert(organisations).values({
        companyId,
        name,
        domain: companyDomain,
        status: "prospect",
        source: "manual",
      }).returning({ id: organisations.id });
      return created!.id;
    });
  }

  async function importOne(companyId: string, siteId: string, enquiry: WebsiteEnquiry) {
    if (!enquiry.id.trim() || !enquiry.email.trim() || !enquiry.name.trim()) {
      throw new Error("Website enquiry is missing its id, name or email");
    }
    const pipelineId = await ensurePipeline(companyId);
    const caseKey = enquiryCaseKey(siteId, enquiry.id);
    const [existing] = await db.select({ id: pipelineCases.id }).from(pipelineCases).where(and(
      eq(pipelineCases.companyId, companyId),
      eq(pipelineCases.pipelineId, pipelineId),
      eq(pipelineCases.caseKey, caseKey),
    )).limit(1);
    if (existing) {
      await ensureInboxItem(companyId, siteId, existing.id, enquiry.name);
      return { caseId: existing.id, created: false };
    }
    const organisationId = await organisationFor(companyId, enquiry);
    const result = await pipeline.ingestCase({
      companyId,
      pipelineId,
      caseKey,
      stageKey: "new",
      title: `${enquiry.name.trim()}: website enquiry`,
      summary: enquiry.message?.trim() || null,
      organisationId,
      fields: {
        websiteSiteId: siteId,
        websiteEnquiryId: enquiry.id,
        contactName: enquiry.name.trim(),
        contactEmail: enquiry.email.trim(),
        contactPhone: enquiry.phone?.trim() || null,
        source: enquiry.source ?? "website",
        page: enquiry.page ?? null,
        utm: enquiry.utm ?? {},
        consent: enquiry.consent ?? {},
        submittedAt: enquiry.createdAt,
      },
      actor: { type: "system" },
    });
    if (result.created) {
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "website-enquiry-import",
        action: "website.enquiry.imported",
        entityType: "pipeline_case",
        entityId: result.case.id,
        details: { siteId, enquiryId: enquiry.id },
      });
    }
    await ensureInboxItem(companyId, siteId, result.case.id, enquiry.name);
    return { caseId: result.case.id, created: result.created };
  }

  return {
    ensurePipeline,
    importOne,
    async importFromBridge(companyId: string, siteId: string, reader: WebsiteEnquiryReader) {
      let cursor: string | undefined;
      let created = 0;
      let skipped = 0;
      const seen = new Set<string>();
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const batch = await reader.listEnquiries(siteId, cursor);
        for (const item of batch.items) {
          const result = await importOne(companyId, siteId, item);
          if (result.created) created += 1;
          else skipped += 1;
          if (copyToPipedrive) {
            try {
              await copyToPipedrive({ companyId, siteId, caseId: result.caseId, enquiry: item });
            } catch (err) {
              logger.warn({ err, companyId, siteId, caseId: result.caseId, enquiryId: item.id }, "website enquiry Pipedrive copy failed; will retry on next pull");
            }
          }
        }
        if (!batch.nextCursor) return { created, skipped };
        if (seen.has(batch.nextCursor)) throw new Error("Website enquiry bridge repeated a page cursor");
        seen.add(batch.nextCursor);
        cursor = batch.nextCursor;
      }
      throw new Error("Website enquiry bridge exceeded its page limit");
    },
    async list(companyId: string, siteId: string) {
      const [existing] = await db.select({ id: pipelines.id }).from(pipelines).where(and(
        eq(pipelines.companyId, companyId), eq(pipelines.key, WEBSITE_ENQUIRIES_PIPELINE_KEY),
      )).limit(1);
      if (!existing) return [];
      return db.select().from(pipelineCases).where(and(
        eq(pipelineCases.companyId, companyId),
        eq(pipelineCases.pipelineId, existing.id),
        sql`${pipelineCases.fields} ->> 'websiteSiteId' = ${siteId}`,
      )).orderBy(desc(pipelineCases.createdAt)).limit(200);
    },
  };
}

/** Poll sites with a configured bridge read key every five minutes. */
export function startWebsiteEnquiryScheduler(
  db: Db,
  reader: WebsiteEnquiryReader,
  copyToPipedrive: WebsiteEnquiryCopy,
  onError: (error: unknown, siteId: string) => void,
) {
  const service = websiteEnquiryService(db, copyToPipedrive);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const sites = await db.select({ id: websiteSite.id, companyId: websiteSite.companyId })
        .from(websiteSite).where(and(isNull(websiteSite.archivedAt), isNotNull(websiteSite.dataBridgeReadSecretId)));
      for (const site of sites) {
        try {
          await service.importFromBridge(site.companyId, site.id, reader);
        } catch (error) {
          onError(error, site.id);
        }
      }
    } catch (error) {
      onError(error, "");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, 5 * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
