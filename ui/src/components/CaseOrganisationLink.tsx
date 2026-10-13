import { useQuery } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import { organisationsApi } from "@/api/organisations";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";

/**
 * "Company: Acme Mining" on a pipeline item, linking to the organisation's
 * company page (GRE-1480). Until the name loads, or if it cannot, the link
 * still opens the page.
 */
export function CaseOrganisationLink({ companyId, organisationId }: { companyId: string; organisationId: string }) {
  const organisation = useQuery({
    queryKey: queryKeys.organisations.detail(companyId, organisationId),
    queryFn: () => organisationsApi.get(companyId, organisationId),
  });
  return (
    <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
      <Building2 className="h-3.5 w-3.5 shrink-0" />
      Company:{" "}
      <Link to={`/organisations/${organisationId}`} className="min-w-0 truncate font-medium text-foreground hover:underline">
        {organisation.data?.name ?? "Open company page"}
      </Link>
    </p>
  );
}
