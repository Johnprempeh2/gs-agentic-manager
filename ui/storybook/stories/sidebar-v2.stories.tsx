import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AskEverestPanel } from "@/components/AskEverestPanel";
import { EverestOrb } from "@/components/EverestOrb";
import { MobileBottomNav } from "@/components/MobileBottomNav";
import { Sidebar } from "@/components/Sidebar";
import { SidebarAccountMenu } from "@/components/SidebarAccountMenu";
import { SidebarShell } from "@/components/SidebarShell";
import { useSidebar } from "@/context/SidebarContext";
import { openAskEverest } from "@/lib/ask-everest-events";
import { openSidebarCustomise } from "@/lib/sidebar-layout";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { storybookAgents } from "../fixtures/paperclipData";

/**
 * Sidebar v2 (John, 12 Nov): direction A open, direction B collapsed. A
 * floating liquid-glass panel with the real Greatstone logo, the account menu
 * bottom left and Everest glowing bottom right. The whole app frame is real:
 * SidebarShell, Sidebar, SidebarAccountMenu, EverestOrb and AskEverestPanel.
 */

const agents = storybookAgents.map((agent) =>
  agent.id === "agent-cto" ? { ...agent, name: "Everest", role: "ceo", urlKey: "everest" } : agent,
);
const needsMe = { count: 7, decisionCount: 7, assignedTaskCount: 0, overdueWaits: [], assignedTasks: [], decisions: [] };

function installFetch() {
  const marker = window as typeof window & { __sidebarV2StoryFetch?: boolean };
  if (marker.__sidebarV2StoryFetch) return;
  marker.__sidebarV2StoryFetch = true;
  const inner = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin);
    if (/\/api\/companies\/[^/]+\/agents$/.test(url.pathname)) return Response.json(agents);
    if (/\/api\/companies\/[^/]+\/needs-me$/.test(url.pathname)) return Response.json(needsMe);
    return inner(input, init);
  };
}

type Mode = "open" | "collapsed" | "customise" | "account" | "everest";

function Stage({ mode }: { mode: Mode }) {
  installFetch();
  const { collapsed, setCollapsed, peeking, isMobile } = useSidebar();
  // Phones: the sidebar is a drawer (as in Layout); "collapsed" means closed.
  const drawerOpen = isMobile && mode !== "collapsed" && mode !== "everest";

  useEffect(() => {
    setCollapsed(mode === "collapsed");
  }, [mode, setCollapsed]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (mode === "customise") openSidebarCustomise();
      if (mode === "everest") openAskEverest();
      if (mode === "account") document.querySelector<HTMLButtonElement>('button[aria-label="Open account menu"]')?.click();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [mode]);

  return (
    <div className="flex h-dvh overflow-hidden text-foreground">
      {isMobile ? (
        drawerOpen ? (
          <>
            <div className="fixed inset-0 z-drawer gs-scrim" />
            <div className="gs-rail gs-sidebar-drawer fixed inset-y-0 left-0 z-drawer flex flex-col">
              <div className="gs-sidebar-glass w-72">
                <div className="flex min-h-0 flex-1 overflow-hidden">
                  <div className="w-full min-w-0 overflow-hidden"><Sidebar /></div>
                </div>
                <SidebarAccountMenu deploymentMode="authenticated" />
              </div>
            </div>
          </>
        ) : null
      ) : (
        <SidebarShell className="gs-rail" open collapsed={collapsed} peeking={peeking} resizable>
          <div className="flex min-h-0 flex-1">
            <Sidebar />
          </div>
          <SidebarAccountMenu deploymentMode="authenticated" />
        </SidebarShell>
      )}
      <main className="flex min-w-0 flex-1 flex-col gap-4 p-6">
        <h1 className="text-xl font-bold">Desk</h1>
        <p className="text-sm text-muted-foreground">Seven things need you today. The top one is approving the header and footer.</p>
        {[0, 1, 2].map((index) => (
          <div key={index} className="gs-glass-card h-28 rounded-xl border p-4">
            <p className="text-sm font-semibold">Decision {index + 1}</p>
            <p className="text-sm text-muted-foreground">Waiting on your sign-off.</p>
          </div>
        ))}
      </main>
      <AskEverestPanel />
      <EverestOrb />
      {isMobile ? <MobileBottomNav visible /> : null}
    </div>
  );
}

const meta: Meta<typeof Stage> = {
  title: "Chrome/Sidebar v2",
  component: Stage,
  decorators: [(Story) => <PluginLauncherProvider><Story /></PluginLauncherProvider>],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof Stage>;

export const Open: Story = { args: { mode: "open" } };
export const CollapsedWithFlyout: Story = { args: { mode: "collapsed" } };
export const Customise: Story = { args: { mode: "customise" } };
export const AccountMenu: Story = { args: { mode: "account" } };
export const EverestOpen: Story = { args: { mode: "everest" } };
