import { expect, test, type Page } from "@playwright/test";
import { json } from "./agent-chat.shared";

// 15 Nov overnight audit: at 768 wide, beside the open sidebar, the Inbox
// search sat on top of its view controls and ran past the screen edge.

type Company = { id: string; issuePrefix: string };

/** Overlaps between the search box and every other control in the toolbar. */
async function toolbarFit(page: Page, name: string) {
  const toolbar = page.getByRole("toolbar", { name });
  await expect(toolbar).toBeVisible({ timeout: 30_000 });
  return toolbar.evaluate((root) => {
    const search = root.querySelector('[data-slot="collection-toolbar-search"] input')!.getBoundingClientRect();
    const overlaps = [...root.querySelectorAll("button, [role=tab]")]
      .map((el) => ({ label: el.getAttribute("aria-label") || el.textContent?.trim() || el.tagName, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.left < search.right && r.right > search.left && r.top < search.bottom && r.bottom > search.top)
      .map(({ label }) => label);
    return { overlaps, searchRight: search.right, viewport: innerWidth, searchWidth: search.width };
  });
}

test("list toolbars never put the search on top of their controls", async ({ page, request }) => {
  const company = (await json(await request.post("/api/companies", { data: { name: `Toolbar fit ${Date.now()}` } }))) as Company;
  await page.addInitScript(() => localStorage.setItem("paperclip.sidebar.collapsed", "0"));
  for (const [width, height] of [[768, 1024], [1024, 768], [1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(`/${company.issuePrefix}/inbox/mine`);
    const fit = await toolbarFit(page, "Inbox controls");
    expect(fit.overlaps, `${width}: nothing under the Inbox search`).toEqual([]);
    expect(fit.searchRight, `${width}: search ends on screen`).toBeLessThanOrEqual(fit.viewport);
    expect(fit.searchWidth, `${width}: search keeps a usable width`).toBeGreaterThanOrEqual(200);
  }
});
