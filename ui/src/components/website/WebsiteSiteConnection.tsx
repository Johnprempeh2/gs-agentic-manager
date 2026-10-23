import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WebsiteProperty, WebsiteSite } from "@greatstone/shared";
import { websiteModuleApi } from "../../api/website";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorStateMessage } from "../ErrorState";
import { useCanManageWebsite } from "./WebsiteSetup";

// Connect a site (GRE-2105): the website module's site row for this website
// property. The Netlify token goes into the company's secrets; the page only
// ever learns whether one is stored.

/** The bare domain of a website property's address: `https://www.example.com/` → `www.example.com`. */
export function domainFromSiteUrl(siteUrl: string): string {
  const scDomain = /^sc-domain:(.+)$/i.exec(siteUrl)?.[1];
  if (scDomain) return scDomain.toLowerCase();
  try {
    return new URL(siteUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** The connected site of a website property, if any. */
export function useWebsiteSite(companyId: string, propertyId: string) {
  const query = useQuery({
    queryKey: queryKeys.website.sites(companyId),
    queryFn: () => websiteModuleApi.sites(companyId),
  });
  const site = query.data?.find((entry) => entry.propertyId === propertyId && !entry.archivedAt) ?? null;
  return { ...query, site };
}

function Field({ id, label, help, children }: { id: string; label: string; help?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 text-sm">
      <label htmlFor={id} className="font-medium">{label}</label>
      {children}
      {help ? <p id={`${id}-help`} className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}

function SiteForm({ companyId, property, site, onDone }: {
  companyId: string;
  property: WebsiteProperty;
  site: WebsiteSite | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(site?.name ?? property.name);
  const [domain, setDomain] = useState(site?.domain ?? domainFromSiteUrl(property.siteUrl));
  const [repoUrl, setRepoUrl] = useState(site?.repoUrl ?? "");
  const [netlifySiteId, setNetlifySiteId] = useState(site?.netlifySiteId ?? "");
  const [netlifyToken, setNetlifyToken] = useState("");
  const save = useMutation({
    mutationFn: () => {
      const fields = {
        name: name.trim(),
        domain: domain.trim(),
        repoUrl: repoUrl.trim() || null,
        netlifySiteId: netlifySiteId.trim(),
        ...(netlifyToken.trim() ? { netlifyToken: netlifyToken.trim() } : {}),
      };
      return site
        ? websiteModuleApi.updateSite(companyId, site.id, fields)
        : websiteModuleApi.createSite(companyId, { ...fields, propertyId: property.id });
    },
    onSuccess: () => {
      setNetlifyToken("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.website.sites(companyId) });
      onDone();
    },
  });
  const idPrefix = `website-site-${property.id}`;
  return (
    <form
      className="space-y-4"
      data-testid="website-site-form"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <fieldset disabled={save.isPending} className="grid gap-4 sm:grid-cols-2">
        <Field id={`${idPrefix}-name`} label="Site name">
          <Input id={`${idPrefix}-name`} value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required />
        </Field>
        <Field id={`${idPrefix}-domain`} label="Domain" help="The bare domain the public site answers on, for example www.example.com.">
          <Input
            id={`${idPrefix}-domain`}
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            aria-describedby={`${idPrefix}-domain-help`}
            inputMode="url"
            required
          />
        </Field>
        <Field id={`${idPrefix}-repo`} label="Repository" help="Optional. The site's code repository, for example https://github.com/owner/site.">
          <Input
            id={`${idPrefix}-repo`}
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            aria-describedby={`${idPrefix}-repo-help`}
            inputMode="url"
            placeholder="https://github.com/owner/site"
          />
        </Field>
        <Field id={`${idPrefix}-netlify`} label="Netlify site id" help="In Netlify open Site configuration and copy the Site ID.">
          <Input
            id={`${idPrefix}-netlify`}
            value={netlifySiteId}
            onChange={(event) => setNetlifySiteId(event.target.value)}
            aria-describedby={`${idPrefix}-netlify-help`}
            autoComplete="off"
            required
          />
        </Field>
        <Field
          id={`${idPrefix}-token`}
          label="Netlify token"
          help={
            site?.hasNetlifyToken
              ? "A token is stored in this company's secrets. Leave this empty to keep it, or paste a new one to replace it."
              : "Optional now, needed to publish. It is stored in this company's secrets and never shown again."
          }
        >
          <Input
            id={`${idPrefix}-token`}
            type="password"
            value={netlifyToken}
            onChange={(event) => setNetlifyToken(event.target.value)}
            aria-describedby={`${idPrefix}-token-help`}
            autoComplete="new-password"
          />
        </Field>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="ghost" onClick={onDone} disabled={save.isPending}>Cancel</Button>
        {save.isError ? <p role="alert" className="text-xs text-status-danger">{errorStateMessage(save.error)}</p> : null}
        <Button type="submit" className="ml-auto" disabled={save.isPending || !name.trim() || !domain.trim() || !netlifySiteId.trim()}>
          {save.isPending ? "Saving" : site ? "Save" : "Connect site"}
        </Button>
      </div>
    </form>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:gap-2">
      <dt className="shrink-0 text-muted-foreground sm:w-32">{label}</dt>
      <dd className="min-w-0 break-all text-foreground">{children}</dd>
    </div>
  );
}

/** Overview panel: the connected site, or a "Connect site" form for people who can publish. */
export function WebsiteSiteConnection({ companyId, property }: { companyId: string; property: WebsiteProperty }) {
  const { site, isLoading, error } = useWebsiteSite(companyId, property.id);
  const { canManage } = useCanManageWebsite(companyId);
  const [editing, setEditing] = useState(false);

  return (
    <section className="gs-glass-card min-w-0 space-y-3 rounded-xl border p-4" aria-labelledby={`website-site-${property.id}-title`} data-testid="website-site-connection">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`website-site-${property.id}-title`} className="text-sm font-semibold">Site connection</h2>
        {site && canManage && !editing ? (
          <Button type="button" variant="ghost" size="xs" onClick={() => setEditing(true)}>Change</Button>
        ) : null}
      </div>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading the site connection</p>
      ) : error ? (
        <p role="alert" className="text-xs text-status-danger">{errorStateMessage(error)}</p>
      ) : editing ? (
        <SiteForm companyId={companyId} property={property} site={site} onDone={() => setEditing(false)} />
      ) : site ? (
        <dl className="space-y-1.5 text-xs">
          <Detail label="Site">{site.name}</Detail>
          <Detail label="Domain"><span className="font-mono">{site.domain}</span></Detail>
          <Detail label="Repository">{site.repoUrl ? <span className="font-mono">{site.repoUrl}</span> : "Not set"}</Detail>
          <Detail label="Netlify site id"><span className="font-mono">{site.netlifySiteId}</span></Detail>
          <Detail label="Netlify token">{site.hasNetlifyToken ? "Stored in this company's secrets" : "Not stored yet: needed to publish"}</Detail>
        </dl>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Connect the site so its pages, sitemap and content can be managed here, then published to Netlify.
          </p>
          {canManage ? (
            <Button type="button" size="sm" onClick={() => setEditing(true)}>Connect site</Button>
          ) : (
            <p className="text-xs text-muted-foreground">A company owner or admin can connect it.</p>
          )}
        </div>
      )}
    </section>
  );
}
