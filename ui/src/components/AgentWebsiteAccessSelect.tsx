import { useState } from "react";
import { agentWebsiteAccess, type AgentWebsiteAccessLevel } from "@greatstone/shared";
import { NativeSelect } from "@/components/ui/native-select";

const ALL_SITES = "all";
const SOME_SITES = "some";

function accessHint(level: AgentWebsiteAccessLevel, where: string) {
  if (level === "none") return "Cannot open the website pages.";
  if (level === "view") return `Sees the website pages and drafts on ${where}.`;
  return `Also edits drafts and proposes a Publish on ${where}.`;
}

/**
 * "Website access" on Agent → Permissions (GRE-2239): None, View or Edit, on
 * every site or on one chosen site (GRE-3992). There is no Publish option;
 * publishing stays with people. With None, picking a site only prepares the
 * next grant; nothing is saved until a level is picked.
 */
export function AgentWebsiteAccessSelect({
  grants,
  sites = [],
  disabled = false,
  onChange,
}: {
  grants: ReadonlyArray<{ permissionKey: string; scope?: Record<string, unknown> | null }>;
  /** This company's sites. Without any, the access covers every site. */
  sites?: ReadonlyArray<{ id: string; name: string }>;
  disabled?: boolean;
  onChange: (level: AgentWebsiteAccessLevel, siteId: string | null) => void;
}) {
  const { level, siteIds } = agentWebsiteAccess(grants);
  const [pendingSite, setPendingSite] = useState(ALL_SITES);
  const siteValue = level === "none"
    ? pendingSite
    : siteIds === null ? ALL_SITES : siteIds.length === 1 ? siteIds[0]! : SOME_SITES;
  const siteId = siteValue === ALL_SITES || siteValue === SOME_SITES ? null : siteValue;
  const siteName = sites.find((site) => site.id === siteId)?.name;
  const where = siteValue === ALL_SITES
    ? "every site"
    : siteValue === SOME_SITES ? `${siteIds?.length ?? 0} sites` : (siteName ?? "one site");
  // A scoped grant can name a site this list does not show (archived or not loaded): keep it pickable.
  const unlistedSite = siteId && !siteName ? siteId : null;

  return (
    <div className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="space-y-1">
        <div>Website access</div>
        <p className="text-xs text-muted-foreground" data-testid="agent-website-access-hint">
          {accessHint(level, where)} Publishing stays with people.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {sites.length > 0 || siteValue !== ALL_SITES ? (
          <NativeSelect
            aria-label="Website access sites"
            className="h-8 w-56 max-w-full"
            value={siteValue}
            disabled={disabled}
            onChange={(event) => {
              const next = event.target.value;
              if (level === "none") setPendingSite(next);
              else onChange(level, next === ALL_SITES ? null : next);
            }}
          >
            <option value={ALL_SITES}>All sites</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>{site.name}</option>
            ))}
            {unlistedSite ? <option value={unlistedSite}>One site</option> : null}
            {siteValue === SOME_SITES ? <option value={SOME_SITES} disabled>{where}</option> : null}
          </NativeSelect>
        ) : null}
        <NativeSelect
          aria-label="Website access"
          className="h-8 w-36"
          value={level}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value as AgentWebsiteAccessLevel;
            // None removes the grants whatever their sites, so it names no site.
            onChange(next, next === "none" ? null : siteId);
          }}
        >
          <option value="none">None</option>
          <option value="view">View</option>
          <option value="edit">Edit</option>
        </NativeSelect>
      </div>
    </div>
  );
}
