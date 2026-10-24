import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Blocks,
  Briefcase,
  DoorOpen,
  FileText,
  Globe,
  Plus,
  KeyRound,
  Radar,
  ShoppingBag,
  Telescope,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { WebsiteFeatureCard, WebsiteFeatureHealthState, WebsiteFeatureIcon, WebsiteSite } from "@greatstone/shared";
import { websiteFeaturesApi } from "../../../api/website-features";
import { queryKeys } from "../../../lib/queryKeys";
import { Link } from "@/lib/router";
import { cn, formatNumber } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ErrorState } from "../../ErrorState";
import { releaseDate, releaseTime } from "../WebsiteReleases";
import { AddFeatureDialog } from "./AddFeatureDialog";

// The Features section of Website Home (GRE-2325): one card per feature of the
// site. A card shows only what is set: no "Owner: none" line, and no tasks
// line when there is no project or nothing open.

const FEATURE_ICONS: Record<WebsiteFeatureIcon, LucideIcon> = {
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

export function FeatureIcon({ icon, className }: { icon: WebsiteFeatureIcon; className?: string }) {
  const Icon = FEATURE_ICONS[icon] ?? Blocks;
  return <Icon className={className} aria-hidden="true" />;
}

const HEALTH_COPY: Record<WebsiteFeatureHealthState, { label: string; dot: string }> = {
  ok: { label: "Healthy", dot: "bg-status-success" },
  attention: { label: "Needs a look", dot: "bg-status-warning" },
  unknown: { label: "No data yet", dot: "bg-status-neutral" },
};

/** The health dot with its meaning in words for screen readers and on hover. */
export function HealthDot({ health, showLabel = false }: { health: WebsiteFeatureCard["health"]; showLabel?: boolean }) {
  const copy = HEALTH_COPY[health.state];
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" title={health.reason} data-testid="website-feature-health" data-state={health.state}>
      <span aria-hidden="true" className={cn("size-2 rounded-full", copy.dot)} />
      <span className={showLabel ? undefined : "sr-only"}>{copy.label}</span>
    </span>
  );
}

export function featureHref(siteId: string, featureId: string) {
  return `/website/sites/${siteId}/features/${featureId}`;
}

/** "3 open tasks · 1 needs a person", or why there is no count. */
export function taskLine(card: Pick<WebsiteFeatureCard, "openTasks" | "needsPerson">): { text: string; needsPerson: number } {
  if (card.openTasks === null) return { text: "No project linked", needsPerson: 0 };
  const open = card.openTasks === 1 ? "1 open task" : `${formatNumber(card.openTasks)} open tasks`;
  const needs = card.needsPerson ?? 0;
  return { text: needs > 0 ? `${open} · ${formatNumber(needs)} need${needs === 1 ? "s" : ""} a person` : open, needsPerson: needs };
}

function FeatureCardLink({ card, siteId }: { card: WebsiteFeatureCard; siteId: string }) {
  const { feature } = card;
  const tasks = taskLine(card);
  const people = [card.ownerName ? `Owner: ${card.ownerName}` : null, card.leadAgentName ? `Lead: ${card.leadAgentName}` : null].filter(Boolean);
  return (
    <Link
      to={featureHref(siteId, feature.id)}
      data-testid="website-feature-card"
      data-feature={feature.key}
      className={cn(
        "gs-glass-card flex min-w-0 flex-col gap-3 rounded-xl border p-4 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        !feature.enabled && "opacity-70",
      )}
    >
      <span className="flex min-w-0 items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
          <FeatureIcon icon={feature.icon} className="size-4 text-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold">{feature.name}</span>
            {feature.enabled ? null : (
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

/** The Features section: the site's own features, or "Add your first feature" for a person with Publish rights. */
export function WebsiteFeaturesSection({ companyId, site, canChange }: { companyId: string; site: WebsiteSite | null; canChange: boolean }) {
  const [adding, setAdding] = useState(false);
  const cardsQuery = useQuery({
    queryKey: queryKeys.website.featureCards(companyId, site?.id ?? ""),
    queryFn: () => websiteFeaturesApi.cards(companyId, site!.id),
    enabled: !!site,
  });
  const cards = cardsQuery.data ?? [];

  return (
    <section className="space-y-4" aria-labelledby="website-home-features" data-testid="website-home-features">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id="website-home-features" className="text-lg font-semibold">Features</h2>
          <p className="text-sm text-muted-foreground">The big parts of the site. Open one to see its pages, tasks and settings.</p>
        </div>
        {site && canChange && cards.length > 0 ? (
          <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            Add feature
          </Button>
        ) : null}
      </div>
      {!site ? (
        <p className="text-sm text-muted-foreground">Connect the site under Releases to see its features.</p>
      ) : cardsQuery.error ? (
        <ErrorState error={cardsQuery.error} onRetry={() => cardsQuery.refetch()} retrying={cardsQuery.isFetching} compact />
      ) : cardsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground" role="status">Loading features</p>
      ) : cards.length === 0 ? (
        <div className="gs-glass-card flex flex-col items-center gap-3 rounded-xl border px-6 py-8 text-center" data-testid="website-home-features-empty">
          <span className="flex size-10 items-center justify-center rounded-full bg-muted">
            <Blocks className="size-5 text-muted-foreground" aria-hidden="true" />
          </span>
          <div className="space-y-1">
            <p className="text-sm font-medium">{canChange ? "Add your first feature" : "No features yet"}</p>
            <p className="max-w-md text-xs text-muted-foreground">
              {canChange
                ? "A feature is one big part of the site, like a shop or a client portal, with its own pages, tasks and owner."
                : "A person with Publish rights adds the site's features."}
            </p>
          </div>
          {canChange ? (
            <Button type="button" size="sm" onClick={() => setAdding(true)}>
              <Plus aria-hidden="true" />
              Add your first feature
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {cards.map((card) => <FeatureCardLink key={card.feature.id} card={card} siteId={site.id} />)}
        </div>
      )}
      {site && canChange ? <AddFeatureDialog companyId={companyId} siteId={site.id} open={adding} onOpenChange={setAdding} /> : null}
    </section>
  );
}
