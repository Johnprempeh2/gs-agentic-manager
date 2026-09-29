// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseProgressState } from "@/api/releases";
import { ApiError } from "@/api/client";
import { ConfirmProvider } from "@/context/ConfirmContext";
import {
  KEYSTONE_AGENT_ID,
  flaggedRunFixture,
  releaseProgressFixture,
  releasesOverviewFixture,
  restartReportFixture,
} from "@/fixtures/releaseFixtures";
import { queryKeys } from "@/lib/queryKeys";
import { Releases, ReleasesView } from "./Releases";

const mockReleasesApi = vi.hoisted(() => ({
  overview: vi.fn(),
  releaseNow: vi.fn(),
  rollback: vi.fn(),
  cancel: vi.fn(),
  override: vi.fn(),
  setFinishBeforeUpdate: vi.fn(),
  promote: vi.fn(),
}));
const mockReauthApi = vi.hoisted(() => ({ confirm: vi.fn() }));
const mockAccessApi = vi.hoisted(() => ({ getCurrentBoardAccess: vi.fn() }));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockHeartbeatsApi = vi.hoisted(() => ({ liveRunsForCompany: vi.fn() }));

vi.mock("@/api/releases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/releases")>()),
  releasesApi: mockReleasesApi,
}));
vi.mock("@/api/reauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/reauth")>()),
  reauthApi: mockReauthApi,
}));
vi.mock("@/api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("@/api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: mockHeartbeatsApi }));
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

function reauthDialog() {
  return document.querySelector('[data-slot="reauth-dialog"]');
}

