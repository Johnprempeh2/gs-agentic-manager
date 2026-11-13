import { describe, expect, it } from "vitest";
import {
  SIDEBAR_SECTIONS,
  SIDEBAR_SECTION_IDS,
  moveSidebarItem,
  moveSidebarItemBy,
  resolveSidebarLayout,
  setSidebarItemHidden,
  setSidebarItemPinned,
  setSidebarSectionOpen,
} from "./sidebar-layout";
import { mergeSectionOrder } from "./sidebar-section-order";

const EVERY_DESTINATION = [
  "decisions", "my-tasks", "inbox", "calendar", "chats",
  "organisations", "commerce", "pipelines", "deep-dive", "deliverables", "links", "images",
  "dashboard", "tasks", "projects", "goals", "board", "intelligence", "memory",
  "agents", "scorecard", "weekly-report", "conference-room", "status",
  "skills", "connectors", "routines", "workflows", "workspaces", "artifacts", "cases",
  "website", "activity", "releases", "billing", "settings", "design-guide",
  "whats-new", "tutorials",
];

function itemsOf(layout: ReturnType<typeof resolveSidebarLayout>, sectionId: string) {
  return layout.sections.find((section) => section.id === sectionId)?.items;
}

describe("default sidebar layout", () => {
  it("contains every destination exactly once", () => {
    const all = SIDEBAR_SECTIONS.flatMap((section) => section.items);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...EVERY_DESTINATION].sort());
    const resolved = resolveSidebarLayout(null).sections.flatMap((section) => section.items);
    expect(resolved).toEqual(all);
  });

  it("starts with what needs you and folds Manage away", () => {
    const resolved = resolveSidebarLayout({});
    expect(resolved.sections.map((section) => section.id)).toEqual(["start", "company", "work", "manage"]);
    expect(resolved.sections.map((section) => section.open)).toEqual([true, true, true, true]);
    expect(resolved.hidden).toEqual([]);
    expect(resolved.pinned).toEqual([]);
  });

  it("slots the new sections into a section order saved before the reorganisation", () => {
    expect(mergeSectionOrder(SIDEBAR_SECTION_IDS, ["company", "team", "work", "build"])).toEqual([
      "start", "company", "work", "manage",
    ]);
  });
});

describe("merging a saved layout with the defaults", () => {
  it("adds unknown new items at their default place and drops removed ones", () => {
    const resolved = resolveSidebarLayout({
      sections: { work: ["goals", "retired-page", "dashboard", "tasks"] },
      hidden: ["retired-page", "memory"],
      pinned: ["retired-page", "inbox"],
    });
    expect(itemsOf(resolved, "work")).toEqual(["goals", "dashboard", "board", "intelligence", "memory", "tasks", "projects", "website"]);
    expect(resolved.sections.flatMap((section) => section.items)).not.toContain("retired-page");
    expect(resolved.hidden).toEqual(["memory"]);
    expect(resolved.pinned).toEqual(["inbox"]);
  });

  it("keeps moved items where the user put them, once", () => {
    const resolved = resolveSidebarLayout({
      sections: { today: ["decisions", "deliverables"], clients: ["deliverables", "organisations"] },
    });
    expect(itemsOf(resolved, "start")).toEqual(["my-tasks", "decisions", "inbox", "chats", "calendar", "deliverables"]);
    expect(itemsOf(resolved, "company")).not.toContain("deliverables");
  });

  it("respects hidden items and drops a pin on a hidden item", () => {
    const resolved = resolveSidebarLayout({ hidden: ["goals"], pinned: ["goals", "agents"] });
    expect(resolved.hidden).toEqual(["goals"]);
    expect(resolved.pinned).toEqual(["agents"]);
    // Hidden items keep their slot so showing them again puts them back.
    expect(itemsOf(resolved, "work")).toContain("goals");
  });

  it("remembers folded and opened sections", () => {
    const resolved = resolveSidebarLayout({ collapsed: { work: true, admin: false } });
    expect(resolved.sections.find((section) => section.id === "work")?.open).toBe(false);
    expect(resolved.sections.find((section) => section.id === "manage")?.open).toBe(true);
  });
});

describe("layout changes", () => {
  it("moves an item within a section and across sections", () => {
    let layout = moveSidebarItem({}, "inbox", "start", 0);
    expect(itemsOf(resolveSidebarLayout(layout), "start")).toEqual(["inbox", "my-tasks", "decisions", "chats", "calendar"]);
    layout = moveSidebarItem(layout, "deliverables", "start", 1);
    const resolved = resolveSidebarLayout(layout);
    expect(itemsOf(resolved, "start")).toEqual(["inbox", "deliverables", "my-tasks", "decisions", "chats", "calendar"]);
    expect(itemsOf(resolved, "company")).not.toContain("deliverables");
    expect(moveSidebarItem(layout, "nope", "today", 0)).toBe(layout);
  });

  it("moves up and down past items that are not shown", () => {
    // board sits between goals and intelligence but is switched off.
    const layout = moveSidebarItemBy({}, "intelligence", -1, (id) => id !== "board");
    expect(itemsOf(resolveSidebarLayout(layout), "work")?.slice(3, 6)).toEqual(["goals", "intelligence", "dashboard"]);
    expect(moveSidebarItemBy({}, "my-tasks", -1)).toEqual({});
    expect(itemsOf(resolveSidebarLayout(moveSidebarItemBy({}, "decisions", 1)), "start")).toEqual([
      "my-tasks", "inbox", "decisions", "chats", "calendar",
    ]);
  });

  it("hides, shows, pins and folds", () => {
    let layout = setSidebarItemPinned({}, "agents", true);
    layout = setSidebarItemHidden(layout, "agents", true);
    expect(layout.hidden).toEqual(["agents"]);
    expect(layout.pinned).toEqual([]);
    layout = setSidebarItemHidden(layout, "agents", false);
    expect(layout.hidden).toEqual([]);
    layout = setSidebarSectionOpen(layout, "manage", true);
    expect(resolveSidebarLayout(layout).sections.at(-1)?.open).toBe(true);
  });
});
