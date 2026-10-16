import type { StorageService } from "../storage/types.js";
import { Router, type Request } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { assets, crmFiles, organisations, toolConnections, type Db } from "@greatstone/db";
import {
  createOrganisationContactSchema,
  createOrganisationSchema,
  importOrganisationsFromPipedriveSchema,
  importHubspotExportSchema,
  importNotionSchema,
  importPipedriveExportSchema,
  listOrganisationsQuerySchema,
  updateOrganisationContactSchema,
  updateOrganisationSchema,
} from "@greatstone/shared";
import { contentDispositionHeader, isInlineAttachmentContentType, SVG_CONTENT_TYPE } from "../attachment-types.js";
import { badRequest, conflict, forbidden, HttpError, notFound, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { logActivity } from "../services/activity-log.js";
import { resolveCrmConnectionCredential } from "../services/crm-sync-runner.js";
import {
  createPipedriveClient,
  PipedriveApiError,
  PipedriveAuthError,
  PipedriveRateLimitError,
  resolvePipedriveBaseUrl,
  type PipedriveFetch,
} from "../services/crm-sync-pipedrive.js";
import { requireEntitlement } from "../services/entitlements.js";
import { crmProductService } from "../services/crm-products.js";
import { organisationHistoryService } from "../services/organisation-history.js";
import { notionImportService } from "../services/organisation-import-notion.js";
import { pipedriveOrganisationImportService } from "../services/organisation-import-pipedrive.js";
import {
  hubspotExportImportService,
  pipedriveExportImportService,
} from "../services/organisation-import-pipedrive-export.js";
import { organisationService } from "../services/organisations.js";
import { assertBoard, assertCompanyAccess, getActorInfo, hasCompanyBoardRole } from "./authz.js";

type ConnectionRow = typeof toolConnections.$inferSelect;

export interface OrganisationRouteDeps {
  /** Tests pass recorded Pipedrive pages and a stub credential. */
  pipedriveFetch?: PipedriveFetch;
  resolveCredential?: (connection: ConnectionRow) => Promise<string>;
  /** Where imported CRM files are copied. Without it, files keep their details only. */
  storage?: StorageService;
}

/** Companies with an import running in this process, so two clicks do not race. */
const runningImports = new Set<string>();

/** Organisations are part of the CRM, so they are off while enablePipelines is off. */
export const ORGANISATION_ROUTE_PREFIX = "/companies/:companyId/organisations";

const idSchema = z.string().guid();

function parseId(value: unknown, what: string) {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw notFound(`${what} not found`);
  return parsed.data;
}

/**
 * CRM organisations and their contacts (GRE-1477). Every route carries the
 * company id and every query is scoped to it, so another company's record
 * answers 404. Reads need company access; writes need Work cases on all
 * pipelines (pipelines:cases with no pipeline scope): owners, admins and
 * operators by role, agents only with an explicit grant.
 */
export function organisationRoutes(db: Db, deps: OrganisationRouteDeps = {}) {
  const router = Router();
  const svc = organisationService(db);
  const access = accessService(db);
  const importer = pipedriveOrganisationImportService(db, { storage: deps.storage });
  const exportImporter = pipedriveExportImportService(db);
  const hubspotImporter = hubspotExportImportService(db);
  const notionImporter = notionImportService(db);
  const history = organisationHistoryService(db);
  const products = crmProductService(db);
  const resolveCredential = deps.resolveCredential ?? ((connection: ConnectionRow) => resolveCrmConnectionCredential(db, connection));

  router.use(ORGANISATION_ROUTE_PREFIX, requireEntitlement(db, "enablePipelines"));
  router.use("/companies/:companyId/crm-files", requireEntitlement(db, "enablePipelines"));
  router.use("/companies/:companyId/crm-products", requireEntitlement(db, "enablePipelines"));

  async function assertCrmWriter(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "pipelines:cases",
      resource: { type: "company", companyId },
      scope: null,
    });
    if (!decision.allowed) {
      throw new HttpError(403, "You may view organisations but not change them", {
        code: "crm_write_forbidden",
        reason: decision.reason,
      });
    }
    const actor = getActorInfo(req);
    return {
      actor,
      createdBy: { userId: actor.actorType === "user" ? actor.actorId : null, agentId: actor.agentId },
    };
  }

  function actorIds(req: Request) {
    const actor = getActorInfo(req);
    return { userId: actor.actorType === "user" ? actor.actorId : null, agentId: actor.agentId };
  }

  async function audit(
    req: Request,
    companyId: string,
    action: string,
    entityId: string,
    details: Record<string, unknown>,
  ) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action,
      entityType: "organisation",
      entityId,
      details,
    });
  }

  router.get(ORGANISATION_ROUTE_PREFIX, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = listOrganisationsQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest("Invalid query", parsed.error.flatten());
    res.json(await svc.list(companyId, parsed.data));
  });

  router.post(ORGANISATION_ROUTE_PREFIX, validate(createOrganisationSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const { createdBy } = await assertCrmWriter(req, companyId);
    const organisation = await svc.create(companyId, req.body, createdBy);
    await audit(req, companyId, "organisation.created", organisation.id, { name: organisation.name });
    res.status(201).json(organisation);
  });

  /**
   * Full read-only import of every Pipedrive organisation and person (GRE-1479).
   * Company owners only. Nothing is written to Pipedrive; a rerun updates the
   * rows it made before instead of adding new ones.
   */
  router.post(
    `${ORGANISATION_ROUTE_PREFIX}/import/pipedrive`,
    validate(importOrganisationsFromPipedriveSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      if (!hasCompanyBoardRole(req, companyId)) {
        throw forbidden("Only a company owner may run the Pipedrive import", { code: "owner_required" });
      }
      const connection = await db
        .select()
        .from(toolConnections)
        .where(and(eq(toolConnections.id, req.body.connectionId), eq(toolConnections.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      // Same answer for "missing" and "another company's" so ids do not leak.
      if (!connection) throw unprocessable("Connection not found", { code: "connection_not_found" });
      if (!connection.enabled || connection.status !== "active") {
        throw unprocessable("The Pipedrive connection is turned off or not active. Turn it on in Connections first.", {
          code: "connection_not_active",
        });
      }
      if (runningImports.has(companyId)) {
        throw conflict("A Pipedrive import is already running for this company", { code: "import_running" });
      }

      runningImports.add(companyId);
      try {
        let token: string;
        try {
          token = await resolveCredential(connection);
        } catch (error) {
          throw unprocessable("The Pipedrive connection has no usable credential. Reconnect it in Connections.", {
            code: "credential_missing",
            detail: (error as Error).message,
          });
        }
        const client = createPipedriveClient({
          token,
          authKind: connection.authKind,
          baseUrl: resolvePipedriveBaseUrl(connection.config),
          fetch: deps.pipedriveFetch,
        });
        let result;
        try {
          result = await importer.run(companyId, client, actorIds(req));
        } catch (error) {
          if (error instanceof PipedriveAuthError) {
            throw unprocessable("Pipedrive refused the credential. Reconnect Pipedrive in Connections.", {
              code: "pipedrive_auth_failed",
            });
          }
          if (error instanceof PipedriveRateLimitError) {
            throw new HttpError(503, "Pipedrive rate limit reached. Run the import again later; rows already imported are updated, not duplicated.", {
              code: "pipedrive_rate_limited",
              retryAfterMs: error.retryAfterMs,
            });
          }
          if (error instanceof PipedriveApiError) {
            throw new HttpError(502, error.message, { code: "pipedrive_error" });
          }
          throw error;
        }
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "organisation.import_completed",
          entityType: "company",
          entityId: companyId,
          details: {
            source: "pipedrive",
            connectionId: connection.id,
            // Every count the run made, so Integrations can say what a re-import changed.
            ...Object.fromEntries(Object.entries(result).filter(([, value]) => (
              Boolean(value) && typeof value === "object" && !Array.isArray(value) && "created" in value
            ))),
            errorCount: result.errorSamples.length,
          },
        });
        res.json(result);
      } finally {
        runningImports.delete(companyId);
      }
    },
  );

  /**
   * Import of the CSV files Pipedrive exports, for teams without an API key.
   * Company owners only, like the API import, and it shares its rows: a later
   * API import updates what this one made. Open deals become client cases in
   * the chosen pipeline.
   */
  router.post(
    `${ORGANISATION_ROUTE_PREFIX}/import/pipedrive-export`,
    validate(importPipedriveExportSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      if (!hasCompanyBoardRole(req, companyId)) {
        throw forbidden("Only a company owner may run the Pipedrive import", { code: "owner_required" });
      }
      if (runningImports.has(companyId)) {
        throw conflict("A Pipedrive import is already running for this company", { code: "import_running" });
      }
      runningImports.add(companyId);
      try {
        const result = await exportImporter.run(companyId, req.body, actorIds(req));
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "organisation.import_completed",
          entityType: "company",
          entityId: companyId,
          details: {
            source: "pipedrive",
            via: "export",
            pipelineId: req.body.pipelineId ?? null,
            organisations: result.organisations,
            contacts: result.contacts,
            deals: result.deals ?? null,
            activities: result.activities ?? null,
          },
        });
        res.json(result);
      } finally {
        runningImports.delete(companyId);
      }
    },
  );

  /**
   * Import of the CSV files HubSpot exports (companies, contacts, deals), for
   * teams without a HubSpot key. Company owners only. Rows keep source
   * "hubspot" and the HubSpot record id, so a rerun updates them.
   */
  router.post(
    `${ORGANISATION_ROUTE_PREFIX}/import/hubspot-export`,
    validate(importHubspotExportSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      if (!hasCompanyBoardRole(req, companyId)) {
        throw forbidden("Only a company owner may run the HubSpot import", { code: "owner_required" });
      }
      if (runningImports.has(companyId)) {
        throw conflict("An import is already running for this company", { code: "import_running" });
      }
      runningImports.add(companyId);
      try {
        const result = await hubspotImporter.run(companyId, req.body, actorIds(req));
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "organisation.import_completed",
          entityType: "company",
          entityId: companyId,
          details: {
            source: "hubspot",
            via: "export",
            pipelineId: req.body.pipelineId ?? null,
            organisations: result.organisations,
            contacts: result.contacts,
            deals: result.deals ?? null,
          },
        });
        res.json(result);
      } finally {
        runningImports.delete(companyId);
      }
    },
  );

  /**
   * Import of client notes from a Notion export (the Markdown pages). Company
   * owners only. `preview` writes nothing; `import` makes or updates clients,
   * adds the notes and makes a task for each unticked to-do. A rerun adds
   * nothing twice.
   */
  router.post(
    `${ORGANISATION_ROUTE_PREFIX}/import/notion`,
    validate(importNotionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      if (!hasCompanyBoardRole(req, companyId)) {
        throw forbidden("Only a company owner may run the Notion import", { code: "owner_required" });
      }
      if (req.body.mode === "preview") {
        res.json(await notionImporter.preview(companyId, req.body));
        return;
      }
      if (runningImports.has(companyId)) {
        throw conflict("An import is already running for this company", { code: "import_running" });
      }
      runningImports.add(companyId);
      try {
        const result = await notionImporter.run(companyId, req.body, actorIds(req));
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "organisation.import_completed",
          entityType: "company",
          entityId: companyId,
          details: {
            source: "notion",
            via: "export",
            organisations: { ...result.organisations, skipped: result.skipped.length },
            tasks: { created: result.tasksCreated },
          },
        });
        res.json(result);
      } finally {
        runningImports.delete(companyId);
      }
    },
  );

  /** People with no organisation, such as Pipedrive people held on their own. Reads need company access only. */
  router.get("/companies/:companyId/organisation-contacts/unassigned", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listUnassignedContacts(companyId));
  });

  /** The CRM product catalogue with the deals each product is on. Reads need company access only. */
  router.get("/companies/:companyId/crm-products", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await products.list(companyId));
  });

  // A file copied from a CRM import, served like a case upload: inline only when safe.
  router.get("/companies/:companyId/crm-files/:fileId/content", async (req, res, next) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const fileId = parseId(req.params.fileId, "File");
    if (!deps.storage) throw new HttpError(503, "File storage is not available");
    const row = await db
      .select({ name: crmFiles.name, objectKey: assets.objectKey, contentType: assets.contentType, byteSize: assets.byteSize, originalFilename: assets.originalFilename })
      .from(crmFiles)
      .innerJoin(assets, and(eq(assets.id, crmFiles.assetId), eq(assets.companyId, crmFiles.companyId)))
      .where(and(eq(crmFiles.companyId, companyId), eq(crmFiles.id, fileId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("File not found");
    const object = await deps.storage.getObject(companyId, row.objectKey);
    const contentType = row.contentType || object.contentType || "application/octet-stream";
    const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const inlineSafe = mediaType !== SVG_CONTENT_TYPE && isInlineAttachmentContentType(mediaType);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(row.byteSize || object.contentLength || 0));
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!inlineSafe) res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    res.setHeader(
      "Content-Disposition",
      contentDispositionHeader(inlineSafe && req.query.download !== "1" ? "inline" : "attachment", row.originalFilename ?? row.name),
    );
    object.stream.on("error", (err) => next(err));
    object.stream.pipe(res);
  });

  router.get(`${ORGANISATION_ROUTE_PREFIX}/:organisationId`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const organisationId = parseId(req.params.organisationId, "Organisation");
    const detail = await svc.getDetail(companyId, organisationId);
    if (!detail) throw notFound("Organisation not found");
    res.json(detail);
  });

  /** Engagement history for the company page (GRE-1480). Reads need company access only. */
  router.get(`${ORGANISATION_ROUTE_PREFIX}/:organisationId/history`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const organisationId = parseId(req.params.organisationId, "Organisation");
    const result = await history.get(companyId, organisationId);
    if (!result) throw notFound("Organisation not found");
    res.json(result);
  });

  router.patch(
    `${ORGANISATION_ROUTE_PREFIX}/:organisationId`,
    validate(updateOrganisationSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCrmWriter(req, companyId);
      const organisationId = parseId(req.params.organisationId, "Organisation");
      const previousStatus = req.body.status === undefined
        ? null
        : await db
            .select({ status: organisations.status })
            .from(organisations)
            .where(and(eq(organisations.companyId, companyId), eq(organisations.id, organisationId)))
            .then((rows) => rows[0]?.status ?? null);
      const organisation = await svc.update(companyId, organisationId, req.body);
      if (!organisation) throw notFound("Organisation not found");
      await audit(req, companyId, "organisation.updated", organisation.id, {
        fields: Object.keys(req.body),
        // Stage moves are sent to outbound webhooks as client.stage_changed.
        ...(previousStatus && previousStatus !== organisation.status
          ? { status: organisation.status, previousStatus }
          : {}),
      });
      res.json(organisation);
    },
  );

  router.post(`${ORGANISATION_ROUTE_PREFIX}/:organisationId/archive`, async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCrmWriter(req, companyId);
    const organisationId = parseId(req.params.organisationId, "Organisation");
    const organisation = await svc.archive(companyId, organisationId);
    if (!organisation) throw notFound("Organisation not found");
    await audit(req, companyId, "organisation.archived", organisation.id, {});
    res.json(organisation);
  });

  router.post(
    `${ORGANISATION_ROUTE_PREFIX}/:organisationId/contacts`,
    validate(createOrganisationContactSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const { createdBy } = await assertCrmWriter(req, companyId);
      const organisationId = parseId(req.params.organisationId, "Organisation");
      if (!(await svc.getDetail(companyId, organisationId))) throw notFound("Organisation not found");
      const contact = await svc.createContact(companyId, organisationId, req.body, createdBy);
      await audit(req, companyId, "organisation.contact_created", organisationId, { contactId: contact.id });
      res.status(201).json(contact);
    },
  );

  router.patch(
    `${ORGANISATION_ROUTE_PREFIX}/:organisationId/contacts/:contactId`,
    validate(updateOrganisationContactSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCrmWriter(req, companyId);
      const organisationId = parseId(req.params.organisationId, "Organisation");
      const contactId = parseId(req.params.contactId, "Contact");
      const contact = await svc.updateContact(companyId, organisationId, contactId, req.body);
      if (!contact) throw notFound("Contact not found");
      await audit(req, companyId, "organisation.contact_updated", organisationId, {
        contactId,
        fields: Object.keys(req.body),
      });
      res.json(contact);
    },
  );

  router.post(`${ORGANISATION_ROUTE_PREFIX}/:organisationId/contacts/:contactId/archive`, async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCrmWriter(req, companyId);
    const organisationId = parseId(req.params.organisationId, "Organisation");
    const contactId = parseId(req.params.contactId, "Contact");
    const contact = await svc.archiveContact(companyId, organisationId, contactId);
    if (!contact) throw notFound("Contact not found");
    await audit(req, companyId, "organisation.contact_archived", organisationId, { contactId });
    res.json(contact);
  });

  return router;
}
