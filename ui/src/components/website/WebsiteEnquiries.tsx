import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WebsiteEnquiryLead } from "@greatstone/shared";
import { websiteModuleApi } from "../../api/website";
import { Link } from "@/lib/router";
import { formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ErrorState, errorStateMessage } from "../ErrorState";

/** The live enquiry list in the Front door feature's Admin tab. */
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

  return <WebsiteEnquiriesView
    leads={enquiries.data}
    loading={enquiries.isLoading}
    loadError={enquiries.error}
    onRetry={() => void enquiries.refetch()}
    onCheck={() => check.mutate()}
    checking={check.isPending}
    checkError={check.error}
    checkResult={check.data}
  />;
}

/** Presentational view also used for laptop and phone review in Storybook. */
export function WebsiteEnquiriesView({ leads, loading = false, loadError, onRetry, onCheck, checking = false, checkError, checkResult }: {
  leads?: WebsiteEnquiryLead[];
  loading?: boolean;
  loadError?: unknown;
  onRetry?: () => void;
  onCheck: () => void;
  checking?: boolean;
  checkError?: unknown;
  checkResult?: { created: number; skipped: number };
}) {
  return (
    <section className="space-y-4" aria-labelledby="website-enquiries-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="website-enquiries-heading" className="text-lg font-semibold">Front door and enquiries</h2>
          <p className="text-sm text-muted-foreground">Website submissions filed as leads in GSAM.</p>
        </div>
        <Button type="button" onClick={onCheck} disabled={checking}>
          {checking ? "Checking…" : "Check now"}
        </Button>
      </div>
      {checkError ? <p role="alert" className="text-sm text-destructive">{errorStateMessage(checkError)}</p> : null}
      {checkResult ? <p role="status" className="text-sm text-muted-foreground">{checkResult.created} new, {checkResult.skipped} already filed.</p> : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading enquiries…</p> : null}
      {loadError ? <ErrorState error={loadError} onRetry={onRetry} /> : null}
      {leads?.length === 0 ? <p className="text-sm text-muted-foreground">No enquiries have been imported yet.</p> : null}
      {leads?.length ? (
        <ul className="divide-y rounded-lg border" aria-label="Website enquiries">
          {leads.map((lead) => (
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
