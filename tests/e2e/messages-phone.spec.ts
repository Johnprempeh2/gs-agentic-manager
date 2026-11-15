import { expect, test } from "@playwright/test";
import { json } from "./agent-chat.shared";

// Messages on a phone (15 Nov overnight audit): what a thumb needs in a chat.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

type Company = { id: string; issuePrefix: string };

test("a long group chat on a phone keeps the back button and chat name on top", async ({ page, request }) => {
  await json(await request.patch("/api/instance/settings/experimental", { data: { enableTeamChat: true, enableAgentChat: true } }));
  const company = (await json(await request.post("/api/companies", { data: { name: `Phone chat ${Date.now()}` } }))) as Company;
  const agent = (await json(await request.post(`/api/companies/${company.id}/agents`, {
    data: {
      name: "Ada",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", ""], graceSec: 1 },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    },
  }))) as { id: string };
  const group = (await json(await request.post(`/api/companies/${company.id}/team-chats`, { data: { title: "Launch room", agentIds: [agent.id] } }))) as { id: string };
  for (let i = 1; i <= 16; i += 1) {
    await json(await request.post(`/api/issues/${group.id}/comments`, { data: { body: `Note ${i}: the homepage copy is ready for review.` } }));
  }

  await page.goto(`/${company.issuePrefix}/messages/${group.id}`);
  const back = page.getByRole("button", { name: "Back", exact: true }).or(page.getByRole("link", { name: "Back", exact: true })).first();
  await expect(back).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("list", { name: "Members" })).toBeVisible();
  // A first visit shows the chat's short tour; it is not what this checks.
  const skip = page.getByRole("button", { name: "Skip" });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.waitForTimeout(800);
  // The thread opens at the latest message, so the page has scrolled.
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  const hit = await back.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top && el.contains(top) ? "back" : `${top?.tagName}.${String(top?.className).slice(0, 80)} at ${Math.round(r.top)}`;
  });
  expect(hit, "the back button is not covered by the members strip").toBe("back");
  // The members strip still sticks, just under the top bar.
  const strip = await page.getByRole("list", { name: "Members" }).boundingBox();
  const backBox = await back.boundingBox();
  expect(strip!.y).toBeGreaterThan(backBox!.y + backBox!.height);
});

test("the agent chat send button is thumb sized on a phone", async ({ page, request }) => {
  await json(await request.patch("/api/instance/settings/experimental", { data: { enableTeamChat: true, enableAgentChat: true } }));
  const company = (await json(await request.post("/api/companies", { data: { name: `Phone send ${Date.now()}` } }))) as Company;
  const agent = (await json(await request.post(`/api/companies/${company.id}/agents`, {
    data: {
      name: "Ada",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", ""], graceSec: 1 },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    },
  }))) as { id: string; urlKey?: string };
  await json(await request.post(`/api/companies/${company.id}/chats/${agent.id}`));
  await page.goto(`/${company.issuePrefix}/chats/${agent.urlKey ?? agent.id}`);
  const send = page.getByTestId("task-chat-composer-send");
  await expect(send).toBeVisible({ timeout: 30_000 });
  const box = await send.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
});
