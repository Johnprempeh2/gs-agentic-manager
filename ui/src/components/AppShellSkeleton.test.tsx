// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const sidebar = vi.hoisted(() => ({ isMobile: false, collapsed: false, sidebarOpen: true }));
vi.mock("../context/SidebarContext", () => ({ useOptionalSidebar: () => sidebar }));

import { AppShellSkeleton, shellSkeletonVariant } from "./AppShellSkeleton";

describe("shellSkeletonVariant", () => {
  it("picks the route's own page skeleton from the path", () => {
    expect(shellSkeletonVariant("/")).toBe("dashboard");
    expect(shellSkeletonVariant("/GRE/dashboard")).toBe("dashboard");
    expect(shellSkeletonVariant("/GRE/inbox/mine")).toBe("inbox");
    expect(shellSkeletonVariant("/GRE/issues")).toBe("issues-list");
    expect(shellSkeletonVariant("/GRE/issues/GRE-12")).toBe("detail");
    expect(shellSkeletonVariant("/GRE/costs")).toBe("costs");
    expect(shellSkeletonVariant("/GRE/agents")).toBe("list");
  });
});

describe("AppShellSkeleton", () => {
  it("renders the sidebar with the brand, the 60px top bar and a page skeleton on desktop", () => {
    sidebar.isMobile = false;
    const html = renderToStaticMarkup(<AppShellSkeleton pathname="/GRE/dashboard" />);

    expect(html).toContain('role="status"');
    expect(html).toContain('data-slot="sidebar-spacer"');
    expect(html).toContain('data-slot="greatstone-stone"');
    expect(html).toContain("h-(--sz-60px)");
    expect(html).toContain('<span class="sr-only">Loading…</span>');
  });

  it("renders a phone top bar with the stone and no sidebar on a phone", () => {
    sidebar.isMobile = true;
    const html = renderToStaticMarkup(<AppShellSkeleton pathname="/GRE/issues" />);

    expect(html).toContain('data-slot="greatstone-stone"');
    expect(html).toContain("gs-glass-bar");
    expect(html).not.toContain('data-slot="sidebar-spacer"');
  });
});