async function typePassword(value: string) {
  const input = reauthDialog()!.querySelector('input[type="password"]') as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submitPassword() {
  await act(async () => {
    reauthDialog()!.querySelector("form")!.requestSubmit();
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
  mockReleasesApi.releaseNow.mockResolvedValue({ progress: releaseProgressFixture("checking") });
  mockReleasesApi.rollback.mockResolvedValue({
    progress: releaseProgressFixture("checking", { kind: "rollback", targetTag: "live-2026-09-14.1" }),
  });
  mockReleasesApi.cancel.mockResolvedValue({ progress: releaseProgressFixture("cancelled") });
  mockReleasesApi.override.mockResolvedValue({
    progress: releaseProgressFixture("holding", { overridden: true, waitingForFlaggedRuns: 0 }),
  });
  mockReleasesApi.setFinishBeforeUpdate.mockResolvedValue({ runId: "x", finishBeforeUpdate: true });
  mockAgentsApi.list.mockResolvedValue([{ id: KEYSTONE_AGENT_ID, name: "Keystone" }]);
  mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
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
    expect(buttonByText("Release now")).toBeUndefined();
    expect(mockReleasesApi.overview).not.toHaveBeenCalled();
  });

  it("hides the page when board access cannot be read (agent keys)", async () => {
    mockAccessApi.getCurrentBoardAccess.mockRejectedValue(new Error("Unauthorized"));
    await render(<Releases />);

    expect(document.body.textContent).toContain("Releases are for the board");
    expect(mockReleasesApi.overview).not.toHaveBeenCalled();
  });


  it("shows live, next version and history to the board", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue(BOARD);
    await render(<Releases />);

    const live = document.querySelector('[data-testid="release-live"]')!;
    expect(live.textContent).toContain("Run limits");
    expect(live.textContent).toContain("live-2026-09-21.1");
    expect(live.textContent).toContain("c77a43c");
    expect(live.textContent).toContain("Healthy");
    expect(live.textContent).toContain("John");

    expect(document.querySelector('[data-testid="release-next"]')).toBeTruthy();
    expect(document.body.textContent).not.toContain("Ready to go live");
    expect(buttonByText("Release now")).toBeTruthy();

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

  it("offers no rollback or promote for a version that never ran (GRE-239)", async () => {
    const base = releasesOverviewFixture();
    const failed = { ...base.history[1], tag: "live-2026-09-29.2", title: "Failed release", neverRan: true };
    await render(
      <ReleasesView companyId="company-1" overview={{ ...base, history: [failed, ...base.history] }} fetchError={null} />,
    );
    const row = document.querySelector('[data-testid="release-history-live-2026-09-29.2"]')!;
    expect(row.textContent).toContain("Never ran");
    expect(row.textContent).not.toContain("Roll back to this version");
    expect(row.textContent).not.toContain("Promote to Stable");
    expect(
      document.querySelector('[data-testid="release-history-live-2026-09-14.1"]')?.textContent,
    ).toContain("Roll back to this version");
  });

  it("says in plain words when release is off on this server", async () => {
    await render(
      <ReleasesView
        companyId="company-1"
        overview={releasesOverviewFixture({ disabledReason: "This server does not run from the live checkout." })}
        fetchError={null}
      />,
    );
    const banner = document.querySelector('[data-testid="release-disabled"]')!;
    expect(banner.textContent).toContain("Release is off on this server.");
    expect(banner.textContent).toContain("This server does not run from the live checkout.");
    expect(buttonByText("Release now")?.disabled).toBe(true);
    expect(buttonByText("Roll back to this version")?.disabled).toBe(true);
  });
});

describe("Dev (next version)", () => {
  it("lists the changes, the title and the changelog", async () => {
    await render(<ReleasesView companyId="company-1" overview={releasesOverviewFixture()} fetchError={null} />);

    const next = document.querySelector('[data-testid="release-next"]')!;
    // The channel is named Dev (GRE-132), with "next version" as the subline.
    expect(next.querySelector('[data-slot="card-title"]')?.textContent).toBe("Dev · next version");
    expect(next.textContent).not.toContain("Next version");
    expect(next.textContent).toContain("Release from the app");
    expect(next.textContent).toContain("Since live-2026-09-21.1");
    expect(next.textContent).toContain("main at 4f2a9d1");
    expect(next.textContent).toContain("Fork CI passed");
    expect(next.textContent).toContain("Features");
    expect(next.textContent).toContain("What's new in the sidebar");
    expect(next.textContent).toContain("Fixes");
    expect(next.textContent).toContain("3 changes merged");

    const changes = [...next.querySelectorAll('[data-testid="release-next-changes"] li')].map((li) => li.textContent);
    expect(changes).toHaveLength(3);
    expect(changes[0]).toContain("Releases page and What's new in the sidebar");
    expect(changes[0]).toContain("#51 · GRE-122");
    expect(changes[2]).toContain("Fix");
  });

  it("shows who set the title; the board sees it but cannot edit it (Keystone edits it)", async () => {
    await render(<ReleasesView companyId="company-1" overview={releasesOverviewFixture()} fetchError={null} />);

    const source = document.querySelector('[data-testid="release-next-title-source"]')!;
    expect(source.textContent).toContain("Title set by Keystone");
    const next = document.querySelector('[data-testid="release-next"]')!;
    expect(next.querySelector("input, textarea")).toBeNull();
    expect([...next.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(["Release now"]);
  });

  it("says the title is a proposal until Keystone changes it", async () => {
    const base = releasesOverviewFixture();
    const overview = releasesOverviewFixture({ next: { ...base.next!, titleEditedBy: null, titleEditedAt: null } });
    await render(<ReleasesView companyId="company-1" overview={overview} fetchError={null} />);
    expect(document.querySelector('[data-testid="release-next-title-source"]')?.textContent).toBe(
      "Title proposed from the pull request titles. Keystone can change it.",
    );
  });

  it("says main is the same as live when there is nothing new", async () => {
    await render(
      <ReleasesView companyId="company-1" overview={releasesOverviewFixture({ next: null })} fetchError={null} />,
    );
    const next = document.querySelector('[data-testid="release-next"]')!;
    expect(next.textContent).toContain("Main is the same as live.");
    expect(buttonByText("Release now")?.disabled).toBe(true);
  });
});

describe("Release now confirm", () => {
  it("says the tag is cut from origin/main, CI is checked, runs are held and resume", async () => {
    await render(<ReleasesView companyId="company-1" overview={releasesOverviewFixture()} fetchError={null} />);
    await click(buttonByText("Release now"));

    const dialog = confirmDialog();
    expect(dialog?.textContent).toContain("Release Release from the app?");
    expect(dialog?.textContent).toContain("Live moves from Run limits (live-2026-09-21.1) to Release from the app.");
    expect(dialog?.textContent).toContain("Releases page with one-click release and rollback");
    expect(dialog?.textContent).toContain("Fix: Update live card works after the preview is stopped");
    expect(dialog?.textContent).toContain("The tag is cut from origin/main.");
    expect(dialog?.textContent).toContain("Fork CI on main is checked first");
    expect(dialog?.textContent).toContain("New runs are held.");
    expect(dialog?.textContent).toContain("Running runs are checkpointed and resume after the update");
    expect(mockReleasesApi.releaseNow).not.toHaveBeenCalled();

    await click([...dialog!.querySelectorAll("button")].find((b) => b.textContent === "Release now"));
    expect(mockReleasesApi.releaseNow).toHaveBeenCalledWith("company-1", undefined);
  });

  it("does nothing when the release is cancelled in the dialog", async () => {
    await render(<ReleasesView companyId="company-1" overview={releasesOverviewFixture()} fetchError={null} />);
    await click(buttonByText("Release now"));
    await click([...confirmDialog()!.querySelectorAll("button")].find((b) => b.textContent === "Cancel"));
    expect(mockReleasesApi.releaseNow).not.toHaveBeenCalled();
  });

  it("shows a refusal in plain words", async () => {
    mockReleasesApi.releaseNow.mockRejectedValue(new Error("Fork CI on main has not passed."));
    await render(<ReleasesView companyId="company-1" overview={releasesOverviewFixture()} fetchError={null} />);
    await click(buttonByText("Release now"));
    await click([...confirmDialog()!.querySelectorAll("button")].find((b) => b.textContent === "Release now"));

    const alert = [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent);
    expect(alert).toContain("Fork CI on main has not passed.");
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
    expect(dialog?.textContent).toContain("New runs are held.");
    expect(mockReleasesApi.rollback).not.toHaveBeenCalled();

    await click([...dialog!.querySelectorAll("button")].find((b) => b.textContent === "Roll back"));
    expect(mockReleasesApi.rollback).toHaveBeenCalledWith("company-1", "live-2026-09-14.1", undefined);
  });
});

describe("Release progress", () => {
  const cases: [ReleaseProgressState, string][] = [
    ["checking", "Releasing Release from the app (rc-2026-09-28.1): checking"],
    ["holding", "holding new runs, waiting for 1 run marked finish before update"],
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
    expect(buttonByText("Release now")?.disabled).toBe(inProgress);
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

describe("Runs marked finish before update", () => {
  it("lists flagged runs with the progress and releases without waiting after a confirm", async () => {
    const overview = releasesOverviewFixture({
      progress: releaseProgressFixture("holding"),
      flaggedRuns: [flaggedRunFixture()],
    });
    await render(<ReleasesView companyId="company-1" overview={overview} fetchError={null} />);

    const flagged = document.querySelector('[data-testid="release-progress-flagged"]')!;
    expect(flagged.textContent).toContain("Ridge");
    expect(flagged.textContent).toContain("on GRE-130");
    expect(flagged.textContent).toContain("Mid database migration");
    expect(flagged.textContent).toContain("Marked by Ridge");

    await click(buttonByText("Release without waiting"));
    const dialog = confirmDialog();
    expect(dialog?.textContent).toContain("1 run marked finish before update is still running.");
    expect(mockReleasesApi.override).not.toHaveBeenCalled();
    await click([...dialog!.querySelectorAll("button")].find((b) => b.textContent === "Release without waiting"));
    expect(mockReleasesApi.override).toHaveBeenCalledWith("company-1");
  });

  it("hides the override when nothing is waited for", async () => {
    const overview = releasesOverviewFixture({
      progress: releaseProgressFixture("holding", { waitingForFlaggedRuns: 1, overridden: true }),
      flaggedRuns: [flaggedRunFixture()],
    });
    await render(<ReleasesView companyId="company-1" overview={overview} fetchError={null} />);
    expect(buttonByText("Release without waiting")).toBeUndefined();
    expect(document.querySelector('[data-testid="release-progress"] [role="status"]')?.textContent).toContain(
      "not waiting for flagged runs",
    );
  });

  it("lets the board mark a running run and clear a flagged one", async () => {
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      { id: "run-running-1", status: "running", agentId: "agent-mica", agentName: "Mica" },
      { id: "run-queued-1", status: "queued", agentId: "agent-flint", agentName: "Flint" },
      { id: "4d5e6f70-flagged-run", status: "running", agentId: "agent-ridge", agentName: "Ridge" },
    ]);
    const overview = releasesOverviewFixture({ flaggedRuns: [flaggedRunFixture()] });
    await render(<ReleasesView companyId="company-1" overview={overview} fetchError={null} />);

    const card = document.querySelector('[data-testid="release-flagged-runs"]')!;
    // Queued runs are not listed; the flagged run shows once.
    expect(card.textContent).not.toContain("Flint");
    expect(card.querySelectorAll("li")).toHaveLength(2);

    const flaggedRow = card.querySelector('[data-testid="release-run-4d5e6f70-flagged-run"]')!;
    expect(flaggedRow.textContent).toContain("Finish before update");
    await click([...flaggedRow.querySelectorAll("button")].find((b) => b.textContent === "Clear"));
    expect(mockReleasesApi.setFinishBeforeUpdate).toHaveBeenCalledWith("4d5e6f70-flagged-run", false);

    const runningRow = card.querySelector('[data-testid="release-run-run-running-1"]')!;
    await click([...runningRow.querySelectorAll("button")].find((b) => b.textContent === "Mark finish before update"));
    expect(mockReleasesApi.setFinishBeforeUpdate).toHaveBeenCalledWith("run-running-1", true);
  });
});

describe("Restart report", () => {
  it("shows what resumed and what was lost on the progress panel", async () => {
    const overview = releasesOverviewFixture({ progress: releaseProgressFixture("healthy") });
    await render(<ReleasesView companyId="company-1" overview={overview} fetchError={null} />);

    const report = document.querySelector('[data-testid="release-progress"] [data-testid="restart-report"]')!;
    expect(report.textContent).toContain("2 runs resumed after the update (1 kept running, 1 continued from a checkpoint).");
    expect(report.textContent).toContain("1 run lost (needs recovery): 9c8d7e6");
  });

  it("shows the report on that release in History", async () => {
    await render(<ReleasesView companyId="company-1" overview={releasesOverviewFixture()} fetchError={null} />);
    const liveEntry = document.querySelector('[data-testid="release-history-live-2026-09-21.1"]')!;
    expect(liveEntry.querySelector('[data-testid="restart-report"]')?.textContent).toContain("2 runs resumed");
    const older = document.querySelector('[data-testid="release-history-live-2026-09-14.1"]')!;
    expect(older.querySelector('[data-testid="restart-report"]')).toBeNull();
  });

  it("says nothing was lost only when no runs were lost or kept running", async () => {
    const overview = releasesOverviewFixture({
      progress: releaseProgressFixture("healthy", {
        restartReport: restartReportFixture({
          lostRunIds: [],
          adoptedRunIds: [],
          resumedRunIds: ["e5f6a7b8-run-checkpoint"],
        }),
      }),
    });
    await render(<ReleasesView companyId="company-1" overview={overview} fetchError={null} />);
    const text = document.querySelector('[data-testid="release-progress"]')?.textContent;
    expect(text).toContain("Nothing was lost.");
    expect(
      document.querySelector('[data-testid="release-progress"] [data-testid="restart-report-adopted-caveat"]'),
    ).toBeNull();
  });

  // GRE-246: a kept-running run's result is not captured, so the page must not promise nothing was lost.
  it("does not say nothing was lost when a run kept running", async () => {
    const overview = releasesOverviewFixture({
      progress: releaseProgressFixture("healthy", { restartReport: restartReportFixture({ lostRunIds: [] }) }),
    });
    await render(<ReleasesView companyId="company-1" overview={overview} fetchError={null} />);
    const text = document.querySelector('[data-testid="release-progress"]')?.textContent;
    expect(text).not.toContain("Nothing was lost.");
    expect(text).toContain("No run stopped.");
    expect(
      document.querySelector('[data-testid="release-progress"] [data-testid="restart-report-adopted-caveat"]')
        ?.textContent,
    ).toContain(
      "When it ends, it is marked lost and runs once more.",
    );
  });
});

describe("Password prompt (login mode)", () => {
  const reauthRequired = () => new ApiError("Password needed.", 403, { code: "reauth_required" });
  const view = () => <ReleasesView companyId="company-1" overview={releasesOverviewFixture()} fetchError={null} />;

  async function confirmRelease() {
    await click(buttonByText("Release now"));
    await click([...confirmDialog()!.querySelectorAll("button")].find((b) => b.textContent === "Release now"));
  }

  it("asks for the password on 403 reauth_required and retries with the token header", async () => {
    mockReleasesApi.releaseNow.mockRejectedValueOnce(reauthRequired());
    mockReauthApi.confirm.mockResolvedValue({ token: "tok-1", expiresAt: "2026-09-28T23:10:00.000Z" });
    await render(view());
    await confirmRelease();

    expect(reauthDialog()?.textContent).toContain("Enter your password");
    expect(reauthDialog()?.textContent).toContain("To release a version");
    expect(mockReleasesApi.releaseNow).toHaveBeenCalledTimes(1);

    await typePassword("secret");
    await submitPassword();

    expect(mockReauthApi.confirm).toHaveBeenCalledWith("release", "secret");
    expect(mockReleasesApi.releaseNow).toHaveBeenCalledTimes(2);
    expect(mockReleasesApi.releaseNow).toHaveBeenLastCalledWith("company-1", { headers: { "X-GSAM-Reauth": "tok-1" } });
    expect(reauthDialog()).toBeNull();
  });

  it("says a wrong password in plain words and keeps the prompt open", async () => {
    mockReleasesApi.releaseNow.mockRejectedValueOnce(reauthRequired());
    mockReauthApi.confirm.mockRejectedValue(new ApiError("x", 403, { code: "reauth_invalid_password" }));
    await render(view());
    await confirmRelease();
    await typePassword("wrong");
    await submitPassword();

    expect(reauthDialog()?.textContent).toContain("That password is not right. Try again.");
    expect(mockReleasesApi.releaseNow).toHaveBeenCalledTimes(1);
  });

  it("says when too many wrong passwords locked it for 15 minutes", async () => {
    mockReleasesApi.releaseNow.mockRejectedValueOnce(reauthRequired());
    mockReauthApi.confirm.mockRejectedValue(new ApiError("x", 429, { code: "reauth_locked" }));
    await render(view());
    await confirmRelease();
    await typePassword("wrong");
    await submitPassword();

    expect(reauthDialog()?.textContent).toContain("Too many wrong passwords. Try again in 15 minutes.");
    expect(mockReleasesApi.releaseNow).toHaveBeenCalledTimes(1);
  });

  it("retries with no header when the server says no password is needed", async () => {
    mockReleasesApi.releaseNow.mockRejectedValueOnce(reauthRequired());
    mockReauthApi.confirm.mockRejectedValue(new ApiError("x", 409, { code: "reauth_not_needed" }));
    await render(view());
    await confirmRelease();
    await typePassword("secret");
    await submitPassword();

    expect(mockReleasesApi.releaseNow).toHaveBeenCalledTimes(2);
    expect(mockReleasesApi.releaseNow).toHaveBeenLastCalledWith("company-1", undefined);
    expect(reauthDialog()).toBeNull();
  });

  it("does not release and shows no error when the prompt is cancelled", async () => {
    mockReleasesApi.releaseNow.mockRejectedValueOnce(reauthRequired());
    await render(view());
    await confirmRelease();
    await click([...reauthDialog()!.querySelectorAll("button")].find((b) => b.textContent === "Cancel"));

    expect(reauthDialog()).toBeNull();
    expect(mockReleasesApi.releaseNow).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("asks for the password on rollback too", async () => {
    mockReleasesApi.rollback.mockRejectedValueOnce(reauthRequired());
    mockReauthApi.confirm.mockResolvedValue({ token: "tok-2", expiresAt: "2026-09-28T23:10:00.000Z" });
    await render(view());
    await click(buttonByText("Roll back to this version"));
    await click([...confirmDialog()!.querySelectorAll("button")].find((b) => b.textContent === "Roll back"));

    expect(reauthDialog()?.textContent).toContain("To roll back");
    await typePassword("secret");
    await submitPassword();

    expect(mockReauthApi.confirm).toHaveBeenCalledWith("rollback", "secret");
    expect(mockReleasesApi.rollback).toHaveBeenLastCalledWith("company-1", "live-2026-09-14.1", {
      headers: { "X-GSAM-Reauth": "tok-2" },
    });
  });
});

describe("Promote to Stable (GRE-127)", () => {
  function promoteDialog() {
    return document.querySelector('[data-testid="promote-dialog"]');
  }

  async function typeNotes(value: string) {
    const input = promoteDialog()!.querySelector("textarea") as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function submitNotes() {
    await act(async () => {
      promoteDialog()!.querySelector("form")!.requestSubmit();
    });
    await flush();
  }

  function withStable(stableTag: string | null) {
    const overview = releasesOverviewFixture();
    return { ...overview, history: overview.history.map((entry, i) => (i === 1 ? { ...entry, stableTag } : entry)) };
  }

  async function openPromote(tag: string) {
    const row = document.querySelector(`[data-testid="release-history-${tag}"]`)!;
    await click([...row.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Promote to Stable"));
  }

  it("marks releases already on Stable and offers promote only on the others", async () => {
    await render(<ReleasesView companyId="company-1" overview={withStable("stable-2026-09-22.1")} fetchError={null} />);
    const older = document.querySelector('[data-testid="release-history-live-2026-09-14.1"]')!;
    expect(older.textContent).toContain("Stable as stable-2026-09-22.1");
    expect([...older.querySelectorAll("button")].map((b) => b.textContent?.trim())).not.toContain("Promote to Stable");
    const current = document.querySelector('[data-testid="release-history-live-2026-09-21.1"]')!;
    expect([...current.querySelectorAll("button")].map((b) => b.textContent?.trim())).toContain("Promote to Stable");
  });

  it("asks for the client notes and sends them with the live tag", async () => {
    mockReleasesApi.promote.mockResolvedValue({ stable: { tag: "stable-2026-09-29.1", commit: "abc", liveTag: "live-2026-09-14.1" } });
    await render(<ReleasesView companyId="company-1" overview={withStable(null)} fetchError={null} />);
    await openPromote("live-2026-09-14.1");

    expect(promoteDialog()?.textContent).toContain("Promote RAM management to Stable?");
    expect(promoteDialog()?.textContent).toContain("Client notes");
    await typeNotes("Faster board.");
    await submitNotes();

    expect(mockReleasesApi.promote).toHaveBeenCalledWith("company-1", "live-2026-09-14.1", "Faster board.", undefined);
    expect(promoteDialog()).toBeNull();
  });

  it("shows the server's refusal in the dialog and keeps it open", async () => {
    mockReleasesApi.promote
      .mockRejectedValue(new Error("the client notes contain an issue number (GRE-123); clients must not see internal numbers"));
    await render(<ReleasesView companyId="company-1" overview={withStable(null)} fetchError={null} />);
    await openPromote("live-2026-09-14.1");
    await typeNotes("Fix GRE-123");
    await submitNotes();

    expect(promoteDialog()?.querySelector('[role="alert"]')?.textContent).toMatch(/issue number/);
  });

  it("asks for the password to promote in login mode", async () => {
    mockReleasesApi.promote
      .mockRejectedValueOnce(new ApiError("Password needed.", 403, { code: "reauth_required" }))
      .mockResolvedValue({ stable: { tag: "stable-2026-09-29.1", commit: "abc", liveTag: "live-2026-09-14.1" } });
    mockReauthApi.confirm.mockResolvedValue({ token: "tok-3", expiresAt: "2026-09-28T23:10:00.000Z" });
    await render(<ReleasesView companyId="company-1" overview={withStable(null)} fetchError={null} />);
    await openPromote("live-2026-09-14.1");
    await typeNotes("Faster board.");
    await submitNotes();

    expect(reauthDialog()?.textContent).toContain("To promote a version");
    await typePassword("secret");
    await submitPassword();
    expect(mockReauthApi.confirm).toHaveBeenCalledWith("promote", "secret");
    expect(mockReleasesApi.promote).toHaveBeenLastCalledWith("company-1", "live-2026-09-14.1", "Faster board.", {
      headers: { "X-GSAM-Reauth": "tok-3" },
    });
  });
});
