import { Link, useNavigate } from "@/lib/router";
import { ChevronLeft, Menu, MessageCircle, PanelRightClose, PanelRightOpen, Search } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { useCompany } from "../context/CompanyContext";
import { usePanel } from "../context/PanelContext";
import { Button } from "@/components/ui/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Fragment, useMemo, type ReactNode } from "react";
import { PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet, usePluginLaunchers } from "@/plugins/launchers";
import { cn } from "../lib/utils";
import { goBackOr, mobileBackFallback } from "../lib/mobile-back";
import { MobileEverestButton, useLeadAgent } from "./MobileEverestButton";
import { PageTourButton } from "./PageTourButton";
import { openAskEverest } from "../lib/ask-everest-events";
import { openCommandPalette } from "../lib/global-search";

type GlobalToolbarContext = { companyId: string | null; companyPrefix: string | null };

/** Task identifier rendered in gray monospace beside its breadcrumb label. */
function CrumbIdentifier({ identifier }: { identifier?: string }) {
  if (!identifier) return null;
  return (
    <span data-slot="task-title-identifier" className="shrink-0 font-mono text-(length:--text-micro) text-muted-foreground">
      {identifier}
    </span>
  );
}

function GlobalToolbar({
  context,
  pageToolbar,
}: {
  context: GlobalToolbarContext;
  pageToolbar?: ReactNode;
}) {
  const { slots } = usePluginSlots({ slotTypes: ["globalToolbarButton"], companyId: context.companyId });
  const { launchers } = usePluginLaunchers({ placementZones: ["globalToolbarButton"], companyId: context.companyId, enabled: !!context.companyId });
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1 pl-2 empty:hidden">
      <PageTourButton />
      {pageToolbar}
      <GlobalSearchButton />
      <GlobalAskButton />
      {slots.length > 0 ? (
        <PluginSlotOutlet slotTypes={["globalToolbarButton"]} context={context} className="flex items-center gap-1" />
      ) : null}
      {launchers.length > 0 ? (
        <PluginLauncherOutlet placementZones={["globalToolbarButton"]} context={context} className="flex items-center gap-1" />
      ) : null}
    </div>
  );
}

/**
 * "Search everything" on every page's top bar (desktop): opens the command
 * palette, so nobody has to know Cmd/Ctrl+K to find a task, client or document.
 */
function GlobalSearchButton() {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <button
      type="button"
      onClick={() => openCommandPalette()}
      data-testid="global-search-button"
      aria-label="Search everything"
      aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
      className="hidden h-8 items-center gap-2 rounded-lg border border-border bg-background px-2.5 text-(length:--text-compact) text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring md:inline-flex"
    >
      <Search className="h-4 w-4" aria-hidden="true" />
      <span>Search</span>
      <kbd className="rounded border border-border bg-muted px-1 font-sans text-(length:--text-nano)">{isMac ? "⌘K" : "Ctrl K"}</kbd>
    </button>
  );
}

/** "Ask Everest" on every page's top bar (desktop): opens the Ask panel (Ctrl/Cmd+J). */
function GlobalAskButton() {
  const lead = useLeadAgent();
  if (!lead) return null;
  return (
    <button
      type="button"
      onClick={() => openAskEverest()}
      data-testid="global-ask-button"
      aria-keyshortcuts="Control+J Meta+J"
      className="hidden h-8 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-(length:--text-compact) font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring md:inline-flex"
    >
      <MessageCircle className="h-4 w-4" aria-hidden="true" />
      Ask {lead.name}
    </button>
  );
}

/** Phone back button for inner pages (see lib/mobile-back). */
function MobileBackButton({ fallbackHref }: { fallbackHref: string }) {
  const navigate = useNavigate();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="-ml-2 mr-1 size-10 shrink-0"
      onClick={() => goBackOr(navigate, fallbackHref)}
      aria-label="Back"
    >
      <ChevronLeft className="size-6" />
    </Button>
  );
}

