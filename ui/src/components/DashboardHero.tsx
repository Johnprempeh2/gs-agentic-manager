import { useEffect, useRef } from "react";
import { mountGreatstoneTide } from "../lib/greatstone-tide";
import { BrandMark } from "./BrandMark";

function greetingFor(hour: number) {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * Dashboard welcome band: the organization on the void, with the tide of time
 * and the lime stone on the right. The band stays on the void in both themes
 * (it is the brand image, like the sign-in hero). The tide is masked out of
 * the copy zone entirely, so a lime crest never passes behind text; on small
 * screens there is no room for that quiet zone and the tide is not drawn.
 */
export function DashboardHero({ companyName, now = new Date() }: { companyName: string; now?: Date }) {
  const tideRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = tideRef.current;
    if (!host || typeof window.matchMedia !== "function") return;
    if (!window.matchMedia("(min-width: 640px)").matches) return;
    // The band is wide and short: the tide rises from below its right edge so
    // the arcs sweep through it as concentric curves, spaced tightly.
    const tide = mountGreatstoneTide(host, {
      focalPoint: { x: 1.02, y: 1.7 },
      sweep: [-3.3, -1.25],
      spread: 0.78,
      arcs: 52,
      warpRadius: 0.55,
      warpStrength: 22,
      crestWidth: 0.09,
    });
    return () => tide.destroy();
  }, []);

  const dateLabel = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(now);

  return (
    <section aria-label="Welcome" className="gs-dash-hero relative overflow-hidden rounded-xl border">
      <div ref={tideRef} aria-hidden="true" className="gs-dash-hero-tide absolute inset-0 hidden sm:block" />
      <BrandMark
        variant="outline"
        decorative
        className="gs-dash-hero-mark absolute right-(--gs-dash-hero-mark-inset) top-1/2 hidden h-24 w-auto -translate-y-1/2 sm:block"
      />
      <div className="relative min-w-0 px-6 py-7 sm:w-2/5 sm:px-8 sm:py-9">
        <p className="gs-dash-hero-muted text-xs font-semibold uppercase tracking-(--tracking-eyebrow)">
          {greetingFor(now.getHours())}
        </p>
        <h2 className="mt-1.5 truncate text-3xl font-extrabold tracking-tight">{companyName}</h2>
        <p className="gs-dash-hero-muted mt-1 text-sm">{dateLabel}</p>
      </div>
    </section>
  );
}
