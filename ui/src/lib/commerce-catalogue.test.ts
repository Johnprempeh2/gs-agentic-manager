import { describe, expect, it } from "vitest";
import { websiteEntrySummary } from "@greatstone/shared";
import { catalogueCode, catalogueMatches, catalogueMeta, catalogueOneLine, entryMatches, entryReading, offeringGaps, offeringPrice, offeringWebsiteUrl } from "./commerce-catalogue";

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

describe("a Website entry reads by what it is", () => {
  // As the import stores it: the product's id is the entry key, its fields sit under `data`.
  const key = "0f0f0f0f-0000-4000-8000-000000000001";
  const summary = websiteEntrySummary({ data: { ...product, vendor: { name: "Aspose Pty" }, category: { name: "File formats" } } });
  const entry = { entryKey: key, collection: "product", summary };

  it("leads with the name, then one line, vendor, category and price, with the slug as the code", () => {
    expect(entryReading(entry)).toEqual({
      title: "Aspose.Words for .NET",
      line: "Create, edit and convert Word documents in .NET.",
      meta: "Aspose Pty · File formats · From US$1,199.00",
      code: "aspose-words-for-net",
      kind: "Product",
    });
  });

  it("says a product has no price, and shows no price line for other kinds", () => {
    expect(entryReading({ ...entry, summary: { ...summary!, from_price_minor: null } }).meta).toBe("Aspose Pty · File formats · No price set");
    expect(entryReading({ entryKey: "public-person-1", collection: "public-person", summary: websiteEntrySummary({ name: "A Person", role: "Director" }) }))
      .toEqual({ title: "A Person", line: "Director", meta: "", code: "public-person-1", kind: "Team member" });
  });

  it("falls back to the entry key when the content names nothing: nothing is made up", () => {
    expect(websiteEntrySummary({ data: { slug: "no-name" } })).toBeNull();
    expect(entryReading({ entryKey: key, collection: "product", summary: null })).toEqual({ title: key, line: null, meta: "", code: null, kind: "Product" });
    expect(entryReading({ entryKey: "old", collection: "legacy" }).kind).toBe("Entry");
  });

  it("is found by name, vendor, category, slug, edition SKU and the entry key", () => {
    for (const search of ["words", "aspose pty", "file formats", "aspose-words-for-net", "aspose-1-2", key.slice(0, 8)]) {
      expect(entryMatches(entry, search), search).toBe(true);
    }
    expect(entryMatches(entry, "java")).toBe(false);
    expect(entryMatches({ entryKey: "plain-key", summary: null }, "plain")).toBe(true);
  });

  it("keeps the list light: a long description is cut and the rest of the content is left out", () => {
    const long = websiteEntrySummary({ data: { name: "Long", description: "x".repeat(900), specs: [{ a: 1 }], seo: { title: "t" } } })!;
    expect(long.description).toHaveLength(300);
    expect(Object.keys(long).sort()).toEqual(["category", "description", "from_price_currency", "from_price_minor", "name", "short_description", "slug", "variants", "vendor"]);
  });
});
