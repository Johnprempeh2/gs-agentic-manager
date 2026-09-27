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
 * the copy zone entirely, so a lime crest never passes behind text. Wide
 * screens keep the copy on the left and the tide on the right; on phones the
 * tide runs along a bottom strip the copy can never reach (the copy always
 * ends 5rem above the band's bottom edge, and the mask is measured from it).
 */
export function DashboardHero({ companyName, now = new Date() }: { companyName: string; now?: Date }) {
  const tideRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = tideRef.current;
    if (!host) return;
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
      <div ref={tideRef} aria-hidden="true" className="gs-dash-hero-tide absolute inset-0" />
      <BrandMark
        variant="outline"
        decorative
        className="gs-dash-hero-mark absolute bottom-3 right-6 h-10 w-auto sm:bottom-auto sm:right-(--gs-dash-hero-mark-inset) sm:top-1/2 sm:h-24 sm:-translate-y-1/2"
      />
      <div className="relative min-w-0 px-6 pt-7 pb-20 sm:w-2/5 sm:px-8 sm:py-9">
        <p className="gs-dash-hero-muted text-xs font-semibold uppercase tracking-(--tracking-eyebrow)">
          {greetingFor(now.getHours())}
        </p>
        <h2 className="mt-1.5 break-words text-2xl font-extrabold tracking-tight sm:truncate sm:text-3xl">{companyName}</h2>
        <p className="gs-dash-hero-muted mt-1 text-sm">{dateLabel}</p>
      </div>
    </section>
  );
}
