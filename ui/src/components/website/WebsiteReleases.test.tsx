// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebsiteRelease, WebsiteSite } from "@greatstone/shared";
import { ApiError } from "../../api/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const moduleMock = vi.hoisted(() => ({
  releases: vi.fn(),
  release: vi.fn(),
  publish: vi.fn(),
  retryPlan: vi.fn(),
  retry: vi.fn(),
  rollbackPlan: vi.fn(),
  rollback: vi.fn(),
}));
const canManage = vi.hoisted(() => ({ value: true }));
vi.mock("../../api/website", async () => {
  const actual = await vi.importActual<typeof import("../../api/website")>("../../api/website");
  return { ...actual, websiteModuleApi: moduleMock };
});
vi.mock("../../api/access", () => ({
  accessApi: { listUserDirectory: vi.fn().mockResolvedValue({ users: [{ principalId: "user-1", status: "active", user: { id: "user-1", name: "Ada", email: null, image: null } }] }) },
}));
vi.mock("./WebsiteSetup", () => ({ useCanManageWebsite: () => ({ canManage: canManage.value, isLoading: false }) }));

import { WebsiteReleases, releaseDate } from "./WebsiteReleases";

const site: WebsiteSite = {
  id: "site-1",
  companyId: "co-1",
  name: "Greatstone",
  domain: "www.greatstone.example",
  repoUrl: null,
  netlifySiteId: "netlify-123",
  hasNetlifyToken: true,
  blobsStoreName: "gsam-content",
  engineVersion: null,
  releaseSchemaVersion: 1,
  propertyId: "prop-1",
  editorOrigins: [],
  checkPaths: ["/"],
  liveReleaseId: "rel-41",
  archivedAt: null,
  createdAt: "2026-10-23T09:00:00.000Z",
  updatedAt: "2026-10-23T09:00:00.000Z",
};

function release(overrides: Partial<WebsiteRelease> = {}): WebsiteRelease {
  return {
    id: "rel-42",
    companyId: "co-1",
    siteId: "site-1",
    number: 42,
    kind: "publish",
    rollbackOfReleaseId: null,
    status: "live",
    pendingReason: null,
    blobsKey: "releases/42.json",
    releaseSha256: "abc",
    checks: [],
    deploy: null,
    publishedByUserId: "user-1",
    switchedAt: "2026-10-23T10:00:00.000Z",
    liveAt: null,
    failedAt: null,
    createdAt: "2026-10-23T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:00.000Z",
    ...overrides,
  };
}

const live41 = release({ id: "rel-41", number: 41, status: "live", liveAt: "2026-10-22T14:05:00.000Z" });
const replaced40 = release({ id: "rel-40", number: 40, status: "superseded", liveAt: "2026-10-21T09:30:00.000Z" });

