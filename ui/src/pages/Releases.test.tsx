// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseProgressState } from "@/api/releases";
import { ConfirmProvider } from "@/context/ConfirmContext";
import { releaseProgressFixture, releasesOverviewFixture } from "@/fixtures/releaseFixtures";
import { queryKeys } from "@/lib/queryKeys";
import { Releases, ReleasesView } from "./Releases";

const mockReleasesApi = vi.hoisted(() => ({
  overview: vi.fn(),
  release: vi.fn(),
  rollback: vi.fn(),
  cancel: vi.fn(),
}));
const mockAccessApi = vi.hoisted(() => ({ getCurrentBoardAccess: vi.fn() }));

vi.mock("@/api/releases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/releases")>()),
  releasesApi: mockReleasesApi,
}));
vi.mock("@/api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const BOARD = { source: "local_implicit", isInstanceAdmin: true, companyIds: ["company-1"], memberships: [] };
const AGENT_OR_VIEWER = {
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-1"],
  memberships: [{ companyId: "company-1", status: "active", membershipRole: "viewer" }],
};

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

async function render(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.health, health);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ConfirmProvider>{node}</ConfirmProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined;
}

async function click(element: Element | undefined) {
  expect(element).toBeTruthy();
  await act(async () => {
    (element as HTMLElement).click();
  });
  await flush();
}

function confirmDialog() {
  return document.querySelector('[data-slot="confirm-dialog"]');
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  health = { status: "ok" };
  mockReleasesApi.overview.mockResolvedValue(releasesOverviewFixture());
  mockReleasesApi.release.mockResolvedValue({ progress: releaseProgressFixture("checking") });
  mockReleasesApi.rollback.mockResolvedValue({
    progress: releaseProgressFixture("checking", { kind: "rollback", targetTag: "live-2026-09-14.1" }),
  });
  mockReleasesApi.cancel.mockResolvedValue({ progress: releaseProgressFixture("cancelled") });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("Releases page", () => {
  it("shows no page and no release buttons on a client edition, even for the board (GRE-129)", async () => {
    health = { status: "ok", hiddenSettings: ["instance.releases"] };
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue(BOARD);
    await render(<Releases />);

    expect(buttonByText("Release Release from the app")).toBeUndefined();
    expect(mockReleasesApi.overview).not.toHaveBeenCalled();
  });

  it("shows the page and its buttons to the board on our own install (GRE-129)", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue(BOARD);
    await render(<Releases />);

    expect(mockReleasesApi.overview).toHaveBeenCalledWith("company-1");
    expect(document.body.textContent).not.toContain("Releases are for the board");
  });

  it("hides the page and its buttons from non-board viewers", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue(AGENT_OR_VIEWER);
    await render(<Releases />);

    expect(document.body.textContent).toContain("Releases are for the board");
    expect(buttonByText("Release Release from the app")).toBeUndefined();
    expect(mockReleasesApi.overview).not.toHaveBeenCalled();
  });

  it("hides the page when board access cannot be read (agent keys)", async () => {
    mockAccessApi.getCurrentBoardAccess.mockRejectedValue(new Error("Unauthorized"));
    await render(<Releases />);

    expect(document.body.textContent).toContain("Releases are for the board");
    expect(mockReleasesApi.overview).not.toHaveBeenCalled();
  });

  it("shows live, candidate and history to the board", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue(BOARD);
    await render(<Releases />);

    const live = document.querySelector('[data-testid="release-live"]')!;
    expect(live.textContent).toContain("Run limits");
    expect(live.textContent).toContain("live-2026-09-21.1");
    expect(live.textContent).toContain("c77a43c");
    expect(live.textContent).toContain("Healthy");
    expect(live.textContent).toContain("John");

    const candidate = document.querySelector('[data-testid="release-candidate"]')!;
    expect(candidate.textContent).toContain("Release from the app");
    expect(candidate.textContent).toContain("Fork CI passed");
    expect(candidate.textContent).toContain("Flint check passed");
    expect(candidate.textContent).toContain("Features");
    expect(candidate.textContent).toContain("Fixes");
    expect(buttonByText("Release Release from the app")).toBeTruthy();

    const history = document.querySelector('[data-testid="release-history"]')!;
    expect(history.textContent).toContain("RAM management");
    // The live version has no rollback button; older ones do.
    expect(
      document.querySelector('[data-testid="release-history-live-2026-09-21.1"]')?.textContent,
    ).not.toContain("Roll back to this version");
    expect(
      document.querySelector('[data-testid="release-history-live-2026-09-14.1"]')?.textContent,
    ).toContain("Roll back to this version");
  });
});

