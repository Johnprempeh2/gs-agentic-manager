// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebsiteEntry, WebsitePage, WebsiteReviewQueue as Queue } from "@greatstone/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const moduleApiMock = vi.hoisted(() => ({ review: vi.fn(), approveReview: vi.fn(), access: vi.fn() }));
const confirm = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true));

vi.mock("../../api/website", async () => {
  const actual = await vi.importActual<typeof import("../../api/website")>("../../api/website");
  return { ...actual, websiteModuleApi: moduleApiMock };
});
vi.mock("../../context/ConfirmContext", () => ({ useConfirm: () => confirm }));

import { WebsiteReviewQueue, reviewCountText, versionLabel } from "./WebsiteReviewQueue";

const page = (id: string, title: string, slug: string, extra: Partial<WebsitePage> = {}) =>
  ({ id, title, slug, status: "review", latestRevisionId: `${id}-r2`, latestRevisionNumber: 2, approvedRevisionId: null, updatedAt: "2026-11-08T10:00:00Z", ...extra }) as WebsitePage;
const entry = (id: string, entryKey: string) => ({ id, entryKey, collection: "product", status: "review" }) as WebsiteEntry;
const queue: Queue = {
  pages: [page("p1", "Home", "/"), page("p2", "About", "/about")],
  entries: [entry("e1", "aspose-pdf-net")],
};

let container: HTMLDivElement;
let root: Root;

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}><WebsiteReviewQueue companyId="co-1" siteId="site-1" /></QueryClientProvider>);
  });
  await flush();
}

function button() {
  return container.querySelector<HTMLButtonElement>('[data-testid="website-review-approve"]');
}

