import type {
  WebsitePortalDocument,
  WebsitePortalDocumentAnswer,
  WebsitePortalDocumentApproveInput,
  WebsitePortalDocumentCreateInput,
  WebsitePortalDocumentEditInput,
  WebsitePortalDocumentStep,
} from "@greatstone/shared";
import { api } from "./client";

// Portal documents on a connected website (routes GRE-4083, screen GRE-4084). Reads stay on `data/portal-documents`
// (websiteDataBridgeApi.list). Drafting needs website:edit and agents may do it; approve and publish, and withdraw,
// are a signed-in person's (website:publish). Every write carries an Idempotency-Key so a retry writes once.
const documentsPath = (companyId: string, siteId: string) =>
  `/companies/${encodeURIComponent(companyId)}/website/sites/${encodeURIComponent(siteId)}/portal-documents`;

const writeOptions = (idempotencyKey: string) => ({ headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey } });

export const websitePortalDocumentsApi = {
  /** A new draft for one client (website:edit). */
  create: (companyId: string, siteId: string, input: WebsitePortalDocumentCreateInput, idempotencyKey: string) =>
    api.post<{ item: WebsitePortalDocument }>(documentsPath(companyId, siteId), input, writeOptions(idempotencyKey)),
  /** Change a draft (website:edit). Only the fields sent change. */
  edit: (companyId: string, siteId: string, documentId: string, input: WebsitePortalDocumentEditInput, idempotencyKey: string) =>
    api.patch<{ item: WebsitePortalDocument }>(`${documentsPath(companyId, siteId)}/${encodeURIComponent(documentId)}`, input,
      writeOptions(idempotencyKey)),
  /** Submit, return to draft, withdraw (`expectedRowVersion`) or approve and publish (`expectedContentSha256`). */
  step: (companyId: string, siteId: string, documentId: string, step: WebsitePortalDocumentStep,
    input: { expectedRowVersion: number } | WebsitePortalDocumentApproveInput, idempotencyKey: string) =>
    api.post<WebsitePortalDocumentAnswer>(`${documentsPath(companyId, siteId)}/${encodeURIComponent(documentId)}/${step}`, input,
      writeOptions(idempotencyKey)),
};
