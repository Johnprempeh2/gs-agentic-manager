import { describe, expect, it } from "vitest";
import { catalogueCode, catalogueMatches, catalogueMeta, catalogueOneLine, offeringGaps, offeringPrice, offeringWebsiteUrl } from "./commerce-catalogue";

// What a catalogue row says about itself. Rows are shaped as the website sends them (snake_case).
const product = {
  id: "0f0f0f0f-0000-4000-8000-000000000001", slug: "aspose-words-for-net", name: "Aspose.Words for .NET", status: "published",
  short_description: "Create, edit and convert Word documents in .NET.", description: "A long description. With more.",
  from_price_minor: 119900, from_price_currency: "USD", category_id: "cat-1", vendor_id: "ven-1", platforms: [".NET"],
  variants: [{ sku: "ASPOSE-1-2", name: "Developer Small Business" }, { sku: null, name: "Site OEM" }],
};

describe("catalogueOneLine", () => {
  it("is the short description when it says something", () => {
    expect(catalogueOneLine(product)).toBe("Create, edit and convert Word documents in .NET.");
  });

  it("falls back to the first sentence of the long description when the short one only repeats the name", () => {
    expect(catalogueOneLine({ ...product, short_description: "aspose.words for .net" })).toBe("A long description.");
    expect(catalogueOneLine({ ...product, short_description: null, description: "Version 2.5 has no full stop after it" })).toBe("Version 2.5 has no full stop after it");
  });

  it("is null when the site holds no description: nothing is made up", () => {
    expect(catalogueOneLine({ ...product, short_description: product.name, description: "" })).toBeNull();
  });
});

describe("offering price and gaps", () => {
  it("shows the from price in the product's currency, or nothing", () => {
    expect(offeringPrice(product)).toBe("From US$1,199.00");
    expect(offeringPrice({ ...product, from_price_minor: null })).toBeNull();
  });

  it("names each gap a person has to fill", () => {
    expect(offeringGaps(product)).toEqual([]);
    expect(offeringGaps({ ...product, from_price_minor: null, short_description: product.name, category_id: null }))
      .toEqual(["No price set", "No short description", "No category"]);
  });
});

describe("catalogueMatches", () => {
  it("finds a product by name, code, edition SKU, platform, and the vendor and category names passed in", () => {
    for (const search of ["words", "ASPOSE-WORDS", "aspose-1-2", ".net", "site oem", "aspose pty", "file formats", "words formats"]) {
      expect(catalogueMatches(product, search, ["Aspose Pty", "File formats"]), search).toBe(true);
    }
  });

  it("needs every word to match, and matches everything when the search is empty", () => {
    expect(catalogueMatches(product, "words java", ["Aspose Pty"])).toBe(false);
    expect(catalogueMatches(product, "   ")).toBe(true);
  });
});

describe("code, small print and the website link", () => {
  it("keeps the code out of the small print", () => {
    expect(catalogueCode(product)).toBe("aspose-words-for-net");
    expect(catalogueMeta("offerings", product, { vendor: "Aspose Pty" })).toBe("Aspose Pty · 2 editions");
    expect(catalogueMeta("offerings", { ...product, variants: [{}] })).toBe("1 edition");
  });

  it("links only a published product, on the site's own address", () => {
    expect(offeringWebsiteUrl(product, "greatstone.example")).toBe("https://greatstone.example/product/aspose-words-for-net");
    expect(offeringWebsiteUrl({ ...product, status: "draft" }, "greatstone.example")).toBeNull();
    expect(offeringWebsiteUrl(product, null)).toBeNull();
  });
});