export function BreadcrumbBar({ taskDetailLayout = false }: { taskDetailLayout?: boolean }) {
  const {
    breadcrumbs,
    breadcrumbToolbar,
    breadcrumbPanelControl,
    mobileToolbar,
  } = useBreadcrumbs();
  const { toggleSidebar, isMobile } = useSidebar();
  const { panelVisible, togglePanelVisible } = usePanel();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const taskPanelOpen = breadcrumbPanelControl?.open ?? panelVisible;
  const toggleTaskPanel = breadcrumbPanelControl?.onToggle ?? togglePanelVisible;

  const globalToolbarSlotContext = useMemo(
    () => ({
      companyId: selectedCompanyId ?? null,
      companyPrefix: selectedCompany?.issuePrefix ?? null,
    }),
    [selectedCompanyId, selectedCompany?.issuePrefix],
  );

  const globalToolbarSlots = (
    <GlobalToolbar
      context={globalToolbarSlotContext}
      pageToolbar={isMobile ? null : breadcrumbToolbar}
    />
  );

  if (isMobile && mobileToolbar) {
    return (
      <div className="gs-page-bar h-(--sz-60px) shrink-0 flex items-center px-2">
        {mobileToolbar}
      </div>
    );
  }

  if (breadcrumbs.length === 0) {
    return (
      <div className="gs-page-bar h-(--sz-60px) shrink-0 flex items-center justify-end px-4 md:px-6">
        {globalToolbarSlots}
      </div>
    );
  }

  const menuButton = isMobile && (
    <Button
      variant="ghost"
      size="icon-sm"
      className="mr-2 shrink-0"
      onClick={toggleSidebar}
      aria-label="Open sidebar"
    >
      <Menu className="h-5 w-5" />
    </Button>
  );

  const currentCrumb = breadcrumbs[breadcrumbs.length - 1];
  const backFallback = isMobile ? mobileBackFallback(breadcrumbs) : null;
  if (isMobile && backFallback) {
    // Inner page on a phone: back arrow and the page title, like a native app.
    return (
      <div className="gs-page-bar h-(--sz-60px) shrink-0 flex items-center px-4">
        <MobileBackButton fallbackHref={backFallback} />
        <h1 className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm font-semibold">
          {currentCrumb.leading ? (
            <span className="flex shrink-0 items-center self-center">{currentCrumb.leading}</span>
          ) : null}
          <span className="min-w-0 truncate" title={currentCrumb.label}>{currentCrumb.label}</span>
          <CrumbIdentifier identifier={currentCrumb.identifier} />
        </h1>
        {globalToolbarSlots}
      </div>
    );
  }
  if (isMobile && breadcrumbs[0]?.label === "Tasks" && currentCrumb.identifier) {
    return (
      <div className="gs-page-bar h-(--sz-60px) shrink-0 flex items-center px-4">
        {menuButton}
        <h1 className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm">
          {currentCrumb.leading ? (
            <span className="flex shrink-0 items-center self-center">{currentCrumb.leading}</span>
          ) : null}
          <span className="min-w-0 truncate" title={currentCrumb.label}>{currentCrumb.label}</span>
          <CrumbIdentifier identifier={currentCrumb.identifier} />
        </h1>
        {globalToolbarSlots}
      </div>
    );
  }

  const breadcrumbTrail = (
    <div className="min-w-0 overflow-hidden flex-1">
      <Breadcrumb className="min-w-0 overflow-hidden">
        <BreadcrumbList className="flex-nowrap">
          {breadcrumbs.map((crumb, i) => {
            const isLast = i === breadcrumbs.length - 1;
            return (
              <Fragment key={i}>
                {i > 0 && <BreadcrumbSeparator />}
                <BreadcrumbItem className={isLast ? "min-w-0" : "shrink-0"}>
                  {isLast || !crumb.href ? (
                    crumb.leading || crumb.identifier ? (
                      <BreadcrumbPage className="flex min-w-0 items-baseline gap-1.5">
                        {crumb.leading && (
                          <span className="flex shrink-0 items-center self-center">{crumb.leading}</span>
                        )}
                        {!taskDetailLayout ? <CrumbIdentifier identifier={crumb.identifier} /> : null}
                        <span className="min-w-0 truncate">{crumb.label}</span>
                        {taskDetailLayout && isLast ? <CrumbIdentifier identifier={crumb.identifier} /> : null}
                      </BreadcrumbPage>
                    ) : (
                      <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
                    )
                  ) : (
                    <BreadcrumbLink asChild>
                      {crumb.leading || crumb.identifier ? (
                        <Link
                          to={crumb.href} onClick={crumb.onClick}
                          className={cn(
                            "flex min-w-0 items-baseline gap-1.5",
                            i === 0 && "font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {crumb.leading && (
                            <span className="flex shrink-0 items-center self-center">{crumb.leading}</span>
                          )}
                          {!taskDetailLayout ? <CrumbIdentifier identifier={crumb.identifier} /> : null}
                          <span className="min-w-0 truncate">{crumb.label}</span>
                          {taskDetailLayout && isLast ? <CrumbIdentifier identifier={crumb.identifier} /> : null}
                        </Link>
                      ) : (
                        <Link
                          to={crumb.href} onClick={crumb.onClick}
                          className={cn(
                            "min-w-0 truncate",
                            i === 0 && "font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {crumb.label}
                        </Link>
                      )}
                    </BreadcrumbLink>
                  )}
                  {crumb.trailing && <span className="flex shrink-0 items-center">{crumb.trailing}</span>}
                </BreadcrumbItem>
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  );

  // Task details use the same breadcrumb typography even with one item.
  // Other single-crumb pages keep their existing page-title presentation.
  if (breadcrumbs.length === 1 && !taskDetailLayout) {
    return (
      <div className="gs-page-bar h-(--sz-60px) shrink-0 flex items-center px-4 md:px-6">
        {menuButton}
        <div className="min-w-0 overflow-hidden flex-1">
          {breadcrumbs[0].leading || breadcrumbs[0].identifier ? (
            <h1 className="gs-page-title flex items-baseline gap-1.5 text-lg font-bold tracking-tight">
              {breadcrumbs[0].leading && (
                <span className="flex shrink-0 items-center self-center">{breadcrumbs[0].leading}</span>
              )}
              <CrumbIdentifier identifier={breadcrumbs[0].identifier} />
              <span className="truncate">{breadcrumbs[0].label}</span>
            </h1>
          ) : (
            <h1 className="gs-page-title text-lg font-bold tracking-tight truncate">
              {breadcrumbs[0].label}
            </h1>
          )}
        </div>
        {globalToolbarSlots}
        {isMobile ? <MobileEverestButton /> : null}
      </div>
    );
  }

  // Multiple breadcrumbs = breadcrumb trail
  return (
    <div
      className={cn(
        "gs-page-bar relative h-(--sz-60px) shrink-0 flex items-center",
        "px-4 md:px-6",
      )}
    >
      {menuButton}
      {breadcrumbTrail}
      {globalToolbarSlots}
      {taskDetailLayout ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-5 size-9 shrink-0 text-muted-foreground"
          onClick={toggleTaskPanel}
          aria-label={taskPanelOpen ? "Hide properties" : "Show properties"}
          title={taskPanelOpen ? "Hide properties" : "Show properties"}
        >
          {taskPanelOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
        </Button>
      ) : null}
    </div>
  );
}
