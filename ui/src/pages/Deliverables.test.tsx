// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HTML_ATTACHMENT_SANDBOX_TOKENS } from "@greatstone/shared";
import type { Deliverable, DeliverablesResponse } from "../api/deliverables";
import { DELIVERABLE_IFRAME_SANDBOX } from "../components/deliverables/DeliverableDocument";
import { Deliverables, EXAMPLE_DELIVERABLE_PROMPT, dateRangeStart, groupDeliverables, projectsWithPreview } from "./Deliverables";
import type { Project } from "@greatstone/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const deliverablesApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  markOpened: vi.fn(),
  mark: vi.fn(),
  reviewContentPath: (companyId: string, id: string) => `/api/companies/${companyId}/deliverables/${id}/review-content`,
  listComments: vi.fn(async () => ({ comments: [] })),
}));

vi.mock("../api/deliverables", () => ({ deliverablesApi: deliverablesApiMock }));

const projectsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  checkoutHead: vi.fn(),
  controlWorkspaceRuntimeServices: vi.fn(),
  updatePreview: vi.fn(),
  setPreviewAutoUpdate: vi.fn(),
}));
vi.mock("../api/projects", () => ({ projectsApi: projectsApiMock }));

function previewProject(id: string, name: string, withPreview: boolean): Project {
  const workspace = {
    id: `${id}-ws`,
    projectId: id,
    runtimeConfig: withPreview
      ? {
          workspaceRuntime: {
            commands: [
              { id: "preview", kind: "service", name: "preview", command: "npx vite", port: 4100 },
              { id: "update", kind: "job", name: "update to latest main", command: "git pull" },
            ],
          },
          desiredState: "running",
          serviceStates: null,
        }
      : null,
    runtimeServices: withPreview
      ? [{
          id: `${id}-svc`,
          serviceName: "preview",
          status: "running",
          url: "https://preview.example:4100",
          scopeType: "project_workspace",
          configIndex: 0,
          startedAt: new Date(),
          updatedAt: new Date(),
          stoppedAt: null,
          healthStatus: "healthy",
        }]
      : [],
    metadata: null,
    defaultRef: "main",
    repoRef: null,
  };
  return { id, companyId: "company-1", urlKey: id, name, workspaces: [workspace], primaryWorkspace: workspace } as unknown as Project;
}
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/components/AgentAvatar", () => ({ AgentAvatar: () => <span data-testid="agent-avatar" /> }));
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    useSearchParams: actual.useSearchParams,
    useNavigate: actual.useNavigate,
    Link: ({ to, children, disableIssueQuicklook: _ignored, ...props }: { to: string; children: ReactNode; disableIssueQuicklook?: boolean }) => (
      <a href={to} {...props}>{children}</a>
    ),
  };
});

class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}

function sample(overrides: Partial<Deliverable> = {}): Deliverable {
  const id = overrides.id ?? "d-1";
  return {
    id,
    companyId: "company-1",
    key: "q3-board-pack",
    version: 1,
    versionCount: 1,
    title: "Q3 board pack",
    summary: "Numbers for the board",
    kind: "report",
    brand: "Greatstone",
    status: "final",
    confidentiality: "internal",
    external: false,
    url: null,
    screenshotPath: null,
    screenshotCapturedAt: null,
    linkCheck: null,
    restricted: false,
    appPath: `/GRE/deliverables?open=${id}`,
    attachmentId: `att-${id}`,
    contentType: "text/html",
    byteSize: 100,
    originalFilename: "q3.html",
    contentPath: `/api/attachments/att-${id}/content`,
    openPath: `/api/attachments/att-${id}/content`,
    downloadPath: `/api/attachments/att-${id}/content?download=1`,
    issue: { id: "issue-1", identifier: "GRE-1", title: "Quarterly pack" },
    project: { id: "project-1", name: "Board" },
    clientCase: null,
    createdByAgent: { id: "agent-1", name: "Everest" },
    createdAt: "2026-09-30T10:00:00.000Z",
    updatedAt: "2026-09-30T10:00:00.000Z",
    lastOpenedAt: null,
    href: "/GRE/issues/GRE-1#work-product-d-1",
    ...overrides,
  };
}

function response(deliverables: Deliverable[]): DeliverablesResponse {
  return {
    deliverables,
    total: deliverables.length,
    nextOffset: null,
    facets: { brands: ["Greatstone"], agents: [{ id: "agent-1", name: "Everest" }], projects: [{ id: "project-1", name: "Board" }] },
  };
}

