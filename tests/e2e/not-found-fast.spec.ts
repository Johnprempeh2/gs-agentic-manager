import { expect, test } from "@playwright/test";
import { json } from "./agent-chat.shared";

// 15 Nov overnight audit: a link to a task that does not exist sat on a loading
// skeleton for about seven seconds while the app asked again three times.
test("a missing task says so straight away", async ({ page, request }) => {
  const company = (await json(await request.post("/api/companies", { data: { name: `Missing ${Date.now()}` } }))) as { issuePrefix: string };
  await page.goto(`/${company.issuePrefix}/issues/${company.issuePrefix}-999`);
  await expect(page.getByText("Could not load this page")).toBeVisible({ timeout: 3_000 });
});
