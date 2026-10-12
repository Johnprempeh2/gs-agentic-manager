// Pick an organisation record for a pipeline case, or create one by name
// (GRE-1478). Archived organisations are not offered: the server refuses them.
import { Plus } from "lucide-react";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { organisationsApi } from "@/api/organisations";
import { SearchableSelect, type SearchableSelectOption } from "@/components/SearchableSelect";
import { queryKeys } from "@/lib/queryKeys";

export function OrganisationPicker({
  companyId,
  value,
  onChange,
  error,
}: {
  companyId: string;
  value: string | null;
  onChange: (organisationId: string) => void;
  error?: string | null;
}) {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: queryKeys.organisations.list(companyId, {}),
    queryFn: () => organisationsApi.list(companyId),
  });
  const create = useMutation({
    mutationFn: (name: string) => organisationsApi.create(companyId, { name, status: "prospect" }),
    onSuccess: async (organisation) => {
      onChange(organisation.id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.organisations.all(companyId) });
    },
  });

  const options = useMemo<SearchableSelectOption[]>(
    () =>
      (list.data ?? [])
        .filter((organisation) => !organisation.archivedAt)
        .map((organisation) => ({
          key: organisation.id,
          value: organisation.id,
          label: organisation.name,
          searchText: [organisation.country, organisation.industry].filter(Boolean).join(" "),
        })),
    [list.data],
  );

  const message = error ?? (list.isError ? "Could not load organisations. Try again." : null)
    ?? (create.isError ? "Could not create the organisation. Try again." : null);

  return (
    <div className="space-y-1.5">
      <span className="block text-sm font-medium text-foreground">Organisation</span>
      <SearchableSelect
        value={value ?? ""}
        groups={[{ id: "organisations", options }]}
        onValueChange={(organisationId) => onChange(organisationId)}
        placeholder={create.isPending ? "Creating..." : "Pick an organisation"}
        searchPlaceholder="Search organisations..."
        emptyMessage="No organisation found. Type a name to create one."
        loading={list.isLoading}
        disabled={create.isPending}
        mobileTitle="Organisation"
        createItem={{
          render: (query) => (
            <span className="flex items-center gap-1.5 text-sm">
              <Plus className="size-3.5 shrink-0" />
              {query.trim() ? `Create organisation "${query.trim()}"` : "Type a name to create an organisation"}
            </span>
          ),
          onSelect: (query) => {
            if (query.trim()) create.mutate(query.trim());
          },
        }}
      />
      {message ? <p className="text-xs text-destructive">{message}</p> : null}
    </div>
  );
}
