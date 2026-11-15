// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Prototype } from "@/api/prototypes";

const setVisibility = vi.fn(async () => ({ prototype: {}, portal: { sites: 1, error: null } }));
const list = vi.fn(async () => ({ prototypes: [prototype()] }));
vi.mock("@/api/prototypes", () => ({ prototypesApi: { list: () => list(), setVisibility: (...args: unknown[]) => setVisibility(...(args as [])), setStatus: vi.fn(), uploadScreenshot: vi.fn() } }));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));

import { PrototypeList } from "./PrototypeList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function prototype(overrides: Partial<Prototype> = {}): Prototype {
  return {
    id: "p-1", companyId: "c-1", key: "northwind-portal", version: 2, versionCount: 2, title: "Northwind portal",
    summary: "Clickable first cut", kind: "prototype", brand: "Greatstone", status: "final", stage: "in_review",
    confidentiality: "internal", attachmentId: null, external: true, url: "https://northwind-proto.example.invalid",
    screenshotPath: null, screenshotCapturedAt: null, linkCheck: null, restricted: false, contentType: "text/uri-list",
    byteSize: 0, originalFilename: null, contentPath: "", openPath: "", downloadPath: "",
    issue: { id: "i-1", identifier: "GRE-1", title: "Build it" }, project: { id: "pr-1", name: "Northwind app" },
    projectMoved: false, clientCase: null, createdByAgent: null, createdAt: "2026-11-14T10:00:00.000Z",
    updatedAt: "2026-11-14T10:00:00.000Z", lastOpenedAt: null, href: "", appPath: "",
    prototypeStatus: "draft", client: { id: "org-1", name: "Northwind Test", websiteLinked: true },
    portal: { visible: false, sharedAt: null, sharedByUserId: null, needsReshare: false },
    owner: { type: "agent", id: "a-1", name: "Lintel" },
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root!.render(
    <QueryClientProvider client={client}>
      <MemoryRouter><PrototypeList companyId="c-1" filters /></MemoryRouter>
    </QueryClientProvider>,
  ));
  await vi.waitFor(() => expect(document.body.textContent).toContain("Northwind portal"));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  setVisibility.mockClear();
});

describe("PrototypeList", () => {
  it("shows the card and asks a confirm that names the client before sharing", async () => {
    await render();
    expect(document.body.textContent).toContain("Northwind portal");
    expect(document.body.textContent).toContain("Lintel");
    const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle.click());
    expect(setVisibility).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Show this prototype to Northwind Test?");
    const confirm = [...document.querySelectorAll("button")].find((button) => button.textContent === "Show to Northwind Test")!;
    await act(async () => confirm.click());
    expect(setVisibility).toHaveBeenCalledWith("c-1", "p-1", { visible: true, organisationId: "org-1" });
  });

  it("cannot share until the client is linked to its website organisation", async () => {
    list.mockResolvedValueOnce({ prototypes: [prototype({ client: { id: "org-1", name: "Northwind Test", websiteLinked: false } })] });
    await render();
    expect(document.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true);
    expect(document.body.textContent).toContain("Link Northwind Test to its website organisation first.");
  });
});
