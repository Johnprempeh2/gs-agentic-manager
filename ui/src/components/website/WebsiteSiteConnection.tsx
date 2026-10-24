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
// ever learns whether one is stored. Words: GRE-2107 copy sections 3, 13, 14.

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
  const [editorFrameOrigin, setEditorFrameOrigin] = useState(site?.editorFrameOrigin ?? "");
  const save = useMutation({
    mutationFn: () => {
      const fields = {
        name: name.trim(),
        domain: domain.trim(),
        repoUrl: repoUrl.trim() || null,
        netlifySiteId: netlifySiteId.trim(),
        ...(netlifyToken.trim() ? { netlifyToken: netlifyToken.trim() } : {}),
        // Sent only when it changes: a change ends open editor sessions (frame contract rule C2.3).
        ...((site?.editorFrameOrigin ?? "") !== editorFrameOrigin.trim() ? { editorFrameOrigin: editorFrameOrigin.trim() || null } : {}),
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
        <Field id={`${idPrefix}-name`} label="Site name" help="What your team calls it. Only shown in GSAM.">
          <Input
            id={`${idPrefix}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-describedby={`${idPrefix}-name-help`}
            maxLength={120}
            required
          />
        </Field>
        <Field id={`${idPrefix}-domain`} label="Live address" help="The address visitors use, for example www.example.com.">
          <Input
            id={`${idPrefix}-domain`}
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            aria-describedby={`${idPrefix}-domain-help`}
            inputMode="url"
            required
          />
        </Field>
        <Field id={`${idPrefix}-repo`} label="Code repository" help="Where the site's code lives, for example owner/site-name.">
          <Input
            id={`${idPrefix}-repo`}
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            aria-describedby={`${idPrefix}-repo-help`}
            autoComplete="off"
            placeholder="owner/site-name"
          />
        </Field>
        <Field id={`${idPrefix}-netlify`} label="Netlify site ID" help="In Netlify: Site configuration, General, Site ID.">
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
          label="Netlify access token"
          help={
            site?.hasNetlifyToken
              ? "Token saved. Leave this empty to keep it, or paste a new token to replace it."
              : "Stored in this company's secrets. Only the Publish job reads it. You cannot see it again after saving."
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
        <Field
          id={`${idPrefix}-editor`}
          label="Editor address"
          help="Optional now, needed to edit pages. The site's own editor host, for example https://editor.example.com. Never the public address. Changing it closes open editors."
        >
          <Input
            id={`${idPrefix}-editor`}
            value={editorFrameOrigin}
            onChange={(event) => setEditorFrameOrigin(event.target.value)}
            aria-describedby={`${idPrefix}-editor-help`}
            inputMode="url"
            placeholder="https://editor.example.com"
            autoComplete="off"
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

/** Overview panel: the connected site, or a "Connect a site" form for people with Publish rights. */
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
          <Detail label="Site name">{site.name}</Detail>
          <Detail label="Live address"><span className="font-mono">{site.domain}</span></Detail>
          <Detail label="Code repository">{site.repoUrl ? <span className="font-mono">{site.repoUrl}</span> : "Not set"}</Detail>
          <Detail label="Netlify site ID"><span className="font-mono">{site.netlifySiteId}</span></Detail>
          <Detail label="Netlify access token">{site.hasNetlifyToken ? "Token saved." : "Not saved yet. Publish needs it."}</Detail>
          <Detail label="Editor address">{site.editorFrameOrigin ? <span className="font-mono">{site.editorFrameOrigin}</span> : "Not set. Editing pages needs it."}</Detail>
        </dl>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">Connect your website</p>
            <p className="text-sm text-muted-foreground">Connect a site to edit its pages here and Publish them.</p>
          </div>
          {canManage ? (
            <Button type="button" size="sm" onClick={() => setEditing(true)}>Connect a site</Button>
          ) : (
            <p className="text-xs text-muted-foreground">Only people with Publish rights can change site settings, the theme and the token.</p>
          )}
        </div>
      )}
    </section>
  );
}