function conflict(code: string, message = "Refused") {
  return new ApiError(message, 409, { error: message, code });
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function wait(ms: number) {
  return act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

function button(label: string) {
  return [...document.body.querySelectorAll("button")].find((entry) => entry.textContent === label);
}

async function click(label: string) {
  const target = button(label);
  if (!target) throw new Error(`No button "${label}"`);
  await act(async () => target.click());
  await flush();
}

describe("WebsiteReleases", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    canManage.value = true;
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  async function render(pollMs = 20) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <WebsiteReleases companyId="co-1" site={site} pollMs={pollMs} />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  it("lists releases with the copy's status labels, and an empty state", async () => {
    moduleMock.releases.mockResolvedValue([]);
    await render();
    expect(container.textContent).toContain("No releases yet");

    moduleMock.releases.mockResolvedValue([live41, replaced40]);
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    const labels = [...container.querySelectorAll("[data-testid=website-release-status]")].map((node) => node.textContent);
    expect(labels).toEqual(["Live", "Replaced"]);
    expect(container.textContent).toContain("Release 41");
    expect(container.textContent).toContain("Ada");
  });

  it("confirms a Publish with its cost, then polls the release and stops when it is live", async () => {
    const building = release({ status: "building", switchedAt: null });
    moduleMock.releases.mockResolvedValueOnce([live41]).mockResolvedValue([building, live41]);
    moduleMock.publish.mockResolvedValue(building);
    moduleMock.release
      .mockResolvedValueOnce(release({ status: "uploading" }))
      .mockResolvedValueOnce(release({ status: "switched" }))
      .mockResolvedValue(release({ status: "live", liveAt: "2026-10-23T10:01:00.000Z", checks: [{ kind: "verify", name: "/", ok: true }] }));
    await render();

    await click("Publish");
    expect(document.body.textContent).toContain("Publish to Greatstone?");
    expect(document.body.textContent).toContain("costs about 15 credits");
    await click("Publish now");
    expect(moduleMock.publish).toHaveBeenCalledWith("co-1", "site-1");
    expect(container.querySelector("[data-testid=website-release-progress]")).not.toBeNull();

    await wait(200);
    await flush();
    const calls = moduleMock.release.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(3);
    await wait(200);
    expect(moduleMock.release.mock.calls.length).toBe(calls);
  });

  it("shows the copy, not a raw error, when a Publish is already running", async () => {
    const running = release({ id: "rel-43", number: 43, status: "uploading", createdAt: new Date(Date.now() - 4 * 60_000).toISOString() });
    moduleMock.releases.mockResolvedValueOnce([live41]).mockResolvedValue([running, live41]);
    moduleMock.release.mockResolvedValue(running);
    moduleMock.publish.mockRejectedValue(conflict("website_publish_running", "A publish is running for this site. Wait for it to finish."));
    await render(60_000);
    await click("Publish");
    await click("Publish now");
    expect(container.querySelector("[data-testid=website-publish-error]")?.textContent).toBe(
      "A Publish is running for this site, started by Ada 4 minutes ago. Wait for it to finish, then Publish again.",
    );
  });

  it("Pending case A: the check failed, Retry check is free and sends no confirm", async () => {
    const pending = release({
      status: "pending",
      pendingReason: "verify_failed",
      deploy: { method: "build", requestedAt: "2026-10-23T10:00:00.000Z", deployId: "d1", commitRef: "c1", state: "ready" },
      checks: [{ kind: "verify", name: "/about", ok: false, message: "/about shows release 41, not 42." }],
    });
    moduleMock.releases.mockResolvedValue([pending, live41]);
    moduleMock.retryPlan.mockResolvedValue({ action: "verify", costsCredits: false, reason: "The rebuild worked." });
    moduleMock.retry.mockResolvedValue(pending);
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("Release 42 is pending");
    expect(text).toContain("The site rebuilt, but 1 check page does not show Release 42 yet.");
    expect(text).toContain("/about shows Release 41");
    expect(container.querySelector("[data-testid=website-retry-cost]")?.textContent).toBe("Checks the live pages again. Free. Safe to repeat.");
    await click("Retry check");
    expect(moduleMock.retry).toHaveBeenCalledWith("co-1", "site-1", "rel-42", false);
  });

  it("Pending case B: the build failed, the cost shows first and Rebuild again needs a confirm", async () => {
    const pending = release({
      status: "pending",
      pendingReason: "build_failed",
      deploy: { method: "build", requestedAt: "2026-10-23T10:00:00.000Z", deployId: "d1", commitRef: null, state: "error", errorMessage: "npm ERR" },
    });
    moduleMock.releases.mockResolvedValue([pending, live41]);
    moduleMock.retryPlan.mockResolvedValue({ action: "build", costsCredits: true, reason: "The rebuild failed." });
    moduleMock.retry.mockResolvedValue(pending);
    await render();
    expect(container.textContent).toContain("The site did not rebuild. Visitors still see Release 41.");
    expect(container.querySelector("[data-testid=website-retry-cost]")?.textContent).toBe("About 15 credits.");
    await click("Rebuild again");
    expect(moduleMock.retry).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Start one more rebuild? It costs about 15 credits.");
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>("[role=alertdialog] button")].find((entry) => entry.textContent === "Rebuild again")!;
    await act(async () => confirm.click());
    await flush();
    expect(moduleMock.retry).toHaveBeenCalledWith("co-1", "site-1", "rel-42", true);
  });

  it("asks for the rebuild confirm when the API answers 409 website_rebuild_needs_confirm", async () => {
    const pending = release({ status: "pending", pendingReason: "verify_failed", checks: [] });
    moduleMock.releases.mockResolvedValue([pending, live41]);
    moduleMock.retryPlan
      .mockResolvedValueOnce({ action: "verify", costsCredits: false, reason: "The rebuild is still running." })
      .mockResolvedValue({ action: "build", costsCredits: true, reason: "The rebuild failed." });
    moduleMock.retry.mockRejectedValueOnce(conflict("website_rebuild_needs_confirm")).mockResolvedValue(pending);
    await render();
    await click("Retry check");
    expect(moduleMock.retry).toHaveBeenCalledWith("co-1", "site-1", "rel-42", false);
    expect(document.body.textContent).toContain("Start one more rebuild? It costs about 15 credits.");
    expect(document.body.querySelector("[role=alert]")).toBeNull();
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>("[role=alertdialog] button")].find((entry) => entry.textContent === "Rebuild again")!;
    await act(async () => confirm.click());
    await flush();
    expect(moduleMock.retry).toHaveBeenLastCalledWith("co-1", "site-1", "rel-42", true);
  });

  it("rollback that restores the old deploy: no cost line, POST without confirmRebuild", async () => {
    moduleMock.releases.mockResolvedValue([live41, replaced40]);
    moduleMock.rollbackPlan.mockResolvedValue({ action: "restore", costsCredits: false, reason: "No credits." });
    moduleMock.rollback.mockResolvedValue(release({ id: "rel-43", number: 43, kind: "rollback", rollbackOfReleaseId: "rel-40", status: "building" }));
    await render();
    await click("Roll back to this release");
    expect(document.body.textContent).toContain("Roll back to Release 40?");
    expect(document.body.querySelector("[data-testid=website-rollback-body]")?.textContent).toBe(
      `Visitors will see the site as it was on ${releaseDate(replaced40.liveAt!)}. This rebuilds the site. Your drafts and newer changes stay in GSAM; nothing is deleted.`,
    );
    await click("Roll back");
    expect(moduleMock.rollback).toHaveBeenCalledWith("co-1", "site-1", "rel-40", false);
  });

  it("rollback that rebuilds: the cost line shows and the POST confirms the rebuild", async () => {
    moduleMock.releases.mockResolvedValue([live41, replaced40]);
    moduleMock.rollbackPlan.mockResolvedValue({ action: "build", costsCredits: true, reason: "The code changed." });
    moduleMock.rollback.mockResolvedValue(release({ id: "rel-43", number: 43, kind: "rollback", rollbackOfReleaseId: "rel-40", status: "building" }));
    await render();
    await click("Roll back to this release");
    expect(document.body.querySelector("[data-testid=website-rollback-body]")?.textContent).toBe(
      `Visitors will see the site as it was on ${releaseDate(replaced40.liveAt!)}. This rebuilds the site and costs about 15 credits. Your drafts and newer changes stay in GSAM; nothing is deleted.`,
    );
    await click("Roll back");
    expect(moduleMock.rollback).toHaveBeenCalledWith("co-1", "site-1", "rel-40", true);
  });

  it("shows the API's refusal plainly when a person cannot Publish here", async () => {
    moduleMock.releases.mockResolvedValue([live41]);
    moduleMock.publish.mockRejectedValue(new ApiError("Only a person can publish, retry or roll back a website, by clicking in GSAM.", 403, { code: "website_publish_person_only" }));
    await render();
    await click("Publish");
    await click("Publish now");
    expect(container.querySelector("[data-testid=website-publish-error]")?.textContent).toBe(
      "Only a person can publish, retry or roll back a website, by clicking in GSAM.",
    );
  });

  it("hides Publish, Retry and Roll back from people without Publish rights", async () => {
    canManage.value = false;
    moduleMock.releases.mockResolvedValue([live41, replaced40]);
    await render();
    expect(button("Publish")).toBeUndefined();
    expect(button("Roll back to this release")).toBeUndefined();
    expect(container.textContent).toContain("A person with Publish rights approves them and starts the Publish.");
  });
});
