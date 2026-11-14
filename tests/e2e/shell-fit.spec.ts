import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { json } from "./agent-chat.shared";

// The app shell measured in a real browser (14 Nov polish): Messages fits the
// content area beside the sidebar, the rail's icons never move when the
// sidebar opens, and reduced motion opens it with no transition. Storybook
// alone missed the fit problem, so these drive the whole app.

type Company = { id: string; issuePrefix: string };

async function seed(request: APIRequestContext) {
  await json(await request.patch("/api/instance/settings/experimental", { data: { enableTeamChat: true, enableAgentChat: true } }));
  const company = (await json(await request.post("/api/companies", { data: { name: `Shell fit ${Date.now()}` } }))) as Company;
  const agent = (await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Ada",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", ""], graceSec: 1 },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    }),
  )) as { id: string };
  const group = (await json(
    await request.post(`/api/companies/${company.id}/team-chats`, { data: { title: "Launch room", agentIds: [agent.id] } }),
  )) as { id: string };
  // Enough messages that the thread has to scroll inside its own pane.
  for (let i = 1; i <= 24; i += 1) {
    await json(await request.post(`/api/issues/${group.id}/comments`, {
      data: { body: `Note ${i}: the homepage copy is ready for review, and the deck needs one more pass on the numbers slide.` },
    }));
  }
  return { company, agent, group };
}

async function openShell(page: Page, path: string, { collapsed }: { collapsed: boolean }) {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem("paperclip.sidebar.collapsed", value ? "1" : "0");
    } catch {
      // The shell still renders without storage.
    }
  }, collapsed);
  await page.goto(path);
  await expect(page.locator('[data-slot="sidebar-glass"]')).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.mouse.move(page.viewportSize()!.width - 2, 2);
}

test("Messages fills the content area beside the sidebar with no overflow", async ({ page, request }) => {
  test.setTimeout(180_000);
  const { company, group } = await seed(request);
  for (const [width, height] of [[1280, 720], [1440, 900]] as const) {
    for (const collapsed of [false, true]) {
      const label = `${width}x${height} ${collapsed ? "rail" : "open"}`;
      await page.setViewportSize({ width, height });
      await openShell(page, `/${company.issuePrefix}/messages/${group.id}`, { collapsed });
      const dock = page.getByTestId("team-chat-composer-dock");
      await expect(dock, label).toBeVisible({ timeout: 30_000 });
      const fit = await page.evaluate(() => {
        const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
        const doc = document.documentElement;
        const main = document.getElementById("main-content")!;
        return {
          vw: innerWidth,
          vh: innerHeight,
          pageScrollY: Math.max(doc.scrollHeight, document.body.scrollHeight) - innerHeight,
          pageScrollX: Math.max(doc.scrollWidth, document.body.scrollWidth) - innerWidth,
          glass: rect('[data-slot="sidebar-glass"]'),
          list: rect('[data-testid="messages-list-pane"]'),
          main: main.getBoundingClientRect(),
          mainScrolls: main.scrollHeight > main.clientHeight,
          composer: rect('[data-testid="team-chat-composer-dock"]'),
        };
      });
      expect(fit.pageScrollY, `${label}: the page itself must not scroll`).toBeLessThanOrEqual(0);
      expect(fit.pageScrollX, `${label}: nothing past the right edge`).toBeLessThanOrEqual(0);
      // The list sits beside the sidebar glass, never under it, and ends on screen.
      expect(fit.list, `${label}: the list shows beside the thread`).not.toBeNull();
      expect(fit.list!.left, `${label}: list clear of the sidebar`).toBeGreaterThanOrEqual(fit.glass!.right);
      expect(fit.list!.bottom, `${label}: list ends on screen`).toBeLessThanOrEqual(fit.vh);
      // The thread column reaches the bottom edge and its composer is pinned there.
      expect(fit.main.bottom, `${label}: thread reaches the bottom`).toBeCloseTo(fit.vh, 0);
      expect(fit.main.right, `${label}: thread ends at the right edge`).toBeLessThanOrEqual(fit.vw);
      expect(fit.composer!.bottom, `${label}: composer on screen`).toBeLessThanOrEqual(fit.vh);
      expect(fit.vh - fit.composer!.bottom, `${label}: composer pinned to the bottom`).toBeLessThanOrEqual(24);
      expect(fit.mainScrolls, `${label}: the thread scrolls inside its own pane`).toBe(true);
    }
  }
});