async function flush(times = 5) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("Deliverables page", () => {
  let container: HTMLDivElement;
  let root: Root;

  function LocationProbe() {
    const location = useLocation();
    return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
  }

  function render(entry: string | string[] = "/deliverables") {
    const entries = Array.isArray(entry) ? entry : [entry];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
            <LocationProbe />
            <Routes>
              <Route path="/deliverables" element={<Deliverables />} />
              <Route path="*" element={<p>Chat page</p>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
  }

  const quickLook = () => document.querySelector<HTMLElement>("[data-testid='deliverable-quicklook']");
  const backButton = () => document.querySelector<HTMLButtonElement>("[data-testid='deliverable-quicklook-back']");
  const currentLocation = () => container.querySelector("[data-testid='location']")?.textContent;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    window.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
    projectsApiMock.list.mockReset().mockResolvedValue([]);
    projectsApiMock.checkoutHead.mockReset().mockResolvedValue({ workspaceId: "w", branch: "main", commit: "abc1234", commitSubject: "Hero", committedAt: null });
    deliverablesApiMock.list.mockReset();
    deliverablesApiMock.get.mockReset();
    deliverablesApiMock.markOpened.mockReset().mockResolvedValue({ ok: true });
    // Detail mirrors whatever the list returned for that id.
    deliverablesApiMock.get.mockImplementation(async (_companyId: string, id: string) => {
      const listed = (await deliverablesApiMock.list.mock.results.at(-1)?.value as DeliverablesResponse | undefined)
        ?.deliverables.find((item) => item.id === id);
      return { ...(listed ?? sample({ id })), versions: [] };
    });
  });

  afterEach(() => {
    window.history.replaceState(null, "");
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("shows cards with a sandboxed live thumbnail", async () => {
    deliverablesApiMock.list.mockResolvedValue(response([sample()]));
    render();
    await flush();

    const cards = container.querySelectorAll("[data-testid='deliverable-card']");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("Q3 board pack");
    expect(cards[0]!.textContent).toContain("GRE-1");
    expect(cards[0]!.textContent).toContain("Report");
    const frame = container.querySelector<HTMLIFrameElement>("[data-testid='deliverable-thumbnail-frame']");
    expect(frame?.getAttribute("src")).toBe("/api/attachments/att-d-1/content");
    expect(frame?.getAttribute("sandbox")).toBe(DELIVERABLE_IFRAME_SANDBOX);
  });

  it("shows a live site as a placeholder or stored screenshot with Open site, never a frame", async () => {
    const site = (id: string, screenshotPath: string | null) => sample({
      id,
      title: `MoEnGT deck ${id === "s-1" ? "site" : "mirror"}`,
      external: true,
      url: "https://greatstone-moengt-deck.netlify.app",
      attachmentId: null,
      contentType: "text/uri-list",
      openPath: "https://greatstone-moengt-deck.netlify.app",
      screenshotPath,
      confidentiality: "client",
      linkCheck: { lastCheckedAt: "2026-10-13T09:00:00.000Z", httpStatus: 404, ok: false },
    });
    deliverablesApiMock.list.mockResolvedValue(response([site("s-1", null), site("s-2", "/api/attachments/shot/content")]));
    render();
    await flush();

    expect(container.querySelector("[data-testid='deliverable-thumbnail-frame']")).toBeNull();
    expect(container.querySelector("[data-testid='deliverable-site-placeholder']")?.textContent).toContain("GM");
    expect(container.querySelector("[data-testid='deliverable-site-placeholder']")?.textContent).toContain("greatstone-moengt-deck.netlify.app");
    expect(container.querySelector("[data-testid='deliverable-site-screenshot']")?.getAttribute("src")).toBe("/api/attachments/shot/content");
    const open = container.querySelector<HTMLAnchorElement>("a[aria-label='Open site']");
    expect(open?.getAttribute("href")).toBe("https://greatstone-moengt-deck.netlify.app");
    expect(open?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(container.querySelector("a[aria-label='Download']")).toBeNull();
    expect(container.querySelector("[data-testid='deliverable-link-broken']")?.textContent).toContain("Link broken");
    expect(container.querySelector("[data-testid='deliverable-confidentiality']")?.textContent).toBe("Client");
  });

  it("groups by project by default, shows the project on each card, and puts no-project last (GRE-1471)", async () => {
    deliverablesApiMock.list.mockResolvedValue(response([
      sample({ id: "a", title: "Loose note", project: null }),
      sample({ id: "b", title: "Board pack", project: { id: "p1", name: "Board" } }),
      sample({ id: "c", title: "Site brief", project: { id: "p2", name: "Website" } }),
      sample({ id: "d", title: "Board minutes", project: { id: "p1", name: "Board" } }),
    ]));
    render();
    await flush();

    const sections = [...container.querySelectorAll<HTMLElement>("section[aria-label]")]
      .filter((section) => section.querySelector("[data-testid='deliverable-card']"));
    expect(sections.map((section) => section.getAttribute("aria-label"))).toEqual(["Board", "Website", "No project"]);
    const titlesIn = (section: HTMLElement) =>
      [...section.querySelectorAll("[data-testid='deliverable-card'] h3")].map((title) => title.textContent);
    expect(titlesIn(sections[0]!)).toEqual(["Board pack", "Board minutes"]);
    expect(titlesIn(sections[2]!)).toEqual(["Loose note"]);

    const projectLabels = [...container.querySelectorAll("[data-testid='deliverable-card-project']")]
      .map((label) => label.textContent);
    expect(projectLabels).toEqual(["Project: Board", "Project: Board", "Project: Website", "Project: No project"]);
  });

  it("splits a project by client case, with no-case last, and shows the case on the card (GRE-1471)", async () => {
    deliverablesApiMock.list.mockResolvedValue(response([
      sample({ id: "a", title: "Internal note", project: { id: "p1", name: "Board" } }),
      sample({ id: "b", title: "Acme brief", project: { id: "p1", name: "Board" }, clientCase: { id: "c1", name: "Acme" } }),
      sample({ id: "c", title: "Site brief", project: { id: "p2", name: "Website" } }),
      sample({ id: "d", title: "Loose Acme note", project: null, clientCase: { id: "c1", name: "Acme" } }),
    ]));
    render();
    await flush();

    const caseHeadings = [...container.querySelectorAll("[data-testid='deliverable-case-heading']")]
      .map((heading) => heading.textContent);
    // Board has a case so it splits; Website has none so it stays flat.
    expect(caseHeadings).toEqual(["Acme· 1", "No client case· 1", "Acme· 1"]);
    const board = container.querySelector<HTMLElement>("section[aria-label='Board']")!;
    expect([...board.querySelectorAll("[data-testid='deliverable-card'] h3")].map((title) => title.textContent))
      .toEqual(["Acme brief", "Internal note"]);
    expect(container.querySelector("section[aria-label='Website'] [data-testid='deliverable-case-heading']")).toBeNull();
    expect(container.querySelector("section[aria-label='No project'] [role='group'][aria-label='Client case: Acme']")).not.toBeNull();

    const caseLabels = [...container.querySelectorAll("[data-testid='deliverable-card-case']")]
      .map((label) => label.textContent);
    expect(caseLabels).toEqual(["Client case: Acme", "Client case: Acme"]);
  });

  it("can turn grouping off and keeps the choice in the link", async () => {
    deliverablesApiMock.list.mockResolvedValue(response([
      sample({ id: "a", project: null }),
      sample({ id: "b", project: { id: "p1", name: "Board" } }),
    ]));
    render("/deliverables?group=none");
    await flush();

    expect(container.querySelector("section[aria-label='Deliverables']")).not.toBeNull();
    expect(container.querySelectorAll("[data-testid='deliverable-card']")).toHaveLength(2);
    expect(container.querySelector("[data-testid='deliverable-group']")?.textContent).toContain("No grouping");
  });

  it("uses the same sandbox as HTML attachments and never grants app access", () => {
    expect(DELIVERABLE_IFRAME_SANDBOX.split(" ")).toEqual([...HTML_ATTACHMENT_SANDBOX_TOKENS]);
    expect(DELIVERABLE_IFRAME_SANDBOX).not.toContain("allow-same-origin");
    expect(DELIVERABLE_IFRAME_SANDBOX).not.toContain("allow-forms");
    expect(DELIVERABLE_IFRAME_SANDBOX).not.toContain("allow-top-navigation");
  });

  it("searches as you type and focuses the search box with /", async () => {
    deliverablesApiMock.list.mockResolvedValue(response([sample()]));
    render();
    await flush();

    const input = container.querySelector<HTMLInputElement>("input[aria-label='Search deliverables']")!;
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
    });
    expect(document.activeElement).toBe(input);

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "accra");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await flush();
    expect(deliverablesApiMock.list).toHaveBeenLastCalledWith(
      "company-1",
      expect.objectContaining({ q: "accra", sort: "newest" }),
    );
  });

  it("opens Quick Look, moves with the arrow keys and closes on Escape", async () => {
    deliverablesApiMock.list.mockResolvedValue(response([
      sample({ id: "d-1", title: "First" }),
      sample({ id: "d-2", title: "Second" }),
    ]));
    render();
    await flush();

    act(() => {
      container.querySelector<HTMLButtonElement>("[data-testid='deliverable-card-preview']")!.click();
    });
    await flush();
    expect(quickLook()?.textContent).toContain("First");
    expect(backButton()).toBeNull();
    expect(quickLook()?.textContent).toContain("1 of 2");
    expect(document.querySelector("[data-testid='deliverable-preview-frame']")?.getAttribute("sandbox"))
      .toBe(DELIVERABLE_IFRAME_SANDBOX);
    expect(deliverablesApiMock.markOpened).toHaveBeenCalledWith("company-1", "d-1");

    act(() => {
      quickLook()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    await flush();
    expect(quickLook()?.textContent).toContain("Second");
    expect(quickLook()?.textContent).toContain("2 of 2");

    act(() => {
      quickLook()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    await flush();
    expect(quickLook()?.textContent).toContain("1 of 2");

    act(() => {
      quickLook()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(quickLook()).toBeNull();
  });

  it("switches an HTML deliverable to comment mode with the comments panel (GRE-982)", async () => {
    deliverablesApiMock.list.mockResolvedValue(response([sample({ id: "d-1", title: "First" })]));
    render();
    await flush();
    act(() => {
      container.querySelector<HTMLButtonElement>("[data-testid='deliverable-card-preview']")!.click();
    });
    await flush();
    expect(deliverablesApiMock.listComments).not.toHaveBeenCalled();

    act(() => {
      document.querySelector<HTMLButtonElement>("[data-testid='deliverable-comment-mode']")!.click();
    });
    await flush();
    const reviewFrame = document.querySelector("[data-testid='deliverable-review-frame']");
    expect(reviewFrame?.getAttribute("src")).toBe("/api/companies/company-1/deliverables/d-1/review-content");
    expect(reviewFrame?.getAttribute("sandbox")).toBe(DELIVERABLE_IFRAME_SANDBOX);
    expect(document.querySelector("[data-testid='deliverable-preview-frame']")).toBeNull();
    expect(document.querySelector("[data-testid='deliverable-comments-panel']")?.textContent)
      .toContain("No comments on this version yet.");
    expect(deliverablesApiMock.listComments).toHaveBeenCalledWith("company-1", "d-1");
  });

  it("returns to the chat it was opened from on Back and on Escape (GRE-611)", async () => {
    deliverablesApiMock.list.mockResolvedValue(response([
      sample({ id: "d-1", title: "First" }),
      sample({ id: "d-2", title: "Second" }),
    ]));
    // BrowserRouter keeps its history index here; > 0 means an in-app page came before.
    window.history.replaceState({ idx: 1 }, "");
    render(["/issues/GRE-296", "/deliverables?open=d-1"]);
    await flush();
    expect(quickLook()?.textContent).toContain("First");

    // Moving to the next deliverable still returns to the chat.
    act(() => {
      quickLook()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    await flush();
    expect(quickLook()?.textContent).toContain("Second");

    act(() => backButton()!.click());
    await flush();
    expect(currentLocation()).toBe("/issues/GRE-296");
    expect(quickLook()).toBeNull();
    expect(container.textContent).toContain("Chat page");

    act(() => root.unmount());
    render(["/issues/GRE-296", "/deliverables?open=d-1"]);
    await flush();
    act(() => {
      quickLook()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(currentLocation()).toBe("/issues/GRE-296");
  });

  it("closes a shared link to the Deliverables list, with no Back button", async () => {
    deliverablesApiMock.list.mockResolvedValue(response([sample({ id: "d-1", title: "First" })]));
    render("/deliverables?open=d-1");
    await flush();
    expect(quickLook()?.textContent).toContain("First");
    expect(backButton()).toBeNull();

    act(() => {
      quickLook()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(quickLook()).toBeNull();
    expect(currentLocation()).toBe("/deliverables");
    expect(container.querySelectorAll("[data-testid='deliverable-card']")).toHaveLength(1);
  });

  // Ben, 13 Oct: the same document showed as three cards.
  it("shows one card per document, with its versions one click away", async () => {
    deliverablesApiMock.list.mockResolvedValue(response([
      sample({ id: "brief-3", key: "brief-v3", title: "Ghana Airport Taxi discovery prep brief v3", createdAt: "2026-10-12T10:00:00.000Z" }),
      sample({ id: "toolkit", key: "toolkit", title: "The Greatstone Method Toolkit", createdAt: "2026-10-11T10:00:00.000Z" }),
      sample({ id: "brief-2", key: "brief-draft", title: "Ghana airport taxi discovery prep brief (draft)", createdAt: "2026-10-10T10:00:00.000Z", issue: { id: "issue-2", identifier: "GRE-2", title: "Prep" } }),
      sample({ id: "brief-1", key: "brief", title: "Ghana Airport Taxi discovery prep brief", createdAt: "2026-10-01T10:00:00.000Z", versionCount: 2, version: 2 }),
    ]));
    render();
    await flush();

    const cards = [...container.querySelectorAll("[data-testid='deliverable-card']")];
    expect(cards.map((card) => card.querySelector("h3")?.textContent)).toEqual([
      "Ghana Airport Taxi discovery prep brief v3",
      "The Greatstone Method Toolkit",
    ]);
    const versions = cards[0]!.querySelector<HTMLButtonElement>("[data-testid='deliverable-versions']");
    // Three entries, one of which has two versions of its own.
    expect(versions?.textContent).toContain("4 versions");
    expect(cards[1]!.querySelector("[data-testid='deliverable-versions']")).toBeNull();
    expect(container.textContent).toContain("2 older versions grouped under the latest");

    await act(async () => {
      versions!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    await flush(2);
    const older = [...document.querySelectorAll("[role='menuitem']")].find((item) => item.textContent?.includes("(draft)"));
    expect(older?.textContent).toContain("GRE-2");
    await act(async () => {
      (older as HTMLElement).click();
    });
    await flush();
    expect(currentLocation()).toContain("open=brief-2");
  });

  it("filters by who a deliverable is for, first and in words", async () => {
    deliverablesApiMock.list.mockResolvedValue(response([sample()]));
    render();
    await flush();

    const audience = container.querySelector("[data-testid='deliverable-audience']");
    const options = [...(audience?.querySelectorAll("[role='radio']") ?? [])] as HTMLButtonElement[];
    expect(options.map((option) => option.textContent)).toEqual(["Everything", "Client-facing", "Internal"]);
    expect(options[0]!.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      options[1]!.click();
    });
    await flush();
    expect(currentLocation()).toContain("audience=client_facing");
    expect(deliverablesApiMock.list.mock.calls.at(-1)?.[1]).toMatchObject({ audience: "client_facing" });
    const checked = container.querySelector("[data-testid='deliverable-audience'] [aria-checked='true']");
    expect(checked?.textContent).toBe("Client-facing");
  });

  it("explains the page and shows an example prompt when there is nothing yet", async () => {
    deliverablesApiMock.list.mockResolvedValue(response([]));
    render();
    await flush();
    const empty = container.querySelector("[data-testid='deliverables-empty']");
    expect(empty?.textContent).toContain("No deliverables yet");
    expect(empty?.textContent).toContain(EXAMPLE_DELIVERABLE_PROMPT);
  });

  it("says no match, not 'nothing yet', when a filter hides everything", async () => {
    deliverablesApiMock.list.mockResolvedValue(response([]));
    render("/deliverables?kind=deck");
    await flush();
    expect(container.querySelector("[data-testid='deliverables-empty']")).toBeNull();
    expect(container.textContent).toContain("No deliverables match.");
    expect(deliverablesApiMock.list).toHaveBeenCalledWith("company-1", expect.objectContaining({ kind: "deck" }));
  });

  it("shows a live preview card for each project with a preview, with Update now", async () => {
    projectsApiMock.list.mockResolvedValue([
      previewProject("site", "Greatstone Website", true),
      previewProject("ops", "Operations", false),
    ]);
    deliverablesApiMock.list.mockResolvedValue(response([sample()]));
    render();
    await flush();

    const previews = container.querySelector("[data-testid='deliverables-live-previews']");
    expect(previews).not.toBeNull();
    const cards = previews!.querySelectorAll("section[aria-label='Live preview']");
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain("Greatstone Website");
    expect(cards[0].textContent).toContain("Open preview");
    expect(cards[0].textContent).toContain("Update now");
    expect(cards[0].querySelector("button[aria-label='Stop']")).not.toBeNull();
  });

  it("looks the same as before when no project has a preview", async () => {
    projectsApiMock.list.mockResolvedValue([previewProject("ops", "Operations", false)]);
    deliverablesApiMock.list.mockResolvedValue(response([sample()]));
    render();
    await flush();
    expect(container.querySelector("[data-testid='deliverables-live-previews']")).toBeNull();
    expect(container.querySelector("section[aria-label='Live preview']")).toBeNull();
  });
});

describe("projectsWithPreview", () => {
  it("keeps projects with a preview and follows the project filter", () => {
    const projects = [previewProject("site", "Site", true), previewProject("blog", "Blog", true), previewProject("ops", "Ops", false)];
    expect(projectsWithPreview(projects, null).map((project) => project.id)).toEqual(["site", "blog"]);
    expect(projectsWithPreview(projects, "blog").map((project) => project.id)).toEqual(["blog"]);
    expect(projectsWithPreview(projects, "ops")).toEqual([]);
    expect(projectsWithPreview(undefined, null)).toEqual([]);
  });
});

describe("deliverable helpers", () => {
  it("groups by project and by month, keeping list order, with no project last", () => {
    const items = [
      sample({ id: "a", project: { id: "p1", name: "Board" }, createdAt: "2026-09-02T00:00:00.000Z" }),
      sample({ id: "b", project: null, createdAt: "2026-08-15T00:00:00.000Z" }),
      sample({ id: "c", project: { id: "p1", name: "Board" }, createdAt: "2026-08-01T00:00:00.000Z" }),
      sample({ id: "e", project: { id: "p2", name: "Website" }, createdAt: "2026-07-01T00:00:00.000Z" }),
    ];
    expect(groupDeliverables(items, "project").map((group) => [group.label, group.items.map((item) => item.id)]))
      .toEqual([["Board", ["a", "c"]], ["Website", ["e"]], ["No project", ["b"]]]);
    expect(groupDeliverables(items, "month").map((group) => group.items.map((item) => item.id)))
      .toEqual([["a"], ["b", "c"], ["e"]]);
    expect(groupDeliverables(items, "none").map((group) => [group.label, group.items])).toEqual([[null, items]]);
  });

  it("splits a project by client case in list order, with no case last and items in shown order", () => {
    const items = [
      sample({ id: "a", project: { id: "p1", name: "Board" } }),
      sample({ id: "b", project: { id: "p1", name: "Board" }, clientCase: { id: "c2", name: "Beta" } }),
      sample({ id: "c", project: { id: "p1", name: "Board" }, clientCase: { id: "c1", name: "Acme" } }),
      sample({ id: "d", project: { id: "p1", name: "Board" }, clientCase: { id: "c2", name: "Beta" } }),
      sample({ id: "e", project: null }),
    ];
    const [board, none] = groupDeliverables(items, "project");
    expect(board!.cases.map((section) => [section.label, section.items.map((item) => item.id)]))
      .toEqual([["Beta", ["b", "d"]], ["Acme", ["c"]], ["No client case", ["a"]]]);
    expect(board!.items.map((item) => item.id)).toEqual(["b", "d", "c", "a"]);
    // No case anywhere in the group: one unlabelled section.
    expect(none!.cases).toEqual([{ key: "all", label: null, items: [items[4]] }]);
    // Month grouping never splits by case.
    expect(groupDeliverables(items, "month").every((group) => group.cases.length === 1 && group.cases[0]!.label === null)).toBe(true);
  });

  it("starts weeks on Monday and months on the 1st", () => {
    const thursday = new Date(2026, 9, 1, 15, 30); // Thu 1 Oct 2026
    expect(new Date(dateRangeStart("week", thursday)!).getDate()).toBe(28); // Mon 28 Sep
    expect(new Date(dateRangeStart("month", thursday)!).getDate()).toBe(1);
    expect(dateRangeStart("all", thursday)).toBeUndefined();
  });
});
