import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WebsiteProperty } from "@greatstone/shared";
import { websiteModuleApi } from "../../api/website";
import { Link } from "@/lib/router";
import { formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ErrorState, errorStateMessage } from "../ErrorState";
import { useWebsiteSite } from "./WebsiteSiteConnection";

/** The front door list reads GSAM leads. The site remains the source for raw form submissions. */
export function WebsiteEnquiriesForProperty({ companyId, property }: { companyId: string; property: WebsiteProperty }) {
  const { site, isLoading, error } = useWebsiteSite(companyId, property.id);
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading site…</p>;
  if (error) return <ErrorState error={error} />;
  if (!site) return <p className="text-sm text-muted-foreground">Connect this website before checking enquiries.</p>;
  return <WebsiteEnquiries companyId={companyId} siteId={site.id} />;
}

/** Reused on the Front door module page as well as the site's interim tab. */
export function WebsiteEnquiries({ companyId, siteId }: { companyId: string; siteId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["website", companyId, "enquiries", siteId];
  const enquiries = useQuery({
    queryKey,
    queryFn: () => websiteModuleApi.enquiries(companyId, siteId),
  });
  const check = useMutation({
    mutationFn: () => websiteModuleApi.checkEnquiries(companyId, siteId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey }),
  });

  return (
    <section className="space-y-4" aria-labelledby="website-enquiries-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="website-enquiries-heading" className="text-lg font-semibold">Front door and enquiries</h2>
          <p className="text-sm text-muted-foreground">Website submissions filed as leads in GSAM.</p>
        </div>
        <Button type="button" onClick={() => check.mutate()} disabled={check.isPending}>
          {check.isPending ? "Checking…" : "Check now"}
        </Button>
      </div>
      {check.isError ? <p role="alert" className="text-sm text-destructive">{errorStateMessage(check.error)}</p> : null}
      {check.isSuccess ? <p role="status" className="text-sm text-muted-foreground">{check.data.created} new, {check.data.skipped} already filed.</p> : null}
      {enquiries.isLoading ? <p className="text-sm text-muted-foreground">Loading enquiries…</p> : null}
      {enquiries.isError ? <ErrorState error={enquiries.error} onRetry={() => void enquiries.refetch()} /> : null}
      {enquiries.data?.length === 0 ? <p className="text-sm text-muted-foreground">No enquiries have been imported yet.</p> : null}
      {enquiries.data?.length ? (
        <ul className="divide-y rounded-lg border" aria-label="Website enquiries">
          {enquiries.data.map((lead) => (
            <li key={lead.id} className="flex flex-wrap items-center justify-between gap-2 p-4">
              <div className="min-w-0">
                <Link to={`/pipelines/${lead.pipelineId}/cases/${lead.id}`} className="font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {lead.title}
                </Link>
                <p className="break-all text-sm text-muted-foreground">{lead.contactEmail ?? "No email"}{lead.page ? ` · ${lead.page}` : ""}</p>
              </div>
              <time className="text-xs text-muted-foreground" dateTime={lead.submittedAt ?? lead.createdAt}>
                {formatDateTime(lead.submittedAt ?? lead.createdAt)}
              </time>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
