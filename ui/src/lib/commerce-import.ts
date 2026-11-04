import type { CommerceRow } from "@/api/website-commerce";

// The price-book import (GRE-3972 slice 3). A port of the website staff screen's planner (greatstone-website,
// src/store/bulkCsv.mjs: parseCsv, csvToObjects, buildSkuPlan), so a GSAM dry run plans rows exactly as the site's
// own importer does. The site's `bridge_import_apply` then applies the job's insert and update rows with
// `import_skus`: an insert row's `mapped` is a create (with `offeringSlug`), an update row's an update (with
// `variantId`). Prices are USD; the site shows GBP at the display rate.

export const SKU_COLUMNS = ["sku", "offering_slug", "offering_name", "vendor", "category", "edition_name", "license_type",
  "billing_period", "list_price_usd", "status", "featured"] as const;

const STATUSES = ["draft", "published", "archived"];
const BILLING_PERIODS = ["one_time", "perpetual", "monthly", "quarterly", "annual", "multi_year"];
const VARIANT_TEXT: [csvKey: string, column: string][] = [["edition_name", "name"], ["license_type", "license_type"], ["billing_period", "billing_period"]];
/** The site takes at most 2,000 rows in one job. */
export const MAX_IMPORT_ROWS = 2000;

/** RFC 4180-ish: quoted fields, escaped quotes, commas and new lines inside quotes. */
export function parseCsv(input: string): string[][] {
  const s = String(input).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (c === "\"") {
        if (s[i + 1] === "\"") { field += "\""; i += 1; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === "\"") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] !== undefined && r[0] !== ""));
}

export function csvToObjects(input: string): Record<string, string>[] {
  const rows = parseCsv(input);
  if (!rows.length) return [];
  const head = rows[0]!.map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

const asBool = (v: unknown) => /^(true|yes|1|y)$/i.test(String(v ?? "").trim());
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

/** "870", "870.00", "$1,299.99" → cents; blank → null (price on request); anything else → an error. */
export function parseUsdPriceToMinor(raw: unknown): { minor: number | null } | { error: string } {
  const s = String(raw ?? "").trim().replace(/[$£,\s]/g, "");
  if (s === "") return { minor: null };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { error: `not a valid price: "${String(raw).trim()}"` };
  return { minor: Math.round(parseFloat(s) * 100) };
}

export interface ImportCatalogue {
  /** Every live edition by its SKU, with `offering_id`. */
  variantsBySku: Map<string, CommerceRow>;
  /** Every live offering by its slug. */
  offeringsBySlug: Map<string, CommerceRow>;
}

/** The catalogue as the planner needs it, from the offerings (each with its `variants`). */
export function importCatalogueOf(offerings: readonly CommerceRow[]): ImportCatalogue {
  const variantsBySku = new Map<string, CommerceRow>();
  const offeringsBySlug = new Map<string, CommerceRow>();
  for (const offering of offerings) {
    if (typeof offering.slug === "string") offeringsBySlug.set(offering.slug, offering);
    for (const variant of Array.isArray(offering.variants) ? (offering.variants as CommerceRow[]) : []) {
      const sku = typeof variant.sku === "string" ? variant.sku.trim() : "";
      if (sku) variantsBySku.set(sku, { ...variant, offering_id: variant.offering_id ?? offering.id });
    }
  }
  return { variantsBySku, offeringsBySlug };
}

/** One row of the dry run, as the site's `POST /imports` takes it. */
export interface ImportJobRow {
  rowNumber: number;
  raw: Record<string, string>;
  mapped: Record<string, unknown> | null;
  targetEntity: "variant";
  matchKey: string | null;
  action: "insert" | "update" | "noop" | "error";
  errors: string[];
}

export interface ImportPlan {
  rows: ImportJobRow[];
  counts: { total: number; insert: number; update: number; noop: number; error: number };
}

const currentMinor = (value: unknown) => (value === null || value === undefined || value === "" ? null : Number(value));

/**
 * The dry-run rows for a price book, against the catalogue as it is now. `rowNumber` is the spreadsheet line (the
 * header is line 1). A SKU that repeats in the file is an error on every line it is on, as on the site.
 */
export function planSkuImport(objects: readonly Record<string, string>[], catalogue: ImportCatalogue): ImportPlan {
  const skuCount = new Map<string, number>();
  for (const row of objects) {
    const sku = (row.sku ?? "").trim();
    if (sku) skuCount.set(sku, (skuCount.get(sku) ?? 0) + 1);
  }
  const rows = objects.map((row, index): ImportJobRow => {
    const sku = (row.sku ?? "").trim();
    const base = { rowNumber: index + 2, raw: { ...row }, targetEntity: "variant" as const, matchKey: sku || null };
    const error = (reason: string): ImportJobRow => ({ ...base, mapped: null, action: "error", errors: [reason] });
    if (!sku) return error("missing sku");
    if ((skuCount.get(sku) ?? 0) > 1) return error("sku repeats in the file");
    const price = parseUsdPriceToMinor(row.list_price_usd);
    if ("error" in price) return error(price.error);
    const status = (row.status ?? "").trim();
    if (status && !STATUSES.includes(status)) return error(`invalid status "${status}"`);
    const period = (row.billing_period ?? "").trim();
    if (period && !BILLING_PERIODS.includes(period)) return error(`invalid billing_period "${period}" (use one of: ${BILLING_PERIODS.join(", ")})`);

    const current = catalogue.variantsBySku.get(sku);
    if (current) {
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const [csvKey, column] of VARIANT_TEXT) {
        const next = (row[csvKey] ?? "").trim();
        if (!next) continue;
        const now = current[column] === null || current[column] === undefined ? "" : String(current[column]);
        if (next !== now) changes[column] = { from: now, to: next };
      }
      const was = currentMinor(current.base_price_minor);
      if (price.minor !== null && price.minor !== was) changes.base_price_minor = { from: was, to: price.minor };
      if (!Object.keys(changes).length) return { ...base, mapped: null, action: "noop", errors: [] };
      return { ...base, action: "update", errors: [], mapped: { sku, variantId: current.id, offeringId: current.offering_id, changes } };
    }

    const offeringSlug = (row.offering_slug ?? "").trim() || null;
    const vendor = (row.vendor ?? "").trim() || null;
    const offeringName = (row.offering_name ?? "").trim() || null;
    const effectiveSlug = offeringSlug || slugify(offeringName || sku);
    if (!effectiveSlug) return error("cannot derive a product slug; set offering_slug");
    const parentExists = catalogue.offeringsBySlug.has(effectiveSlug);
    if (!offeringSlug && parentExists) return error("product name matches an existing product; set offering_slug to attach, or rename");
    if (!parentExists && !vendor) return error("new product needs a vendor");
    return {
      ...base,
      action: "insert",
      errors: [],
      mapped: {
        sku,
        offeringSlug: effectiveSlug,
        offeringName,
        vendor,
        category: (row.category ?? "").trim() || null,
        status: status || "draft",
        featured: asBool(row.featured),
        variant: {
          name: (row.edition_name ?? "").trim() || "Standard",
          license_type: (row.license_type ?? "").trim() || null,
          billing_period: period || "perpetual",
          base_price_minor: price.minor,
        },
      },
    };
  });
  const count = (action: ImportJobRow["action"]) => rows.filter((row) => row.action === action).length;
  return { rows, counts: { total: rows.length, insert: count("insert"), update: count("update"), noop: count("noop"), error: count("error") } };
}
