// Read-only import of the Pipedrive product catalogue and the products on each
// deal (John, 16 Oct: every bit of client information must come across).
// Products keep their prices in every currency, their custom fields under
// Pipedrive's names, and each deal keeps its line items with quantity, price,
// discount and sum. Rows are keyed on source and Pipedrive id, so a rerun
// updates them. Nothing is written to Pipedrive.
import { and, eq } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { crmDealProducts, crmProducts, type CrmProductPrice } from "@greatstone/db";
import type { OrganisationImportCounts, OrganisationImportResult } from "@greatstone/shared";
import { PipedriveApiError, PipedriveAuthError, type PipedriveClient, type PipedriveDealField } from "./crm-sync-pipedrive.js";
import { pipedriveRecordFields } from "./pipedrive-record-fields.js";

const SOURCE = "pipedrive";
const MAX_ERROR_SAMPLES = 20;
const MAX_TEXT = 10_000;

/** Product fields GSAM holds in its own columns, or that mean nothing outside Pipedrive. */
export const PRODUCT_COLUMN_KEYS = new Set([
  "id",
  "name",
  "code",
  "unit",
  "description",
  "tax",
  "active_flag",
  "owner_id",
  "prices",
  "first_char",
  "files_count",
  "followers_count",
]);

type ProductRow = typeof crmProducts.$inferSelect;
type ProductValues = Omit<typeof crmProducts.$inferInsert, "id" | "companyId" | "source" | "createdAt" | "updatedAt">;
type LineRow = typeof crmDealProducts.$inferSelect;

/** One product on a deal, before it is linked to its case and product rows. */
export interface MappedDealProduct {
  externalId: string;
  productExternalId: string | null;
  position: number;
  name: string;
  quantity: number | null;
  itemPrice: number | null;
  discount: number | null;
  discountType: "percentage" | "amount" | null;
  tax: number | null;
  sum: number | null;
  currency: string | null;
  comments: string | null;
  details: Record<string, unknown>;
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/,/g, ""));
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

function nameOf(value: unknown, users: Map<string, string>): string | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return str(record.name) ?? (idOf(record) ? users.get(idOf(record)!) ?? null : null);
  }
  const id = str(value);
  return id ? users.get(id) ?? null : null;
}

function text(value: unknown): string | null {
  const out = str(value);
  return out ? out.slice(0, MAX_TEXT) : null;
}

function compact(details: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(details).filter(([, value]) =>
    value !== null && value !== undefined && value !== ""));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Prices in every currency; v1 answers a list, older accounts an object keyed by currency. */
function pricesOf(raw: unknown): CrmProductPrice[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw as Record<string, unknown>) : [];
  return list.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const price = item as Record<string, unknown>;
    const currency = str(price.currency);
    if (!currency) return [];
    return [{ currency, price: num(price.price), cost: num(price.cost), overheadCost: num(price.overhead_cost) }];
  });
}

export function mapPipedriveProduct(
  product: Record<string, unknown>,
  context: { fields: PipedriveDealField[]; users: Map<string, string> },
): (ProductValues & { externalId: string }) | null {
  const externalId = str(product.id);
  if (!externalId) return null;
  return {
    externalId,
    name: (str(product.name) ?? `Pipedrive product ${externalId}`).slice(0, 500),
    code: text(product.code),
    unit: text(product.unit),
    description: text(product.description),
    tax: num(product.tax),
    active: product.active_flag !== false,
    ownerName: nameOf(product.owner_id, context.users),
    prices: pricesOf(product.prices),
    fields: pipedriveRecordFields(product, context.fields, { skip: PRODUCT_COLUMN_KEYS, users: context.users }),
  };
}

export function mapPipedriveDealProduct(item: Record<string, unknown>, position: number): MappedDealProduct | null {
  const externalId = str(item.id);
  if (!externalId) return null;
  // Newer accounts answer discount plus its type; older ones only a percentage.
  const amount = num(item.discount);
  const percentage = num(item.discount_percentage);
  const discount = amount ?? percentage;
  const type = str(item.discount_type);
  const discountType = discount === null ? null : amount !== null && type === "amount" ? "amount" : "percentage";
  return {
    externalId,
    productExternalId: idOf(item.product_id),
    position,
    name: (str(item.name) ?? (item.product && typeof item.product === "object" ? str((item.product as Record<string, unknown>).name) : null)
      ?? `Pipedrive product ${idOf(item.product_id) ?? externalId}`).slice(0, 500),
    quantity: num(item.quantity),
    itemPrice: num(item.item_price),
    discount: discount === 0 ? null : discount,
    discountType: discount === 0 ? null : discountType,
    tax: num(item.tax),
    sum: num(item.sum),
    currency: str(item.currency),
    comments: text(item.comments),
    details: compact({
      duration: num(item.duration),
      durationUnit: str(item.duration_unit),
      taxMethod: str(item.tax_method),
      billingFrequency: str(item.billing_frequency),
      billingFrequencyCycles: num(item.billing_frequency_cycles),
      billingStartDate: str(item.billing_start_date),
      variationId: idOf(item.product_variation_id),
      enabled: typeof item.enabled_flag === "boolean" ? item.enabled_flag : null,
      addedAt: str(item.add_time),
    }),
  };
}

