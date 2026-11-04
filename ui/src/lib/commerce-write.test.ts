import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { CATALOGUE_FIELDS } from "./commerce-catalogue";
import { csvToObjects, importCatalogueOf, planSkuImport } from "./commerce-import";
import {
  bodyFromForm,
  commerceWriteFailure,
  formValuesOf,
  isPersonAccess,
  newIdempotencyKey,
  parseMajorToMinor,
} from "./commerce-write";

describe("commerce writes", () => {
  it("makes 22-character base64url idempotency keys, a new one each time", () => {
    const a = newIdempotencyKey();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newIdempotencyKey()).not.toBe(a);
  });

  it("treats only a GSAM session or the local board as a person", () => {
    expect(isPersonAccess({ source: "session" })).toBe(true);
    expect(isPersonAccess({ source: "local_implicit" })).toBe(true);
    expect(isPersonAccess({ source: "board_key" })).toBe(false);
    expect(isPersonAccess(undefined)).toBe(false);
  });

  it("reads money in major units without float error", () => {
    expect(parseMajorToMinor("1,299.99")).toBe(129999);
    expect(parseMajorToMinor("£0.1")).toBe(10);
    expect(parseMajorToMinor("")).toBeNull();
    expect(parseMajorToMinor("12.345")).toBeUndefined();
    expect(parseMajorToMinor("-3")).toBeUndefined();
  });

  it("sends every filled field on create and only what changed on edit", () => {
    const fields = CATALOGUE_FIELDS.offerings;
    const created = bodyFromForm(fields, { ...formValuesOf(fields, null), name: "Toolbox", slug: "toolbox", type: "product", fromPriceMinor: "99", tags: "ide, jvm" }, null);
    expect(created).toEqual({ error: null, body: { name: "Toolbox", slug: "toolbox", type: "product", fromPriceMinor: 9900, tags: ["ide", "jvm"] } });

    const row = { name: "Toolbox", slug: "toolbox", type: "product", from_price_minor: "9900", featured: false, vendor_id: "v1", tags: ["ide"] };
    const values = formValuesOf(fields, row);
    expect(values.fromPriceMinor).toBe("99.00");
    expect(bodyFromForm(fields, { ...values, featured: "true", vendorId: "" }, row)).toEqual({ error: null, body: { featured: true, vendorId: null } });
    expect(bodyFromForm(fields, { ...values, name: " " }, row)).toEqual({ body: null, error: "Name is required." });
  });

  it("names the conflict, no-key and people-only answers", () => {
    expect(commerceWriteFailure(new ApiError("off", 409, { error: "off", code: "capability_not_configured", details: { capability: "refund_request" } })))
      .toMatchObject({ kind: "no_key", capability: "refund_request" });
    expect(commerceWriteFailure(new ApiError("people", 403, { error: "people", code: "website_commerce_people_only" })))
      .toEqual({ kind: "people_only", message: "people" });
    expect(commerceWriteFailure(new ApiError("changed", 409, { error: "changed", code: "website_bridge_conflict", details: { current: { row_version: 9 } } })))
      .toEqual({ kind: "conflict", message: "changed", current: { row_version: 9 } });
    expect(commerceWriteFailure(new ApiError("other", 409, { error: "other", code: "website_bridge_idempotency_mismatch" })).kind).toBe("other");
  });
});

describe("price-book import plan", () => {
  const catalogue = importCatalogueOf([
    { id: "o1", slug: "toolbox", variants: [{ id: "v1", sku: "TB-1", name: "Annual", billing_period: "annual", base_price_minor: "10000" }] },
  ]);

  it("plans inserts, updates, unchanged rows and errors as the site's importer does", () => {
    const csv = [
      "sku,offering_slug,offering_name,vendor,edition_name,billing_period,list_price_usd",
      "TB-1,,,,Annual,annual,100",
      "TB-1b,toolbox,,,Monthly,monthly,12",
      "NEW-1,,Fresh Product,Acme,,,$1,299.00",
      "NEW-2,,Lonely Product,,,,10",
      "TB-2,toolbox,,,,weekly,10",
    ].join("\n");
    const plan = planSkuImport(csvToObjects(csv.replace("$1,299.00", "\"$1,299.00\"")), catalogue);
    expect(plan.rows.map((row) => [row.rowNumber, row.action])).toEqual([[2, "noop"], [3, "insert"], [4, "insert"], [5, "error"], [6, "error"]]);
    expect(plan.rows[1]!.mapped).toMatchObject({ sku: "TB-1b", offeringSlug: "toolbox", variant: { name: "Monthly", billing_period: "monthly", base_price_minor: 1200 } });
    expect(plan.rows[2]!.mapped).toMatchObject({ offeringSlug: "fresh-product", vendor: "Acme", variant: { base_price_minor: 129900 } });
    expect(plan.rows[3]!.errors).toEqual(["new product needs a vendor"]);
    expect(plan.counts).toEqual({ total: 5, insert: 2, update: 0, noop: 1, error: 2 });
  });

  it("updates a known SKU by its edition id, and refuses a SKU that repeats", () => {
    const plan = planSkuImport(csvToObjects("sku,list_price_usd\nTB-1,120\nX,1\nX,2"), catalogue);
    expect(plan.rows[0]).toMatchObject({ action: "update", mapped: { variantId: "v1", offeringId: "o1", changes: { base_price_minor: { from: 10000, to: 12000 } } } });
    expect(plan.rows.slice(1).map((row) => row.errors)).toEqual([["sku repeats in the file"], ["sku repeats in the file"]]);
  });
});
