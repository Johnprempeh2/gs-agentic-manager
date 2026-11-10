import type { WebsiteCommerceCatalogueResource, WebsiteEntry } from "@greatstone/shared";
import type { CommerceRow } from "@/api/website-commerce";
import { formatMinor, text } from "@/lib/commerce";
import type { CommerceFieldDef } from "@/lib/commerce-write";

// The catalogue's forms (GRE-3972). Each field is one the site's write route takes (greatstone-website,
// netlify/functions/lib/admin-bridge-write.mjs): the body name is camelCase, the row column snake_case. A field the
// site does not take is never sent. No status field: a draft stays a draft until a person publishes it.

const BILLING_PERIODS = [
  { value: "one_time", label: "One time" }, { value: "perpetual", label: "Perpetual" }, { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" }, { value: "annual", label: "Annual" }, { value: "multi_year", label: "Multi-year" },
] as const;

const SORT: CommerceFieldDef = { name: "sortOrder", column: "sort_order", label: "Sort order", kind: "int", help: "Lower comes first." };
const SLUG: CommerceFieldDef = { name: "slug", column: "slug", label: "Slug", kind: "slug", required: true, help: "The address part, for example jetbrains-all-products." };

export const CATALOGUE_FIELDS: Record<WebsiteCommerceCatalogueResource, CommerceFieldDef[]> = {
  vendors: [
    { name: "name", column: "name", label: "Name", kind: "text", required: true },
    SLUG,
    { name: "domain", column: "domain", label: "Website", kind: "text", help: "For example jetbrains.com." },
    { name: "logoUrl", column: "logo_url", label: "Logo address", kind: "text" },
    { name: "description", column: "description", label: "Description", kind: "textarea", wide: true },
    { name: "activationInstructions", column: "activation_instructions", label: "Activation steps", kind: "textarea", wide: true,
      help: "What a customer does with a licence key from this vendor." },
    SORT,
  ],
  categories: [
    { name: "name", column: "name", label: "Name", kind: "text", required: true },
    SLUG,
    { name: "parentId", column: "parent_id", label: "Parent category", kind: "ref", ref: "categories" },
    { name: "iconUrl", column: "icon_url", label: "Icon address", kind: "text" },
    { name: "description", column: "description", label: "Description", kind: "textarea", wide: true },
    SORT,
  ],
  offerings: [
    { name: "name", column: "name", label: "Name", kind: "text", required: true },
    SLUG,
    { name: "type", column: "type", label: "Type", kind: "select", required: true,
      options: [{ value: "product", label: "Product" }, { value: "service", label: "Service" }] },
    { name: "fulfilment", column: "fulfilment", label: "Fulfilment", kind: "select",
      options: [{ value: "license", label: "Licence key" }, { value: "subscription", label: "Subscription" },
        { value: "engagement", label: "Engagement" }, { value: "enquiry", label: "Enquiry" }] },
    { name: "vendorId", column: "vendor_id", label: "Vendor", kind: "ref", ref: "vendors", help: "A product needs a vendor." },
    { name: "categoryId", column: "category_id", label: "Category", kind: "ref", ref: "categories" },
    { name: "shortDescription", column: "short_description", label: "Short description", kind: "textarea", wide: true },
    { name: "description", column: "description", label: "Description", kind: "textarea", wide: true },
    { name: "platforms", column: "platforms", label: "Platforms", kind: "words", help: "Separate with commas." },
    { name: "tags", column: "tags", label: "Tags", kind: "words", help: "Separate with commas." },
    { name: "fromPriceMinor", column: "from_price_minor", label: "From price", kind: "money" },
    { name: "fromPriceCurrency", column: "from_price_currency", label: "From price currency", kind: "currency", help: "For example USD." },
    { name: "featured", column: "featured", label: "Featured", kind: "bool", help: "Shown first on the shop." },
  ],
  "pricing-rules": [
    { name: "name", column: "name", label: "Name", kind: "text", required: true },
    { name: "label", column: "label", label: "Label on the site", kind: "text", help: "For example Partner price." },
    { name: "scopeType", column: "scope_type", label: "Applies to", kind: "select", required: true,
      options: [{ value: "all", label: "Everything" }, { value: "vendor", label: "Vendors" }, { value: "category", label: "Categories" },
        { value: "offering", label: "Offerings" }, { value: "tier", label: "Customer tiers" }],
      help: "Pick the vendors, categories, offerings or tiers under Targets." },
    { name: "appliesToOfferingType", column: "applies_to_offering_type", label: "Offering type", kind: "select",
      options: [{ value: "product", label: "Products only" }, { value: "service", label: "Services only" }] },
    { name: "adjustmentType", column: "adjustment_type", label: "Adjustment", kind: "select", required: true,
      options: [{ value: "percentage", label: "Percentage" }, { value: "fixed", label: "Fixed amount" }] },
    { name: "adjustmentValue", column: "adjustment_value", label: "Amount", kind: "money", required: true,
      help: "For a fixed adjustment. Enter 0 for a percentage." },
    { name: "adjustmentValuePct", column: "adjustment_value_pct", label: "Percentage", kind: "decimal", help: "0 to 100, for example 12.5." },
    { name: "currency", column: "currency", label: "Currency", kind: "currency" },
    { name: "audience", column: "audience", label: "Audience", kind: "select",
      options: [{ value: "public", label: "Everyone" }, { value: "tier", label: "One customer tier" }] },
    { name: "audienceTierId", column: "audience_tier_id", label: "Customer tier", kind: "ref", ref: "customer-tiers" },
    { name: "startsAt", column: "starts_at", label: "Starts", kind: "datetime" },
    { name: "endsAt", column: "ends_at", label: "Ends", kind: "datetime" },
    { name: "priority", column: "priority", label: "Priority", kind: "int", help: "Higher wins when rules overlap." },
    { name: "floorFraction", column: "floor_fraction", label: "Floor", kind: "decimal", help: "The lowest share of list price, 0 to 1." },
    { name: "active", column: "active", label: "Active", kind: "bool" },
  ],
};

export const VARIANT_FIELDS: CommerceFieldDef[] = [
  { name: "name", column: "name", label: "Edition", kind: "text", required: true },
  { name: "sku", column: "sku", label: "SKU", kind: "text" },
  { name: "billingPeriod", column: "billing_period", label: "Billing", kind: "select", options: BILLING_PERIODS },
  { name: "basePriceMinor", column: "base_price_minor", label: "Price", kind: "money" },
  { name: "currency", column: "currency", label: "Currency", kind: "currency" },
  { name: "licenseType", column: "license_type", label: "Licence type", kind: "text" },
  { name: "platform", column: "platform", label: "Platform", kind: "text" },
  { name: "minOrderQty", column: "min_order_qty", label: "Minimum quantity", kind: "int" },
  { name: "listDiscountPct", column: "list_discount_pct", label: "List discount %", kind: "decimal" },
  SORT,
];

export const SPEC_FIELDS: CommerceFieldDef[] = [
  { name: "label", column: "label", label: "Label", kind: "text", required: true },
  { name: "value", column: "value", label: "Value", kind: "text", required: true },
  SORT,
];

export const MEDIA_FIELDS: CommerceFieldDef[] = [
  { name: "assetId", column: "asset_id", label: "Asset id", kind: "text", required: true,
    help: "An image already on the website, by its id. GSAM does not upload." },
  SORT,
];

export const TARGET_FIELDS: CommerceFieldDef[] = [
  { name: "vendorId", column: "vendor_id", label: "Vendor", kind: "ref", ref: "vendors" },
  { name: "categoryId", column: "category_id", label: "Category", kind: "ref", ref: "categories" },
  { name: "offeringId", column: "offering_id", label: "Offering", kind: "ref", ref: "offerings" },
  { name: "tierId", column: "tier_id", label: "Customer tier", kind: "ref", ref: "customer-tiers" },
];

export const CATALOGUE_COPY: Record<WebsiteCommerceCatalogueResource | "customer-tiers", { label: string; singular: string; empty: string }> = {
  offerings: { label: "Offerings", singular: "Offering", empty: "No offerings yet. Add one, or import a price book." },
  vendors: { label: "Vendors", singular: "Vendor", empty: "No vendors yet." },
  categories: { label: "Categories", singular: "Category", empty: "No categories yet." },
  "pricing-rules": { label: "Pricing rules", singular: "Pricing rule", empty: "No pricing rules yet." },
  "customer-tiers": { label: "Customer tiers", singular: "Customer tier", empty: "No customer tiers on the website." },
};

/** A row's small print under its name and description: never its code, which `catalogueCode` gives. */
export function catalogueMeta(resource: WebsiteCommerceCatalogueResource | "customer-tiers", row: CommerceRow, names: { vendor?: string | null } = {}): string {
  const parts: (string | null | undefined)[] = [];
  if (resource === "offerings") {
    const variants = Array.isArray(row.variants) ? row.variants.length : 0;
    parts.push(names.vendor, variants ? `${variants} ${variants === 1 ? "edition" : "editions"}` : null);
  } else if (resource === "pricing-rules") {
    const amount = text(row.adjustment_type) === "percentage"
      ? (text(row.adjustment_value_pct) ? `${text(row.adjustment_value_pct)}%` : null)
      : formatMinor(row.adjustment_value, row.currency);
    parts.push(text(row.label), amount, row.active === false ? "Off" : null);
  } else if (resource === "customer-tiers") {
    parts.push(text(row.rank) ? `Rank ${text(row.rank)}` : null);
  } else {
    parts.push(text(row.domain));
  }
  return parts.filter(Boolean).join(" · ");
}

/** A row's code (its address part on the website): shown small, after what the row is. */
export function catalogueCode(row: CommerceRow): string | null {
  return text(row.slug);
}

const sameText = (a: string | null, b: string | null) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/**
 * What a row is, in one line, from the site's own words: its short description, or the first sentence of its
 * description when the short one is missing or only repeats the name. Null when the site holds neither.
 */
export function catalogueOneLine(row: CommerceRow): string | null {
  const short = text(row.short_description);
  if (short && !sameText(short, text(row.name))) return short;
  const long = text(row.description);
  return long ? long.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? long : null;
}

/** An offering's price line: "From" its lowest price, or null when the site holds no price. */
export function offeringPrice(row: CommerceRow): string | null {
  const price = formatMinor(row.from_price_minor, row.from_price_currency);
  return price ? `From ${price}` : null;
}

/** What an offering still lacks before it reads well on the shop. Empty when nothing is missing. */
export function offeringGaps(row: CommerceRow): string[] {
  const short = text(row.short_description);
  return [
    offeringPrice(row) ? null : "No price set",
    short && !sameText(short, text(row.name)) ? null : "No short description",
    text(row.category_id) ? null : "No category",
  ].filter((gap): gap is string => gap !== null);
}

/** True when every word of `search` is in the row's name, code, description, tags, SKUs or the given names. */
export function catalogueMatches(row: CommerceRow, search: string, names: (string | null | undefined)[] = []): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  const haystack = [row.name, row.slug, row.short_description, row.label, row.domain, ...names, ...list(row.tags), ...list(row.platforms),
    ...list(row.variants).flatMap((variant: CommerceRow) => [variant.sku, variant.name])]
    .map(text).filter(Boolean).join("\n").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

const ENTRY_KINDS: Record<string, string> = {
  product: "Product", category: "Category", vendor: "Vendor", "public-person": "Team member", form: "Form", redirect: "Redirect",
};

/**
 * How a Website entry reads in a list: what it is first, its code last. An entry whose content names nothing
 * reads by its key, as before. A product always says its price, or that none is set.
 */
export function entryReading(entry: Pick<WebsiteEntry, "entryKey" | "collection" | "summary">) {
  const row: CommerceRow = { ...entry.summary };
  const named = Boolean(text(row.name));
  const price = entry.collection === "product" && named ? offeringPrice(row) ?? "No price set" : null;
  return {
    title: text(row.name) ?? entry.entryKey,
    line: catalogueOneLine(row),
    meta: [text(row.vendor), text(row.category), price].filter(Boolean).join(" · "),
    code: named ? text(row.slug) ?? entry.entryKey : null,
    kind: ENTRY_KINDS[entry.collection] ?? "Entry",
  };
}

/** Search a Website entry by name, vendor, category, code, key or edition SKU. */
export function entryMatches(entry: Pick<WebsiteEntry, "entryKey" | "summary">, search: string): boolean {
  return catalogueMatches({ ...entry.summary }, search, [entry.entryKey, entry.summary?.vendor, entry.summary?.category]);
}

/** The product's public page. Only a published product has one. */
export function offeringWebsiteUrl(row: CommerceRow, domain: string | null | undefined): string | null {
  const slug = text(row.slug);
  const host = text(domain);
  return slug && host && text(row.status) === "published" ? `https://${host}/product/${encodeURIComponent(slug)}` : null;
}

/** An option label for a row picked in a `ref` field. */
export function rowOptionLabel(row: CommerceRow): string {
  return text(row.name) ?? text(row.slug) ?? (text(row.id) ?? "").slice(0, 8);
}
