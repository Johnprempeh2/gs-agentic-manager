import { useMemo } from "react";
import { NavLink, useLocation } from "@/lib/router";
import {
  House,
  CircleCheck,
  SquarePen,
  ListChecks,
  Inbox,
} from "lucide-react";
import { useDecisionsCount } from "../hooks/useDecisionsFeed";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { cn } from "../lib/utils";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { useAppBadge } from "../hooks/usePushNotifications";
import { Badge } from "@/components/ui/badge";

interface MobileBottomNavProps {
  visible: boolean;
}

interface MobileNavLinkItem {
  type: "link";
  to: string;
  label: string;
  icon: typeof House;
  badge?: number;
}

interface MobileNavActionItem {
  type: "action";
  label: string;
  icon: typeof SquarePen;
  onClick: () => void;
}

type MobileNavItem = MobileNavLinkItem | MobileNavActionItem;

/** True on a tab's own list (`/GRE/issues`), not a page inside it (`/GRE/issues/GRE-12`). */
export function isTabRoot(pathname: string, tabPath: string): boolean {
  return new RegExp(`^/[^/]+${tabPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?$`).test(pathname);
}

export function MobileBottomNav({ visible }: MobileBottomNavProps) {
  const location = useLocation();
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialogActions();
  const inboxBadge = useInboxBadge(selectedCompanyId);
  // The one Decisions count (GRE-263): same number as the Decisions header and Focus.
  const attentionCount = useDecisionsCount(selectedCompanyId);
  // The Home Screen icon shows the same Decisions count (push updates it too).
  useAppBadge(attentionCount);

  const items = useMemo<MobileNavItem[]>(
    () => [
      { type: "link", to: "/dashboard", label: "Home", icon: House },
      { type: "link", to: "/issues", label: "Tasks", icon: CircleCheck },
      { type: "action", label: "New Task", icon: SquarePen, onClick: () => openNewIssue() },
      // Decisions replaced Agents (GRE-66): the bar holds the places a person
      // acts from; Agents stays one tap away in the sidebar drawer.
      {
        type: "link",
        to: "/decisions",
        label: "Decisions",
        icon: ListChecks,
        badge: attentionCount,
      },
      {
        type: "link",
        to: "/inbox",
        label: "Inbox",
        icon: Inbox,
        badge: inboxBadge.inbox,
      },
    ],
    [openNewIssue, inboxBadge.inbox, attentionCount],
  );

  return (
    <nav
      className={cn(
        "fixed bottom-0 left-0 right-0 z-30 border-t border-border gs-glass-bar transition-transform duration-200 ease-out md:hidden pb-(--sz-safe-bottom)",
        visible ? "translate-y-0" : "translate-y-full",
      )}
      aria-label="Mobile navigation"
    >
      <div className="grid h-16 grid-cols-5 px-1">
        {items.map((item) => {
          if (item.type === "action") {
            const Icon = item.icon;
            const active = /\/issues\/new(?:\/|$)/.test(location.pathname);
            return (
              <button
                key={item.label}
                type="button"
                onClick={item.onClick}
                className={cn(
                  "relative flex min-w-0 select-none flex-col items-center justify-center gap-1 rounded-md text-(length:--text-nano) font-medium transition-[color,transform] duration-(--motion-press) active:scale-95",
                  active
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span className="flex h-7 w-12 items-center justify-center rounded-full">
                  <Icon className="h-(--sz-18px) w-(--sz-18px)" />
                </span>
                <span className="truncate">{item.label}</span>
              </button>
            );
          }

          const Icon = item.icon;
          return (
            <NavLink
              key={item.label}
              to={item.to}
              state={SIDEBAR_SCROLL_RESET_STATE}
              onClick={(event) => {
                // Tapping the tab you are already on scrolls it to the top,
                // like an iPhone app. From a page inside the tab it still
                // navigates back to the tab's list.
                if (!isTabRoot(location.pathname, item.to)) return;
                event.preventDefault();
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              className={({ isActive }) =>
                cn(
                  "relative flex min-w-0 select-none flex-col items-center justify-center gap-1 rounded-md text-(length:--text-nano) font-medium transition-[color,transform] duration-(--motion-press) active:scale-95",
                  isActive
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={cn(
                      "relative flex h-7 w-12 items-center justify-center rounded-full transition-colors duration-(--motion-press)",
                      isActive && "bg-primary/15 text-primary",
                    )}
                  >
                    <Icon className={cn("h-(--sz-18px) w-(--sz-18px)", isActive && "stroke-(length:--sw-2_3)")} />
                    {item.badge != null && item.badge > 0 && (
                      <Badge variant="ghost" className="absolute -right-1 -top-1.5 bg-primary px-1.5 text-(length:--text-nano) leading-none text-primary-foreground">
                        {item.badge > 99 ? "99+" : item.badge}
                      </Badge>
                    )}
                  </span>
                  <span className="truncate">{item.label}</span>
                </>
              )}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
