import type {
  Approval,
  WebsiteCommerceRefundRequestInput,
  WebsiteCommerceResource,
  WebsiteCommerceWriteMethod,
  WebsitePaymentReport,
  WebsitePaymentReportQuery,
  WebsiteVendorActivationSteps,
  WebsiteVendorActivationStepsInput,
} from "@greatstone/shared";
import { api } from "./client";

// Commerce on the website admin bridge (GRE-2354, screens GRE-3972): the catalogue, FX, imports and the payment
// report are read on the read key; every change is one typed write on the write key, sent with an Idempotency-Key.
const commercePath = (companyId: string, siteId: string) =>
  `/companies/${encodeURIComponent(companyId)}/website/sites/${encodeURIComponent(siteId)}/commerce`;

/** A row as the site returns it, under the site's own column names (snake_case). */
export type CommerceRow = Record<string, unknown>;

export interface CommerceWrite {
  method: WebsiteCommerceWriteMethod;
  /** The path after `/commerce/`, e.g. `["offerings", id, "variants"]`. Must be a `websiteCommerceWriteOperation`. */
  parts: readonly string[];
  /** The site's body: camelCase fields, plus `expectedRowVersion` on a versioned change. */
  body?: Record<string, unknown>;
}

function searchOf(query: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
  const search = params.toString();
  return search ? `?${search}` : "";
}

const writeHeaders = (idempotencyKey: string) => ({ "Content-Type": "application/json", "Idempotency-Key": idempotencyKey });

export const websiteCommerceApi = {
  list: (companyId: string, siteId: string, resource: WebsiteCommerceResource, query: { cursor?: string; limit?: number } = {}) =>
    api.get<{ items: CommerceRow[]; nextCursor: string | null }>(
      `${commercePath(companyId, siteId)}/${encodeURIComponent(resource)}${searchOf(query)}`),
  /** One row. An import job adds `rows: { items, nextCursor }`, paged with `cursor` and `limit`. */
  get: (companyId: string, siteId: string, resource: WebsiteCommerceResource, itemId: string, page: { cursor?: string; limit?: number } = {}) =>
    api.get<{ item: CommerceRow }>(
      `${commercePath(companyId, siteId)}/${encodeURIComponent(resource)}/${encodeURIComponent(itemId)}${searchOf(page)}`),
  /** The USD to GBP display rate, its row version and its last 50 changes. */
  fx: (companyId: string, siteId: string) => api.get<{ item: CommerceRow }>(`${commercePath(companyId, siteId)}/fx`),
  /** From the site's database: no Stripe call. */
  payments: (companyId: string, siteId: string, range: WebsitePaymentReportQuery = {}) =>
    api.get<{ report: WebsitePaymentReport }>(`${commercePath(companyId, siteId)}/payments${searchOf(range)}`),
  /** One typed change. The same key and the same body write once on the site. */
  write: (companyId: string, siteId: string, change: CommerceWrite, idempotencyKey: string) => {
    const path = `${commercePath(companyId, siteId)}/${change.parts.map(encodeURIComponent).join("/")}`;
    const options = { headers: writeHeaders(idempotencyKey) };
    const body = change.body ?? {};
    if (change.method === "POST") return api.post<{ item: CommerceRow; result?: unknown }>(path, body, options);
    if (change.method === "PATCH") return api.patch<{ item: CommerceRow }>(path, body, options);
    return api.deleteWithBody<{ item: CommerceRow }>(path, body, options);
  },
  /** Sets or clears one vendor's licence activation steps (GRE-3982). The answer never holds a licence key. */
  putActivationSteps: (companyId: string, siteId: string, vendorId: string, input: WebsiteVendorActivationStepsInput,
    idempotencyKey: string) =>
    api.put<{ item: WebsiteVendorActivationSteps }>(
      `${commercePath(companyId, siteId)}/vendors/${encodeURIComponent(vendorId)}/activation-steps`, input,
      { headers: writeHeaders(idempotencyKey) }),
  /** Records a refund request on the site and opens a card for a person. Moves no money. */
  requestRefund: (companyId: string, siteId: string, input: WebsiteCommerceRefundRequestInput, idempotencyKey: string) =>
    api.post<{ approval: Approval; request: CommerceRow | null }>(`${commercePath(companyId, siteId)}/refund-requests`, input,
      { headers: writeHeaders(idempotencyKey) }),
};