/** Each rail row's icon centre and top, by its accessible name. */
async function railIcons(page: Page) {
  return page.evaluate(() => {
    const glass = document.querySelector('[data-slot="sidebar-glass"]')!;
    const out: Record<string, { x: number; y: number }> = {};
    for (const icon of glass.querySelectorAll("nav svg")) {
      const row = icon.closest("a, button");
      const r = icon.getBoundingClientRect();
      if (!row || r.width === 0 || r.width > 20) continue;
      const name = (row.getAttribute("aria-label") || row.textContent || "").trim();
      if (name && !out[name]) out[name] = { x: r.left + r.width / 2, y: r.top };
    }
    const g = glass.getBoundingClientRect();
    return { icons: out, glassCentre: g.left + g.width / 2 };
  });
}

test("the sidebar's icons keep their place when it expands", async ({ page, request }) => {
  const { company } = await seed(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openShell(page, `/${company.issuePrefix}/dashboard`, { collapsed: true });
  const rail = await railIcons(page);
  expect(Object.keys(rail.icons).length).toBeGreaterThan(5);
  // One vertical axis, centred in the rail.
  for (const [name, icon] of Object.entries(rail.icons)) {
    expect(Math.abs(icon.x - rail.glassCentre), `${name} on the rail axis`).toBeLessThanOrEqual(0.5);
  }
  await page.locator('[data-slot="sidebar-brand-header"]').hover();
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
  await page.waitForTimeout(500);
  const open = await railIcons(page);
  for (const [name, icon] of Object.entries(rail.icons)) {
    const after = Object.entries(open.icons).find(([key]) => key.startsWith(name) || name.startsWith(key))?.[1];
    expect(after, `${name} still in the open sidebar`).toBeTruthy();
    expect(Math.abs(after!.x - icon.x), `${name} same x`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(after!.y - icon.y), `${name} same y`).toBeLessThanOrEqual(0.5);
  }
});

test("reduced motion opens and closes the sidebar with no transition", async ({ page, request }) => {
  const { company } = await seed(request);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openShell(page, `/${company.issuePrefix}/dashboard`, { collapsed: true });
  const motion = await page.evaluate(() => {
    const spacer = document.querySelector('[data-slot="sidebar-spacer"]')!;
    const panel = spacer.firstElementChild!;
    const style = (el: Element) => getComputedStyle(el);
    return [style(spacer).transitionDuration, style(panel).transitionDuration];
  });
  expect(motion).toEqual(["0s", "0s"]);
  await page.locator('[data-slot="sidebar-brand-header"]').hover();
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  // No easing: the very next frame is already the full width, labels already solid.
  const next = await page.evaluate(() => new Promise<{ width: number; label: string }>((resolve) =>
    requestAnimationFrame(() => {
      const glass = document.querySelector('[data-slot="sidebar-glass"]')!;
      const label = glass.querySelector(".gs-side-reveal");
      resolve({ width: glass.getBoundingClientRect().width, label: label ? getComputedStyle(label).animationName : "none" });
    })));
  expect(next.width).toBeGreaterThan(200);
  expect(next.label).toBe("none");
});

/** What sits on top at the left, middle and right of each conversation row. */
async function rowHits(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="messages-list-pane"] [data-conversation]')].map((row) => {
      const r = row.getBoundingClientRect();
      const blockers = [r.left + 12, r.left + r.width / 2, r.right - 12].flatMap((x) => {
        const top = document.elementFromPoint(x, r.top + r.height / 2);
        return top && row.contains(top) ? [] : [`${top?.tagName}.${String(top?.className).slice(0, 60)}`];
      });
      return { key: row.getAttribute("data-conversation"), visible: r.width > 0, blockers };
    }));
}

