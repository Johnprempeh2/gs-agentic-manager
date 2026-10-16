import { useQuery } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import { ORGANISATION_STATUS_LABELS, type OrganisationListItem } from "@greatstone/shared";
import { organisationsApi } from "@/api/organisations";
import { EmptyState } from "@/components/EmptyState";
import { OrganisationPipelineStages } from "@/components/OrganisationPipelineStages";
import { Badge } from "@/components/ui/badge";
import { useIsPhone } from "@/hooks/useIsPhone";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { ORGANISATION_STATUS_BADGE } from "@/pages/Organisations";

function keyContactText(organisation: OrganisationListItem) {
  if (organisation.keyContacts.length === 0) return "No key contact";
  return organisation.keyContacts.map((contact) => contact.name).join(", ");
}

/**
 * The pipeline's "By organisation" view (GRE-1540): every organisation with a
 * live card in this pipeline and the stage it is in. Each name opens the
 * organisation page with its journey.
 */
export function PipelineOrganisationsView({ companyId, pipelineId }: { companyId: string; pipelineId: string }) {
  const isPhone = useIsPhone();
  const filters = { pipelineId };
  const query = useQuery({
    queryKey: queryKeys.organisations.list(companyId, filters),
    queryFn: () => organisationsApi.list(companyId, filters),
  });
  const rows = query.data ?? [];

  if (query.isLoading) return <p className="text-sm text-muted-foreground">Loading organisations…</p>;
  if (query.error) {
    return (
      <p className="text-sm text-destructive">
        Could not load organisations. {query.error instanceof Error ? query.error.message : "Try again."}
      </p>
    );
  }
  if (rows.length === 0) {
    return <EmptyState icon={Building2} message="No organisations in this pipeline yet." />;
  }

  if (isPhone) {
    return (
      <ul className="space-y-3" aria-label="Organisations in this pipeline">
        {rows.map((organisation) => (
          <li key={organisation.id}>
            <Link
              to={`/organisations/${organisation.id}`}
              className="block w-full rounded-lg border border-border px-3 py-2 text-left hover:bg-accent/40"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate font-medium">{organisation.name}</span>
                <Badge variant={ORGANISATION_STATUS_BADGE[organisation.status]}>
                  {ORGANISATION_STATUS_LABELS[organisation.status]}
                </Badge>
              </div>
              <div className="mt-1 text-xs">
                <OrganisationPipelineStages stages={organisation.pipelines} pipelineId={pipelineId} />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm" aria-label="Organisations in this pipeline">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Organisation</th>
            <th className="px-3 py-2 font-medium">Stage</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Country</th>
            <th className="px-3 py-2 font-medium">Key contacts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((organisation) => (
            <tr key={organisation.id} className="border-t border-border hover:bg-accent/40">
              <td className="px-3 py-2">
                <Link to={`/organisations/${organisation.id}`} className="font-medium hover:underline">
                  {organisation.name}
                </Link>
              </td>
              <td className="px-3 py-2">
                <OrganisationPipelineStages stages={organisation.pipelines} pipelineId={pipelineId} />
              </td>
              <td className="px-3 py-2">
                <Badge variant={ORGANISATION_STATUS_BADGE[organisation.status]}>
                  {ORGANISATION_STATUS_LABELS[organisation.status]}
                </Badge>
              </td>
              <td className="px-3 py-2">{organisation.country ?? "Not set"}</td>
              <td className="px-3 py-2 text-muted-foreground">{keyContactText(organisation)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
