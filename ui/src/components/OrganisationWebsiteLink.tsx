import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Organisation } from "@greatstone/shared";
import { organisationsApi } from "@/api/organisations";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { useCommerceCustomers, useCommerceSite } from "@/hooks/useCommerceSite";
import { text } from "@/lib/commerce";
import { queryKeys } from "@/lib/queryKeys";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

/**
 * The organisation's link to its website organisation (GRE-2682): a person picks the website customer from the
 * site's list, or unlinks it. Nothing is matched by name, domain or email. Shown only where the website has a
 * Commerce site (Greatstone, with the website view on).
 */
export function OrganisationWebsiteLink({
  companyId,
  organisation,
}: {
  companyId: string;
  organisation: Pick<Organisation, "id" | "websiteOrganisationId">;
}) {
  const queryClient = useQueryClient();
  const { commerce } = useCommerceSite(companyId);
  const siteId = commerce?.site.id ?? null;
  const customers = useCommerceCustomers(companyId, siteId);
  const [picking, setPicking] = useState(false);
  const [choice, setChoice] = useState("");
  const linked = organisation.websiteOrganisationId;

  const save = useMutation({
    mutationFn: (websiteOrganisationId: string | null) =>
      organisationsApi.setWebsiteLink(companyId, organisation.id, websiteOrganisationId === null
        ? { websiteOrganisationId: null }
        : { websiteOrganisationId, siteId: siteId! }),
    onSuccess: () => {
      setPicking(false);
      setChoice("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.organisations.detail(companyId, organisation.id) });
    },
  });

  if (!commerce) return null;
  const linkedName = linked
    ? text(customers.data?.find((customer) => text(customer.id) === linked)?.name)
    : null;

  return (
    <section aria-label="Website organisation" className="space-y-2" data-testid="organisation-website-link">
      <h2 className="text-sm font-semibold">Website organisation</h2>
      {linked ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="min-w-0 break-words">
            Linked to <span className="font-medium">{linkedName ?? linked}</span>
            {linkedName ? <span className="text-muted-foreground"> ({linked})</span> : null}
          </span>
          <Button variant="outline" size="sm" disabled={save.isPending} onClick={() => save.mutate(null)}>
            Unlink
          </Button>
        </div>
      ) : picking ? (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-center"
          onSubmit={(event) => {
            event.preventDefault();
            if (choice) save.mutate(choice);
          }}
        >
          <NativeSelect
            aria-label="Website organisation"
            className="sm:max-w-sm"
            value={choice}
            disabled={customers.isLoading || save.isPending}
            onChange={(event) => setChoice(event.target.value)}
          >
            <option value="">{customers.isLoading ? "Loading website organisations…" : "Pick a website organisation"}</option>
            {(customers.data ?? []).map((customer) => {
              const id = text(customer.id);
              if (!id) return null;
              return (
                <option key={id} value={id}>
                  {text(customer.name) ?? id}
                  {text(customer.domain) ? ` (${text(customer.domain)})` : ""}
                </option>
              );
            })}
          </NativeSelect>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!choice || save.isPending}>Link</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setPicking(false); save.reset(); }}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Not linked to a website organisation.</span>
          <Button variant="outline" size="sm" onClick={() => setPicking(true)}>Link website organisation</Button>
        </div>
      )}
      {customers.error ? (
        <p className="text-sm text-destructive" role="alert">Could not load the website organisations. {errorText(customers.error)}</p>
      ) : null}
      {save.error ? <p className="text-sm text-destructive" role="alert">{errorText(save.error)}</p> : null}
    </section>
  );
}