async function click(element: Element | null) {
  await act(async () => { (element as HTMLElement).click(); });
  await flush();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  confirm.mockResolvedValue(true);
  moduleApiMock.review.mockResolvedValue(queue);
  moduleApiMock.access.mockResolvedValue({ view: true, edit: true, publish: true });
  moduleApiMock.approveReview.mockResolvedValue({ approvedPageIds: ["p1", "p2"], approvedEntryIds: ["e1"], skipped: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("WebsiteReviewQueue", () => {
  it("says what it counts", () => {
    expect(reviewCountText(20, 79)).toBe("20 pages and 79 entries");
    expect(reviewCountText(1, 0)).toBe("1 page");
    expect(reviewCountText(0, 1)).toBe("1 entry");
  });

  it("approves every item in review after one confirm that shows the count", async () => {
    await render();
    expect(container.textContent).toContain("2 pages and 1 entry waiting for approval.");
    expect(button()?.textContent).toContain("Approve all in review");

    await click(button());
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: "Approve all 3 items in review?",
      description: expect.stringContaining("2 pages and 1 entry become approved"),
      confirmLabel: "Approve 3",
    }));
    expect(moduleApiMock.approveReview).toHaveBeenCalledWith("co-1", "site-1", {});
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Approved 2 pages and 1 entry. Publish puts them on staging, and Deploy puts them live.");
  });

  it("approves only the ticked items", async () => {
    moduleApiMock.approveReview.mockResolvedValue({ approvedPageIds: ["p2"], approvedEntryIds: ["e1"], skipped: [] });
    await render();
    await click(container.querySelector('[aria-label="Select About"]'));
    await click(container.querySelector('[aria-label="Select aspose-pdf-net"]'));
    expect(button()?.textContent).toContain("Approve 2 selected");

    await click(button());
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Approve 2 selected items?", confirmLabel: "Approve 2" }));
    expect(moduleApiMock.approveReview).toHaveBeenCalledWith("co-1", "site-1", { pageIds: ["p2"], entryIds: ["e1"] });
  });

  it("does nothing when the confirm is declined", async () => {
    confirm.mockResolvedValueOnce(false);
    await render();
    await click(button());
    expect(moduleApiMock.approveReview).not.toHaveBeenCalled();
  });

  it("shows the items not approved and why", async () => {
    moduleApiMock.approveReview.mockResolvedValue({
      approvedPageIds: ["p1", "p2"],
      approvedEntryIds: [],
      skipped: [{ kind: "entry", id: "e1", title: "product/aspose-pdf-net", reason: "The entry fields are incomplete" }],
    });
    await render();
    await click(button());
    const status = container.querySelector('[role="status"]')?.textContent ?? "";
    expect(status).toContain("Approved 2 pages. Publish puts them on staging, and Deploy puts them live. 1 item was not approved.");
    // The item reads as it does in the list above, not as collection/key.
    expect(status).toContain("not approved.aspose-pdf-net: The entry fields are incomplete");
  });

  it("reads an entry by its name, kind and price, with the code small: never the id it is keyed by", async () => {
    const id = "0221935f-296a-499f-bad7-a9f155452ed0";
    const summary = { name: "Aspose.PDF for .NET", slug: "aspose-pdf-for-net", short_description: null, description: null, from_price_minor: 119900, from_price_currency: "USD", vendor: "Aspose", category: "PDF", variants: [] };
    moduleApiMock.review.mockResolvedValue({ pages: [page("p1", "Home", "/")], entries: [{ ...entry("e1", id), summary }, { ...entry("e2", "public-person-1"), collection: "public-person" }] });
    moduleApiMock.approveReview.mockResolvedValue({ approvedPageIds: ["p1"], approvedEntryIds: [], skipped: [{ kind: "entry", id: "e1", title: `product/${id}`, reason: "The entry fields are incomplete" }] });
    await render();
    const rows = [...container.querySelectorAll("li")].map((row) => row.textContent ?? "");
    const product = rows.find((row) => row.includes("Aspose.PDF for .NET"))!;
    expect(product).toContain("Aspose · PDF · From US$1,199.00 · aspose-pdf-for-net");
    expect(product).toContain("Product");
    expect(container.textContent).not.toContain(id);
    expect(container.querySelector('[aria-label="Select Aspose.PDF for .NET"]')).not.toBeNull();
    // An entry whose content names nothing still reads by its key.
    expect(rows.some((row) => row.includes("public-person-1") && row.includes("Team member"))).toBe(true);

    await click(button());
    const status = container.querySelector('[role="status"]')?.textContent ?? "";
    expect(status).toContain("Aspose.PDF for .NET: The entry fields are incomplete");
    expect(status).not.toContain(id);
  });

  it("without Publish rights: the list shows, with no button and no checkboxes", async () => {
    moduleApiMock.access.mockResolvedValue({ view: true, edit: true, publish: false });
    await render();
    expect(container.textContent).toContain("A person with Publish rights on this site approves them.");
    expect(button()).toBeNull();
    expect(container.querySelector('[role="checkbox"]')).toBeNull();
  });

  it("shows nothing when nothing is in review", async () => {
    moduleApiMock.review.mockResolvedValue({ pages: [], entries: [] });
    await render();
    expect(container.querySelector('[data-testid="website-review-queue"]')).toBeNull();
  });

  it("lists the newest change first and labels the version Approve takes", async () => {
    moduleApiMock.review.mockResolvedValue({
      pages: [page("p1", "About", "/about"), page("p2", "Two Doors", "/", { latestRevisionId: "r20", latestRevisionNumber: 20, approvedRevisionId: "r19", updatedAt: "2026-11-08T17:00:00Z" })],
      entries: [],
    });
    await render();
    expect(container.querySelector("li")?.textContent).toContain("Two Doors");
    const labels = [...container.querySelectorAll('[data-testid="website-review-version"]')].map((node) => node.textContent);
    expect(labels).toEqual(["Version 20, newest draft (replaces the approved version)", "Version 2, newest draft"]);
    expect(versionLabel({ latestRevisionId: "a", latestRevisionNumber: 3, approvedRevisionId: "a", updatedAt: "" })).toBe("Version 3, newest draft");
  });
});
