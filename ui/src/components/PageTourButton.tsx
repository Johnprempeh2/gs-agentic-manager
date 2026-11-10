import { useLocation } from "@/lib/router";
import { toCompanyRelativePath } from "@/lib/company-routes";
import { coreTourForPath } from "@/lib/feature-tours";
import { WELCOME_TOUR } from "@/lib/welcome-tour";
import { FeatureTour } from "./FeatureTour";

/** "Show me around" in the page bar, for the everyday page on screen (Home, Decisions, Tasks...). */
export function PageTourButton() {
  const { pathname } = useLocation();
  const path = toCompanyRelativePath(pathname);
  const tour = coreTourForPath(path);
  return (
    <>
      {/* Opens once for a person new to GSAM, on Home only so it never meets another page's first tour. */}
      {WELCOME_TOUR.route!.match.test(path) ? <FeatureTour tour={WELCOME_TOUR} className="hidden" /> : null}
      {tour ? <FeatureTour key={tour.id} tour={tour} /> : null}
    </>
  );
}
