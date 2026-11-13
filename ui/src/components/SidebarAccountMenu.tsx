import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  ChevronsUpDown,
  Flag,
  GraduationCap,
  LogOut,
  Rocket,
  Settings,
  SlidersHorizontal,
  Sparkles,
  type LucideIcon,
  UserRound,
  UserRoundPen,
} from "lucide-react";
import type { DeploymentMode } from "@greatstone/shared";
import { Link } from "@/lib/router";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { useCloudInstance } from "@/hooks/useCloudInstance";
import { useSignOut } from "@/hooks/useSignOut";
import { useSidebar } from "../context/SidebarContext";
import { useCompany } from "../context/CompanyContext";
import { useCanRelease } from "../hooks/useReleases";
import { openSidebarCustomise } from "../lib/sidebar-layout";
import { useWhatsNewUnseen } from "../lib/whats-new";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "../lib/utils";
import { ThemeToggle } from "./ThemeToggle";
import { SidebarServerInfo } from "./SidebarServerInfo";

const PROFILE_SETTINGS_PATH = "/company/settings/instance/profile";
// Feedback goes to Greatstone, never to the upstream project.
const FEEDBACK_URL = "mailto:info@greatstone.co.uk?subject=GS%20Agentic%20Manager%20feedback";

interface SidebarAccountMenuProps {
  deploymentMode?: DeploymentMode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Contextual navigation occupies a full sidebar even if the saved global nav mode is collapsed. */
  forceExpanded?: boolean;
}

interface MenuActionProps {
  label: string;
  icon: LucideIcon;
  onClick?: () => void;
  href?: string;
  external?: boolean;
  tag?: string;
}

function deriveInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

// The built-in local board user carries a placeholder address, never a real one.
const LOCAL_BOARD_PLACEHOLDER_EMAIL = "local@paperclip.local";

