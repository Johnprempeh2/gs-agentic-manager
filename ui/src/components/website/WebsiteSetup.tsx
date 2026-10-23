import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WebsiteOverview, WebsiteProperty } from "@greatstone/shared";
import { accessApi } from "../../api/access";
import { projectsApi } from "../../api/projects";
import { websiteApi } from "../../api/website";
import { canBoardRelease } from "../../hooks/useReleases";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { errorStateMessage } from "../ErrorState";

/**
 * Owners and admins set up and edit the website (the server stays authoritative).
 * Same rule as releases: the local board, an instance admin, or an active owner or admin.
 */
export function useCanManageWebsite(companyId: string) {
  const access = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  return { canManage: canBoardRelease(companyId, access.data), isLoading: access.isLoading };
}

const GA4_HELP =
  "Optional. In Google Analytics open Admin, then Property details, and copy the property id (digits only, for example 123456789). You can add it later.";

function Field({ id, label, help, children }: { id: string; label: string; help?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 text-sm">
      <label htmlFor={id} className="font-medium">{label}</label>
      {children}
      {help ? <p id={`${id}-help`} className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}

/** First-time setup on the Website page: site name, address, optional GA4 id and the project that builds it. */
export function WebsiteSetupForm({ companyId, onCreated }: { companyId: string; onCreated: (property: WebsiteProperty) => void }) {
  const queryClient = useQueryClient();
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });
  const [name, setName] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [ga4PropertyId, setGa4PropertyId] = useState("");
  const [projectId, setProjectId] = useState("");
  const create = useMutation({
    mutationFn: () =>
      websiteApi.create(companyId, {
        name: name.trim(),
        siteUrl: siteUrl.trim(),
        ...(ga4PropertyId.trim() ? { ga4PropertyId: ga4PropertyId.trim() } : {}),
        ...(projectId ? { projectId } : {}),
      }),
    onSuccess: (property) => {
      queryClient.setQueryData<WebsiteOverview>(queryKeys.website.overview(companyId), (current) =>
        current ? { ...current, properties: [...current.properties, property] } : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.website.overview(companyId) });
      onCreated(property);
    },
  });
  const projects = (projectsQuery.data ?? []).filter((project) => !project.archivedAt);

  return (
    <form
      className="gs-glass-card max-w-2xl space-y-4 rounded-xl border p-4"
      data-testid="website-setup"
      aria-labelledby="website-setup-title"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <div className="space-y-0.5">
        <h2 id="website-setup-title" className="text-lg font-semibold">Set up your website</h2>
        <p className="text-xs text-muted-foreground">
          Progress, the sitemap and previews work straight away. Google Analytics is optional and can be added later.
        </p>
      </div>
      <fieldset disabled={create.isPending} className="grid gap-4 sm:grid-cols-2">
        <Field id="website-setup-name" label="Site name">
          <Input
            id="website-setup-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Greatstone website"
            maxLength={120}
            required
          />
        </Field>
        <Field
          id="website-setup-url"
          label="Site address"
          help="The full address, for example https://www.example.com/, or a Search Console domain, for example sc-domain:example.com."
        >
          <Input
            id="website-setup-url"
            value={siteUrl}
            onChange={(event) => setSiteUrl(event.target.value)}
            placeholder="https://www.example.com/"
            aria-describedby="website-setup-url-help"
            inputMode="url"
            autoComplete="url"
            maxLength={500}
            required
          />
        </Field>
        <Field id="website-setup-ga4" label="Google Analytics property id" help={GA4_HELP}>
          <Input
            id="website-setup-ga4"
            value={ga4PropertyId}
            onChange={(event) => setGa4PropertyId(event.target.value)}
            placeholder="123456789"
            aria-describedby="website-setup-ga4-help"
            inputMode="numeric"
          />
        </Field>
        <Field id="website-setup-project" label="Project that builds it" help="Its progress, sitemap and previews show on this page.">
          <NativeSelect
            id="website-setup-project"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            disabled={projectsQuery.isLoading}
            aria-describedby="website-setup-project-help"
          >
            <option value="">No project yet</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </NativeSelect>
        </Field>
      </fieldset>
      <div className="flex flex-wrap items-center justify-end gap-3">
        {create.isError ? (
          <p role="alert" className="mr-auto text-xs text-status-danger">{errorStateMessage(create.error)}</p>
        ) : null}
        <Button type="submit" disabled={create.isPending || !name.trim() || !siteUrl.trim()}>
          {create.isPending ? "Setting up" : "Set up website"}
        </Button>
      </div>
    </form>
  );
}

/** Link, change or clear the GA4 property id of an existing website. */
export function WebsiteGa4Link({ companyId, property, onDone }: {
  companyId: string;
  property: WebsiteProperty;
  onDone?: () => void;
}) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(property.ga4PropertyId ?? "");
  const save = useMutation({
    mutationFn: (ga4PropertyId: string | null) => websiteApi.update(companyId, property.id, { ga4PropertyId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.website.overview(companyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.website.report(companyId, property.id) });
      onDone?.();
    },
  });
  const inputId = `website-ga4-${property.id}`;
  const next = value.trim() || null;
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-start"
      data-testid="website-ga4-link"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(next);
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
        <label htmlFor={inputId} className="font-medium">Google Analytics property id</label>
        <Input
          id={inputId}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="123456789"
          aria-describedby={`${inputId}-help`}
          inputMode="numeric"
          disabled={save.isPending}
        />
        <p id={`${inputId}-help`} className="text-xs text-muted-foreground">
          In Google Analytics open Admin, then Property details, and copy the property id (digits only).
          {property.ga4PropertyId ? " Leave it empty to unlink." : ""}
        </p>
        {save.isError ? <p role="alert" className="text-xs text-status-danger">{errorStateMessage(save.error)}</p> : null}
      </div>
      <div className="flex items-center gap-2 sm:pt-6">
        {onDone ? (
          <Button type="button" variant="ghost" onClick={onDone} disabled={save.isPending}>Cancel</Button>
        ) : null}
        <Button type="submit" disabled={save.isPending || next === (property.ga4PropertyId ?? null)}>
          {save.isPending ? "Saving" : "Save"}
        </Button>
      </div>
    </form>
  );
}
