import { describe, expect, it } from "vitest";
import type { WebsiteFeature } from "@greatstone/shared";
import {
  GREATSTONE_COMPANY_ID,
  commerceFeatureOf,
  formatMinor,
  maskedLicenceKey,
  newestFirst,
  organisationFor,
  recordTitle,
  recordTotal,
  websiteCustomerFor,
} from "./commerce";

const feature = (key: string, enabled = true) => ({ id: `f-${key}`, key, enabled } as WebsiteFeature);

describe("commerceFeatureOf", () => {
  it("is the Shop feature of Greatstone's site while it is on", () => {
    expect(commerceFeatureOf(GREATSTONE_COMPANY_ID, [feature("public-site"), feature("shop")])?.id).toBe("f-shop");
  });

  it("is null for any other company, even one with a feature called shop", () => {
    expect(commerceFeatureOf("00000000-0000-4000-8000-000000000001", [feature("shop")])).toBeNull();
  });

  it("is null while the Shop feature is off or missing", () => {
    expect(commerceFeatureOf(GREATSTONE_COMPANY_ID, [feature("shop", false)])).toBeNull();
    expect(commerceFeatureOf(GREATSTONE_COMPANY_ID, [feature("public-site")])).toBeNull();
    expect(commerceFeatureOf(GREATSTONE_COMPANY_ID, undefined)).toBeNull();
  });
});

describe("record display", () => {
  it("formats minor units in the record's currency", () => {
    expect(formatMinor(129900, "gbp")).toBe("£1,299.00");
    expect(formatMinor("4550", "USD")).toBe("US$45.50");
    expect(formatMinor(null, "GBP")).toBeNull();
  });

  it("names an invoice by its number and a quote by its reference", () => {
    expect(recordTitle("invoices", { id: "o1", invoice_number: "INV-0042", reference: "ORD-7" })).toBe("INV-0042");
    expect(recordTitle("quotes", { id: "q1", reference: "Q-2026-001" })).toBe("Q-2026-001");
    expect(recordTitle("licences", { id: "l1", offering_name: "JetBrains All Products", variant_name: "Annual" })).toBe("JetBrains All Products, Annual");
  });

  it("uses the quoted total, else the indicative one", () => {
    expect(recordTotal("quotes", { currency: "GBP", indicative_total_minor: 1000, quoted_total_minor: null })).toBe("£10.00");
    expect(recordTotal("quotes", { currency: "GBP", indicative_total_minor: 1000, quoted_total_minor: 900 })).toBe("£9.00");
  });

  it("shows only the last four characters of a licence key, as the bridge returns them", () => {
    expect(maskedLicenceKey({ licence_key_last4: "9F2A" })).toBe("•••• 9F2A");
    expect(maskedLicenceKey({ licence_key_last4: null })).toBe("Not delivered");
  });

  it("puts the newest record first", () => {
    const rows = newestFirst([{ id: "a", created_at: "2026-10-01T00:00:00Z" }, { id: "b", created_at: "2026-10-20T00:00:00Z" }]);
    expect(rows.map((row) => row.id)).toEqual(["b", "a"]);
  });
});

describe("the link between an organisation and a website customer", () => {
  const customers = [
    { id: "c1", name: "Acme Ltd", domain: "acme.co.uk" },
    { id: "c2", name: "Borealis Health", domain: null },
  ];

  it("matches on the domain first, ignoring scheme and www", () => {
    expect(websiteCustomerFor({ id: "o1", name: "ACME Group", website: "https://www.acme.co.uk/about" }, customers)?.id).toBe("c1");
    expect(websiteCustomerFor({ id: "o1", name: "Other", domain: "ACME.co.uk" }, customers)?.id).toBe("c1");
  });

  it("falls back to the same name", () => {
    expect(websiteCustomerFor({ id: "o2", name: "  borealis   health " }, customers)?.id).toBe("c2");
  });

  it("finds nothing when neither matches", () => {
    expect(websiteCustomerFor({ id: "o3", name: "Nobody", domain: "nobody.example" }, customers)).toBeNull();
  });

  it("finds the organisation for a customer", () => {
    const organisations = [{ id: "o9", name: "Unrelated" }, { id: "o1", name: "Acme", domain: "acme.co.uk" }];
    expect(organisationFor(customers[0], organisations)?.id).toBe("o1");
    expect(organisationFor(null, organisations)).toBeNull();
  });
});
