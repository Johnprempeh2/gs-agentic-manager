// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MorningSummary as Summary } from "@greatstone/shared";
import { MorningSummary, greeting } from "./MorningSummary";

const server = vi.hoisted(() => ({ summary: null as Summary | null }));

vi.mock("../api/notificationPreferences", () => ({ morningSummaryApi: { get: async () => server.summary } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: null }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <MorningSummary />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("MorningSummary", () => {
  it("shows what needs you, what finished and what is stuck, with links to each task", async () => {
    server.summary = {
      companyId: "company-1",
      generatedAt: "",
      since: "",
      needsYou: { count: 5, items: [{ id: "a", identifier: "GRE-1", title: "Approve the brief" }] },
      finished: { count: 1, items: [{ id: "b", identifier: "GRE-5", title: "Write the one-pager" }] },
      stuck: { count: 0, items: [] },
    };
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("Approve the brief");
    expect(text).toContain("See all 5");
    expect(text).toContain("Write the one-pager");
    expect(text).toContain("Nothing is stuck.");
    expect(container.querySelector('a[href="/issues/GRE-1"]')).not.toBeNull();
  });

  it("greets by the time of day", () => {
    expect(greeting(new Date(2026, 9, 16, 8))).toBe("Good morning");
    expect(greeting(new Date(2026, 9, 16, 14))).toBe("Good afternoon");
    expect(greeting(new Date(2026, 9, 16, 20))).toBe("Good evening");
  });
});
