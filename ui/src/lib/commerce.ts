import type { WebsiteDataResource, WebsiteFeature } from "@greatstone/shared";

// Commerce, Phase A (GRE-2383, plan on GRE-2326): read-only screens for the
// website's quotes, orders, invoices and licences, read through the admin
// bridge as the site returns them. Nothing here writes to the site.

/** Greatstone's company: the only one whose site seeds the Shop feature (migration 0393). */
export const GREATSTONE_COMPANY_ID = "34dad57e-b5ad-4a72-9400-9eba645c99f6";
/** The feature registry entry (GRE-2325) the Commerce area hangs on. */
export const COMMERCE_FEATURE_KEY = "shop";

export const COMMERCE_RESOURCES = ["quotes", "orders", "invoices", "licences"] as const satisfies readonly WebsiteDataResource[];
export type CommerceResource = (typeof COMMERCE_RESOURCES)[number];

export function isCommerceResource(value: string | undefined): value is CommerceResource {
  return (COMMERCE_RESOURCES as readonly string[]).includes(value ?? "");
}

/** A row as the bridge returns it: the site's own column names, snake_case. */
export type CommerceRecord = Record<string, unknown>;

/** Shown for Greatstone only, and only while its site's Shop feature is on in the registry. */
export function commerceFeatureOf(companyId: string | null | undefined, features: readonly WebsiteFeature[] | undefined) {
  if (companyId !== GREATSTONE_COMPANY_ID) return null;
  return features?.find((feature) => feature.key === COMMERCE_FEATURE_KEY && feature.enabled) ?? null;
}

export const COMMERCE_COPY: Record<CommerceResource, { label: string; singular: string; empty: string }> = {
  quotes: { label: "Quotes", singular: "Quote", empty: "No quotes on the website yet." },
  orders: { label: "Orders", singular: "Order", empty: "No orders on the website yet." },
  invoices: { label: "Invoices", singular: "Invoice", empty: "No invoices yet. An order becomes an invoice when it gets an invoice number." },
  licences: { label: "Licences", singular: "Licence", empty: "No licence keys on the website yet." },
};

export function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const out = String(value).trim();
  return out ? out : null;
}

/** Money in minor units (pence, cents), as the site stores it. */
export function formatMinor(minor: unknown, currency: unknown): string | null {
  const amount = typeof minor === "string" && minor.trim() !== "" ? Number(minor) : minor;
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  const code = text(currency)?.toUpperCase() ?? null;
  if (code && /^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat("en-GB", { style: "currency", currency: code }).format(amount / 100);
    } catch {
      // An unknown code still shows its number below.
    }
  }
  return `${(amount / 100).toFixed(2)}${code ? ` ${code}` : ""}`;
}

/** The record's own name: its invoice number or reference, else a short id. */
export function recordTitle(resource: CommerceResource, record: CommerceRecord): string {
  const id = text(record.id) ?? "";
  if (resource === "invoices") return text(record.invoice_number) ?? text(record.reference) ?? id.slice(0, 8);
  if (resource === "licences") {
    const product = [text(record.offering_name), text(record.variant_name)].filter(Boolean).join(", ");
    return product || `Licence ${id.slice(0, 8)}`;
  }
  return text(record.reference) ?? id.slice(0, 8);
}

/** The bridge masks licence keys to their last four characters (GRE-2330); GSAM never sees more. */
export function maskedLicenceKey(record: CommerceRecord): string {
  const last4 = text(record.licence_key_last4);
  return last4 ? `•••• ${last4}` : "Not delivered";
}

export function recordTotal(resource: CommerceResource, record: CommerceRecord): string | null {
  if (resource === "quotes") {
    return formatMinor(record.quoted_total_minor, record.currency) ?? formatMinor(record.indicative_total_minor, record.currency);
  }
  if (resource === "orders" || resource === "invoices") return formatMinor(record.total_minor, record.currency);
  return null;
}

export function recordTime(record: CommerceRecord): string | null {
  return text(record.placed_at) ?? text(record.created_at);
}

/** Newest first. The bridge pages oldest first, keyed on created_at. */
export function newestFirst(records: readonly CommerceRecord[]): CommerceRecord[] {
  return [...records].sort((a, b) => (text(b.created_at) ?? "").localeCompare(text(a.created_at) ?? ""));
}

const STATUS_TONES: Record<string, string> = {
  draft: "bg-status-neutral-soft text-status-neutral-foreground",
  new: "bg-status-info-soft text-status-info-foreground",
  requested: "bg-status-info-soft text-status-info-foreground",
  sent: "bg-status-review-soft text-status-review-foreground",
  quoted: "bg-status-review-soft text-status-review-foreground",
  pending: "bg-status-pending-soft text-status-pending-foreground",
  awaiting_payment: "bg-status-pending-soft text-status-pending-foreground",
  accepted: "bg-status-success-soft text-status-success-foreground",
  paid: "bg-status-success-soft text-status-success-foreground",
  fulfilled: "bg-status-success-soft text-status-success-foreground",
  delivered: "bg-status-success-soft text-status-success-foreground",
  active: "bg-status-success-soft text-status-success-foreground",
  converted: "bg-status-success-soft text-status-success-foreground",
  paused: "bg-status-warning-soft text-status-warning-foreground",
  ended: "bg-status-neutral-soft text-status-neutral-foreground",
  refunded: "bg-status-warning-soft text-status-warning-foreground",
  partially_refunded: "bg-status-warning-soft text-status-warning-foreground",
  expired: "bg-status-neutral-soft text-status-neutral-foreground",
  cancelled: "bg-status-neutral-soft text-status-neutral-foreground",
  declined: "bg-status-neutral-soft text-status-neutral-foreground",
  revoked: "bg-status-danger-soft text-status-danger-foreground",
  failed: "bg-status-danger-soft text-status-danger-foreground",
};

export function statusTone(status: string): string {
  return STATUS_TONES[status.toLowerCase()] ?? "bg-status-neutral-soft text-status-neutral-foreground";
}

export function statusLabel(status: string): string {
  const words = status.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : status;
}

/** A host name to compare: no scheme, no www, no path, lower case. */
export function hostOf(value: string | null | undefined): string | null {
  const raw = value?.trim().toLowerCase();
  if (!raw) return null;
  const host = raw.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0]!.replace(/^www\./, "").replace(/:\d+$/, "");
  return host || null;
}

function nameKey(value: string | null | undefined) {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") || null;
}

export interface CommerceOrganisationRef {
  id: string;
  name: string;
  domain?: string | null;
  website?: string | null;
}

/**
 * The website customer that is this GSAM organisation: same domain first, else the same name. It is a link
 * between the two records, never a copy; neither side stores the other's id.
 */
export function websiteCustomerFor(organisation: CommerceOrganisationRef, customers: readonly CommerceRecord[]): CommerceRecord | null {
  const hosts = new Set([hostOf(organisation.domain), hostOf(organisation.website)].filter(Boolean));
  if (hosts.size) {
    const byDomain = customers.find((customer) => {
      const host = hostOf(text(customer.domain));
      return host !== null && hosts.has(host);
    });
    if (byDomain) return byDomain;
  }
  const name = nameKey(organisation.name);
  return customers.find((customer) => name !== null && nameKey(text(customer.name)) === name) ?? null;
}

/** The other way: the GSAM organisation for a website customer. */
export function organisationFor<T extends CommerceOrganisationRef>(customer: CommerceRecord | null | undefined, organisations: readonly T[]): T | null {
  if (!customer) return null;
  return organisations.find((organisation) => websiteCustomerFor(organisation, [customer]) !== null) ?? null;
}
