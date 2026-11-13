// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebsiteProductionStatus, WebsiteSite } from "@greatstone/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ production: vi.fn(), deploy: vi.fn(), deployDirect: vi.fn(), rollbackLive: vi.fn() }));
vi.mock("../../api/website", async () => {
  const actual = await vi.importActual<typeof import("../../api/website")>("../../api/website");
  return { ...actual, websiteModuleApi: api };
});

import { directContents, runLabel, waitingCount, WebsiteDeployPanel } from "./WebsiteDeployPanel";

const site = { id: "site-1", companyId: "co-1", netlifySiteId: "3b1e97e6-e184-4251-badd-deed532be3ab" } as WebsiteSite;
const STAGED = "a".repeat(40);
const MAIN = "f".repeat(40);

function status(over: Partial<WebsiteProductionStatus> = {}): WebsiteProductionStatus {
  return {
    staging: { commit: STAGED, release: 9, changedAt: "2026-11-12T15:02:00.000Z", url: "https://gre3833-next-db-staging.netlify.app" },
    live: { commit: "d".repeat(40), release: 8, deployId: "e".repeat(24), publishedAt: "2026-11-09T06:04:22.415Z", url: "https://greatstoneint.com" },
    commits: [{ sha: STAGED, title: "Voice guide on every page" }],
    blockers: [],
    rollback: { deployId: "b".repeat(24), commit: null, publishedAt: "2026-11-08T10:00:00.000Z" },
    runs: [],
    canDeploy: true,
    workflowReady: true,
    publicKey: "k".repeat(43),
    problems: [],
    direct: {
      supported: true,
      main: { sha: MAIN, title: "Shop filters" },
      commits: [{ sha: MAIN, title: "Shop filters" }, { sha: STAGED, title: "Voice guide on every page" }],
      approved: { pages: ["About us (/about)"], entries: ["product: deep-dive", "vendor: acme"] },
    },
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
    expect(el.textContent).toContain("On staging, waiting to go live (2)");
    expect(el.textContent).toContain("content release 9 (live has 8)");
    expect(el.textContent).toContain("aaaaaaa Voice guide on every page");
    await act(async () => { buttons(el).find((b) => b.textContent === "Deploy to live: greatstoneint.com")!.click(); });
    expect(api.deploy).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Deploy staging to live: greatstoneint.com?");
    await act(async () => { buttons(document.body).find((b) => b.textContent === "Deploy to live")!.click(); });
    expect(api.deploy).toHaveBeenCalledWith("co-1", "site-1", STAGED, 9);
  });

  it("gives everyone else no Deploy or Roll back button", async () => {
    const el = await mount(status({ canDeploy: false, publicKey: null }));
    expect(buttons(el).map((b) => b.textContent)).toEqual([]);
    expect(el.textContent).toContain("Only John can deploy to live or roll back.");
  });

  it("holds Deploy while staging fails a check, a run is going, or nothing waits", async () => {
    const disabled = async (value: WebsiteProductionStatus) =>
      buttons(await mount(value)).find((b) => b.textContent === "Deploy to live: greatstoneint.com")!.disabled;
    expect(await disabled(status({ blockers: ["Staging's /shop shows no prices."] }))).toBe(true);
    expect(await disabled(status({ runs: [{ id: 1, action: "deploy", request: "r", status: "in_progress", conclusion: null, createdAt: "", url: "https://github.com/x", steps: [] }] }))).toBe(true);
    expect(await disabled(status({ commits: [], staging: { commit: STAGED, release: 8, changedAt: null, url: "u" } }))).toBe(true);
    expect(await disabled(status({ workflowReady: false }))).toBe(true);
    expect(await disabled(status())).toBe(false);
  });

  it("keeps GSAM's public key within John's reach even when the workflow file exists", async () => {
    const el = await mount(status({ workflowReady: true }));
    expect(el.querySelector("[data-testid=website-deploy-setup]")?.textContent).toContain("k".repeat(43));
    const other = await mount(status({ canDeploy: false, publicKey: null }));
    expect(other.querySelector("[data-testid=website-deploy-setup]")).toBeNull();
  });

  it("names runs in plain words and counts what waits", () => {
    const run = { id: 1, request: "r", createdAt: "", url: "" };
    expect(runLabel({ ...run, action: "deploy", status: "in_progress", conclusion: null })).toBe("Deploying to live");
    expect(runLabel({ ...run, action: "deploy", status: "completed", conclusion: "failure" })).toBe("Deploy to live failed");
    expect(runLabel({ ...run, action: "direct", status: "completed", conclusion: "success" })).toBe("Deployed straight to live");
    expect(runLabel({ ...run, action: "rollback", status: "completed", conclusion: "success" })).toBe("Rolled back");
    expect(waitingCount(status({ commits: [] }))).toBe(1);
  });

  it("labels Staging and Live side by side, each with its commit, release, time and address", async () => {
    const el = await mount(status());
    const staging = el.querySelector("[data-testid=website-deploy-staging]")!;
    const live = el.querySelector("[data-testid=website-deploy-live]")!;
    expect(staging.textContent).toContain("Staging (test copy)");
    expect(staging.textContent).toContain("aaaaaaa");
    expect(staging.querySelector("a")!.getAttribute("href")).toBe("https://gre3833-next-db-staging.netlify.app");
    expect(live.textContent).toContain("Live (public site)");
    expect(live.textContent).toContain("ddddddd");
    expect(live.querySelector("a")!.getAttribute("href")).toBe("https://greatstoneint.com");
    expect(el.textContent).not.toContain("unknown");
  });

  it("says Could not read with a Retry when GSAM cannot read a side, and Retry reads again", async () => {
    const el = await mount(status({ staging: { commit: null, release: null, changedAt: null, url: "https://gre3833-next-db-staging.netlify.app" }, problems: ["GSAM could not read staging's deploys (aborted)."] }));
    const staging = el.querySelector("[data-testid=website-deploy-staging]")!;
    expect(staging.textContent).toContain("Could not read");
    const calls = api.production.mock.calls.length;
    await act(async () => { buttons(staging).find((b) => b.textContent === "Retry")!.click(); });
    expect(api.production.mock.calls.length).toBe(calls + 1);
    expect(el.querySelector("[data-testid=website-deploy-live]")!.textContent).not.toContain("Could not read");
  });

  it("lists exactly what Deploy straight to live sends, and starts it only once John types live", async () => {
    api.deployDirect.mockResolvedValue({ request: "r2", release: 10 });
    const el = await mount(status());
    await act(async () => { buttons(el).find((b) => b.textContent === "Deploy straight to live (skip staging)")!.click(); });
    const dialog = document.querySelector("[data-testid=website-confirm-direct]")!;
    expect(dialog.textContent).toContain("Deploy straight to live: greatstoneint.com?");
    expect(dialog.textContent).toContain("Nothing below was checked on staging");
    const listed = dialog.querySelector("[data-testid=website-direct-contents]")!.textContent!;
    for (const line of ["fffffff \"Shop filters\"", "2 code changes from what is live", "1 approved page and 2 approved entries", "About us (/about)", "product: deep-dive", "vendor: acme"]) {
      expect(listed).toContain(line);
    }
    const go = () => buttons(dialog).find((b) => b.textContent === "Deploy straight to live")!;
    expect(go().disabled).toBe(true);
    const input = dialog.querySelector("input")!;
    const type = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await type("yes");
    expect(go().disabled).toBe(true);
    await type("live");
    expect(go().disabled).toBe(false);
    await act(async () => { go().click(); });
    expect(api.deployDirect).toHaveBeenCalledWith("co-1", "site-1", MAIN);
    expect(api.deploy).not.toHaveBeenCalled();
  });

  it("keeps Deploy straight to live off, saying why, until the website takes direct tickets", async () => {
    const el = await mount(status({ direct: { ...status().direct, supported: false } }));
    expect(buttons(el).find((b) => b.textContent === "Deploy straight to live (skip staging)")!.disabled).toBe(true);
    expect(el.textContent).toContain("Waiting for the website update");
  });

  it("words the direct contents when nothing is approved", () => {
    expect(directContents(status({ direct: { supported: true, main: null, commits: [], approved: { pages: [], entries: [] } } })).content).toContain("No approved changes are waiting");
  });
});
