// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebsiteProductionStatus, WebsiteSite } from "@greatstone/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ production: vi.fn(), deploy: vi.fn(), rollbackLive: vi.fn() }));
vi.mock("../../api/website", async () => {
  const actual = await vi.importActual<typeof import("../../api/website")>("../../api/website");
  return { ...actual, websiteModuleApi: api };
});

import { runLabel, waitingCount, WebsiteDeployPanel } from "./WebsiteDeployPanel";

const site = { id: "site-1", companyId: "co-1", netlifySiteId: "3b1e97e6-e184-4251-badd-deed532be3ab" } as WebsiteSite;
const STAGED = "a".repeat(40);

function status(over: Partial<WebsiteProductionStatus> = {}): WebsiteProductionStatus {
  return {
    staging: { commit: STAGED, release: 9 },
    live: { commit: "d".repeat(40), release: 8, deployId: "e".repeat(24), publishedAt: "2026-11-09T06:04:22.415Z" },
    commits: [{ sha: STAGED, title: "Voice guide on every page" }],
    blockers: [],
    rollback: { deployId: "b".repeat(24), commit: null, publishedAt: "2026-11-08T10:00:00.000Z" },
    runs: [],
    canDeploy: true,
    workflowReady: true,
    publicKey: "k".repeat(43),
    problems: [],
    ...over,
  };
}

async function mount(value: WebsiteProductionStatus) {
  api.production.mockResolvedValue(value);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { createRoot(el).render(<QueryClientProvider client={client}><WebsiteDeployPanel companyId="co-1" site={site} /></QueryClientProvider>); });
  for (let i = 0; i < 5 && el.textContent?.includes("Reading Live"); i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  return el;
}

const buttons = (root: ParentNode) => [...root.querySelectorAll("button")];

describe("WebsiteDeployPanel", () => {
  afterEach(() => { vi.clearAllMocks(); document.body.innerHTML = ""; });

  it("shows John what goes live and starts Deploy only after he confirms", async () => {
    api.deploy.mockResolvedValue({ request: "r1" });
    const el = await mount(status());
    expect(el.textContent).toContain("Waiting to go live (2)");
    expect(el.textContent).toContain("content release 9 (live has 8)");
    expect(el.textContent).toContain("aaaaaaa Voice guide on every page");
    await act(async () => { buttons(el).find((b) => b.textContent === "Deploy to greatstoneint.com")!.click(); });
    expect(api.deploy).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Deploy staging to greatstoneint.com?");
    await act(async () => { buttons(document.body).find((b) => b.textContent === "Deploy")!.click(); });
    expect(api.deploy).toHaveBeenCalledWith("co-1", "site-1", STAGED, 9);
  });

  it("gives everyone else no Deploy or Roll back button", async () => {
    const el = await mount(status({ canDeploy: false, publicKey: null }));
    expect(buttons(el).map((b) => b.textContent)).toEqual([]);
    expect(el.textContent).toContain("Only John can Deploy or Roll back.");
  });

  it("holds Deploy while staging fails a check, a run is going, or nothing waits", async () => {
    const disabled = async (value: WebsiteProductionStatus) =>
      buttons(await mount(value)).find((b) => b.textContent === "Deploy to greatstoneint.com")!.disabled;
    expect(await disabled(status({ blockers: ["Staging's /shop shows no prices."] }))).toBe(true);
    expect(await disabled(status({ runs: [{ id: 1, action: "deploy", request: "r", status: "in_progress", conclusion: null, createdAt: "", url: "https://github.com/x", steps: [] }] }))).toBe(true);
    expect(await disabled(status({ commits: [], staging: { commit: STAGED, release: 8 } }))).toBe(true);
    expect(await disabled(status({ workflowReady: false }))).toBe(true);
    expect(await disabled(status())).toBe(false);
  });

  it("names runs in plain words and counts what waits", () => {
    const run = { id: 1, request: "r", createdAt: "", url: "" };
    expect(runLabel({ ...run, action: "deploy", status: "in_progress", conclusion: null })).toBe("Deploying");
    expect(runLabel({ ...run, action: "deploy", status: "completed", conclusion: "failure" })).toBe("Deploy failed");
    expect(runLabel({ ...run, action: "rollback", status: "completed", conclusion: "success" })).toBe("Rolled back");
    expect(waitingCount(status({ commits: [] }))).toBe(1);
  });
});
