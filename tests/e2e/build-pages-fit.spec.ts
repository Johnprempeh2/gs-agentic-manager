import { expect, test } from "@playwright/test";
import { json } from "./agent-chat.shared";

// 15 Nov overnight audit: Build pages at tablet and phone widths.
type Company = { id: string; issuePrefix: string };

test("Skills cards fit beside both sidebars at tablet width", async ({ page, request }) => {
  const company = (await json(await request.post("/api/companies", { data: { name: `Skills fit ${Date.now()}` } }))) as Company;
  await page.addInitScript(() => localStorage.setItem("paperclip.sidebar.collapsed", "0"));
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto(`/${company.issuePrefix}/skills`);
  await expect(page.getByText("Installed skills")).toBeVisible({ timeout: 30_000 });
  const cards = page.locator(".gs-glass-card-interactive");
  await expect(cards.first()).toBeVisible();
  const overflow = await cards.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().right - innerWidth).filter((d) => d > 0.5));
  expect(overflow, "no skill card runs past the screen edge").toEqual([]);
});

test("Mailboxes keeps its sign-in buttons on screen beside the Connectors menu", async ({ page, request }) => {
  const company = (await json(await request.post("/api/companies", { data: { name: `Mailboxes fit ${Date.now()}` } }))) as Company;
  await page.addInitScript(() => localStorage.setItem("paperclip.sidebar.collapsed", "0"));
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto(`/${company.issuePrefix}/apps/mailboxes`);
  await expect(page.getByRole("heading", { name: "Mailboxes" })).toBeVisible({ timeout: 30_000 });
  const overflow = await page.locator("header button").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().right - innerWidth).filter((d) => d > 0.5));
  expect(overflow, "no header button runs past the screen edge").toEqual([]);
});

test("Pipelines keeps its title readable at tablet width", async ({ page, request }) => {
  await json(await request.patch("/api/instance/settings/experimental", { data: { enablePipelines: true } }));
  const company = (await json(await request.post("/api/companies", { data: { name: `Pipelines fit ${Date.now()}` } }))) as Company;
  await page.addInitScript(() => localStorage.setItem("paperclip.sidebar.collapsed", "0"));
  await page.setViewportSize({ width: 768, height: 1024 });
  try {
    await page.goto(`/${company.issuePrefix}/pipelines`);
    const title = page.locator("[data-tour=pipelines-title]");
    await expect(title).toBeVisible({ timeout: 30_000 });
    expect((await title.boundingBox())!.width, "the title block keeps a readable width").toBeGreaterThanOrEqual(260);
  } finally {
    await request.patch("/api/instance/settings/experimental", { data: { enablePipelines: false } });
  }
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("Routines keeps every header button on screen", async ({ page, request }) => {
    const company = (await json(await request.post("/api/companies", { data: { name: `Routines fit ${Date.now()}` } }))) as Company;
    // With a routine the header also offers Copy the schedule: three buttons.
    await json(await request.post(`/api/companies/${company.id}/routines`, { data: { title: "Weekly report", status: "paused" } }));
    await page.goto(`/${company.issuePrefix}/routines`);
    const create = page.locator("[data-tour=routines-create]");
    await expect(create).toBeVisible({ timeout: 30_000 });
    const box = (await create.boundingBox())!;
    expect(box.x + box.width, "Create routine ends on screen").toBeLessThanOrEqual(390);
  });
});
