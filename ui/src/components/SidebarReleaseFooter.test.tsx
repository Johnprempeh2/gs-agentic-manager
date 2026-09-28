// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releasesOverviewFixture } from "@/fixtures/releaseFixtures";
import { SidebarReleaseFooter } from "./SidebarReleaseFooter";

const mockReleasesApi = vi.hoisted(() => ({ overview: vi.fn() }));
const mockAccessApi = vi.hoisted(() => ({ getCurrentBoardAccess: vi.fn() }));

vi.mock("@/api/releases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/releases")>()),
  releasesApi: mockReleasesApi,
}));
vi.mock("@/api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(rail = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SidebarReleaseFooter companyId="company-1" rail={rail} />
      </QueryClientProvider>,
    );
  });
  await flush();
}

function footer() {
  return document.querySelector<HTMLButtonElement>('[data-slot="sidebar-release-footer"]');
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  mockReleasesApi.overview.mockResolvedValue(releasesOverviewFixture());
  mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
    source: "local_implicit",
    isInstanceAdmin: true,
    companyIds: ["company-1"],
    memberships: [],
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("SidebarReleaseFooter", () => {
  it("names the live version and opens its changelog", async () => {
    await render();

    expect(footer()?.textContent).toBe("Run limits");
    expect(footer()?.getAttribute("aria-label")).toBe("What's new in Run limits");

    await act(async () => footer()!.click());
    await flush();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("What's new in Run limits");
    expect(dialog?.textContent).toContain("live-2026-09-21.1");
    expect(dialog?.textContent).toContain("Run limits in settings, with a usage-based recommendation");
    expect(dialog?.textContent).toContain("Board no longer flickers when a run finishes");
    expect(dialog?.querySelector('a[href="/releases"]')?.textContent).toBe("All releases");
  });

  it("is hidden for non-board viewers", async () => {
    mockAccessApi.getCurrentBoardAccess.mockRejectedValue(new Error("Unauthorized"));
    await render();
    expect(footer()).toBeNull();
    expect(mockReleasesApi.overview).not.toHaveBeenCalled();
  });

  it("is hidden when no live version is recorded, and in the collapsed rail", async () => {
    mockReleasesApi.overview.mockResolvedValue(releasesOverviewFixture({ live: null }));
    await render();
    expect(footer()).toBeNull();
    await act(async () => root.unmount());

    mockReleasesApi.overview.mockResolvedValue(releasesOverviewFixture());
    await render(true);
    expect(footer()).toBeNull();
  });

  it("names an untitled live version by its tag", async () => {
    const base = releasesOverviewFixture();
    mockReleasesApi.overview.mockResolvedValue(releasesOverviewFixture({ live: { ...base.live!, title: null } }));
    await render();
    expect(footer()?.textContent).toBe("live-2026-09-21.1");
  });
});
