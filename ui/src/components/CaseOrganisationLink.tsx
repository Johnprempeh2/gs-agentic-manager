import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import { organisationsApi } from "@/api/organisations";
import { pipelinesApi } from "@/api/pipelines";
import { OrganisationPicker } from "@/components/OrganisationPicker";
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

/**
 * A card made before every card needed an organisation (GRE-1538): the server
 * refuses to save it until it has one, so pick or create it here.
 */
export function CaseOrganisationMissing({ companyId, caseId }: { companyId: string; caseId: string }) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (organisationId: string) => pipelinesApi.setCaseOrganisation(caseId, organisationId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseDetail(caseId) });
    },
  });
  return (
    <div className="mt-2 max-w-md text-sm">
      <p className="mb-1 text-muted-foreground">No organisation yet. Every card needs one before it can be saved.</p>
      <OrganisationPicker
        companyId={companyId}
        value={null}
        onChange={(organisationId) => save.mutate(organisationId)}
        error={save.error ? (save.error as Error).message : null}
      />
    </div>
  );
}