function deriveUserSlug(name: string | null | undefined, email: string | null | undefined, id: string | null | undefined) {
  const candidates = [name, email?.split("@")[0], email, id];
  for (const candidate of candidates) {
    const slug = candidate
      ?.trim()
      .toLowerCase()
      .replace(/['"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug) return slug;
  }
  return "me";
}

function MenuAction({
  label,
  icon: Icon,
  onClick,
  href,
  external = false,
  tag,
}: MenuActionProps) {
  const className =
    "flex h-(--profile-popover-row-height) w-full items-center gap-(--profile-popover-row-gap) rounded-lg px-2.5 text-left text-(length:--text-compact) font-medium leading-(--profile-popover-label-line-height) text-foreground transition-colors hover:bg-accent";

  const content = (
    <>
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {tag ? (
        <span className="shrink-0 rounded-full bg-status-warning-soft px-1.5 py-0.5 text-(length:--text-micro) font-semibold text-status-warning-foreground">
          {tag}
        </span>
      ) : null}
    </>
  );

  if (href) {
    if (external) {
      return (
        <a href={href} target="_blank" rel="noreferrer" className={className} onClick={onClick}>
          {content}
        </a>
      );
    }

    return (
      <Link to={href} className={className} onClick={onClick}>
        {content}
      </Link>
    );
  }

  return (
    <button type="button" className={className} onClick={onClick}>
      {content}
    </button>
  );
}

export function SidebarAccountMenu({
  deploymentMode,
  open: controlledOpen,
  onOpenChange,
  forceExpanded = false,
}: SidebarAccountMenuProps) {
  const isCloud = Boolean(useCloudInstance());
  const [internalOpen, setInternalOpen] = useState(false);
  const { isMobile, setSidebarOpen, collapsed, peeking } = useSidebar();
  const { selectedCompany, selectedCompanyId } = useCompany();
  // Releasing is the board's decision (GRE-119): agents never see the page.
  const { canRelease } = useCanRelease(selectedCompanyId);
  const whatsNewUnseen = useWhatsNewUnseen();
  const rail = collapsed && !peeking && !forceExpanded;
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  const signOutMutation = useSignOut({ onSignedOut: closeNavigationChrome });

  const displayName = session?.user.name?.trim() || "Board";
  const email = session?.user.email?.trim();
  const secondaryLabel =
    (email && email !== LOCAL_BOARD_PLACEHOLDER_EMAIL ? email : null)
    || (deploymentMode === "authenticated" ? "Signed in" : "This computer");
  const initials = deriveInitials(displayName);
  const profileHref = `/u/${deriveUserSlug(session?.user.name, session?.user.email, session?.user.id)}`;

  function closeNavigationChrome() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
  }

  function handleSignOut() {
    signOutMutation.mutate();
  }

  return (
    <div className="shrink-0 border-t border-sidebar-border px-2 py-2" data-slot="sidebar-account">
      <div className="flex items-center gap-0.5">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex min-w-0 items-center gap-2.5 rounded-xl text-left text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
                rail ? "w-full justify-center py-2" : "flex-1 px-2 py-1.5",
              )}
              aria-label="Open account menu"
              data-tour="account-menu"
            >
              <Avatar size="sm">
                {session?.user.image ? <AvatarImage src={session.user.image} alt={displayName} /> : null}
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
              <span className={rail ? "sr-only" : "min-w-0 flex-1"}>
                <span className="block truncate text-(length:--text-compact) font-semibold">{displayName}</span>
                {selectedCompany ? (
                  <span className="block truncate text-xs text-muted-foreground" data-slot="account-company">
                    {selectedCompany.name}
                  </span>
                ) : null}
              </span>
              {rail ? null : <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
            </button>
          </PopoverTrigger>
          <PopoverContent
            side={rail ? "right" : "top"}
            align={rail ? "end" : "start"}
            sideOffset={10}
            className="max-h-(--radix-popover-content-available-height) w-(--profile-popover-width) max-w-(--sz-calc-24) overflow-y-auto rounded-xl border-border bg-popover p-0 shadow-(--shadow-profile-popover)"
          >
            <div className="flex h-(--profile-popover-header-height) shrink-0 items-center gap-2.5 px-3.5">
              <Avatar className="size-9">
                {session?.user.image ? <AvatarImage src={session.user.image} alt={displayName} /> : null}
                <AvatarFallback className="text-xs text-foreground">{initials}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-semibold leading-(--profile-popover-label-line-height) text-foreground">
                  {displayName}
                </h2>
                <p className="truncate text-(length:--text-micro) leading-(--profile-popover-meta-line-height) text-muted-foreground">
                  {secondaryLabel}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-0.5 border-t border-border px-2.5 py-2" data-slot="account-menu-company">
              <SidebarCompanyMenu inMenu />
            </div>
            <div className="flex flex-col gap-0.5 border-t border-border px-2.5 py-2">
              <MenuAction label="Your profile" icon={UserRound} href={profileHref} onClick={closeNavigationChrome} />
              <MenuAction label="Edit profile" icon={UserRoundPen} href={PROFILE_SETTINGS_PATH} onClick={closeNavigationChrome} />
              <MenuAction label="Notifications" icon={Bell} href="/notifications" onClick={closeNavigationChrome} />
              <ThemeToggle variant="compact-menu-action" onAfterToggle={() => setOpen(false)} />
              <MenuAction
                label="Customise menu"
                icon={SlidersHorizontal}
                onClick={() => {
                  setOpen(false);
                  openSidebarCustomise();
                }}
              />
            </div>
            <div className="flex flex-col gap-0.5 border-t border-border px-2.5 py-2">
              <MenuAction label="Company settings" icon={Settings} href="/company/settings" onClick={closeNavigationChrome} />
              {canRelease ? (
                <MenuAction label="Releases" icon={Rocket} href="/releases" onClick={closeNavigationChrome} />
              ) : null}
              <MenuAction label="Tutorials" icon={GraduationCap} href="/tutorials" onClick={closeNavigationChrome} />
              <MenuAction
                label="What's new"
                icon={Sparkles}
                href="/whats-new"
                onClick={closeNavigationChrome}
                tag={whatsNewUnseen ? "New" : undefined}
              />
            </div>
            <div className="flex flex-col gap-0.5 border-t border-border px-2.5 pb-2.5 pt-2">
              {deploymentMode === "authenticated" ? (
                <button
                  type="button"
                  className={cn(
                    "flex h-(--profile-popover-row-height) w-full items-center gap-(--profile-popover-row-gap) rounded-lg px-2.5 text-left text-(length:--text-compact) font-medium leading-(--profile-popover-label-line-height) text-foreground transition-colors hover:bg-destructive/10",
                    signOutMutation.isPending && "cursor-not-allowed opacity-60",
                  )}
                  onClick={handleSignOut}
                  disabled={signOutMutation.isPending}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                    <LogOut className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {signOutMutation.isPending ? "Signing out..." : "Sign out"}
                  </span>
                </button>
              ) : null}
              <SidebarServerInfo />
            </div>
          </PopoverContent>
        </Popover>
        {!rail && !isCloud ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={FEEDBACK_URL}
                aria-label="Email feedback to Greatstone"
                className="flex size-8 shrink-0 items-center justify-center rounded-lg text-subtle-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Flag className="h-4 w-4" aria-hidden="true" />
              </a>
            </TooltipTrigger>
            <TooltipContent side="top">Email feedback to Greatstone</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}