function amountText(value: number) {
  return value.toLocaleString("en-GB", { maximumFractionDigits: 2 });
}

/**
 * The products on a deal as one readable block for the case's Products
 * field, such as "2 x Team seats at 600 GBP, 10% off: 1,080 GBP".
 */
export function summariseDealProducts(items: MappedDealProduct[]): string | null {
  if (items.length === 0) return null;
  const lines = items.map((item) => {
    const currency = item.currency ? ` ${item.currency}` : "";
    let line = `${item.quantity !== null ? `${amountText(item.quantity)} x ` : ""}${item.name}`;
    if (item.itemPrice !== null) line += ` at ${amountText(item.itemPrice)}${currency}`;
    if (item.discount !== null) {
      line += item.discountType === "amount" ? `, ${amountText(item.discount)}${currency} off` : `, ${amountText(item.discount)}% off`;
    }
    if (item.sum !== null) line += `: ${amountText(item.sum)}${currency}`;
    if (item.comments) line += ` (${item.comments.replace(/\s+/g, " ")})`;
    return line;
  });
  const currencies = new Set(items.map((item) => item.currency));
  if (items.length > 1 && currencies.size === 1 && items.every((item) => item.sum !== null)) {
    const total = items.reduce((sum, item) => sum + item.sum!, 0);
    lines.push(`Total: ${amountText(total)}${items[0]!.currency ? ` ${items[0]!.currency}` : ""}`);
  }
  return lines.join("\n");
}

/** Every product on one deal, across pages. */
export async function readPipedriveDealProducts(client: PipedriveClient, dealId: string): Promise<MappedDealProduct[]> {
  const out: MappedDealProduct[] = [];
  let start: number | null = 0;
  while (start !== null) {
    const page: Awaited<ReturnType<PipedriveClient["listDealProductsPage"]>> = await client.listDealProductsPage({ dealId, start });
    for (const item of page.items) {
      const mapped = mapPipedriveDealProduct(item, out.length);
      if (mapped) out.push(mapped);
    }
    start = page.nextStart;
  }
  return out;
}

function sameProduct(row: ProductRow, values: ProductValues) {
  return row.name === values.name
    && row.code === (values.code ?? null)
    && row.unit === (values.unit ?? null)
    && row.description === (values.description ?? null)
    && row.tax === (values.tax ?? null)
    && row.active === (values.active ?? true)
    && row.ownerName === (values.ownerName ?? null)
    && stableJson(row.prices ?? []) === stableJson(values.prices ?? [])
    && stableJson(row.fields ?? []) === stableJson(values.fields ?? []);
}

function sameLine(row: LineRow, caseId: string, productId: string | null, item: MappedDealProduct) {
  return row.caseId === caseId
    && row.productId === productId
    && row.position === item.position
    && row.name === item.name
    && row.quantity === item.quantity
    && row.itemPrice === item.itemPrice
    && row.discount === item.discount
    && row.discountType === item.discountType
    && row.tax === item.tax
    && row.sum === item.sum
    && row.currency === item.currency
    && row.comments === item.comments
    && stableJson(row.details ?? {}) === stableJson(item.details);
}

const emptyCounts = (): OrganisationImportCounts => ({ created: 0, updated: 0, skipped: 0, errors: 0 });

