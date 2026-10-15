// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryApps } from "./MemoryApps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const graphApiMock = vi.hoisted(() => ({ scopes: vi.fn(), importEntries: vi.fn() }));

vi.mock("../api/memoryGraph", () => ({ memoryGraphApi: graphApiMock }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "co-kestrel" }) }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    useNavigate: actual.useNavigate,
    Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  };
});

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/memory/apps"]}>
          <Routes>
            <Route path="/memory/apps" element={<MemoryApps />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

const body = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find((element) => element.textContent?.trim() === label) as HTMLButtonElement;

function typeInto(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const scopes = [
  { id: "scope-agent", companyId: "co-kestrel", kind: "agent", name: "Mason notes", projectId: null, agentId: "a1", createdAt: "" },
  { id: "scope-org", companyId: "co-kestrel", kind: "organization", name: "Greatstone", projectId: null, agentId: null, createdAt: "" },
];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  graphApiMock.scopes.mockResolvedValue(scopes);
  graphApiMock.importEntries.mockResolvedValue({ added: 2, alreadyImported: 0, heldBack: 0, entries: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("MemoryApps", () => {
  it("turns a pasted answer into entries and adds the ticked ones to the organisation scope", async () => {
    await render();
    expect(body()).toContain("Bring what Claude and ChatGPT know into shared memory");
    // Agent working notes are not offered as a place to import into.
    expect([...document.querySelectorAll("option")].map((option) => option.textContent)).toEqual(["Greatstone"]);

    typeInto(document.querySelector("textarea")!, "- Runs Greatstone International\n- Prefers British English\n");
    await flush();
    expect(body()).toContain("2 of 2 ticked");

    await act(async () => button("Add 2 to memory").click());
    await flush();
    expect(graphApiMock.importEntries).toHaveBeenCalledWith(
      "co-kestrel",
      expect.objectContaining({
        scopeId: "scope-org",
        app: "chatgpt",
        via: "paste",
        entries: [
          expect.objectContaining({ content: "Runs Greatstone International" }),
          expect.objectContaining({ content: "Prefers British English" }),
        ],
      }),
    );
    expect(body()).toContain("2 added");
    expect(body()).toContain("Review");
  });
});
