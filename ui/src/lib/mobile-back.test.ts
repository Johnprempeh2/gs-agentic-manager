import { describe, expect, it, vi } from "vitest";
import { goBackOr, mobileBackFallback } from "./mobile-back";
import { routeEnterVariant } from "../hooks/useRouteEnterMotion";
import { isTabRoot } from "../components/MobileBottomNav";

describe("phone back navigation", () => {
  it("falls back to the parent crumb on inner pages and keeps the menu on main tabs", () => {
    expect(mobileBackFallback([{ label: "Dashboard" }])).toBeNull();
    expect(mobileBackFallback([{ label: "Agents", href: "/agents" }, { label: "Everest" }])).toBe("/agents");
    expect(mobileBackFallback([{ label: "Tasks", identifier: "GRE-12" }])).toBe("/issues");
    expect(mobileBackFallback([{ label: "Settings" }, { label: "Members" }])).toBe("/dashboard");
  });

  it("goes back through history when there is some, else replaces the page with its parent", () => {
    const navigate = vi.fn();
    goBackOr(navigate, "/issues", { idx: 3 });
    expect(navigate).toHaveBeenLastCalledWith(-1);
    // Opened straight from a link or notification: no in-app history.
    goBackOr(navigate, "/issues", { idx: 0 });
    expect(navigate).toHaveBeenLastCalledWith("/issues", { replace: true });
    goBackOr(navigate, "/issues", null);
    expect(navigate).toHaveBeenLastCalledWith("/issues", { replace: true });
  });
});

describe("phone tab bar", () => {
  it("treats only a tab's own list as its root", () => {
    expect(isTabRoot("/GRE/issues", "/issues")).toBe(true);
    expect(isTabRoot("/GRE/issues/", "/issues")).toBe(true);
    expect(isTabRoot("/GRE/issues/GRE-12", "/issues")).toBe(false);
    expect(isTabRoot("/GRE/dashboard", "/issues")).toBe(false);
  });
});

describe("phone page motion", () => {
  const mobile = (navigationType: "POP" | "PUSH" | "REPLACE") => ({ pathname: "/GRE/issues/GRE-1", navigationType });
  it("rises on a section switch and on desktop, and slides sideways inside a section", () => {
    expect(routeEnterVariant("/GRE/dashboard", "/GRE/issues", mobile("PUSH"))).toBe("rise");
    expect(routeEnterVariant(null, "/GRE/issues", mobile("PUSH"))).toBe("rise");
    expect(routeEnterVariant("/GRE/issues", "/GRE/issues", null)).toBe("rise");
    expect(routeEnterVariant("/GRE/issues", "/GRE/issues", mobile("PUSH"))).toBe("forward");
    expect(routeEnterVariant("/GRE/issues", "/GRE/issues", mobile("POP"))).toBe("back");
  });
});

describe("phone header lead agent", () => {
  it("prefers a ceo, else the top of the org chart with the most reports, never a terminated agent", async () => {
    const { resolveLeadAgent } = await import("../components/MobileEverestButton");
    const team = [
      { id: "everest", role: "general", status: "idle", reportsTo: null },
      { id: "keystone", role: "engineer", status: "idle", reportsTo: "everest" },
      { id: "mica", role: "engineer", status: "idle", reportsTo: "everest" },
      { id: "harbor", role: "pm", status: "idle", reportsTo: null },
      { id: "scout", role: "researcher", status: "idle", reportsTo: "harbor" },
      { id: "loner", role: "engineer", status: "idle", reportsTo: null },
    ];
    expect(resolveLeadAgent(team)?.id).toBe("everest");
    expect(resolveLeadAgent([...team, { id: "boss", role: "ceo", status: "idle", reportsTo: null }])?.id).toBe("boss");
    expect(resolveLeadAgent([{ id: "boss", role: "ceo", status: "terminated", reportsTo: null }, ...team])?.id).toBe("everest");
    expect(resolveLeadAgent([{ id: "solo", role: "engineer", status: "idle", reportsTo: null }])).toBeNull();
  });
});

describe("isChatWith", () => {
  it("knows when the lead agent's own chat is open, by url key or id", async () => {
    const { isChatWith } = await import("../components/MobileEverestButton");
    const everest = { id: "a1", name: "Everest", urlKey: "everest" };
    expect(isChatWith("/GRE/chats/everest", everest)).toBe(true);
    expect(isChatWith("/GRE/chats/a1", everest)).toBe(true);
    expect(isChatWith("/GRE/chats/keystone", everest)).toBe(false);
    expect(isChatWith("/GRE/dashboard", everest)).toBe(false);
  });
});
