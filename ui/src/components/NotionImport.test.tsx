// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotionImport, describeNotionResult, pagesFromFiles } from "./NotionImport";

const mocks = vi.hoisted(() => ({ preview: vi.fn(), run: vi.fn(), access: vi.fn() }));

vi.mock("@/api/organisations", () => ({
  organisationsApi: { previewNotionImport: mocks.preview, importFromNotion: mocks.run },
}));
vi.mock("@/api/access", () => ({ accessApi: { getCurrentBoardAccess: mocks.access } }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const PREVIEW = {
  clients: [
    { path: "Kente.md", name: "Kente Logistics", status: "client", action: "create", organisationId: null, notesChars: 40, tasks: ["Send proposal", "Ask for data"] },
    { path: "Osei.md", name: "Osei Farms", status: "client", action: "update", organisationId: "o1", notesChars: 0, tasks: [] },
  ],
  skipped: [{ path: "Clients.md", reason: "Only links to other pages" }],
};

describe("NotionImport", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.access.mockResolvedValue({ source: "local_implicit", isInstanceAdmin: false, memberships: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function flush() {
    for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }

  const button = (label: string) =>
    [...document.body.querySelectorAll("button")].find((element) => element.textContent?.trim() === label) as HTMLButtonElement;

  it("previews the clients, lets you untick one, then imports", async () => {
    mocks.preview.mockResolvedValue(PREVIEW);
    mocks.run.mockResolvedValue({ ...PREVIEW, organisations: { created: 1, updated: 0 }, tasksCreated: 2 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <NotionImport companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flush();
    await act(async () => { button("Import from Notion").click(); });
    await flush();

    const input = document.body.querySelector("#notion-import-file") as HTMLInputElement;
    const file = new File(["# Kente Logistics\n\n- [ ] Send proposal"], "Kente.md", { type: "text/markdown" });
    Object.defineProperty(input, "files", { value: [file] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();

    expect(mocks.preview).toHaveBeenCalledWith("company-1", {
      pages: [{ path: "Kente.md", markdown: "# Kente Logistics\n\n- [ ] Send proposal" }],
      createTasks: true,
    });
    expect(document.body.textContent).toContain("Found 2 clients, skipped 1 page.");
    expect(document.body.textContent).toContain("New client, 2 tasks");
    expect(document.body.textContent).toContain("Already here: notes already imported");

    await act(async () => { (document.body.querySelector("[aria-label='Import Osei Farms']") as HTMLButtonElement).click(); });
    await act(async () => { button("Import 1 client").click(); });
    await flush();
    expect(mocks.run).toHaveBeenCalledWith("company-1", expect.objectContaining({ include: ["Kente.md"], createTasks: true }));
    expect(document.body.textContent).toContain("Done: 1 client added, 2 tasks made from to-dos.");
  });

  it("keeps only Markdown pages from plain files", async () => {
    const pages = await pagesFromFiles([new File(["a"], "notes.md"), new File(["b"], "photo.png")]);
    expect(pages).toEqual([{ path: "notes.md", markdown: "a" }]);
  });

  it("words a rerun that changed nothing", () => {
    expect(describeNotionResult({ clients: [], skipped: [], organisations: { created: 0, updated: 0 }, tasksCreated: 0 })).toBe(
      "Done. Everything was already imported.",
    );
  });
});
