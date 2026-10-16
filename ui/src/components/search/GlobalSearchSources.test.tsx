// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command, CommandList } from "@/components/ui/command";
import { GlobalSearchSources } from "./GlobalSearchSources";

const searchMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/search", () => ({ searchApi: { search: searchMock } }));
vi.mock("../../api/routines", () => ({ routinesApi: { list: vi.fn(async () => []) } }));
vi.mock("../../api/memoryGraph", () => ({ memoryGraphApi: { graph: vi.fn(async () => ({ nodes: [] })) } }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

function emptyResponse() {
  return { results: [] };
}

describe("GlobalSearchSources", () => {
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    container?.remove();
    container = null;
    searchMock.mockReset();
  });

  it("lists matches inside uploaded files with the owner and the matching line", async () => {
    searchMock.mockImplementation(async (_companyId: string, params: { scope: string }) => {
      if (params.scope !== "files") return emptyResponse();
      return {
        results: [
          {
            id: "file:a1",
            type: "file",
            title: "nda.docx",
            href: "/PAP/pipelines/p-1/items/c-1",
            snippet: "The retainer terms stay confidential",
            snippets: [],
            file: { mediaKind: "document", owner: { kind: "client", label: "Acme Ltd", href: "" }, matchedAltText: false },
          },
          {
            id: "file:a2",
            type: "file",
            title: "logo.png",
            href: "/PAP/issues/PAP-6",
            snippet: "Blue retainer badge",
            snippets: [],
            file: { mediaKind: "image", owner: { kind: "task", label: "PAP-6 Brand review", href: "" }, matchedAltText: true },
          },
        ],
      };
    });
    const onGo = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Command>
            <CommandList>
              <GlobalSearchSources companyId="company-1" query="retainer" onGo={onGo} />
            </CommandList>
          </Command>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(searchMock).toHaveBeenCalledWith("company-1", { q: "retainer", scope: "files", limit: 5 });
    const rows = container.querySelectorAll('[data-testid="global-search-file"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Client: Acme Ltd");
    expect(rows[0]?.textContent).toContain("Line: The retainer terms stay confidential");
    expect(rows[1]?.textContent).toContain("in PAP-6 Brand review");
    expect(rows[1]?.textContent).toContain("Image: Blue retainer badge");

    await act(async () => {
      (rows[0] as HTMLElement).click();
    });
    expect(onGo).toHaveBeenCalledWith("/PAP/pipelines/p-1/items/c-1");

    act(() => root.unmount());
  });

  it("lists organisations, people and clients found on the server", async () => {
    searchMock.mockImplementation(async (_companyId: string, params: { scope: string }) => {
      if (params.scope !== "records") return emptyResponse();
      return {
        results: [
          { id: "organisation:o1", type: "record", title: "Acme Ltd", href: "/PAP/organisations/o1", snippets: [], record: { kind: "organisation", subtitle: "Finance, UK" } },
          { id: "person:p1", type: "record", title: "Ada Lovelace", href: "/PAP/organisations/o1", snippets: [], record: { kind: "person", subtitle: "CFO at Acme Ltd" } },
          { id: "client:c1", type: "record", title: "Acme renewal", href: "/PAP/pipelines/p1/items/c1", snippets: [], record: { kind: "client", subtitle: "Proposal in Sales" } },
        ],
      };
    });
    const onGo = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Command>
            <CommandList>
              <GlobalSearchSources companyId="company-1" query="acme" onGo={onGo} />
            </CommandList>
          </Command>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(searchMock).toHaveBeenCalledWith("company-1", { q: "acme", scope: "records", limit: 10 });
    expect(container.textContent).toContain("Clients, people and records");
    const people = container.querySelectorAll('[data-testid="global-search-record"]');
    expect(people[0]?.textContent).toContain("Organisation: Finance, UK");
    expect(people[1]?.textContent).toContain("Person: CFO at Acme Ltd");
    const clientRow = container.querySelector('[data-testid="global-search-client"]') as HTMLElement;
    expect(clientRow.textContent).toContain("Client: Proposal in Sales");
    await act(async () => {
      clientRow.click();
    });
    expect(onGo).toHaveBeenCalledWith("/PAP/pipelines/p1/items/c1");

    act(() => root.unmount());
  });
});
