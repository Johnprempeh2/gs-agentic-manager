// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The catalogue reads as what things are: name, a line of description, category, price, and the code small.

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), write: vi.fn(), access: vi.fn() }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/api/website-commerce", () => ({ websiteCommerceApi: mocks }));
vi.mock("@/api/access", () => ({ accessApi: { getCurrentBoardAccess: mocks.access } }));

import { CatalogueList, CatalogueRecord } from "./CommerceCatalogue";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const vendors = [{ id: "ven-1", name: "Aspose Pty", slug: "aspose" }];
const categories = [{ id: "cat-1", name: "File formats", slug: "file-formats" }];
const words = {
  id: "off-1", slug: "aspose-words-for-net", name: "Aspose.Words for .NET", status: "published", vendor_id: "ven-1", category_id: "cat-1",
  short_description: "Create, edit and convert Word documents.", from_price_minor: 119900, from_price_currency: "USD",
  variants: [{ id: "var-1", sku: "ASPOSE-1-2", name: "Developer Small Business", base_price_minor: 119900, currency: "USD" }], specs: [], media: [], row_version: 1,
};
// no price, no category, and a short description that only repeats the name
const bare = {
  id: "off-2", slug: "apryse-web-sdk", name: "Apryse Web SDK", status: "draft", vendor_id: "ven-1", category_id: null,
  short_description: "Apryse Web SDK", description: "View and edit PDFs in the browser. More follows.", from_price_minor: null, variants: [], specs: [], media: [], row_version: 1,
};
const pages: Record<string, Record<string, unknown>[]> = { vendors, categories, offerings: [words, bare] };

async function flush() {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the catalogue shows what products are", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.list.mockImplementation((_c: string, _s: string, resource: string) => Promise.resolve({ items: pages[resource] ?? [], nextCursor: null }));
    mocks.get.mockResolvedValue({ item: words });
    mocks.access.mockResolvedValue({ source: "session", userId: "user-1" });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.resetAllMocks();
  });

  function render(path: string, element: React.ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes><Route path="*" element={element} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ));
  }
  const list = (path = "/commerce/offerings") => render(path, <CatalogueList companyId="company-1" siteId="site-1" resource="offerings" />);
  const rowsShown = () => [...container.querySelectorAll("li a")].map((link) => link.textContent ?? "");
  const count = () => container.querySelector("[data-testid=commerce-catalogue-count]")?.textContent;
  const searchBox = () => container.querySelector<HTMLInputElement>("input[type=search]")!;

  it("shows the name, a line of description, the vendor, the price, and the code small, under its category", async () => {
    list();
    await flush();
    const row = [...container.querySelectorAll("li a")].find((link) => link.textContent?.includes("Aspose.Words"))!;
    expect(row.querySelector(".font-medium")?.textContent).toBe("Aspose.Words for .NET");
    expect(row.textContent).toContain("Create, edit and convert Word documents.");
    expect(row.textContent).toContain("Aspose Pty · 1 edition");
    expect(row.textContent).toContain("From US$1,199.00");
    expect(row.querySelector(".font-mono")?.textContent).toBe("aspose-words-for-net");
    expect([...container.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual(["No category1", "File formats1"]);
    expect(count()).toBe("2 offerings");
  });

  it("says No price set, and uses the first sentence of the long description when the short one repeats the name", async () => {
    list();
    await flush();
    const row = rowsShown().find((text) => text.includes("Apryse Web SDK"))!;
    expect(row).toContain("No price set");
    expect(row).toContain("View and edit PDFs in the browser.");
    expect(row).not.toContain("More follows");
  });

  it("searches by name, by category, by vendor and by an edition's code", async () => {
    list();
    await flush();
    for (const [search, expected] of [["apryse", "Apryse Web SDK"], ["file formats", "Aspose.Words"], ["ASPOSE-1-2", "Aspose.Words"], ["aspose-words-for", "Aspose.Words"]]) {
      type(searchBox(), search);
      expect(rowsShown(), search).toHaveLength(1);
      expect(rowsShown()[0], search).toContain(expected);
      expect(count()).toBe("1 of 2 offerings");
    }
    type(searchBox(), "aspose pty");
    expect(rowsShown()).toHaveLength(2);
    type(searchBox(), "nothing like this");
    expect(rowsShown()).toHaveLength(0);
    expect(container.textContent).toContain("No offerings match.");
    act(() => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Clear search and filters")!.click(); });
    expect(rowsShown()).toHaveLength(2);
  });

  it("narrows to one category, and to the products that need attention, naming what each is missing", async () => {
    list("/commerce/offerings?category=cat-1");
    await flush();
    expect(rowsShown()).toHaveLength(1);
    expect(rowsShown()[0]).toContain("Aspose.Words");
    const attention = [...container.querySelectorAll("button")].find((button) => button.textContent === "Needs attention (1)")!;
    expect(attention.getAttribute("aria-pressed")).toBe("false");
    act(() => { root.unmount(); });
    root = createRoot(container);
    list("/commerce/offerings?attention=1");
    await flush();
    expect(rowsShown()).toHaveLength(1);
    expect(rowsShown()[0]).toContain("No price set · No short description · No category");
  });

  it("reads past the first 100 rows, following the site's cursor", async () => {
    const many = Array.from({ length: 100 }, (_, index) => ({ ...words, id: `off-a-${index}`, name: `Product ${index}`, slug: `product-${index}` }));
    mocks.list.mockImplementation((_c: string, _s: string, resource: string, options: { cursor?: string } = {}) => Promise.resolve(
      resource !== "offerings" ? { items: pages[resource] ?? [], nextCursor: null }
        : options.cursor === "page-2" ? { items: [bare], nextCursor: null } : { items: many, nextCursor: "page-2" }));
    list();
    await flush();
    expect(count()).toBe("101 offerings");
    expect(rowsShown().some((text) => text.includes("Apryse Web SDK"))).toBe(true);
  });

  it("heads a product with its description, vendor, category, price and code, and links a published one to its page", async () => {
    render("/commerce/offerings/off-1", <CatalogueRecord companyId="company-1" siteId="site-1" resource="offerings" recordId="off-1" domain="greatstone.example" />);
    await flush();
    expect(container.querySelector("[data-testid=commerce-catalogue-summary]")?.textContent)
      .toBe("Aspose Pty · File formats · From US$1,199.00 · aspose-words-for-net");
    expect(container.querySelector("a[target=_blank]")?.getAttribute("href")).toBe("https://greatstone.example/product/aspose-words-for-net");
    // an edition reads as its name and price; its SKU is the small code
    const edition = container.querySelector("[data-testid=commerce-child-variants]")!;
    expect(edition.querySelector(".font-medium")?.textContent).toBe("Developer Small Business");
    expect(edition.querySelector(".font-mono")?.textContent).toBe("ASPOSE-1-2");
  });

  it("has no website link for a draft, and never shows an id for a vendor that is gone", async () => {
    mocks.get.mockResolvedValue({ item: { ...bare, vendor_id: "0a0a0a0a-0000-4000-8000-00000000dead" } });
    render("/commerce/offerings/off-2", <CatalogueRecord companyId="company-1" siteId="site-1" resource="offerings" recordId="off-2" domain="greatstone.example" />);
    await flush();
    expect(container.querySelector("a[target=_blank]")).toBeNull();
    const summary = container.querySelector("[data-testid=commerce-catalogue-summary]")!.textContent!;
    expect(summary).toBe("(no longer in the catalogue) · No category · No price set · apryse-web-sdk");
    expect(container.textContent).not.toContain("0a0a0a0a");
  });
});
