import { useEffect, useState, type CSSProperties } from "react";
import { useCompany } from "../context/CompanyContext";
import { useLiveAgents } from "../hooks/useLiveAgents";
import { useDecisionsCount } from "../hooks/useDecisionsFeed";
import { openAskEverest } from "../lib/ask-everest-events";
import { getPartnerBranding } from "../lib/partner-branding";
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

/**
 * Everest, bottom right of every page: the glowing 3D stone with a count of
 * what needs you. The lime ring turns while the lead agent is running; the
 * glow, bob and ring stop under reduced motion. A click opens Ask Everest
 * over the page.
 */
export function EverestOrb() {
  const { selectedCompanyId } = useCompany();
  const lead = useLeadAgent();
  const { liveAgents } = useLiveAgents(selectedCompanyId);
  const needsYou = useDecisionsCount(selectedCompanyId);
  const lift = useOrbLift();
  if (!lead) return null;

  return (
    <EverestOrbButton
      name={lead.name}
      count={needsYou}
      working={isLeadWorking(liveAgents, lead.id)}
      lift={lift}
      onClick={() => openAskEverest()}
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
    `Ask ${name}`,
    count > 0 ? `${count} ${count === 1 ? "thing needs" : "things need"} you` : null,
    working ? "working now" : null,
  ].filter(Boolean).join(", ");

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={`Ask ${name}`}
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
