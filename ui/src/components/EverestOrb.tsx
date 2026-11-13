import { useEffect, useState, type CSSProperties } from "react";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { useLiveAgents } from "../hooks/useLiveAgents";
import { useConversations } from "../hooks/useConversations";
import { useLocation, useNavigate } from "../lib/router";
import { getPartnerBranding } from "../lib/partner-branding";
import { cn } from "../lib/utils";
import { ProductMark } from "./BrandLockup";
import { GREATSTONE_STONE_3D_SRC } from "./GreatstoneLogo";
import { useLeadAgent } from "./MobileEverestButton";

export function isLeadWorking(liveAgents: readonly { agentId: string }[], leadId: string): boolean {
  return liveAgents.some((agent) => agent.agentId === leadId);
}

/** Room the orb keeps above a chat composer, and how far in from the right edge it lives. */
const ORB_GAP = 12;
const ORB_ZONE = 96;

/**
 * How far up the orb must sit to clear every `[data-orb-avoid]` element (chat
 * composers) that reaches into its bottom-right corner, in px from the bottom.
 */
export function orbLiftFor(rects: readonly Pick<DOMRect, "top" | "right" | "height">[], viewportWidth: number, viewportHeight: number): number {
  let top = viewportHeight;
  for (const rect of rects) {
    if (rect.height > 0 && rect.right > viewportWidth - ORB_ZONE && rect.top < viewportHeight) top = Math.min(top, rect.top);
  }
  return top < viewportHeight ? Math.round(viewportHeight - top + ORB_GAP) : 0;
}

// ponytail: one rAF-throttled body MutationObserver; move to a composer-published
// CSS variable if this ever shows up in a profile.
function useOrbLift(): number {
  const [lift, setLift] = useState(0);
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rects = [...document.querySelectorAll<HTMLElement>("[data-orb-avoid]")].map((el) => el.getBoundingClientRect());
        setLift(orbLiftFor(rects, window.innerWidth, window.innerHeight));
      });
    };
    const observer = new MutationObserver(measure);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, []);
  return lift;
}

/** Messages is open already (its list, a team chat or an agent chat). */
export function isMessagesPath(pathname: string): boolean {
  return /\/(messages|chats\/[^/]+)(\/|$)/.test(pathname);
}

/**
 * Everest, bottom right of every page: the glowing 3D stone with the count of
 * unread messages across every conversation. A click opens Messages, with
 * Everest's thread at the top of the list. The lime ring turns while the lead
 * agent is running; the glow, bob and ring stop under reduced motion. Hidden
 * inside Messages, where it would only point at itself.
 */
export function EverestOrb() {
  const { selectedCompanyId } = useCompany();
  const lead = useLeadAgent();
  const { liveAgents } = useLiveAgents(selectedCompanyId);
  const { unread } = useConversations();
  const lift = useOrbLift();
  const { isMobile } = useSidebar();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // Phones dock Everest into the bottom tab bar (EverestTab) instead.
  if (!lead || isMobile || isMessagesPath(pathname)) return null;

  return (
    <EverestOrbButton
      name={lead.name}
      count={unread}
      working={isLeadWorking(liveAgents, lead.id)}
      lift={lift}
      onClick={() => navigate("/messages")}
    />
  );
}

/**
 * The orb itself, without data: the design guide shows it in place with
 * `preview` (in the page flow instead of fixed to the corner).
 */
export function EverestOrbButton({
  name,
  count: rawCount,
  working,
  lift = 0,
  preview = false,
  onClick,
}: {
  name: string;
  count: number;
  working: boolean;
  lift?: number;
  preview?: boolean;
  onClick?: () => void;
}) {
  const count = rawCount > 0 ? rawCount : 0;
  const label = [
    "Open messages",
    count > 0 ? `${count} unread` : null,
    working ? `${name} working now` : null,
  ].filter(Boolean).join(", ");

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title="Messages"
      className="gs-everest-orb print:hidden"
      data-testid={preview ? undefined : "everest-orb"}
      data-tour={preview ? undefined : "global-ask"}
      data-preview={preview ? "" : undefined}
      data-working={working ? "true" : "false"}
      style={{ "--orb-lift": `${lift}px` } as CSSProperties}
    >
      {getPartnerBranding()
        ? <ProductMark className="h-1/2 w-auto" />
        : <img src={GREATSTONE_STONE_3D_SRC} alt="" aria-hidden="true" className="gs-everest-orb-stone" />}
      {count > 0 ? <span className="gs-everest-orb-count" aria-hidden="true">{count > 99 ? "99+" : count}</span> : null}
    </button>
  );
}

/**
 * Everest on phones: a tab in the bottom tab bar (the whole cell is the 44px+
 * target), so nothing floats over the page. It opens Messages, where Everest
 * is the first conversation, and carries the unread count.
 */
export function EverestTab() {
  const { selectedCompanyId } = useCompany();
  const lead = useLeadAgent();
  const { liveAgents } = useLiveAgents(selectedCompanyId);
  const { unread } = useConversations();
  const navigate = useNavigate();
  const here = isMessagesPath(useLocation().pathname);
  if (!lead) return null;
  const working = isLeadWorking(liveAgents, lead.id);
  return (
    <button
      type="button"
      onClick={() => navigate("/messages")}
      aria-label={["Messages", unread > 0 ? `${unread} unread` : null, working ? `${lead.name} working now` : null].filter(Boolean).join(", ")}
      data-testid="everest-tab"
      data-tour="global-ask"
      aria-current={here ? "page" : undefined}
      className={cn(
        "relative flex min-h-11 min-w-0 select-none flex-col items-center justify-center gap-1 rounded-md text-(length:--text-nano) font-medium transition-[color,transform] duration-(--motion-press) hover:text-foreground active:scale-95",
        here ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <span className="gs-everest-orb" data-variant="tab" data-working={working ? "true" : "false"} aria-hidden="true">
        {getPartnerBranding()
          ? <ProductMark className="h-1/2 w-auto" />
          : <img src={GREATSTONE_STONE_3D_SRC} alt="" className="gs-everest-orb-stone" />}
        {unread > 0 ? <span className="gs-everest-orb-count">{unread > 99 ? "99+" : unread}</span> : null}
      </span>
      <span className="truncate">Messages</span>
    </button>
  );
}
