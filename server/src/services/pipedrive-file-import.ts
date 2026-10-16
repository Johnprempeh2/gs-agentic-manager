// Read-only import of Pipedrive files (John, 16 Oct: every bit of client
// information must come across). Every file keeps its name, size, owner and
// the deal, lead, person, organisation, activity or note it was on. The bytes
// are copied into GSAM storage; a file on a deal or lead is also put on the
// case's files, where the client pipeline shows it. A file linked from Google
// Drive and the like, larger than the upload limit, or of a type GSAM does not
// accept keeps its details and Pipedrive link without the bytes. Rows are
// keyed on source and Pipedrive id, so a rerun updates them and never copies
// a file twice. Nothing is written to Pipedrive.
import { and, eq } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { assets, crmFiles, pipelineCaseEvidence } from "@greatstone/db";
import type { OrganisationImportCounts, OrganisationImportResult } from "@greatstone/shared";
import {
  formatAttachmentSize,
  isAllowedContentType,
  MAX_ATTACHMENT_BYTES,
  normalizeUploadAttachmentContentType,
} from "../attachment-types.js";
import type { StorageService } from "../storage/types.js";
import { PipedriveApiError, PipedriveAuthError, type PipedriveClient } from "./crm-sync-pipedrive.js";
import { pipelineCaseFilesService } from "./pipeline-case-files.js";
import { pipedriveTime } from "./pipedrive-timeline-import.js";

const SOURCE = "pipedrive";
const MAX_ERROR_SAMPLES = 20;
const STORAGE_NAMESPACE = "crm-files/pipedrive";

type FileRow = typeof crmFiles.$inferSelect;
type FileValues = Omit<typeof crmFiles.$inferInsert, "id" | "companyId" | "source" | "createdAt" | "updatedAt" | "assetId" | "evidenceId">;

export interface FileLinks {
  organisationIdByExternalId: Map<string, string>;
  contactIdByExternalId: Map<string, string>;
  caseIdByDealId: Map<string, string>;
  caseIdByLeadId: Map<string, string>;
  users: Map<string, string>;
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function idOf(value: unknown): string | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return str(record.value ?? record.id);
  }
  return str(value);
}

function compact(details: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== null && value !== undefined && value !== ""));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** A file Pipedrive keeps itself, as opposed to one linked from Google Drive and the like. */
function isStoredInPipedrive(file: Record<string, unknown>) {
  const location = str(file.remote_location)?.toLowerCase();
  return !location || location === "s3";
}

export function mapPipedriveFile(file: Record<string, unknown>, links: FileLinks): (FileValues & { externalId: string; storedInPipedrive: boolean }) | null {
  const externalId = str(file.id);
  if (!externalId || file.active_flag === false) return null;
  const orgId = idOf(file.org_id);
  const personId = idOf(file.person_id);
  const dealId = idOf(file.deal_id);
  const leadId = idOf(file.lead_id);
  const userId = idOf(file.user_id);
  return {
    externalId,
    storedInPipedrive: isStoredInPipedrive(file),
    name: (str(file.name) ?? str(file.file_name) ?? `Pipedrive file ${externalId}`).slice(0, 500),
    contentType: null,
    byteSize: num(file.file_size),
    description: str(file.description),
    ownerName: userId ? links.users.get(userId) ?? null : null,
    addedAt: pipedriveTime(file.add_time),
    remoteUrl: str(file.url),
    organisationId: orgId ? links.organisationIdByExternalId.get(orgId) ?? null : null,
    contactId: personId ? links.contactIdByExternalId.get(personId) ?? null : null,
    caseId: (dealId ? links.caseIdByDealId.get(dealId) : undefined) ?? (leadId ? links.caseIdByLeadId.get(leadId) : undefined) ?? null,
    details: compact({
      fileName: str(file.file_name),
      fileType: str(file.file_type),
      remoteLocation: str(file.remote_location),
      dealId,
      leadId,
      personId,
      organisationId: orgId,
      activityId: idOf(file.activity_id),
      noteId: idOf(file.note_id),
      productId: idOf(file.product_id),
      emailId: idOf(file.mail_message_id),
      dealName: str(file.deal_name),
      personName: str(file.person_name),
      organisationName: str(file.org_name),
    }),
  };
}

function sameFile(row: FileRow, values: FileValues) {
  return row.name === values.name
    && row.byteSize === (values.byteSize ?? null)
    && row.description === (values.description ?? null)
    && row.ownerName === (values.ownerName ?? null)
    && (row.addedAt?.getTime() ?? null) === (values.addedAt instanceof Date ? values.addedAt.getTime() : null)
    && row.remoteUrl === (values.remoteUrl ?? null)
    && row.organisationId === (values.organisationId ?? null)
    && row.contactId === (values.contactId ?? null)
    && row.caseId === (values.caseId ?? null)
    && (values.contentType === undefined || values.contentType === null || row.contentType === values.contentType)
    && stableJson(row.details ?? {}) === stableJson(values.details ?? {});
}

