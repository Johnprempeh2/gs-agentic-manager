// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { kestrelGraph } from "../../fixtures/memoryKestrel";
import { IssueMemoryRow } from "./IssueMemoryRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const memoryApiMock = vi.hoisted(() => ({ graph: vi.fn() }));

vi.mock("../../api/memoryGraph", () => ({ memoryGraphApi: memoryApiMock }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

let container: HTMLDivElement;
let root: Root;

async function renderRow() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IssueMemoryRow companyId="co-kestrel" issueId="11111111-2222-4333-8444-555555555555" issueKey="KW-646" />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("IssueMemoryRow (GRE-929)", () => {
  it("links to the memory view filtered by the task key when the caller may read records", async () => {
    memoryApiMock.graph.mockResolvedValue(kestrelGraph);
    await renderRow();

    expect(memoryApiMock.graph).toHaveBeenCalledWith("co-kestrel", { q: "11111111-2222-4333-8444-555555555555", limit: 20 });
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/memory?q=KW-646");
    expect(link?.textContent).toBe(`Memories from this task(${kestrelGraph.nodes.length})`);
  });

  it.each([
    ["no read access", new ApiError("Forbidden", 403, null)],
    ["memory off", new ApiError("Memory is not enabled for this company", 404, null)],
  ])("shows nothing with %s", async (_label, error) => {
    memoryApiMock.graph.mockRejectedValue(error);
    await renderRow();
    expect(container.innerHTML).toBe("");
  });

  it("shows nothing when no readable record came from the task", async () => {
    memoryApiMock.graph.mockResolvedValue({ ...kestrelGraph, nodes: [], edges: [] });
    await renderRow();
    expect(container.innerHTML).toBe("");
  });
});
