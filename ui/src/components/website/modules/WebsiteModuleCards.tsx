import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Blocks,
  Briefcase,
  DoorOpen,
  FileText,
  Globe,
  KeyRound,
  Radar,
  ShoppingBag,
  Telescope,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { WebsiteModuleCard, WebsiteModuleHealthState, WebsiteModuleIcon, WebsiteSite } from "@greatstone/shared";
import { websiteModulesApi } from "../../../api/website-modules";
import { queryKeys } from "../../../lib/queryKeys";
import { Link } from "@/lib/router";
import { cn, formatNumber } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ErrorState } from "../../ErrorState";
import { releaseDate, releaseTime } from "../WebsiteReleases";

// The Modules section of Website Home (GRE-2325): one card per module of the
// site. A card shows only what is set: no "Owner: none" line, and no tasks
// line when there is no project or nothing open.

const MODULE_ICONS: Record<WebsiteModuleIcon, LucideIcon> = {
  blocks: Blocks,
  globe: Globe,
  "shopping-bag": ShoppingBag,
  "key-round": KeyRound,
  users: Users,
  telescope: Telescope,
  "door-open": DoorOpen,
  radar: Radar,
  "file-text": FileText,
  briefcase: Briefcase,
};

export function ModuleIcon({ icon, className }: { icon: WebsiteModuleIcon; className?: string }) {
  const Icon = MODULE_ICONS[icon] ?? Blocks;
  return <Icon className={className} aria-hidden="true" />;
}

const HEALTH_COPY: Record<WebsiteModuleHealthState, { label: string; dot: string }> = {
  ok: { label: "Healthy", dot: "bg-status-success" },
  attention: { label: "Needs a look", dot: "bg-status-warning" },
  unknown: { label: "No data yet", dot: "bg-status-neutral" },
};

/** The health dot with its meaning in words for screen readers and on hover. */
export function HealthDot({ health, showLabel = false }: { health: WebsiteModuleCard["health"]; showLabel?: boolean }) {
  const copy = HEALTH_COPY[health.state];
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" title={health.reason} data-testid="website-module-health" data-state={health.state}>
      <span aria-hidden="true" className={cn("size-2 rounded-full", copy.dot)} />
      <span className={showLabel ? undefined : "sr-only"}>{copy.label}</span>
    </span>
  );
}

export function moduleHref(siteId: string, moduleId: string) {
  return `/website/sites/${siteId}/modules/${moduleId}`;
}

/** "3 open tasks · 1 needs a person", or why there is no count. */
export function taskLine(card: Pick<WebsiteModuleCard, "openTasks" | "needsPerson">): { text: string; needsPerson: number } {
  if (card.openTasks === null) return { text: "No project linked", needsPerson: 0 };
  const open = card.openTasks === 1 ? "1 open task" : `${formatNumber(card.openTasks)} open tasks`;
  const needs = card.needsPerson ?? 0;
  return { text: needs > 0 ? `${open} · ${formatNumber(needs)} need${needs === 1 ? "s" : ""} a person` : open, needsPerson: needs };
}

function ModuleCardLink({ card, siteId }: { card: WebsiteModuleCard; siteId: string }) {
  const { module } = card;
  const tasks = taskLine(card);
  const people = [card.ownerName ? `Owner: ${card.ownerName}` : null, card.leadAgentName ? `Lead: ${card.leadAgentName}` : null].filter(Boolean);
  return (
    <Link
      to={moduleHref(siteId, module.id)}
      data-testid="website-module-card"
      data-module={module.key}
      className={cn(
        "gs-glass-card flex min-w-0 flex-col gap-3 rounded-xl border p-4 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        !module.enabled && "opacity-70",
      )}
    >
      <span className="flex min-w-0 items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
          <ModuleIcon icon={module.icon} className="size-4 text-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold">{module.name}</span>
            {module.enabled ? null : (
              <span className="shrink-0 rounded-full bg-status-neutral-soft px-2 py-0.5 text-xs font-medium text-status-neutral-foreground">Off</span>
            )}
          </span>
          {people.length ? <span className="block truncate text-xs text-muted-foreground">{people.join(" · ")}</span> : null}
        </span>
        <HealthDot health={card.health} />
      </span>
      <span className="flex flex-col gap-1 text-xs text-muted-foreground">
        {card.openTasks ? <span className={cn(tasks.needsPerson > 0 && "font-medium text-status-warning-foreground")}>{tasks.text}</span> : null}
        <span>
          {card.lastRelease ? (
            <>
              Release {card.lastRelease.number},{" "}
              <time dateTime={card.lastRelease.at} title={releaseDate(card.lastRelease.at)}>{releaseTime(card.lastRelease.at)}</time>
            </>
          ) : "No release has changed it yet"}
        </span>
        <span>{card.pageCount === 1 ? "1 page" : `${formatNumber(card.pageCount)} pages`}</span>
      </span>
    </Link>
  );
}

/** The Modules section: cards, or a way to add the starting set for a person with Publish rights. */
export function WebsiteModulesSection({ companyId, site, canChange }: { companyId: string; site: WebsiteSite | null; canChange: boolean }) {
  const queryClient = useQueryClient();
  const cardsQuery = useQuery({
    queryKey: queryKeys.website.moduleCards(companyId, site?.id ?? ""),
    queryFn: () => websiteModulesApi.cards(companyId, site!.id),
    enabled: !!site,
  });
  const addStarting = useMutation({
    mutationFn: () => websiteModulesApi.addStartingSet(companyId, site!.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.website.modules(companyId, site!.id) }),
  });
  const cards = cardsQuery.data ?? [];

  return (
    <section className="space-y-4" aria-labelledby="website-home-modules" data-testid="website-home-modules">
      <div className="space-y-1">
        <h2 id="website-home-modules" className="text-lg font-semibold">Modules</h2>
        <p className="text-sm text-muted-foreground">The big parts of the site. Open one to see its pages, tasks and settings.</p>
      </div>
      {!site ? (
        <p className="text-sm text-muted-foreground">Connect the site under Releases to see its modules.</p>
      ) : cardsQuery.error ? (
        <ErrorState error={cardsQuery.error} onRetry={() => cardsQuery.refetch()} retrying={cardsQuery.isFetching} compact />
      ) : cardsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground" role="status">Loading modules</p>
      ) : cards.length === 0 ? (
        <div className="gs-glass-card flex flex-col gap-3 rounded-xl border px-4 py-4 sm:flex-row sm:items-center sm:justify-between" data-testid="website-home-modules-empty">
          <div className="min-w-0">
            <p className="text-sm font-medium">No modules yet</p>
            <p className="text-xs text-muted-foreground">
              {canChange
                ? "Add the six starting modules: Public site, Shop and licences, Client portal, Deep Dive portal, Front door and enquiries, and Intelligence hub."
                : "A person with Publish rights adds the site's modules."}
            </p>
          </div>
          {canChange ? (
            <Button type="button" size="sm" onClick={() => addStarting.mutate()} disabled={addStarting.isPending}>
              {addStarting.isPending ? "Adding" : "Add the starting modules"}
            </Button>
          ) : null}
          {addStarting.error ? <ErrorState error={addStarting.error} compact /> : null}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {cards.map((card) => <ModuleCardLink key={card.module.id} card={card} siteId={site.id} />)}
        </div>
      )}
    </section>
  );
}
