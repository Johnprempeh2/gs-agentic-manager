// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EverestOrb, EverestTab, isLeadWorking, isMessagesPath, orbLiftFor } from "./EverestOrb";

const state = vi.hoisted(() => ({
  lead: { id: "everest", name: "Everest" } as { id: string; name: string } | null,
  live: [] as { agentId: string }[],
  unread: 0,
  isMobile: false,
  path: "/GRE/desk",
  navigate: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../hooks/useLiveAgents", () => ({ useLiveAgents: () => ({ liveAgents: state.live }) }));
vi.mock("../hooks/useConversations", () => ({ useConversations: () => ({ unread: state.unread }) }));
vi.mock("../lib/router", () => ({ useNavigate: () => state.navigate, useLocation: () => ({ pathname: state.path }) }));
vi.mock("./MobileEverestButton", () => ({ useLeadAgent: () => state.lead }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: state.isMobile }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("EverestOrb", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    state.lead = { id: "everest", name: "Everest" };
    state.live = [];
    state.unread = 0;
    state.isMobile = false;
    state.path = "/GRE/desk";
    state.navigate = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  const orb = () => container.querySelector<HTMLButtonElement>('[data-testid="everest-orb"]');

  it("animates only when the lead has a running run", () => {
    expect(isLeadWorking([{ agentId: "everest" }], "everest")).toBe(true);
    expect(isLeadWorking([{ agentId: "mica" }], "everest")).toBe(false);
  });

  it("opens Messages on click, and steps aside inside Messages", () => {
    flushSync(() => root.render(<EverestOrb />));
    orb()!.click();
    expect(state.navigate).toHaveBeenCalledWith("/messages");

    expect(isMessagesPath("/GRE/messages")).toBe(true);
    expect(isMessagesPath("/GRE/messages/c1")).toBe(true);
    expect(isMessagesPath("/GRE/chats/everest")).toBe(true);
    expect(isMessagesPath("/GRE/desk")).toBe(false);
    state.path = "/GRE/chats/everest";
    flushSync(() => root.render(<EverestOrb key="in-messages" />));
    expect(orb()).toBeNull();
  });

  it("shows the 3D stone, the unread count across conversations, and the turning ring while working", () => {
    state.unread = 7;
    state.live = [{ agentId: "everest" }];
    flushSync(() => root.render(<EverestOrb />));

    expect(orb()?.className).toContain("gs-everest-orb");
    expect(orb()?.querySelector("img.gs-everest-orb-stone")).not.toBeNull();
    expect(orb()?.querySelector(".gs-everest-orb-count")?.textContent).toBe("7");
    expect(orb()?.getAttribute("data-working")).toBe("true");
    expect(orb()?.getAttribute("aria-label")).toBe("Open messages, 7 unread, Everest working now");
  });

  it("rests quietly with no count and no turning ring", () => {
    flushSync(() => root.render(<EverestOrb />));
    expect(orb()?.querySelector(".gs-everest-orb-count")).toBeNull();
    expect(orb()?.getAttribute("data-working")).toBe("false");
    expect(orb()?.getAttribute("aria-label")).toBe("Open messages");
  });

  it("is not shown when the team has no lead", () => {
    state.lead = null;
    flushSync(() => root.render(<EverestOrb />));
    expect(orb()).toBeNull();
  });

  it("rises above a composer in its corner, and ignores one that is elsewhere", () => {
    // 1440 x 900 viewport; a composer docked at the bottom reaching the right edge.
    expect(orbLiftFor([{ top: 780, right: 1400, height: 120 }], 1440, 900)).toBe(132);
    // A composer on the left half never moves the orb.
    expect(orbLiftFor([{ top: 780, right: 700, height: 120 }], 1440, 900)).toBe(0);
    // Hidden or off-screen composers are ignored.
    expect(orbLiftFor([{ top: 780, right: 1400, height: 0 }], 1440, 900)).toBe(0);
    expect(orbLiftFor([{ top: 950, right: 1400, height: 120 }], 1440, 900)).toBe(0);
  });

  it("never floats over a phone page: on phones the orb is not mounted at all", () => {
    state.isMobile = true;
    flushSync(() => root.render(<EverestOrb />));
    expect(orb()).toBeNull();
    expect(document.querySelector(".gs-everest-orb")).toBeNull();
  });

  it("on phones Everest is a tab that opens Messages with the unread count, with a 44px target", () => {
    state.live = [{ agentId: "everest" }];
    state.unread = 3;
    flushSync(() => root.render(<EverestTab />));

    const tab = container.querySelector<HTMLButtonElement>('[data-testid="everest-tab"]')!;
    expect(tab.className).toContain("min-h-11");
    // The stone sits inside the tab, in the flow, never fixed over the page.
    expect(tab.querySelector('.gs-everest-orb[data-variant="tab"]')?.getAttribute("data-working")).toBe("true");
    expect(tab.textContent).toContain("Messages");
    expect(tab.querySelector(".gs-everest-orb-count")?.textContent).toBe("3");
    expect(tab.getAttribute("aria-label")).toBe("Messages, 3 unread, Everest working now");
    tab.click();
    expect(state.navigate).toHaveBeenCalledWith("/messages");
  });
});