// 14 Nov: an agent chat opens the artifacts pane, and under 75rem the hub
// then hid the conversation list, so the next chat could not be clicked.
test("the conversation list stays clickable while switching chats, artifacts pane open or not", async ({ page, request }) => {
  test.setTimeout(240_000);
  const { company, agent, group } = await seed(request);
  await json(await request.post(`/api/companies/${company.id}/chats/${agent.id}`));
  for (const [width, height] of [[1280, 720], [1440, 900]] as const) {
    for (const collapsed of [false, true]) {
      const label = `${width}x${height} ${collapsed ? "rail" : "open"}`;
      await page.setViewportSize({ width, height });
      await openShell(page, `/${company.issuePrefix}/messages/${group.id}`, { collapsed });
      const list = page.getByTestId("messages-list-pane");
      const agentRow = list.locator(`[data-conversation="agent:${agent.id}"]`);
      const groupRow = list.locator(`[data-conversation="chat:${group.id}"]`);
      for (let round = 0; round < 3; round += 1) {
        await agentRow.click();
        await expect(agentRow, label).toHaveAttribute("data-selected", "true");
        // The case that broke: the agent chat brings the artifacts pane.
        await expect(page.locator("[data-messages-hub][data-pane-open]"), `${label}: artifacts pane open`).toHaveCount(1);
        await expect(list, `${label}: list still shown beside the agent chat`).toBeVisible();
        for (const hit of await rowHits(page)) {
          expect(hit.visible, `${label}: ${hit.key} on screen`).toBe(true);
          expect(hit.blockers, `${label}: nothing covers ${hit.key}`).toEqual([]);
        }
        // The pane never covers or crushes the thread: the composer takes the click.
        const composer = page.getByRole("textbox", { name: "editable markdown" }).last();
        await expect(composer, label).toBeVisible();
        const thread = await page.evaluate(() => {
          const main = document.getElementById("main-content")!.getBoundingClientRect();
          const box = [...document.querySelectorAll('[contenteditable="true"]')].at(-1)!;
          const r = box.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          const pane = document.querySelector("aside[data-side-pane]");
          const inner = pane?.lastElementChild as HTMLElement | null;
          return {
            width: main.width,
            composerHit: !!top && box.contains(top),
            paneFits: !pane || getComputedStyle(pane).display === "none" || (inner!.getBoundingClientRect().right <= pane.getBoundingClientRect().right + 1 && pane.getBoundingClientRect().right <= innerWidth),
          };
        });
        expect(thread.paneFits, `${label}: the artifacts pane's content and close button stay on screen`).toBe(true);
        expect(thread.width, `${label}: thread keeps its 480px`).toBeGreaterThanOrEqual(470);
        expect(thread.composerHit, `${label}: nothing covers the composer`).toBe(true);
        await groupRow.click();
        await expect(page, label).toHaveURL(new RegExp(`/messages/${group.id}$`));
        await expect(groupRow, label).toHaveAttribute("data-selected", "true");
      }
    }
  }
});

test("the collapsed sidebar opens on a resting hover and never eats a click meant for the list", async ({ page, request }) => {
  const { company, agent, group } = await seed(request);
  await json(await request.post(`/api/companies/${company.id}/chats/${agent.id}`));
  await page.setViewportSize({ width: 1440, height: 900 });
  await openShell(page, `/${company.issuePrefix}/messages/${group.id}`, { collapsed: true });
  const panel = page.locator('[data-slot="sidebar-spacer"] > div').first();
  const rail = await panel.boundingBox();
  // Passing over the rail does not open it.
  await page.mouse.move(rail!.x + 40, 300);
  await page.waitForTimeout(80);
  await page.mouse.move(rail!.x + 40, 320);
  await page.mouse.move(700, 320);
  await page.waitForTimeout(300);
  await expect(panel).not.toHaveAttribute("data-sidebar-overlay", "");
  // Resting on it does, as an overlay: the list does not move.
  const listBefore = await page.getByTestId("messages-list-pane").boundingBox();
  await page.mouse.move(rail!.x + 40, 300);
  await expect(panel).toHaveAttribute("data-sidebar-overlay", "", { timeout: 2_000 });
  await page.waitForTimeout(300);
  expect((await panel.boundingBox())!.width).toBeGreaterThan(200);
  expect((await page.getByTestId("messages-list-pane").boundingBox())!.x).toBe(listBefore!.x);
  // Straight from the open sidebar onto a conversation: the first click lands,
  // and so does a quick second click on the part of the list the sidebar is
  // still sliding back across.
  const list = page.getByTestId("messages-list-pane");
  const agentRow = list.locator(`[data-conversation="agent:${agent.id}"]`);
  const groupRow = list.locator(`[data-conversation="chat:${group.id}"]`);
  const a = (await agentRow.boundingBox())!;
  const g = (await groupRow.boundingBox())!;
  const open = (await panel.boundingBox())!;
  expect(g.x + 16, "the second click aims under the open sidebar").toBeLessThan(open.x + open.width);
  await page.mouse.click(a.x + a.width - 24, a.y + a.height / 2);
  await page.mouse.click(g.x + 16, g.y + g.height / 2);
  await expect(page).toHaveURL(new RegExp(`/messages/${group.id}$`));
  await expect(groupRow).toHaveAttribute("data-selected", "true");
});
