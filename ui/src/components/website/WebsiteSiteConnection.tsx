import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WebsiteProperty, WebsiteSite } from "@greatstone/shared";
import { ApiError } from "../../api/client";
import { websiteModuleApi } from "../../api/website";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { RadioCardGroup } from "@/components/ui/radio-card";
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

/** The details line of a `connect.err.*` refusal (GRE-2137), when the copy has one. */
export function connectErrorDetail(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const details = (error.body as { details?: { detail?: unknown } } | null)?.details;
  return typeof details?.detail === "string" ? details.detail : null;
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
  /** `saved` is the site after a save that ran the connect check. */
  onDone: (saved?: WebsiteSite) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(site?.name ?? property.name);
  const [domain, setDomain] = useState(site?.domain ?? domainFromSiteUrl(property.siteUrl));
  const [repoUrl, setRepoUrl] = useState(site?.repoUrl ?? "");
  const [netlifySiteId, setNetlifySiteId] = useState(site?.netlifySiteId ?? "");
  const [netlifyToken, setNetlifyToken] = useState("");
  const [tokenMode, setTokenMode] = useState<"saved" | "paste">(site?.netlifyTokenSource === "shared" ? "saved" : "paste");
  const [chosenSecretId, setChosenSecretId] = useState<string | null>(null);
  const tokenSecrets = useQuery({
    queryKey: queryKeys.website.tokenSecrets(companyId),
    queryFn: () => websiteModuleApi.tokenSecrets(companyId),
  });
  // The site names its shared secret, never its id: preselect it by name (names are unique in a company).
  const linkedSecretId = site?.netlifyTokenSource === "shared"
    ? tokenSecrets.data?.find((option) => option.name === site.netlifyTokenSecretName)?.id ?? ""
    : "";
  const secretId = chosenSecretId ?? linkedSecretId;
  const [editorFrameOrigin, setEditorFrameOrigin] = useState(site?.editorFrameOrigin ?? "");
  const [livePreviewUrl, setLivePreviewUrl] = useState(site?.livePreviewUrl ?? "");
  const [devPreviewUrl, setDevPreviewUrl] = useState(site?.devPreviewUrl ?? "");
  // The server checks Netlify and the site's /_release when a token is set or the site it points at changes.
  const tokenChosen = tokenMode === "paste" ? Boolean(netlifyToken.trim()) : Boolean(secretId) && secretId !== linkedSecretId;
  const targetChanged = Boolean(site) && (site!.domain !== domain.trim() || site!.netlifySiteId !== netlifySiteId.trim());
  const willCheck = tokenChosen || (targetChanged && Boolean(site?.hasNetlifyToken));
  const save = useMutation({
    mutationFn: () => {
      const token =
        tokenMode === "paste"
          ? netlifyToken.trim() ? { netlifyToken: netlifyToken.trim() } : {}
          : secretId ? { netlifyTokenSecretId: secretId } : {};
      const fields = {
        name: name.trim(),
        domain: domain.trim(),
        repoUrl: repoUrl.trim() || null,
        netlifySiteId: netlifySiteId.trim(),
        ...token,
        // Sent only when it changes: a change ends open editor sessions (frame contract rule C2.3).
        ...((site?.editorFrameOrigin ?? "") !== editorFrameOrigin.trim() ? { editorFrameOrigin: editorFrameOrigin.trim() || null } : {}),
        ...((site?.livePreviewUrl ?? "") !== livePreviewUrl.trim() ? { livePreviewUrl: livePreviewUrl.trim() || null } : {}),
        ...((site?.devPreviewUrl ?? "") !== devPreviewUrl.trim() ? { devPreviewUrl: devPreviewUrl.trim() || null } : {}),
      };
      return site
        ? websiteModuleApi.updateSite(companyId, site.id, fields)
        : websiteModuleApi.createSite(companyId, { ...fields, propertyId: property.id });
    },
    onSuccess: (saved) => {
      setNetlifyToken("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.website.sites(companyId) });
      onDone(willCheck ? saved : undefined);
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
        <div className="flex min-w-0 flex-col gap-2 text-sm sm:col-span-2" data-testid="website-site-token">
          <p id={`${idPrefix}-token-label`} className="font-medium">Netlify token</p>
          <RadioCardGroup
            ariaLabel="Netlify token"
            value={tokenMode}
            onValueChange={(value) => setTokenMode(value as "saved" | "paste")}
            className="sm:grid-cols-2"
            options={[
              {
                value: "saved",
                title: "Use a saved secret",
                description: "A token already in this company's secrets, such as the one your agents use. GSAM reads it to Publish and never changes it.",
              },
              {
                value: "paste",
                title: "Paste a token",
                description: "Saved as this site's own secret. You cannot see it again after saving.",
              },
            ]}
          />
          {tokenMode === "saved" ? (
            <Field id={`${idPrefix}-token-secret`} label="Saved secret" help="Names only. GSAM never shows a secret's value.">
              {tokenSecrets.isLoading ? (
                <p className="text-xs text-muted-foreground">Loading saved secrets</p>
              ) : tokenSecrets.error ? (
                <p role="alert" className="text-xs text-status-danger">{errorStateMessage(tokenSecrets.error)}</p>
              ) : tokenSecrets.data?.length ? (
                <NativeSelect
                  id={`${idPrefix}-token-secret`}
                  value={secretId}
                  onChange={(event) => setChosenSecretId(event.target.value)}
                  aria-describedby={`${idPrefix}-token-secret-help`}
                >
                  <option value="" disabled>Choose a secret</option>
                  {tokenSecrets.data.map((option) => (
                    <option key={option.id} value={option.id}>{option.name}</option>
                  ))}
                </NativeSelect>
              ) : (
                <p className="text-xs text-muted-foreground">No saved secrets yet. Add one in Secrets, or paste a token.</p>
              )}
            </Field>
          ) : (
            <Field
              id={`${idPrefix}-token`}
              label="Token"
              help={
                site?.netlifyTokenSource === "own"
                  ? "Token saved. Leave this empty to keep it, or paste a new token to replace it."
                  : site?.netlifyTokenSource === "shared"
                    ? "This site uses a saved secret. A pasted token is saved as this site's own secret; the saved secret stays as it is."
                    : "Stored in this company's secrets. Only the Publish job reads it."
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
          )}
        </div>
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
        <Field
          id={`${idPrefix}-live-preview`}
          label="Live site view"
          help="Optional. A copy of the live site that GSAM may show in a frame, for the Preview tab's Live view. It must be an exact copy of the live deploy, for example a Netlify deploy address of the same build. Empty: the live address."
        >
          <Input
            id={`${idPrefix}-live-preview`}
            type="url"
            pattern="https://.*"
            title="An address starting https://"
            value={livePreviewUrl}
            onChange={(event) => setLivePreviewUrl(event.target.value)}
            aria-describedby={`${idPrefix}-live-preview-help`}
            placeholder={`https://${domain.trim() || "www.example.com"}/`}
            autoComplete="off"
          />
        </Field>
        <Field
          id={`${idPrefix}-dev-preview`}
          label="In development"
          help="Optional. Where the next version of the site runs, for the Preview tab's In development view. Empty: the editor address."
        >
          <Input
            id={`${idPrefix}-dev-preview`}
            type="url"
            pattern="https://.*"
            title="An address starting https://"
            value={devPreviewUrl}
            onChange={(event) => setDevPreviewUrl(event.target.value)}
            aria-describedby={`${idPrefix}-dev-preview-help`}
            placeholder={editorFrameOrigin.trim() || "https://next.example.com"}
            autoComplete="off"
          />
        </Field>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="ghost" onClick={() => onDone()} disabled={save.isPending}>Cancel</Button>
        {save.isPending && willCheck ? (
          <p role="status" className="text-xs text-muted-foreground">Checking the site. This takes a few seconds.</p>
        ) : save.isError ? (
          <div role="alert" className="min-w-0 text-xs text-status-danger">
            <p>{errorStateMessage(save.error)}</p>
            {connectErrorDetail(save.error) ? <p className="text-muted-foreground">{connectErrorDetail(save.error)}</p> : null}
          </div>
        ) : null}
        <Button type="submit" className="ml-auto" disabled={save.isPending || !name.trim() || !domain.trim() || !netlifySiteId.trim()}>
          {save.isPending ? (willCheck ? "Checking" : "Saving") : site ? "Save" : "Connect site"}
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

/** Releases tab panel: the connected site, or a "Connect a site" form for people with Publish rights. */
export function WebsiteSiteConnection({ companyId, property }: { companyId: string; property: WebsiteProperty }) {
  const { site, isLoading, error } = useWebsiteSite(companyId, property.id);
  const { canManage } = useCanManageWebsite(companyId);
  const [editing, setEditing] = useState(false);
  const [checked, setChecked] = useState<WebsiteSite | null>(null);

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
        <SiteForm
          companyId={companyId}
          property={property}
          site={site}
          onDone={(saved) => {
            setChecked(saved ?? null);
            setEditing(false);
          }}
        />
      ) : site ? (
        <div className="space-y-3">
          {checked && checked.id === site.id ? (
            <div role="status" className="text-xs">
              <p className="font-medium text-foreground">{checked.name} is connected.</p>
              {checked.engineVersion ? <p className="text-muted-foreground">Details: site version {checked.engineVersion}.</p> : null}
            </div>
          ) : null}
          <dl className="space-y-1.5 text-xs">
            <Detail label="Site name">{site.name}</Detail>
            <Detail label="Live address"><span className="font-mono">{site.domain}</span></Detail>
            <Detail label="Code repository">{site.repoUrl ? <span className="font-mono">{site.repoUrl}</span> : "Not set"}</Detail>
            <Detail label="Netlify site ID"><span className="font-mono">{site.netlifySiteId}</span></Detail>
            <Detail label="Netlify token">
              {site.netlifyTokenSource === "shared"
                ? <>Saved secret <span className="font-medium">{site.netlifyTokenSecretName ?? "(name unavailable)"}</span>. GSAM reads it and never changes it.</>
                : site.hasNetlifyToken
                  ? "Token saved. Pasted for this site."
                  : "Not saved yet. Publish needs it."}
            </Detail>
            <Detail label="Editor address">{site.editorFrameOrigin ? <span className="font-mono">{site.editorFrameOrigin}</span> : "Not set. Editing pages needs it."}</Detail>
            <Detail label="Live site view">{site.livePreviewUrl ? <span className="font-mono">{site.livePreviewUrl}</span> : "The live address"}</Detail>
            <Detail label="In development">{site.devPreviewUrl ? <span className="font-mono">{site.devPreviewUrl}</span> : site.editorFrameOrigin ? "The editor address" : "Not set"}</Detail>
            <Detail label="Site version">{site.engineVersion ? <span className="font-mono">{site.engineVersion}</span> : "Not checked yet. Saving a token checks it."}</Detail>
          </dl>
        </div>
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
