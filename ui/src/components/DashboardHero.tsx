import { BrandMark } from "./BrandMark";

function greetingFor(hour: number) {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * Dashboard welcome band: the organization on the void, with a soft emerald
 * glow and the lime stone on the right. The band stays on the void in both
 * themes (it is the brand image, like the sign-in hero). Nothing moves and no
 * line crosses it: the fanned arcs went on 27 Nov with the other corner waves.
 * The glow is centred behind the stone and has faded out before the copy.
 */
export function DashboardHero({ companyName, now = new Date() }: { companyName: string; now?: Date }) {
  const dateLabel = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }).format(now);

  return (
    <section aria-label="Welcome" className="gs-dash-hero relative overflow-hidden rounded-xl border">
      <div aria-hidden="true" className="gs-dash-hero-grain absolute inset-0" />
      <BrandMark
        variant="outline"
        decorative
        className="gs-dash-hero-mark absolute bottom-3 right-6 h-10 w-auto sm:bottom-auto sm:right-(--gs-dash-hero-mark-inset) sm:top-1/2 sm:h-20 sm:-translate-y-1/2"
      />
      <div className="relative min-w-0 px-6 pt-7 pb-20 sm:w-2/5 sm:px-8 sm:py-6">
        <p className="gs-dash-hero-muted text-xs font-semibold uppercase tracking-(--tracking-eyebrow)">
          {greetingFor(now.getHours())}
        </p>
        <h2 className="mt-1.5 text-balance break-words text-2xl font-extrabold tracking-tight lg:text-3xl">{companyName}</h2>
        <p className="gs-dash-hero-muted mt-1 text-sm">{dateLabel}</p>
      </div>
    </section>
  );
}
