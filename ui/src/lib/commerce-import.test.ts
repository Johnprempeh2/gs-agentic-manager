import { describe, expect, it } from "vitest";
import { sheetToCsv } from "./spreadsheet-export";
import { SKU_COLUMNS, catalogueSkuRows, csvToObjects, importCatalogueOf, planSkuImport } from "./commerce-import";

describe("catalogue SKU export", () => {
  const offerings = [
    { id: "o1", slug: "aspose-total", name: "Aspose.Total, \"all\"", vendor_id: "v1", category_id: "c1", status: "published", featured: true,
      variants: [
        { id: "x1", offering_id: "o1", sku: "AT-1", name: "Developer", license_type: "OEM", billing_period: "annual", base_price_minor: "290000", currency: "USD" },
        { id: "x2", offering_id: "o1", sku: "AT-2", name: "Site", license_type: null, billing_period: "perpetual", base_price_minor: "5000", currency: "GBP" },
        { id: "x3", offering_id: "o1", sku: null, name: "No sku", base_price_minor: null, currency: null },
      ] },
  ];
  const names = { vendors: new Map([["v1", "Aspose"]]), categories: new Map([["c1", "Documents"]]) };

  it("writes the import columns, USD prices only, and counts editions with no SKU", () => {
    const sheet = catalogueSkuRows(offerings, names);
    expect(sheet.headers).toEqual([...SKU_COLUMNS]);
    expect(sheet.withoutSku).toBe(1);
    expect(sheet.rows[0]).toEqual(["AT-1", "aspose-total", "Aspose.Total, \"all\"", "Aspose", "Documents", "Developer", "OEM", "annual", "2900.00", "published", "true"]);
    expect(sheet.rows[1]![8]).toBe(""); // a GBP price is never written as dollars
  });

  it("round-trips: the exported file plans as all unchanged", () => {
    const sheet = catalogueSkuRows(offerings, names);
    const csv = sheetToCsv({ name: "SKUs", headers: sheet.headers, rows: sheet.rows });
    const plan = planSkuImport(csvToObjects(csv), importCatalogueOf(offerings));
    expect(plan.counts).toEqual({ total: 2, insert: 0, update: 0, noop: 2, error: 0 });
  });
});
