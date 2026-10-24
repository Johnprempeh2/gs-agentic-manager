import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { json } from "./agent-chat.shared";

// The journeys an executive takes every day, end to end through the shipped
// UI: open the dashboard, create a task, answer a Needs you card, open a
// client, read the Inbox and its Blocked tab, and switch the theme. Each test
// seeds its own company through the API so the tests stay independent.

type Company = { id: string; issuePrefix: string; name: string };

async function createCompany(request: APIRequestContext, label: string): Promise<Company> {
  return json(await request.post("/api/companies", { data: { name: `${label} ${Date.now()}` } }));
}

async function createTask(request: APIRequestContext, company: Company, title: string, status = "todo") {
  // A blocked task must say what blocks it (GRE-2329).
  const unblockDescriptor = status === "blocked" ? { owner: "board", action: "Unblock the task" } : undefined;
  return json(await request.post(`/api/companies/${company.id}/issues`, { data: { title, status, unblockDescriptor } })) as Promise<{
    id: string;
    identifier: string;
  }>;
}

async function open(page: Page, route: string) {
  await page.goto(route);
  const announcement = page.getByRole("button", { name: "Dismiss announcement" });
  if (await announcement.isVisible()) await announcement.click();
}

test("the dashboard opens for the signed-in board user", async ({ page, request }) => {
  const company = await createCompany(request, "Journey Dashboard");
  // Open tasks lists work in progress, in review or blocked.
  const task = await createTask(request, company, "Draft the quarterly letter", "blocked");
  // Without an agent the dashboard opens the first-agent wizard instead.
  await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Chief of staff",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", ""], graceSec: 1 },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    }),
  );

  await open(page, `/${company.issuePrefix}/dashboard`);

  const welcome = page.getByRole("region", { name: "Welcome" });
  await expect(welcome.getByRole("heading", { name: company.name })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Open account menu" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Open tasks" }).getByRole("link", { name: `Open ${task.identifier}: Draft the quarterly letter` }),
  ).toBeVisible();
  await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
});

test("a new task created from the dialog is saved and listed", async ({ page, request }) => {
  const company = await createCompany(request, "Journey New Task");
  const title = `Book the board dinner ${Date.now()}`;

  await open(page, `/${company.issuePrefix}/issues`);
  await page.getByRole("button", { name: "New Task", exact: true }).first().click();
  await page.getByRole("textbox", { name: "Task title", exact: true }).fill(title);
  await page.getByRole("button", { name: "Create Task", exact: true }).click();

  await expect(page.getByRole("textbox", { name: "Task title", exact: true })).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 15_000 });
  const tasks = (await json(await request.get(`/api/companies/${company.id}/issues`))) as Array<{ title: string }>;
  expect(tasks.map((task) => task.title)).toContain(title);
});

test("approving a Needs you card records the answer", async ({ page, request }) => {
  const company = await createCompany(request, "Journey Decisions");
  const task = await createTask(request, company, "Pick the launch date");
  const interaction = (await json(
    await request.post(`/api/issues/${task.id}/interactions`, {
      data: { kind: "request_confirmation", payload: { version: 1, prompt: "Ship the launch on Friday?" } },
    }),
  )) as { id: string };

  await open(page, `/${company.issuePrefix}/decisions`);
  const card = page.getByRole("article", { name: `${task.identifier} Pick the launch date` });
  await expect(card.getByText("Ship the launch on Friday?")).toBeVisible({ timeout: 30_000 });
  await card.getByRole("button", { name: "Approve", exact: true }).click();

  await expect(card).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(async () => {
      const all = (await json(await request.get(`/api/issues/${task.id}/interactions`))) as Array<{
        id: string;
        status: string;
      }>;
      return all.find((row) => row.id === interaction.id)?.status;
    })
    .toBe("accepted");
});

test("a client opens from the Organisations list", async ({ page, request }) => {
  const settings = await json(await request.get("/api/instance/settings/experimental"));
  await json(await request.patch("/api/instance/settings/experimental", { data: { enablePipelines: true } }));
  try {
    const company = await createCompany(request, "Journey Clients");
    const name = `Acme Holdings ${Date.now()}`;
    const organisation = (await json(
      await request.post(`/api/companies/${company.id}/organisations`, { data: { name, status: "client" } }),
    )) as { id: string };

    await open(page, `/${company.issuePrefix}/organisations`);
    await page.getByRole("table", { name: "Organisations" }).getByRole("link", { name, exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/organisations/${organisation.id}$`));
    await expect(page.getByRole("heading", { name, exact: true }).first()).toBeVisible({ timeout: 30_000 });
  } finally {
    await request.patch("/api/instance/settings/experimental", {
      data: { enablePipelines: Boolean(settings.enablePipelines) },
    });
  }
});

test("waiting work shows in Decisions with the one count, and the Inbox Blocked tab shows blocked work", async ({ page, request }) => {
  const company = await createCompany(request, "Journey Inbox");
  const waiting = await createTask(request, company, "Approve the press release");
  await json(
    await request.post(`/api/issues/${waiting.id}/interactions`, {
      data: { kind: "request_confirmation", payload: { version: 1, prompt: "Send it to the papers?" } },
    }),
  );
  const blocked = await createTask(request, company, "Waiting on legal sign-off", "blocked");

  // What needs you lives on the Desk's Decisions section, with the one count.
  await open(page, `/${company.issuePrefix}/desk#desk-needs-me`);
  const decisions = page.locator('[data-desk-section="desk-needs-me"]');
  await expect(decisions.getByText(/Approve the press release/).first()).toBeVisible({ timeout: 30_000 });
  // The section's number is the sidebar's Decisions badge: one count.
  const count = (await decisions.locator("[data-desk-section-count]").textContent())?.trim() ?? "";
  expect(Number(count)).toBeGreaterThanOrEqual(1);
  await expect(page.locator('a[href$="/desk#desk-needs-me"]').first()).toContainText(count);

  // The Inbox holds updates, not decisions: Mine carries no "needs you" number.
  await open(page, `/${company.issuePrefix}/inbox/mine`);
  await expect(page.getByRole("tab", { name: "Mine", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("region", { name: "Needs you" })).toHaveCount(0);

  await page.getByRole("tab", { name: "Blocked" }).click();
  await expect(page).toHaveURL(/\/inbox\/blocked$/);
  await expect(page.getByRole("tab", { name: "Blocked" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("link", { name: `Open ${blocked.identifier}: Waiting on legal sign-off` })).toBeVisible();
});

test("the theme switch flips the app and survives a reload", async ({ page, request }) => {
  const company = await createCompany(request, "Journey Theme");
  // The dashboard of a company with no agents opens the first-agent wizard,
  // so switch the theme from the task list.
  await open(page, `/${company.issuePrefix}/issues`);
  await expect(page.getByRole("button", { name: "Open account menu" })).toBeVisible({ timeout: 30_000 });

  const isDark = () => page.evaluate(() => document.documentElement.classList.contains("dark"));
  const before = await isDark();
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("button", { name: before ? "Switch to light mode" : "Switch to dark mode" }).click();
  await expect.poll(isDark).toBe(!before);

  await page.reload();
  await expect(page.getByRole("button", { name: "Open account menu" })).toBeVisible({ timeout: 30_000 });
  await expect.poll(isDark).toBe(!before);
});
