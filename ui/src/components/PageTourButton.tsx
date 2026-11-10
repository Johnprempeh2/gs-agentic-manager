import { useLocation } from "@/lib/router";
import { toCompanyRelativePath } from "@/lib/company-routes";
import { coreTourForPath } from "@/lib/feature-tours";
import { WELCOME_TOUR } from "@/lib/welcome-tour";
import { WEBSITE_EDITOR_TOUR } from "@/lib/website-tours";
import { FeatureTour } from "./FeatureTour";

/**
 * Tours with no button of their own, each on one page so they never meet another page's first tour:
 * the welcome on Home, and the page editor, which fills the screen and covers the page bar.
 * They open once for a person new to the page, and Tutorials replays them.
 */
const HIDDEN_TOURS = [WELCOME_TOUR, WEBSITE_EDITOR_TOUR];

/** "Show me around" in the page bar, for the everyday page on screen (Home, Decisions, Tasks...). */
export function PageTourButton() {
  const { pathname } = useLocation();
  const path = toCompanyRelativePath(pathname);
  const tour = coreTourForPath(path);
  return (
    <>
      {HIDDEN_TOURS.filter((hidden) => hidden.route!.match.test(path)).map((hidden) => (
        <FeatureTour key={hidden.id} tour={hidden} className="hidden" />
      ))}
      {tour ? <FeatureTour key={tour.id} tour={tour} /> : null}
    </>
  );
}