describe("Release confirm", () => {
  it("says what changes and that runs pause and live restarts", async () => {
    await render(<ReleasesView companyId="company-1" overview={releasesOverviewFixture()} fetchError={null} />);
    await click(buttonByText("Release Release from the app"));

    const dialog = confirmDialog();
    expect(dialog?.textContent).toContain("Release Release from the app?");
    expect(dialog?.textContent).toContain(
      "Live moves from Run limits (live-2026-09-21.1) to Release from the app (rc-2026-09-28.1).",
    );
    expect(dialog?.textContent).toContain("Releases page with one-click release and rollback");
    expect(dialog?.textContent).toContain("Fix: Update live card works after the preview is stopped");
    expect(dialog?.textContent).toContain("New agent runs pause");
    expect(dialog?.textContent).toContain("Live then restarts");
    expect(mockReleasesApi.release).not.toHaveBeenCalled();

    const confirmButton = [...dialog!.querySelectorAll("button")].find(
      (button) => button.textContent === "Release Release from the app",
    );
    await click(confirmButton);
    expect(mockReleasesApi.release).toHaveBeenCalledWith("company-1", "rc-2026-09-28.1");
  });

  it("does nothing when the release is cancelled in the dialog", async () => {
    await render(<ReleasesView companyId="company-1" overview={releasesOverviewFixture()} fetchError={null} />);
    await click(buttonByText("Release Release from the app"));
    await click([...confirmDialog()!.querySelectorAll("button")].find((b) => b.textContent === "Cancel"));
    expect(mockReleasesApi.release).not.toHaveBeenCalled();
  });

  it("shows a pre-flight refusal in plain words", async () => {
    mockReleasesApi.release.mockRejectedValue(new Error("The release checkout has local changes."));
    await render(<ReleasesView companyId="company-1" overview={releasesOverviewFixture()} fetchError={null} />);
    await click(buttonByText("Release Release from the app"));
    await click([...confirmDialog()!.querySelectorAll("button")].find((b) => b.textContent === "Release Release from the app"));

    const alert = [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent);
    expect(alert).toContain("The release checkout has local changes.");
  });
});

describe("Rollback confirm", () => {
  it("rolls back only after the destructive confirm", async () => {
    await render(<ReleasesView companyId="company-1" overview={releasesOverviewFixture()} fetchError={null} />);
    await click(buttonByText("Roll back to this version"));

    const dialog = confirmDialog();
    expect(dialog?.textContent).toContain("Roll back to RAM management?");
    expect(dialog?.textContent).toContain(
      "Live moves from Run limits (live-2026-09-21.1) back to RAM management (live-2026-09-14.1).",
    );
    expect(dialog?.textContent).toContain("New agent runs pause");
    expect(mockReleasesApi.rollback).not.toHaveBeenCalled();

    await click([...dialog!.querySelectorAll("button")].find((b) => b.textContent === "Roll back"));
    expect(mockReleasesApi.rollback).toHaveBeenCalledWith("company-1", "live-2026-09-14.1");
  });
});

describe("Release progress", () => {
  const cases: [ReleaseProgressState, string][] = [
    ["checking", "Releasing Release from the app (rc-2026-09-28.1): checking"],
    ["holding", "holding new runs, 3 still running"],
    ["switching", "switching live"],
    ["restarting", "restarting live"],
    ["healthy", "Release from the app (rc-2026-09-28.1) is live and healthy"],
    ["rolled_back", "Rolled back. Release from the app (rc-2026-09-28.1) did not go live"],
    ["failed", "Release of Release from the app (rc-2026-09-28.1) failed"],
    ["cancelled", "Cancelled. Live was not changed"],
  ];

  it.each(cases)("renders %s", async (state, headline) => {
    const overview = releasesOverviewFixture({
      progress: releaseProgressFixture(state, state === "failed" ? { reason: "Tag rc-2026-09-28.1 has no title." } : {}),
    });
    await render(<ReleasesView companyId="company-1" overview={overview} fetchError={null} />);

    const panel = document.querySelector('[data-testid="release-progress"]')!;
    expect(panel.getAttribute("data-state")).toBe(state);
    expect(panel.querySelector('[role="status"]')?.textContent).toContain(headline);
    expect(!!buttonByText("Cancel")).toBe(state === "holding");
    if (state === "rolled_back") expect(panel.textContent).toContain("Live did not answer its health check within 2 minutes.");
    if (state === "failed") expect(panel.textContent).toContain("Tag rc-2026-09-28.1 has no title.");
    // Release and rollback wait while a job runs.
    const inProgress = ["checking", "holding", "switching", "restarting"].includes(state);
    expect(buttonByText("Release Release from the app")?.disabled).toBe(inProgress);
  });

  it("cancels while holding", async () => {
    const overview = releasesOverviewFixture({ progress: releaseProgressFixture("holding") });
    await render(<ReleasesView companyId="company-1" overview={overview} fetchError={null} />);
    await click(buttonByText("Cancel"));
    expect(mockReleasesApi.cancel).toHaveBeenCalledWith("company-1");
  });

  it("explains a lost connection while live restarts instead of showing an error", async () => {
    const overview = releasesOverviewFixture({ progress: releaseProgressFixture("restarting") });
    await render(<ReleasesView companyId="company-1" overview={overview} fetchError="Failed to fetch" />);
    expect(document.body.textContent).toContain("This page reconnects on its own.");
    expect([...document.querySelectorAll('[role="alert"]')].map((n) => n.textContent)).not.toContain("Failed to fetch");
  });
});
