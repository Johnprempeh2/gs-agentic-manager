// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebsiteEntry, WebsiteEntrySummary, WebsiteProperty } from "@greatstone/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const moduleApiMock = vi.hoisted(() => ({ entries: vi.fn(), entry: vi.fn(), entryRevisions: vi.fn() }));

vi.mock("../../api/website", async () => {
  const actual = await vi.importActual<typeof import("../../api/website")>("../../api/website");
  return { ...actual, websiteModuleApi: moduleApiMock };
});
vi.mock("./WebsiteSiteConnection", () => ({ useWebsiteSite: () => ({ site: { id: "site-1" }, isLoading: false, error: null }) }));
vi.mock("./WebsiteSetup", () => ({ useCanManageWebsite: () => ({ canManage: true }) }));
vi.mock("./WebsiteRedirects", () => ({ WebsiteRedirects: () => null }));
vi.mock("./WebsiteMediaLibrary", () => ({ WebsiteMediaLibrary: () => null }));

import { WebsiteCollectionsTab } from "./WebsiteCollections";

// The import keys a product by its id, so the key says nothing to a person.
const WORDS = "0f0f0f0f-0000-4000-8000-000000000001";
const PDF = "0f0f0f0f-0000-4000-8000-000000000002";
const summary = (fields: Partial<WebsiteEntrySummary>): WebsiteEntrySummary =>
  ({ name: null, slug: null, short_description: null, description: null, from_price_minor: null, from_price_currency: null, vendor: null, category: null, variants: [], ...fields });
const entry = (id: string, entryKey: string, fields: Partial<WebsiteEntrySummary> | null) =>
  ({ id, entryKey, collection: "product", status: "draft", latestRevisionNumber: 1, updatedAt: "2026-11-08T10:00:00Z", summary: fields ? summary(fields) : null }) as WebsiteEntry;
const entries = [
  entry("e1", WORDS, { name: "Aspose.Words for .NET", slug: "aspose-words-for-net", short_description: "Create, edit and convert Word documents in .NET.", from_price_minor: 119900, from_price_currency: "USD", vendor: "Aspose", category: "Word processing", variants: [{ sku: "ASPOSE-1-2", name: "Developer Small Business" }] }),
  entry("e2", PDF, { name: "Aspose.PDF for Java", slug: "aspose-pdf-for-java", vendor: "Aspose", category: "PDF" }),
  entry("e3", "hand-made-key", null),
];

let container: HTMLDivElement;
let root: Root;

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}><WebsiteCollectionsTab companyId="co-1" property={{ id: "prop-1" } as WebsiteProperty} /></QueryClientProvider>);
  });
  await flush();
}

async function search(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const rows = () => [...container.querySelectorAll("li")].map((row) => row.textContent ?? "");

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  moduleApiMock.entries.mockResolvedValue(entries);
  moduleApiMock.entryRevisions.mockResolvedValue([]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("WebsiteCollectionsTab", () => {
  it("lists a product by name, one line, vendor, category and price, with the code as small print", async () => {
    await render();
    const [words, pdf, bare] = rows();
    expect(words).toContain("Aspose.Words for .NET");
    expect(words).toContain("Create, edit and convert Word documents in .NET.");
    expect(words).toContain("Aspose · Word processing · From US$1,199.00 · Version 1");
    expect(words).toContain("aspose-words-for-net");
    expect(pdf).toContain("Aspose · PDF · No price set");
    // The id the entry is keyed by is never shown when a name exists.
    expect(container.textContent).not.toContain(WORDS);
    expect(container.textContent).not.toContain(PDF);
    // An entry whose content names nothing reads by its key, as before.
    expect(bare).toContain("hand-made-key");
    expect(container.querySelector('[aria-label="Edit Aspose.PDF for Java"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("3 products");
  });

  it("searches by name, category, edition SKU and code, and says when nothing matches", async () => {
    await render();
    for (const [value, found] of [["java", "Aspose.PDF for Java"], ["word processing", "Aspose.Words for .NET"], ["aspose-1-2", "Aspose.Words for .NET"], ["hand-made", "hand-made-key"], [PDF, "Aspose.PDF for Java"]]) {
      await search(value);
      expect(rows(), value).toHaveLength(1);
      expect(rows()[0], value).toContain(found);
    }
    expect(container.querySelector('[role="status"]')?.textContent).toBe("1 of 3 products");
    await search("no such thing");
    expect(rows()).toHaveLength(0);
    expect(container.textContent).toContain('Nothing matches "no such thing". Try part of the name, the category or the code.');
  });

  it("opens an entry under its name, not its key, and drops the fields version", async () => {
    moduleApiMock.entry.mockResolvedValue({ ...entries[0], latestRevisionId: "r1", content: { data: { name: "Aspose.Words for .NET" } } });
    await render();
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Edit Aspose.Words for .NET"]')!.click(); });
    await flush();
    const editor = container.querySelector('[data-testid="website-entry-editor"]')!;
    expect(editor.querySelector("h3")?.textContent).toBe("Aspose.Words for .NET");
    expect(editor.textContent).toContain("Draft. Approved changes go to staging when you Publish, and live when you Deploy.");
    expect(editor.textContent).not.toContain("Fields version");
  });
});
