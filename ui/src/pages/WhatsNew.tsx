import { useEffect } from "react";
import { ArrowRight } from "lucide-react";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Link } from "@/lib/router";
import { formatDate } from "@/lib/utils";
import { WHATS_NEW, markWhatsNewSeen } from "@/lib/whats-new";

/** Release notes in plain words: what changed, grouped by area, each with the page to try it on. */
export function WhatsNew() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "What's new" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    markWhatsNewSeen();
  }, []);

  return (
    <div className="w-full max-w-3xl space-y-6">
      {/* The page bar already says What's new; the line says what it is for. */}
      <p className="text-sm text-muted-foreground">What has changed in GSAM lately, and where to try it.</p>

      {WHATS_NEW.map((release) => (
        <section key={release.id} className="space-y-4" aria-labelledby={`release-${release.id}`} data-testid={`whats-new-${release.id}`}>
          <div className="space-y-0.5">
            <h2 id={`release-${release.id}`} className="text-base font-semibold text-foreground">
              {release.title}
            </h2>
            <p className="text-sm text-muted-foreground">
              {formatDate(release.date)}. {release.summary}
            </p>
          </div>

          {release.areas.map((area) => (
            <div key={area.area} className="space-y-2 rounded-lg border border-border bg-card p-4">
              <h3 className="text-sm font-semibold text-foreground">{area.area}</h3>
              <ul className="space-y-2">
                {area.entries.map((entry) => (
                  <li key={entry.text} className="text-sm leading-6 text-foreground">
                    <span>{entry.text}</span>
                    {entry.to ? (
                      <>
                        {" "}
                        <Link
                          to={entry.to}
                          className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-primary underline-offset-4 hover:underline"
                        >
                          {entry.linkLabel ?? "Try it"}
                          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                        </Link>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
