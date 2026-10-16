import { expect, test, type Page } from "@playwright/test";
import { json } from "./agent-chat.shared";

// Release smoke: walk the main pages of a throwaway instance and fail on a
// page error, a 5xx from the API, an error screen or "Page not found".
// Run it with `pnpm smoke:pages` before and after a release. It never touches
// live data: the e2e config boots its own instance under a temp folder.

type Company = { id: string; issuePrefix: string };

const PAGES = [
  "dashboard",
  "morning",
  "inbox",
  "inbox/blocked",
  "needed",
  "issues",
  "my-tasks",
  "decisions",
  "approvals",
  "agents",
  "projects",
  "goals",
  "calendar",
  "scorecard",
  "weekly-report",
  "deliverables",
  "images",
  "memory",
  "memory/review",
  "search",
  "notifications",
  "tutorials",
  "routines",
  "runs",
  "activity",
  "costs",
  "organisations",
  "releases",
  "company/settings",
  "company/settings/integrations",
];

function watchForBreakage(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`page error on ${page.url()}: ${error.message}`));
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 500) {
      problems.push(`${response.status()} from ${response.url()}`);
    }
  });
  return problems;
}

test("the main pages open without errors", async ({ page, request }) => {
  test.setTimeout(PAGES.length * 20_000 + 60_000);
  const previous = await json(await request.get("/api/instance/settings/experimental"));
  // Organisations sits behind this setting; put it back afterwards.
  await json(await request.patch("/api/instance/settings/experimental", { data: { enablePipelines: true } }));
  try {
    const company = (await json(
      await request.post("/api/companies", { data: { name: `Smoke ${Date.now()}` } }),
    )) as Company;
    const agent = (await json(
      await request.post(`/api/companies/${company.id}/agents`, {
        data: {
          name: "Chief of staff",
          adapterType: "process",
          adapterConfig: { command: process.execPath, args: ["-e", ""], graceSec: 1 },
          runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
        },
      }),
    )) as { id: string };
    const task = (await json(
      await request.post(`/api/companies/${company.id}/issues`, { data: { title: "Quarterly board pack", status: "todo" } }),
    )) as { identifier: string };

    const problems = watchForBreakage(page);
    const routes = [...PAGES, `issues/${task.identifier}`, `agents/${agent.id}`];
    for (const route of routes) {
      await page.goto(`/${company.issuePrefix}/${route}`);
      await expect(page.locator("main").first(), route).toBeVisible({ timeout: 30_000 });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      for (const marker of ["Page not found", "This page hit an error", "GS Agentic Manager hit an error"]) {
        await expect(page.getByRole("heading", { name: marker }), `${route}: ${marker}`).toHaveCount(0);
      }
    }
    expect(problems).toEqual([]);
  } finally {
    await request.patch("/api/instance/settings/experimental", {
      data: { enablePipelines: Boolean((previous as { enablePipelines?: boolean }).enablePipelines) },
    });
  }
});