export function pipedriveFileImportService(db: Db, options: { storage?: StorageService; now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const caseFiles = pipelineCaseFilesService(db);

  return {
    async run(input: {
      companyId: string;
      client: PipedriveClient;
      result: OrganisationImportResult;
      userId: string | null;
      links: FileLinks;
    }) {
      const { companyId, client, result } = input;
      const counts: OrganisationImportCounts = { created: 0, updated: 0, skipped: 0, errors: 0 };
      result.files = counts;
      const pushError = (externalId: string, message: string) => {
        if (result.errorSamples.length < MAX_ERROR_SAMPLES) result.errorSamples.push({ kind: "file", externalId, message });
      };

      const existing = new Map<string, FileRow>();
      for (const row of await db.select().from(crmFiles).where(and(eq(crmFiles.companyId, companyId), eq(crmFiles.source, SOURCE)))) {
        existing.set(row.externalId, row);
      }
      let canDownload = Boolean(options.storage);

      /** Copies the bytes into storage, onto the case when there is one. */
      const copy = async (values: FileValues & { externalId: string }): Promise<{ assetId: string; evidenceId: string | null; contentType: string } | { notCopied: string }> => {
        if (!options.storage) return { notCopied: "File storage is not available" };
        if (values.byteSize !== null && values.byteSize !== undefined && values.byteSize > MAX_ATTACHMENT_BYTES) {
          return { notCopied: `Larger than the ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)} upload limit` };
        }
        const download = await client.downloadFile(values.externalId);
        if (download.body.length > MAX_ATTACHMENT_BYTES) {
          return { notCopied: `Larger than the ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)} upload limit` };
        }
        if (download.body.length === 0) return { notCopied: "Pipedrive sent an empty file" };
        const originalFilename = str(values.details?.fileName) ?? values.name;
        const contentType = normalizeUploadAttachmentContentType({ contentType: download.contentType, originalFilename, isAllowedContentType });
        if (!isAllowedContentType(contentType)) return { notCopied: `Files of type ${contentType} are not accepted` };
        const stored = await options.storage.putFile({
          companyId,
          namespace: values.caseId ? `pipeline-cases/${values.caseId}` : STORAGE_NAMESPACE,
          originalFilename,
          contentType,
          body: download.body,
        });
        if (values.caseId && input.userId) {
          const item = await caseFiles.addUpload(
            companyId,
            values.caseId,
            stored,
            { title: values.name, note: values.description ?? null },
            { type: "user", userId: input.userId },
          );
          const evidence = await db.select({ assetId: pipelineCaseEvidence.assetId }).from(pipelineCaseEvidence)
            .where(and(eq(pipelineCaseEvidence.companyId, companyId), eq(pipelineCaseEvidence.id, item.id)))
            .then((rows) => rows[0]!);
          return { assetId: evidence.assetId!, evidenceId: item.id, contentType };
        }
        const [asset] = await db.insert(assets).values({
          companyId,
          provider: stored.provider,
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          originalFilename: stored.originalFilename,
          createdByUserId: input.userId,
        }).returning({ id: assets.id });
        return { assetId: asset!.id, evidenceId: null, contentType };
      };

      let start: number | null = 0;
      while (start !== null) {
        let page: Awaited<ReturnType<PipedriveClient["listFilesPage"]>>;
        try {
          page = await client.listFilesPage({ start });
        } catch (error) {
          if (!(error instanceof PipedriveAuthError || error instanceof PipedriveApiError)) throw error;
          counts.errors += 1;
          pushError("all", `Pipedrive did not share files: ${error.message}`);
          break;
        }
        for (const item of page.items) {
          const mapped = mapPipedriveFile(item, input.links);
          if (!mapped) {
            counts.skipped += 1;
            continue;
          }
          const { storedInPipedrive, ...values } = mapped;
          try {
            const current = existing.get(values.externalId);
            const needsCopy = storedInPipedrive && !current?.assetId;
            let copied: Awaited<ReturnType<typeof copy>> | null = null;
            if (needsCopy && !options.storage) {
              copied = { notCopied: "File storage is not available" };
            } else if (needsCopy && !canDownload) {
              copied = { notCopied: "Download failed; the next import tries again" };
            } else if (needsCopy) {
              try {
                copied = await copy(values);
              } catch (error) {
                if (!(error instanceof PipedriveAuthError || error instanceof PipedriveApiError)) throw error;
                // The token cannot download files at all; keep the details and stop asking.
                if (error instanceof PipedriveAuthError) canDownload = false;
                pushError(values.externalId, `Could not download the file: ${error.message}`);
                copied = { notCopied: "Download failed; the next import tries again" };
              }
            }
            const notCopied = copied && "notCopied" in copied ? copied.notCopied
              : !storedInPipedrive ? `Linked from ${str(values.details?.remoteLocation) ?? "elsewhere"}`
                : null;
            const full = {
              ...values,
              contentType: copied && "contentType" in copied ? copied.contentType : current?.contentType ?? null,
              details: compact({ ...values.details, notCopied }),
            };
            if (!current) {
              const [row] = await db.insert(crmFiles).values({
                ...full,
                companyId,
                source: SOURCE,
                assetId: copied && "assetId" in copied ? copied.assetId : null,
                evidenceId: copied && "evidenceId" in copied ? copied.evidenceId : null,
              }).returning();
              existing.set(values.externalId, row!);
              counts.created += 1;
            } else if (!(copied && "assetId" in copied) && sameFile(current, full)) {
              counts.skipped += 1;
            } else {
              const [row] = await db.update(crmFiles).set({
                ...full,
                ...(copied && "assetId" in copied ? { assetId: copied.assetId, evidenceId: copied.evidenceId } : {}),
                updatedAt: now(),
              }).where(and(eq(crmFiles.companyId, companyId), eq(crmFiles.id, current.id))).returning();
              existing.set(values.externalId, row!);
              counts.updated += 1;
            }
          } catch (error) {
            counts.errors += 1;
            pushError(values.externalId, error instanceof Error ? error.message : String(error));
          }
        }
        start = page.nextStart;
      }
      return counts;
    },
  };
}
