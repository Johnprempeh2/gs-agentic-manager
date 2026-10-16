import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { json } from "./agent-chat.shared";

// The features shipped on 15 and 16 Oct 2026: search, What we need from you,
// Calendar, Scorecard, notification settings and bringing Claude or ChatGPT
// memory into shared memory through Review. Each test seeds its own company.
// Organisations is covered in core-journeys.spec.ts, behind its setting.

type Company = { id: string; issuePrefix: string; name: string };

async function seedCompany(request: APIRequestContext, label: string): Promise<Company> {
  const company = (await json(
    await request.post("/api/companies", { data: { name: `${label} ${Date.now()}` } }),
  )) as Company;
  // Without an agent some pages open the first-agent wizard over the app.
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
  return company;
}

async function createTask(request: APIRequestContext, company: Company, title: string) {
  return json(await request.post(`/api/companies/${company.id}/issues`, { data: { title, status: "todo" } })) as Promise<{
    id: string;
    identifier: string;
  }>;
}

/** Fails the test on an uncaught page error or a 5xx from the API. */
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

test("tonight's pages open without errors", async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await seedCompany(request, "Pages");
  await createTask(request, company, "Quarterly board pack");
  const problems = watchForBreakage(page);

  const pages: Array<[string, string]> = [
    ["needed", "What we need from you"],
    ["calendar", "Calendar"],
    ["scorecard", "Scorecard"],
    ["notifications", "Notifications"],
    ["search", "Search"],
    ["memory", "Memory"],
    ["deliverables", "Deliverables"],
  ];
  for (const [route, heading] of pages) {
    await page.goto(`/${company.issuePrefix}/${route}`);
    await expect(page.getByRole("heading", { name: heading, level: 1 }).first(), route).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Page not found" }), route).toHaveCount(0);
  }
  expect(problems).toEqual([]);
});

test("search finds a task by a word in its title", async ({ page, request }) => {
  const company = await seedCompany(request, "Search");
  const task = await createTask(request, company, "Quarterly board pack");

  await page.goto(`/${company.issuePrefix}/search`);
  const box = page.getByRole("textbox", { name: "Search query" });
  await box.fill("board");
  await box.press("Enter");

  const result = page.getByRole("link", { name: new RegExp(`${task.identifier} Quarterly board pack`) });
  await expect(result).toBeVisible({ timeout: 30_000 });
  await result.click();
  await expect(page).toHaveURL(new RegExp(`/issues/${task.identifier}$`));
});

test("What we need from you lists a question waiting on the board", async ({ page, request }) => {
  const company = await seedCompany(request, "Needed");
  const task = await createTask(request, company, "Quarterly board pack");
  await json(
    await request.post(`/api/issues/${task.id}/interactions`, {
      data: { kind: "request_confirmation", payload: { version: 1, prompt: "Send the pack on Monday?" } },
    }),
  );

  await page.goto(`/${company.issuePrefix}/needed`);
  const questions = page.getByRole("region", { name: /Answer a question/ });
  await expect(questions.getByRole("link", { name: /Send the pack on Monday\?/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("1 thing needs you.")).toBeVisible();
});

test("memory pasted from ChatGPT waits in Review for someone else to confirm", async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await seedCompany(request, "Memory");
  await json(await request.patch(`/api/companies/${company.id}/memory/settings`, { data: { enabled: true } }));
  const fact = `Acme renews its contract every March ${Date.now()}`;

  await page.goto(`/${company.issuePrefix}/memory/apps`);
  await page.getByRole("textbox", { name: "ChatGPT's answer" }).fill(fact);
  const add = page.getByRole("button", { name: /^Add 1 to memory$/ });
  await expect(add).toBeEnabled({ timeout: 30_000 });
  await add.click();

  await page.goto(`/${company.issuePrefix}/memory/review`);
  const queue = page.getByRole("region", { name: "Review queue" });
  await queue.getByText(fact).first().click({ timeout: 30_000 });
  const proposal = page.getByRole("article", { name: "Proposal under review" });
  // Four eyes: the person who pasted it cannot confirm it, but can reject it.
  await expect(proposal.getByRole("button", { name: "Confirm", exact: true })).toBeDisabled();
  await expect(proposal.getByText("You proposed this card. Someone else must confirm it.")).toBeVisible();
  await proposal.getByRole("button", { name: "Reject", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Reason" }).fill("Pasted by mistake");
  await dialog.getByRole("button", { name: "Reject", exact: true }).click();

  await expect(queue.getByText(fact)).toHaveCount(0, { timeout: 15_000 });
});
