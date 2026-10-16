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
  return json(await request.post(`/api/companies/${company.id}/issues`, { data: { title, status } })) as Promise<{
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

test("the Inbox shows waiting work and the Blocked tab shows blocked work", async ({ page, request }) => {
  const company = await createCompany(request, "Journey Inbox");
  const waiting = await createTask(request, company, "Approve the press release");
  await json(
    await request.post(`/api/issues/${waiting.id}/interactions`, {
      data: { kind: "request_confirmation", payload: { version: 1, prompt: "Send it to the papers?" } },
    }),
  );
  const blocked = await createTask(request, company, "Waiting on legal sign-off", "blocked");

  await open(page, `/${company.issuePrefix}/inbox/mine`);
  const needsYou = page.getByRole("region", { name: "Needs you" });
  await expect(needsYou.getByRole("link", { name: /Approve the press release/ })).toBeVisible({ timeout: 30_000 });

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
