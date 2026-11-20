import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useOptionalSidebar } from "../context/SidebarContext";
import { GreatstoneLogo } from "./GreatstoneLogo";
import { PageSkeleton } from "./PageSkeleton";
import { primarySidebarStyles } from "./primary-sidebar-styles";
import { SidebarShell } from "./SidebarShell";

type PageSkeletonVariant = NonNullable<Parameters<typeof PageSkeleton>[0]["variant"]>;

/**
 * Which existing page skeleton fits the route being opened, from its path
 * alone (no company data is loaded yet). `/:prefix/dashboard` and
 * `/dashboard` both read as the dashboard.
 */
export function shellSkeletonVariant(pathname: string): PageSkeletonVariant {
  const segments = pathname.split("/").filter(Boolean).map((segment) => segment.toLowerCase());
  const at = (root: string) => segments.indexOf(root);
  if (segments.length === 0 || at("dashboard") >= 0) return "dashboard";
  if (at("inbox") >= 0) return "inbox";
  if (at("costs") >= 0 || at("budgets") >= 0) return "costs";
  if (at("approvals") >= 0) return "approvals";
  const issues = Math.max(at("issues"), at("tasks"));
  if (issues >= 0) return segments[issues + 1] ? "detail" : "issues-list";
  return "list";
}

const NAV_ROWS = [5, 7, 4];

/**
 * The app's frame while the first API calls are still out: the sidebar with
 * the brand, the top bar, and the route's own page skeleton. It reuses the
 * shell's real sizes (sidebar width and rail, 60px bar, page padding) so the
 * loaded layout lands in the same place.
 */
export function AppShellSkeleton({ pathname }: { pathname?: string }) {
  // Mirrors SidebarProvider's first state when rendered outside it.
  const sidebar = useOptionalSidebar();
  const isMobile = sidebar?.isMobile ?? (typeof window !== "undefined" && window.innerWidth < 768);
  const collapsed = sidebar?.collapsed ?? false;
  const sidebarOpen = sidebar?.sidebarOpen ?? !isMobile;
  const path = pathname ?? (typeof window === "undefined" ? "/" : window.location.pathname);
  const page = <PageSkeleton variant={shellSkeletonVariant(path)} />;

  if (isMobile) {
    return (
      <div role="status" aria-busy="true" data-testid="app-shell-skeleton" className="min-h-dvh overflow-x-clip text-foreground">
        <span className="sr-only">Loading…</span>
        <div className="sticky top-0 z-sticky gs-glass-bar pt-(--sz-safe-top)">
          <div className="gs-page-bar h-(--sz-60px) shrink-0 flex items-center gap-3 px-4">
            <GreatstoneLogo variant="stone" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
        <div className="p-4 pb-(--mobile-nav-content-inset)">{page}</div>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-busy="true"
      data-testid="app-shell-skeleton"
      className="flex h-dvh flex-col overflow-clip pt-(--sz-safe-top) text-foreground"
    >
      <span className="sr-only">Loading…</span>
      <div className="flex min-h-0 flex-1 overflow-clip">
        <SidebarShell className="gs-rail" open={sidebarOpen} collapsed={collapsed}>
          <aside className={cn("flex h-full min-h-0 w-full flex-col", primarySidebarStyles.surface)}>
            <div className="flex h-14 shrink-0 items-center gap-2 pl-6 pr-5">
              <GreatstoneLogo variant={collapsed ? "stone" : "full"} />
            </div>
            <div className={primarySidebarStyles.nav}>
              {NAV_ROWS.map((rows, group) => (
                <div key={group} className={cn(primarySidebarStyles.group, "gap-2 px-2")}>
                  {Array.from({ length: rows }).map((_, row) => (
                    <div key={row} className="flex h-8 items-center gap-2.5 px-2">
                      <Skeleton className="size-4 shrink-0 rounded" />
                      {collapsed ? null : <Skeleton className="h-3 flex-1" />}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </aside>
        </SidebarShell>
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <div className="gs-page-bar h-(--sz-60px) shrink-0 flex items-center gap-3 px-4 md:px-6">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="ml-auto h-8 w-28 rounded-lg" />
          </div>
          <div className="flex-1 overflow-auto p-4 pb-24 md:p-6 md:pb-24 [scrollbar-gutter:stable]">{page}</div>
        </div>
      </div>
    </div>
  );
}
