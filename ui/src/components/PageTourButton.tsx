import { useLocation } from "@/lib/router";
import { toCompanyRelativePath } from "@/lib/company-routes";
import { coreTourForPath } from "@/lib/feature-tours";
import { FeatureTour } from "./FeatureTour";

/** "Show me around" in the page bar, for the everyday page on screen (Home, Decisions, Tasks...). */
export function PageTourButton() {
  const { pathname } = useLocation();
  const tour = coreTourForPath(toCompanyRelativePath(pathname));
  if (!tour) return null;
  return <FeatureTour key={tour.id} tour={tour} />;
}