export function pipedriveProductImportService(db: Db, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());

  return {
    /**
     * Imports the product catalogue, then the products on every deal the deal
     * import read. `lineItemsByDealId` holds only deals whose products are
     * known, so a deal whose products could not be read keeps what it had.
     */
    async run(input: {
      companyId: string;
      client: PipedriveClient;
      result: OrganisationImportResult;
      users: Map<string, string>;
      caseIdByDealId: Map<string, string>;
      lineItemsByDealId: Map<string, MappedDealProduct[]>;
    }) {
      const { companyId, client, result } = input;
      const products = emptyCounts();
      const dealProducts = emptyCounts();
      result.products = products;
      result.dealProducts = dealProducts;
      const pushError = (externalId: string, message: string) => {
        if (result.errorSamples.length < MAX_ERROR_SAMPLES) result.errorSamples.push({ kind: "product", externalId, message });
      };

      const productByExternalId = new Map<string, ProductRow>();
      for (const row of await db.select().from(crmProducts)
        .where(and(eq(crmProducts.companyId, companyId), eq(crmProducts.source, SOURCE)))) {
        productByExternalId.set(row.externalId, row);
      }

      // The catalogue. Products are a paid Pipedrive add-on, so an account without them still imports the rest.
      try {
        const fields = await client.listProductFields();
        let start: number | null = 0;
        while (start !== null) {
          const page: Awaited<ReturnType<PipedriveClient["listProductsPage"]>> = await client.listProductsPage({ start });
          for (const item of page.items) {
            const values = mapPipedriveProduct(item, { fields, users: input.users });
            if (!values) {
              products.skipped += 1;
              continue;
            }
            try {
              const current = productByExternalId.get(values.externalId);
              if (!current) {
                const [row] = await db.insert(crmProducts).values({ ...values, companyId, source: SOURCE }).returning();
                productByExternalId.set(values.externalId, row!);
                products.created += 1;
              } else if (sameProduct(current, values)) {
                products.skipped += 1;
              } else {
                const [row] = await db.update(crmProducts).set({ ...values, updatedAt: now() })
                  .where(and(eq(crmProducts.companyId, companyId), eq(crmProducts.id, current.id)))
                  .returning();
                productByExternalId.set(values.externalId, row!);
                products.updated += 1;
              }
            } catch (error) {
              products.errors += 1;
              pushError(values.externalId, error instanceof Error ? error.message : String(error));
            }
          }
          start = page.nextStart;
        }
      } catch (error) {
        if (!(error instanceof PipedriveAuthError || error instanceof PipedriveApiError)) throw error;
        products.errors += 1;
        pushError("all", `Pipedrive did not share products: ${error.message}`);
      }

      // The products on each deal, linked to its case and, where it is in the catalogue, its product.
      const lineByExternalId = new Map<string, LineRow>();
      for (const row of await db.select().from(crmDealProducts)
        .where(and(eq(crmDealProducts.companyId, companyId), eq(crmDealProducts.source, SOURCE)))) {
        lineByExternalId.set(row.externalId, row);
      }
      const seen = new Set<string>();
      const knownCases = new Set<string>();
      for (const [dealId, items] of input.lineItemsByDealId) {
        const caseId = input.caseIdByDealId.get(dealId);
        if (!caseId) continue;
        knownCases.add(caseId);
        for (const item of items) {
          seen.add(item.externalId);
          const productId = item.productExternalId ? productByExternalId.get(item.productExternalId)?.id ?? null : null;
          const values = {
            caseId,
            productId,
            position: item.position,
            name: item.name,
            quantity: item.quantity,
            itemPrice: item.itemPrice,
            discount: item.discount,
            discountType: item.discountType,
            tax: item.tax,
            sum: item.sum,
            currency: item.currency,
            comments: item.comments,
            details: item.details,
          };
          try {
            const current = lineByExternalId.get(item.externalId);
            if (!current) {
              const [row] = await db.insert(crmDealProducts)
                .values({ ...values, companyId, source: SOURCE, externalId: item.externalId })
                .returning();
              lineByExternalId.set(item.externalId, row!);
              dealProducts.created += 1;
            } else if (sameLine(current, caseId, productId, item)) {
              dealProducts.skipped += 1;
            } else {
              await db.update(crmDealProducts).set({ ...values, updatedAt: now() })
                .where(and(eq(crmDealProducts.companyId, companyId), eq(crmDealProducts.id, current.id)));
              dealProducts.updated += 1;
            }
          } catch (error) {
            dealProducts.errors += 1;
            pushError(item.externalId, error instanceof Error ? error.message : String(error));
          }
        }
      }
      // A product taken off a deal in Pipedrive comes off the case too; counted as an update.
      for (const row of lineByExternalId.values()) {
        if (!knownCases.has(row.caseId) || seen.has(row.externalId)) continue;
        await db.delete(crmDealProducts).where(and(eq(crmDealProducts.companyId, companyId), eq(crmDealProducts.id, row.id)));
        dealProducts.updated += 1;
      }
      return { products, dealProducts };
    },
  };
}
