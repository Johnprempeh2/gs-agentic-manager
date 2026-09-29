// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releasesOverviewFixture } from "@/fixtures/releaseFixtures";
import { queryKeys } from "@/lib/queryKeys";
import { SidebarReleaseFooter } from "./SidebarReleaseFooter";

const mockReleasesApi = vi.hoisted(() => ({ overview: vi.fn(), clientVersion: vi.fn() }));
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
/** Health as CloudAccessGate caches it; a client edition lists `instance.releases`. */
let health: Record<string, unknown>;

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(rail = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.health, health);
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
  health = { status: "ok" };
  mockReleasesApi.overview.mockResolvedValue(releasesOverviewFixture());
  mockReleasesApi.clientVersion.mockResolvedValue({
    label: "2026-09-28.1",
    stableTag: "stable-2026-09-28.1",
    notes: "Run limits you can set in Settings.\nA faster board.",
  });
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
    expect(mockReleasesApi.clientVersion).not.toHaveBeenCalled();
  });

  it("never reads the live changelog on a client edition, even for the board (GRE-129)", async () => {
    health = { status: "ok", hiddenSettings: ["instance.releases"] };
    await render();
    expect(mockReleasesApi.overview).not.toHaveBeenCalled();
    expect(mockAccessApi.getCurrentBoardAccess).not.toHaveBeenCalled();
  });

  describe("on a client edition (GRE-128)", () => {
    beforeEach(() => {
      health = { status: "ok", hiddenSettings: ["instance.releases"] };
    });

    async function openDialog() {
      await act(async () => footer()!.click());
      await flush();
      return document.querySelector('[role="dialog"]');
    }

    it("shows Version X and the notes of the stable tag it runs", async () => {
      await render();
      expect(mockReleasesApi.clientVersion).toHaveBeenCalledWith("company-1");
      expect(footer()?.textContent).toBe("Version 2026-09-28.1");

      const dialog = await openDialog();
      expect(dialog?.textContent).toContain("What's new in Version 2026-09-28.1");
      expect(dialog?.querySelector('[data-slot="client-notes"]')?.textContent).toBe(
        "Run limits you can set in Settings.\nA faster board.",
      );
      expect(dialog?.querySelector('a[href="/releases"]')).toBeNull();
    });

    it("shows it to members who are not the board", async () => {
      mockAccessApi.getCurrentBoardAccess.mockRejectedValue(new Error("Unauthorized"));
      await render();
      expect(footer()?.textContent).toBe("Version 2026-09-28.1");
    });

    it("never shows PR or GRE numbers, live tags or the live changelog", async () => {
      await render();
      const dialog = await openDialog();
      const text = `${footer()?.textContent} ${dialog?.textContent}`;
      expect(text).not.toMatch(/#\d+|GRE-\d+|live-\d|stable-\d/);
      expect(text).not.toContain("Run limits in settings, with a usage-based recommendation");
    });

    it("with no stable tag shows Version X and no notes", async () => {
      mockReleasesApi.clientVersion.mockResolvedValue({ label: "2026-09-27.1", stableTag: null, notes: null });
      await render();
      expect(footer()?.textContent).toBe("Version 2026-09-27.1");
      const dialog = await openDialog();
      expect(dialog?.querySelector('[data-slot="client-notes"]')).toBeNull();
      expect(dialog?.textContent).toContain("No notes for this version.");
    });

    it("is hidden when the version cannot be read, and in the collapsed rail", async () => {
      mockReleasesApi.clientVersion.mockRejectedValue(new Error("boom"));
      await render();
      expect(footer()).toBeNull();
      await act(async () => root.unmount());

      mockReleasesApi.clientVersion.mockResolvedValue({ label: "2026-09-28.1", stableTag: null, notes: null });
      await render(true);
      expect(footer()).toBeNull();
    });
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
