// CRM products (Pipedrive import, 16 Oct): the product catalogue and the
// products on each deal, so prices, quantities and discounts come across with
// the deal. source + external_id is unique per company, so a rerun of an
// import updates a row instead of adding it twice.
import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { pipelineCases } from "./pipeline_cases.js";

/** One price of a product in one currency. */
export interface CrmProductPrice {
  currency: string;
  price: number | null;
  cost: number | null;
  overheadCost: number | null;
}

/** A named field the CRM holds about a product, custom fields included. */
export interface CrmProductField {
  key: string;
  label: string;
  value: string | number | boolean | string[];
}

export const crmProducts = pgTable(
  "crm_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    code: text("code"),
    unit: text("unit"),
    description: text("description"),
    tax: doublePrecision("tax"),
    active: boolean("active").notNull().default(true),
    ownerName: text("owner_name"),
    prices: jsonb("prices").$type<CrmProductPrice[]>().notNull().default([]),
    // Every other field, such as category, billing frequency and custom fields, under the CRM's name for it.
    fields: jsonb("fields").$type<CrmProductField[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    externalUq: uniqueIndex("crm_products_company_source_external_uq").on(table.companyId, table.source, table.externalId),
    companyNameIdx: index("crm_products_company_name_idx").on(table.companyId, table.name),
  }),
);

export const crmDealProducts = pgTable(
  "crm_deal_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    // The CRM's id for this line on the deal.
    externalId: text("external_id").notNull(),
    caseId: uuid("case_id").notNull().references(() => pipelineCases.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => crmProducts.id, { onDelete: "set null" }),
    position: integer("position").notNull().default(0),
    name: text("name").notNull(),
    quantity: doublePrecision("quantity"),
    itemPrice: doublePrecision("item_price"),
    discount: doublePrecision("discount"),
    // percentage or amount.
    discountType: text("discount_type"),
    tax: doublePrecision("tax"),
    sum: doublePrecision("sum"),
    currency: text("currency"),
    comments: text("comments"),
    // Everything else: duration, billing frequency, variation, enabled.
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    externalUq: uniqueIndex("crm_deal_products_company_source_external_uq").on(table.companyId, table.source, table.externalId),
    companyCaseIdx: index("crm_deal_products_company_case_idx").on(table.companyId, table.caseId, table.position),
  }),
);
