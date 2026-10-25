import { useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Globe, Lock } from "lucide-react";
import { websiteApi, isWebsiteNotEntitled } from "../api/website";
import { instanceSettingsApi } from "../api/instanceSettings";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { FullScreen, WebsiteFullScreenEditor } from "../components/website/WebsiteEditorWorkspace";
import { Button } from "@/components/ui/button";
import { useLocation, useNavigate, useSearchParams } from "@/lib/router";

/**
 * `/website/edit` (GRE-2296): the website editor full screen, with no GSAM
 * sidebar, header or Website tabs. `?property=` picks the website (the first
 * one when left out), `?page=` the page and `?motion=` a GS Studio hand-off.
 */
export function WebsiteEditorPage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: unknown } | null)?.from;

  useEffect(() => {
    setBreadcrumbs([{ label: "Website", href: "/website" }, { label: "Edit pages" }]);
  }, [setBreadcrumbs]);

  // Back goes where the person came from; a link opened on its own goes to the Website's Pages.
  const leave = useCallback(() => {
    if (typeof from === "string" && from.startsWith("/")) navigate(from);
    else navigate("/website?tab=editor");
  }, [from, navigate]);

  const settingsQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const switchedOn = settingsQuery.data?.enableWebsiteView === true;
  const overviewQuery = useQuery({
    queryKey: queryKeys.website.overview(selectedCompanyId ?? ""),
    queryFn: () => websiteApi.overview(selectedCompanyId!),
    enabled: !!selectedCompanyId && switchedOn,
  });

  const properties = overviewQuery.data?.properties ?? [];
  const property = properties.find((entry) => entry.id === searchParams.get("property")) ?? properties[0] ?? null;
  if (selectedCompanyId && property) {
    return <WebsiteFullScreenEditor companyId={selectedCompanyId} property={property} onLeave={leave} />;
  }

  let body;
  if (!selectedCompanyId) body = <EmptyState icon={Globe} message="Choose an organisation to edit its website." />;
  else if (settingsQuery.isLoading || overviewQuery.isLoading) body = <p>Loading the site</p>;
  else if (!switchedOn || isWebsiteNotEntitled(overviewQuery.error)) {
    body = (
      <EmptyState
        icon={Lock}
        title="The Website view is switched off"
        message="This instance does not include the Website view. An instance admin can switch it on under Settings → Experimental."
      />
    );
  } else if (overviewQuery.error) body = <ErrorState error={overviewQuery.error} onRetry={() => void overviewQuery.refetch()} />;
  else body = <EmptyState icon={Globe} title="No website is set up yet" message="Set up the website on the Website page first." />;

  return (
    <FullScreen>
      <header className="flex h-12 shrink-0 items-center border-b border-border px-2">
        <Button type="button" variant="ghost" size="sm" onClick={leave}>Back to Website</Button>
      </header>
      <div className="flex flex-1 items-start justify-center overflow-auto p-6 text-sm text-muted-foreground">{body}</div>
    </FullScreen>
  );
}
