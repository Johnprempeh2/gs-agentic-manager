import { and, desc, eq, ilike, inArray, isNull, ne, notInArray, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@greatstone/db";
import {
  agents,
  assets,
  authUsers,
  companies,
  documents,
  issueAttachments,
  issueDocuments,
  issues,
  pipelineCaseEvidence,
  pipelineCaseIssueLinks,
  pipelineCaseProjectLinks,
  pipelineCases,
  pipelineStages,
} from "@greatstone/db";
import {
  DELIVERABLES_MAX_LIMIT,
  SYSTEM_ISSUE_DOCUMENT_KEYS,
  type ClientEvidenceCandidate,
  type ClientEvidenceItem,
  type ClientFileSourceIssue,
  type ClientFilesResponse,
  type CreateClientEvidence,
} from "@greatstone/shared";
import { isUniqueViolation } from "../db-errors.js";
import { conflict, notFound } from "../errors.js";
import { deliverableService, type DeliverableIssueScope } from "./deliverables.js";
import { visibleIssueCondition } from "./issue-visibility.js";

// Client files (GRE-1311). Evidence rows point at a task attachment, a task
// document or a link; the files themselves stay on their task and are served
// by the existing, access-checked attachment and document routes. An upload
// is a file put straight onto the client: its asset belongs to the evidence
// row and is served by the case's own access-checked content route. Deliverables
// are not stored here: they are the registered deliverables on the client's
// linked tasks and on tasks in its projects.

const CANDIDATE_LIMIT = 100;

export type ClientEvidenceActor =
  | { type: "agent"; agentId: string }
  | { type: "user"; userId: string };

/** The task an evidence source sits on, with the fields an issue:read check needs. */
export type ClientEvidenceSourceIssue = {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  status: string;
};

type ResolvedSource = {
  kind: CreateClientEvidence["kind"];
  stageId: string | null;
  title: string;
  attachmentId: string | null;
  documentId: string | null;
  url: string | null;
  sourceIssue: ClientEvidenceSourceIssue | null;
};

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function likePattern(q: string) {
  return `%${escapeLikePattern(q)}%`;
}

/** Short type label for a file, from its content type or file name. */
export function fileTypeLabel(contentType: string | null, filename: string | null): string {
  const type = (contentType ?? "").toLowerCase().split(";")[0]!.trim();
  if (type === "application/pdf") return "PDF";
  if (type.includes("presentation") || type.includes("powerpoint")) return "Deck";
  if (type.includes("spreadsheet") || type.includes("excel") || type === "text/csv") return "Spreadsheet";
  if (type.includes("wordprocessing") || type === "application/msword") return "Word document";
  if (type === "text/html" || type === "application/xhtml+xml") return "HTML";
  if (type.startsWith("image/")) return "Image";
  if (type.startsWith("video/")) return "Video";
  if (type.startsWith("audio/")) return "Audio";
  if (type === "text/markdown" || type === "text/plain") return "Text";
  const extension = filename?.includes(".") ? filename.split(".").pop() : null;
  return extension ? extension.toUpperCase().slice(0, 8) : "File";
}

function issuePath(prefix: string, issue: { id: string; identifier: string | null }) {
  return `/${prefix}/issues/${issue.identifier ?? issue.id}`;
}

function attachmentContentPath(attachmentId: string) {
  return `/api/attachments/${attachmentId}/content`;
}

function uploadContentPath(caseId: string, evidenceId: string) {
  return `/api/cases/${caseId}/evidence/${evidenceId}/content`;
}

/** The stored file for a new upload, as StorageService.putFile returned it. */
export type ClientUploadFile = {
  provider: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
};

const uploadAssets = alias(assets, "upload_assets");

export function pipelineCaseFilesService(db: Db) {
  async function companyPrefix(companyId: string) {
    const row = await db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Company not found");
    return row.issuePrefix;
  }

  /** The tasks that belong to these clients: linked tasks plus tasks in their projects. */
  async function scopeFor(companyId: string, caseIds: string[]): Promise<DeliverableIssueScope> {
    if (caseIds.length === 0) return { issueIds: [], projectIds: [] };
    const [issueRows, projectRows] = await Promise.all([
      db
        .select({ issueId: pipelineCaseIssueLinks.issueId })
        .from(pipelineCaseIssueLinks)
        .where(and(
          eq(pipelineCaseIssueLinks.companyId, companyId),
          inArray(pipelineCaseIssueLinks.caseId, caseIds),
          isNull(pipelineCaseIssueLinks.retiredAt),
        )),
      db
        .select({ projectId: pipelineCaseProjectLinks.projectId })
        .from(pipelineCaseProjectLinks)
        .where(and(
          eq(pipelineCaseProjectLinks.companyId, companyId),
          inArray(pipelineCaseProjectLinks.caseId, caseIds),
        )),
    ]);
    return {
      issueIds: [...new Set(issueRows.map((row) => row.issueId))],
      projectIds: [...new Set(projectRows.map((row) => row.projectId))],
    };
  }

  async function listEvidence(companyId: string, caseIds: string[], q?: string): Promise<ClientEvidenceItem[]> {
    if (caseIds.length === 0) return [];
    const prefix = await companyPrefix(companyId);
    const conditions: SQL[] = [
      eq(pipelineCaseEvidence.companyId, companyId),
      inArray(pipelineCaseEvidence.caseId, caseIds),
    ];
    if (q) {
      const pattern = likePattern(q);
      conditions.push(or(
        ilike(pipelineCaseEvidence.title, pattern),
        ilike(assets.originalFilename, pattern),
        ilike(uploadAssets.originalFilename, pattern),
        ilike(documents.title, pattern),
      )!);
    }
    const rows = await db
      .select({
        evidence: pipelineCaseEvidence,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        originalFilename: assets.originalFilename,
        uploadContentType: uploadAssets.contentType,
        uploadByteSize: uploadAssets.byteSize,
        uploadFilename: uploadAssets.originalFilename,
        stageName: pipelineStages.name,
        documentKey: issueDocuments.key,
        documentIssueId: issueDocuments.issueId,
        issueId: issues.id,
        issueIdentifier: issues.identifier,
        issueTitle: issues.title,
        agentName: agents.name,
        userName: authUsers.name,
      })
      .from(pipelineCaseEvidence)
      .leftJoin(issueAttachments, and(
        eq(issueAttachments.id, pipelineCaseEvidence.attachmentId),
        eq(issueAttachments.companyId, pipelineCaseEvidence.companyId),
      ))
      .leftJoin(assets, and(eq(assets.id, issueAttachments.assetId), eq(assets.companyId, issueAttachments.companyId)))
      .leftJoin(uploadAssets, and(
        eq(uploadAssets.id, pipelineCaseEvidence.assetId),
        eq(uploadAssets.companyId, pipelineCaseEvidence.companyId),
      ))
      .leftJoin(pipelineStages, eq(pipelineStages.id, pipelineCaseEvidence.stageId))
      .leftJoin(documents, and(
        eq(documents.id, pipelineCaseEvidence.documentId),
        eq(documents.companyId, pipelineCaseEvidence.companyId),
      ))
      .leftJoin(issueDocuments, and(
        eq(issueDocuments.documentId, pipelineCaseEvidence.documentId),
        eq(issueDocuments.companyId, pipelineCaseEvidence.companyId),
      ))
      .leftJoin(issues, and(
        eq(issues.id, pipelineCaseEvidence.sourceIssueId),
        eq(issues.companyId, pipelineCaseEvidence.companyId),
      ))
      .leftJoin(agents, and(
        eq(agents.id, pipelineCaseEvidence.createdByAgentId),
        eq(agents.companyId, pipelineCaseEvidence.companyId),
      ))
      .leftJoin(authUsers, eq(authUsers.id, pipelineCaseEvidence.createdByUserId))
      .where(and(...conditions))
      .orderBy(desc(pipelineCaseEvidence.createdAt), desc(pipelineCaseEvidence.id));

    return rows.map((row): ClientEvidenceItem => {
      const evidence = row.evidence;
      const sourceIssue: ClientFileSourceIssue | null = row.issueId
        ? {
          id: row.issueId,
          identifier: row.issueIdentifier,
          title: row.issueTitle ?? "",
          path: issuePath(prefix, { id: row.issueId, identifier: row.issueIdentifier }),
        }
        : null;
      const addedBy = evidence.createdByAgentId
        ? { type: "agent" as const, id: evidence.createdByAgentId, name: row.agentName }
        : evidence.createdByUserId
          ? { type: "user" as const, id: evidence.createdByUserId, name: row.userName }
          : null;
      const base = {
        id: evidence.id,
        caseId: evidence.caseId,
        title: evidence.title,
        note: evidence.note,
        attachmentId: evidence.attachmentId,
        documentId: evidence.documentId,
        assetId: evidence.assetId,
        stageId: evidence.stageId,
        stageName: evidence.stageId ? row.stageName : null,
        sourceIssue,
        addedBy,
        createdAt: evidence.createdAt.toISOString(),
      };
      if (evidence.kind === "upload" && evidence.assetId) {
        const contentPath = uploadContentPath(evidence.caseId, evidence.id);
        return {
          ...base,
          kind: "upload",
          typeLabel: fileTypeLabel(row.uploadContentType, row.uploadFilename),
          contentType: row.uploadContentType,
          byteSize: row.uploadByteSize,
          originalFilename: row.uploadFilename,
          documentKey: null,
          url: null,
          contentPath,
          downloadPath: `${contentPath}?download=1`,
          openPath: contentPath,
        };
      }
      if (evidence.kind === "attachment" && evidence.attachmentId) {
        const contentPath = attachmentContentPath(evidence.attachmentId);
        return {
          ...base,
          kind: "attachment",
          typeLabel: fileTypeLabel(row.contentType, row.originalFilename),
          contentType: row.contentType,
          byteSize: row.byteSize,
          originalFilename: row.originalFilename,
          documentKey: null,
          url: null,
          contentPath,
          downloadPath: `${contentPath}?download=1`,
          openPath: contentPath,
        };
      }
      if (evidence.kind === "document") {
        const key = row.documentKey;
        const issueId = row.documentIssueId;
        return {
          ...base,
          kind: "document",
          typeLabel: "Document",
          contentType: null,
          byteSize: null,
          originalFilename: null,
          documentKey: key,
          url: null,
          contentPath: key && issueId ? `/api/issues/${issueId}/documents/${encodeURIComponent(key)}` : null,
          downloadPath: null,
          openPath: sourceIssue && key ? `${sourceIssue.path}#document-${encodeURIComponent(key)}` : sourceIssue?.path ?? "",
        };
      }
      return {
        ...base,
        kind: "link",
        typeLabel: "Link",
        contentType: null,
        byteSize: null,
        originalFilename: null,
        documentKey: null,
        url: evidence.url,
        contentPath: null,
        downloadPath: null,
        openPath: evidence.url ?? "",
      };
    });
  }

  async function getIssueForAccess(companyId: string, issueId: string): Promise<ClientEvidenceSourceIssue | null> {
    return db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        projectId: issues.projectId,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        status: issues.status,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
  }

  return {
    scopeFor,
    listEvidence,

    /** Evidence and deliverables for one or more clients, with an optional name search. */
    listFiles: async (
      companyId: string,
      clients: ClientFilesResponse["clients"],
      q?: string,
    ): Promise<ClientFilesResponse> => {
      const caseIds = clients.map((client) => client.id);
      const scope = await scopeFor(companyId, caseIds);
      const [evidence, deliverables] = await Promise.all([
        listEvidence(companyId, caseIds, q),
        deliverableService(db).list(
          companyId,
          { q: q || undefined, limit: DELIVERABLES_MAX_LIMIT },
          { scope },
        ),
      ]);
      return { clients, evidence, deliverables: deliverables.deliverables };
    },

    /** Clients (cases) in this company, by id or by linked project. */
    listClients: async (
      companyId: string,
      filter: { caseId?: string; projectId?: string },
    ): Promise<ClientFilesResponse["clients"]> => {
      const conditions: SQL[] = [eq(pipelineCases.companyId, companyId), isNull(pipelineCases.retiredAt)];
      if (filter.caseId) conditions.push(eq(pipelineCases.id, filter.caseId));
      const query = db
        .selectDistinct({ id: pipelineCases.id, title: pipelineCases.title, pipelineId: pipelineCases.pipelineId })
        .from(pipelineCases);
      if (filter.projectId) {
        return query
          .innerJoin(pipelineCaseProjectLinks, and(
            eq(pipelineCaseProjectLinks.caseId, pipelineCases.id),
            eq(pipelineCaseProjectLinks.companyId, companyId),
            eq(pipelineCaseProjectLinks.projectId, filter.projectId),
          ))
          .where(and(...conditions))
          .orderBy(pipelineCases.title);
      }
      return query.where(and(...conditions)).orderBy(pipelineCases.title);
    },

    /** Task files and documents in the client's scope that are not in Evidence yet. */
    listCandidates: async (companyId: string, caseId: string, q?: string): Promise<ClientEvidenceCandidate[]> => {
      const scope = await scopeFor(companyId, [caseId]);
      if (scope.issueIds.length === 0 && scope.projectIds.length === 0) return [];
      const prefix = await companyPrefix(companyId);
      const scopeConditions: SQL[] = [];
      if (scope.issueIds.length > 0) scopeConditions.push(inArray(issues.id, scope.issueIds));
      if (scope.projectIds.length > 0) scopeConditions.push(inArray(issues.projectId, scope.projectIds));
      const issueConditions = and(
        eq(issues.companyId, companyId),
        visibleIssueCondition(),
        ne(issues.status, "cancelled"),
        or(...scopeConditions),
      )!;
      const existing = await db
        .select({ attachmentId: pipelineCaseEvidence.attachmentId, documentId: pipelineCaseEvidence.documentId })
        .from(pipelineCaseEvidence)
        .where(and(eq(pipelineCaseEvidence.companyId, companyId), eq(pipelineCaseEvidence.caseId, caseId)));
      const usedAttachments = existing.map((row) => row.attachmentId).filter((id): id is string => Boolean(id));
      const usedDocuments = existing.map((row) => row.documentId).filter((id): id is string => Boolean(id));
      const pattern = q ? likePattern(q) : null;

      const [attachmentRows, documentRows] = await Promise.all([
        db
          .select({
            attachmentId: issueAttachments.id,
            filename: assets.originalFilename,
            contentType: assets.contentType,
            createdAt: issueAttachments.createdAt,
            issueId: issues.id,
            identifier: issues.identifier,
            issueTitle: issues.title,
          })
          .from(issueAttachments)
          .innerJoin(assets, and(eq(assets.id, issueAttachments.assetId), eq(assets.companyId, issueAttachments.companyId)))
          .innerJoin(issues, eq(issues.id, issueAttachments.issueId))
          .where(and(
            eq(issueAttachments.companyId, companyId),
            issueConditions,
            usedAttachments.length > 0 ? notInArray(issueAttachments.id, usedAttachments) : undefined,
            pattern ? ilike(assets.originalFilename, pattern) : undefined,
          ))
          .orderBy(desc(issueAttachments.createdAt))
          .limit(CANDIDATE_LIMIT),
        db
          .select({
            documentId: documents.id,
            title: documents.title,
            key: issueDocuments.key,
            createdAt: documents.createdAt,
            issueId: issues.id,
            identifier: issues.identifier,
            issueTitle: issues.title,
          })
          .from(issueDocuments)
          .innerJoin(documents, and(eq(documents.id, issueDocuments.documentId), eq(documents.companyId, issueDocuments.companyId)))
          .innerJoin(issues, eq(issues.id, issueDocuments.issueId))
          .where(and(
            eq(issueDocuments.companyId, companyId),
            issueConditions,
            notInArray(issueDocuments.key, [...SYSTEM_ISSUE_DOCUMENT_KEYS]),
            usedDocuments.length > 0 ? notInArray(documents.id, usedDocuments) : undefined,
            pattern ? or(ilike(documents.title, pattern), ilike(issueDocuments.key, pattern)) : undefined,
          ))
          .orderBy(desc(documents.createdAt))
          .limit(CANDIDATE_LIMIT),
      ]);

      const sourceIssue = (row: { issueId: string; identifier: string | null; issueTitle: string }) => ({
        id: row.issueId,
        identifier: row.identifier,
        title: row.issueTitle,
        path: issuePath(prefix, { id: row.issueId, identifier: row.identifier }),
      });
      const candidates: ClientEvidenceCandidate[] = [
        ...attachmentRows.map((row) => ({
          kind: "attachment" as const,
          attachmentId: row.attachmentId,
          documentId: null,
          title: row.filename ?? "Attachment",
          typeLabel: fileTypeLabel(row.contentType, row.filename),
          sourceIssue: sourceIssue(row),
          createdAt: row.createdAt.toISOString(),
        })),
        ...documentRows.map((row) => ({
          kind: "document" as const,
          attachmentId: null,
          documentId: row.documentId,
          title: row.title ?? row.key,
          typeLabel: "Document",
          sourceIssue: sourceIssue(row),
          createdAt: row.createdAt.toISOString(),
        })),
      ];
      return candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, CANDIDATE_LIMIT);
    },

    /**
     * Find the file, document or task behind a new evidence item. Everything
     * must be in the case's own company; anything else is "not found".
     */
    resolveSource: async (companyId: string, input: CreateClientEvidence): Promise<ResolvedSource> => {
      if (input.kind === "attachment") {
        const row = await db
          .select({ id: issueAttachments.id, issueId: issueAttachments.issueId, filename: assets.originalFilename })
          .from(issueAttachments)
          .innerJoin(assets, and(eq(assets.id, issueAttachments.assetId), eq(assets.companyId, issueAttachments.companyId)))
          .where(and(eq(issueAttachments.id, input.attachmentId), eq(issueAttachments.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!row) throw notFound("Attachment not found");
        return {
          kind: "attachment",
          stageId: input.stageId ?? null,
          title: input.title ?? row.filename ?? "Attachment",
          attachmentId: row.id,
          documentId: null,
          url: null,
          sourceIssue: await getIssueForAccess(companyId, row.issueId),
        };
      }
      if (input.kind === "document") {
        const row = await db
          .select({ documentId: documents.id, title: documents.title, key: issueDocuments.key, issueId: issueDocuments.issueId })
          .from(issueDocuments)
          .innerJoin(documents, and(eq(documents.id, issueDocuments.documentId), eq(documents.companyId, issueDocuments.companyId)))
          .where(and(eq(issueDocuments.documentId, input.documentId), eq(issueDocuments.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!row) throw notFound("Document not found");
        return {
          kind: "document",
          stageId: input.stageId ?? null,
          title: input.title ?? row.title ?? row.key,
          attachmentId: null,
          documentId: row.documentId,
          url: null,
          sourceIssue: await getIssueForAccess(companyId, row.issueId),
        };
      }
      let sourceIssue: ClientEvidenceSourceIssue | null = null;
      if (input.sourceIssueId) {
        sourceIssue = await getIssueForAccess(companyId, input.sourceIssueId);
        if (!sourceIssue) throw notFound("Issue not found");
      }
      return {
        kind: "link",
        stageId: input.stageId ?? null,
        title: input.title,
        attachmentId: null,
        documentId: null,
        url: input.url,
        sourceIssue,
      };
    },

    addEvidence: async (
      companyId: string,
      caseId: string,
      source: ResolvedSource,
      note: string | null | undefined,
      actor: ClientEvidenceActor,
    ) => {
      try {
        const [row] = await db
          .insert(pipelineCaseEvidence)
          .values({
            companyId,
            caseId,
            kind: source.kind,
            title: source.title,
            note: note ?? null,
            attachmentId: source.attachmentId,
            documentId: source.documentId,
            url: source.url,
            stageId: source.stageId,
            sourceIssueId: source.sourceIssue?.id ?? null,
            createdByAgentId: actor.type === "agent" ? actor.agentId : null,
            createdByUserId: actor.type === "user" ? actor.userId : null,
          })
          .returning({ id: pipelineCaseEvidence.id });
        const items = await listEvidence(companyId, [caseId]);
        const created = items.find((item) => item.id === row!.id);
        if (!created) throw notFound("Evidence not found");
        return created;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict("This item is already in the client's evidence", { code: "duplicate_evidence" });
        }
        throw error;
      }
    },

    /**
     * Throws unless the stage belongs to this case's pipeline, so evidence is
     * never filed under another pipeline's stage.
     */
    assertStageOnCase: async (companyId: string, caseId: string, stageId: string) => {
      const row = await db
        .select({ id: pipelineStages.id })
        .from(pipelineStages)
        .innerJoin(pipelineCases, eq(pipelineCases.pipelineId, pipelineStages.pipelineId))
        .where(and(
          eq(pipelineStages.id, stageId),
          eq(pipelineCases.id, caseId),
          eq(pipelineCases.companyId, companyId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Stage not found on this client's pipeline");
    },

    /** File a stored upload on the client: the asset and its evidence row in one step. */
    addUpload: async (
      companyId: string,
      caseId: string,
      file: ClientUploadFile,
      input: { title?: string | null; note?: string | null; stageId?: string | null },
      actor: ClientEvidenceActor,
    ) => {
      const evidenceId = await db.transaction(async (tx) => {
        const [asset] = await tx
          .insert(assets)
          .values({
            companyId,
            provider: file.provider,
            objectKey: file.objectKey,
            contentType: file.contentType,
            byteSize: file.byteSize,
            sha256: file.sha256,
            originalFilename: file.originalFilename,
            createdByAgentId: actor.type === "agent" ? actor.agentId : null,
            createdByUserId: actor.type === "user" ? actor.userId : null,
          })
          .returning({ id: assets.id });
        const [row] = await tx
          .insert(pipelineCaseEvidence)
          .values({
            companyId,
            caseId,
            kind: "upload",
            title: input.title ?? file.originalFilename ?? "Upload",
            note: input.note ?? null,
            assetId: asset!.id,
            stageId: input.stageId ?? null,
            createdByAgentId: actor.type === "agent" ? actor.agentId : null,
            createdByUserId: actor.type === "user" ? actor.userId : null,
          })
          .returning({ id: pipelineCaseEvidence.id });
        return row!.id;
      });
      const items = await listEvidence(companyId, [caseId]);
      const created = items.find((item) => item.id === evidenceId);
      if (!created) throw notFound("Evidence not found");
      return created;
    },

    /** The stored file behind an upload on this case, or null. */
    getUpload: async (companyId: string, caseId: string, evidenceId: string) => {
      return db
        .select({
          companyId: assets.companyId,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          originalFilename: assets.originalFilename,
        })
        .from(pipelineCaseEvidence)
        .innerJoin(assets, and(
          eq(assets.id, pipelineCaseEvidence.assetId),
          eq(assets.companyId, pipelineCaseEvidence.companyId),
        ))
        .where(and(
          eq(pipelineCaseEvidence.companyId, companyId),
          eq(pipelineCaseEvidence.caseId, caseId),
          eq(pipelineCaseEvidence.id, evidenceId),
          eq(pipelineCaseEvidence.kind, "upload"),
        ))
        .then((rows) => rows[0] ?? null);
    },

    /**
     * Remove an evidence row. An upload's asset goes with it (the file was only
     * ever on this client); the caller deletes the stored object.
     */
    removeEvidence: async (companyId: string, caseId: string, evidenceId: string) => {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .delete(pipelineCaseEvidence)
          .where(and(
            eq(pipelineCaseEvidence.companyId, companyId),
            eq(pipelineCaseEvidence.caseId, caseId),
            eq(pipelineCaseEvidence.id, evidenceId),
          ))
          .returning();
        if (!row) return null;
        let removedObjectKey: string | null = null;
        if (row.kind === "upload" && row.assetId) {
          const [asset] = await tx
            .delete(assets)
            .where(and(eq(assets.id, row.assetId), eq(assets.companyId, companyId)))
            .returning({ objectKey: assets.objectKey });
          removedObjectKey = asset?.objectKey ?? null;
        }
        return { ...row, removedObjectKey };
      });
    },
  };
}
