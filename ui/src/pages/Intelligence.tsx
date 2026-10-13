import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Radar, Sparkles } from "lucide-react";
import {
  INTELLIGENCE_BOARD_LABELS,
  type AiBriefingSections,
  type DailyPulseSections,
  type IntelligenceBoardView,
  type IntelligenceRecommendation,
  type IntelligenceRecommendationKind,
  type IntelligenceReportSummary,
} from "@greatstone/shared";
import { ApiError } from "../api/client";
import { instanceSettingsApi } from "../api/instanceSettings";
import { intelligenceApi, reportOrNull } from "../api/intelligence";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { PageSkeleton } from "../components/PageSkeleton";
import { BoardSection, Podium, seriesFor, type ScoreSeries } from "../components/intelligence/IntelligenceBoards";
import {
  IntelligenceSection,
  MovementChip,
  RatingStars,
  SourceLink,
  VerdictCard,
} from "../components/intelligence/IntelligenceCards";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link, useSearchParams } from "@/lib/router";
import { formatCalendarDay } from "@/lib/utils";

const TABS = [
  ["overview", "Overview"],
  ["today", "Today"],
  ["boards", "Leaderboards"],
  ["compare", "Compare"],
  ["radar", "Radar"],
  ["news", "News"],
  ["gsam", "GSAM ideas"],
  ["skills", "Skills"],
  ["archive", "Archive"],
] as const;
type Tab = (typeof TABS)[number][0];

const EFFORT_LABEL = { quick: "Quick", medium: "Medium", deep: "Deep" } as const;
const FRESHNESS_LABEL = { today: "Today", this_week: "This week", emerging: "Emerging trend" } as const;

function humanise(key: string) {
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function Empty({ title, message, action, onAction }: { title: string; message: string; action?: string; onAction?: () => void }) {
  return <EmptyState icon={Radar} title={title} message={message} action={action} onAction={onAction} hideActionIcon />;
}

// What fills each tab, and when. Lodestone is the Intelligence Analyst agent.
const WHEN = {
  pulse: "Lodestone, the Intelligence Analyst agent, publishes the Daily Pulse around 07:00 UK time each morning.",
  briefing: "Lodestone, the Intelligence Analyst agent, publishes the AI briefing around 06:00 UK time each morning.",
  ideas: "Lodestone, the Intelligence Analyst agent, proposes them with the morning briefing, around 06:00 UK time. Each one can become a task in one click.",
} as const;

// ---------- Today (Daily Pulse) ----------

function TodayView({ sections, headline, date }: { sections: DailyPulseSections; headline: string | null; date: string }) {
  const { quickWin } = sections;
  return (
    <div className="space-y-6">
      {headline ? <p className="text-lg font-semibold leading-snug">{headline}</p> : null}
      <section aria-label="Quick win" className="rounded-lg border border-status-success/30 bg-status-success/10 p-4 space-y-1">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 text-status-success" aria-hidden="true" />
          <span className="font-semibold uppercase tracking-wide">Quick win</span>
          <span>{quickWin.timeNeeded}</span>
        </div>
        <h2 className="text-sm font-semibold">{quickWin.title}</h2>
        <p className="text-sm">{quickWin.action}</p>
        <p className="text-sm text-muted-foreground">{quickWin.outcome}</p>
        {quickWin.url ? <SourceLink href={quickWin.url}>Start here</SourceLink> : null}
      </section>

      {sections.weekInReview ? (
        <IntelligenceSection title="Week in review">
          <p className="text-sm md:col-span-2 xl:col-span-3">{sections.weekInReview}</p>
        </IntelligenceSection>
      ) : null}

      {sections.trends.length > 0 ? (
        <IntelligenceSection title="AI industry trends" count={sections.trends.length}>
          {sections.trends.map((trend) => (
            <VerdictCard
              key={trend.url + trend.headline}
              eyebrow={`${FRESHNESS_LABEL[trend.freshness]} · ${trend.sourceName}`}
              title={trend.headline}
              href={trend.url}
              verdict={trend.whyItMatters}
              footer={trend.learnMore.map((link) => (
                <SourceLink key={link.url} href={link.url}>{link.tag ? `${link.label} (${link.tag})` : link.label}</SourceLink>
              ))}
            />
          ))}
        </IntelligenceSection>
      ) : null}

      {sections.tools.length > 0 ? (
        <IntelligenceSection title="Trending tools" count={sections.tools.length}>
          {sections.tools.map((tool) => (
            <VerdictCard
              key={tool.url}
              eyebrow={`${humanise(tool.category)} · ${tool.pricing}`}
              title={tool.name}
              href={tool.url}
              verdict={tool.what}
              points={[tool.quickTake]}
              meta={
                <>
                  <RatingStars value={tool.personalRating} label="Personal" />
                  <RatingStars value={tool.clientRating} label="Client" />
                  <span className="text-xs text-muted-foreground">Flagged by {tool.flaggedBy}</span>
                </>
              }
              footer={tool.learnMore.map((link) => (
                <SourceLink key={link.url} href={link.url}>{link.label}</SourceLink>
              ))}
            />
          ))}
        </IntelligenceSection>
      ) : null}

      {sections.skillIdeas.length > 0 ? (
        <IntelligenceSection title="Skill ideas" count={sections.skillIdeas.length}>
          {sections.skillIdeas.map((idea) => (
            <VerdictCard
              key={idea.name}
              eyebrow={`Build: ${EFFORT_LABEL[idea.buildEstimate]}`}
              title={idea.name}
              verdict={idea.what}
              points={[`Why now: ${idea.whyNow}`, `For clients: ${idea.clientValue}`]}
              footer={idea.sourceUrl ? <SourceLink href={idea.sourceUrl}>Source</SourceLink> : null}
            />
          ))}
        </IntelligenceSection>
      ) : null}

      {sections.creators.length > 0 ? (
        <IntelligenceSection title="Creator content" count={sections.creators.length}>
          {sections.creators.map((item) => (
            <VerdictCard
              key={item.url}
              eyebrow={`${item.creator} · ${item.platform}${item.newFace ? " · New face" : ""}`}
              title={item.content}
              href={item.url}
              verdict={item.why}
            />
          ))}
        </IntelligenceSection>
      ) : null}

      {sections.opportunities.length > 0 ? (
        <IntelligenceSection title="Greatstone opportunities" count={sections.opportunities.length}>
          {sections.opportunities.map((item) => (
            <VerdictCard
              key={item.title}
              eyebrow={`Revenue: ${humanise(item.revenuePotential)} · ${item.targetClients}`}
              title={item.title}
              verdict={item.triggeredBy}
              action={item.nextStep}
              analysis={
                item.revenueReason || item.explorePrompt ? (
                  <>
                    {item.revenueReason ? <p>{item.revenueReason}</p> : null}
                    {item.explorePrompt ? (
                      <div className="space-y-1">
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Explore prompt</h3>
                        <p className="whitespace-pre-wrap rounded-md border border-border bg-muted p-3 font-mono text-xs">{item.explorePrompt}</p>
                      </div>
                    ) : null}
                  </>
                ) : undefined
              }
              footer={item.sources.map((link) => (
                <SourceLink key={link.url} href={link.url}>{link.label}</SourceLink>
              ))}
            />
          ))}
        </IntelligenceSection>
      ) : null}
      <p className="text-xs text-muted-foreground">Daily Pulse for {formatCalendarDay(date, { includeYear: true })}.</p>
    </div>
  );
}

// ---------- Leaderboards and Compare ----------

function CompareView({ view }: { view: IntelligenceBoardView | undefined }) {
  const names = view?.entries.map((entry) => entry.name) ?? [];
  const [left, setLeft] = useState<string | null>(null);
  const [right, setRight] = useState<string | null>(null);
  if (!view || names.length < 2) {
    return <Empty title="Nothing to compare yet" message="Compare needs a Frontier Models snapshot with at least two models." />;
  }
  const a = view.entries.find((entry) => entry.name === (left ?? names[0]))!;
  const b = view.entries.find((entry) => entry.name === (right ?? names[1]))!;
  const specKeys = [...new Set([...Object.keys(a.specs ?? {}), ...Object.keys(b.specs ?? {})])];
  const rows: [string, string, string][] = [
    ["Rank", String(a.rank), String(b.rank)],
    ["Intelligence Index", String(a.score ?? "n/a"), String(b.score ?? "n/a")],
    ...specKeys.map((key): [string, string, string] => [humanise(key), String(a.specs?.[key] ?? "n/a"), String(b.specs?.[key] ?? "n/a")]),
  ];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:max-w-md">
        <NativeSelect aria-label="First model" value={a.name} onChange={(event) => setLeft(event.target.value)}>
          {names.map((name) => <option key={name}>{name}</option>)}
        </NativeSelect>
        <NativeSelect aria-label="Second model" value={b.name} onChange={(event) => setRight(event.target.value)}>
          {names.map((name) => <option key={name}>{name}</option>)}
        </NativeSelect>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th scope="col" className="px-3 py-2 text-left font-medium">Measure</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{a.name}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{b.name}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, x, y]) => (
              <tr key={label} className="border-b border-border last:border-0">
                <th scope="row" className="px-3 py-2 text-left font-normal text-muted-foreground">{label}</th>
                <td className="px-3 py-2 text-right tabular-nums">{x}</td>
                <td className="px-3 py-2 text-right tabular-nums">{y}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Overview ----------

function OverviewHeading({ title, action }: { title: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {action ? (
        <Button variant="link" size="sm" className="h-auto shrink-0 p-0 text-xs" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card p-3 sm:p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="truncate text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

/** The old hub's front page: stats, the lead story with what is trending, the podium and the top tools. */
function OverviewView({
  boards,
  briefing,
  systemsSeries,
  onOpen,
}: {
  boards: IntelligenceBoardView[];
  briefing: AiBriefingSections | null;
  systemsSeries: ScoreSeries | undefined;
  onOpen: (tab: Tab) => void;
}) {
  const byBoard = (board: IntelligenceBoardView["board"]) => boards.find((view) => view.board === board);
  const systems = byBoard("ai_systems");
  const models = byBoard("frontier_models");
  const tools = byBoard("tools_agents");
  const news = briefing?.news ?? [];
  if (boards.length === 0 && news.length === 0) {
    return (
      <Empty
        title="Nothing to show yet"
        message={`The overview draws on the AI briefing and the leaderboards. ${WHEN.briefing} The Daily Pulse follows around 07:00.`}
      />
    );
  }
  const lead = news.find((item) => item.lead) ?? news[0];
  const trending = news.filter((item) => item !== lead).slice(0, 5);
  const stats = [
    systems?.entries[0] ? { label: "Top system", value: String(systems.entries[0].score ?? "n/a"), sub: systems.entries[0].name } : null,
    models?.entries[0] ? { label: "Top model, Index", value: String(models.entries[0].score ?? "n/a"), sub: models.entries[0].name } : null,
    tools ? { label: "Tools tracked", value: String(tools.entries.length), sub: "Agents and builders" } : null,
    briefing ? { label: "Updates", value: String(news.length), sub: "In the briefing" } : null,
  ].filter((stat) => stat !== null);
  return (
    <div className="space-y-6">
      {stats.length > 0 ? (
        <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
          {stats.map((stat) => <StatTile key={stat.label} {...stat} />)}
        </div>
      ) : null}

      {lead ? (
        <section className="space-y-3" aria-label="Leading the field">
          <OverviewHeading title="Leading the field" action={{ label: "All news", onClick: () => onOpen("news") }} />
          <div className="grid gap-3 lg:grid-cols-3">
            <NewsCard item={lead} className="lg:col-span-2" />
            {trending.length > 0 ? (
              <aside className="min-w-0 rounded-lg border border-border bg-card p-4" aria-label="Trending now">
                <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                  Trending now
                </h3>
                <ol className="divide-y divide-border">
                  {trending.map((item) => (
                    <li key={item.url + item.headline} className="py-2 first:pt-0 last:pb-0">
                      <div className="text-xs text-muted-foreground">{item.tag}</div>
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="break-words rounded-sm text-sm font-medium leading-snug underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {item.headline}
                      </a>
                    </li>
                  ))}
                </ol>
              </aside>
            ) : null}
          </div>
        </section>
      ) : null}

      {systems ? (
        <section className="space-y-3" aria-label="The podium">
          <OverviewHeading title={`Podium, ${INTELLIGENCE_BOARD_LABELS.ai_systems}`} action={{ label: "Full leaderboard", onClick: () => onOpen("boards") }} />
          <Podium view={systems} series={systemsSeries} />
        </section>
      ) : null}

      {tools && tools.entries.length > 0 ? (
        <section className="space-y-3" aria-label="Top tools and agents">
          <OverviewHeading title="Top tools and agents" action={{ label: "Tools board", onClick: () => onOpen("boards") }} />
          <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-5">
            {tools.entries.slice(0, 5).map((entry) => (
              <li key={entry.name} className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card p-3">
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">#{entry.rank}</span>
                  <MovementChip movement={entry.movement} />
                </div>
                <div className="break-words text-sm font-semibold leading-snug">{entry.name}</div>
                {entry.maker ? <div className="truncate text-xs text-muted-foreground">{entry.maker}</div> : null}
                <div className="mt-auto text-lg font-bold tabular-nums">{entry.score ?? "n/a"}</div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

// ---------- News and Radar (AI briefing) ----------

type NewsItem = AiBriefingSections["news"][number];

function NewsCard({ item, className }: { item: NewsItem; className?: string }) {
  return (
    <VerdictCard
      className={className}
      eyebrow={`${item.tag} · ${formatCalendarDay(item.date)}${item.rumoured ? " · Rumoured" : ""}`}
      title={item.headline}
      href={item.url}
      verdict={item.verdict}
      points={item.points}
      action={item.action}
      analysis={
        <>
          {item.points.length > 3 ? (
            <ul className="list-disc space-y-1 pl-4">{item.points.map((point) => <li key={point}>{point}</li>)}</ul>
          ) : null}
          {item.take ? <p>{item.take}</p> : null}
          {item.lens ? (
            <div className="space-y-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Greatstone lens</h3>
              <p>{item.lens}</p>
            </div>
          ) : null}
          <SourceLink href={item.url}>{item.sourceName}</SourceLink>
        </>
      }
      footer={<SourceLink href={item.url}>{item.sourceName}</SourceLink>}
    />
  );
}

function NewsView({ sections }: { sections: AiBriefingSections }) {
  if (sections.news.length === 0) return <Empty title="No news in this briefing" message="The briefing for this day has no news items." />;
  return (
    <IntelligenceSection title="News briefing" count={sections.news.length}>
      {sections.news.map((item) => (
        <NewsCard key={item.url + item.headline} item={item} className={item.lead ? "md:col-span-2 xl:col-span-3" : undefined} />
      ))}
    </IntelligenceSection>
  );
}

function RadarView({ sections }: { sections: AiBriefingSections }) {
  const { emerging, movers, watchlist } = sections.radar;
  if (emerging.length + movers.length + watchlist.length === 0) {
    return <Empty title="Radar is empty" message="The briefing for this day has no emerging tools, movers or watchlist items." />;
  }
  return (
    <div className="space-y-6">
      {emerging.length > 0 ? (
        <IntelligenceSection title="Emerging" count={emerging.length}>
          {emerging.map((item) => (
            <VerdictCard key={item.url + item.name} eyebrow={`${item.by} · ${item.status}`} title={item.name} href={item.url} verdict={item.what} points={[item.why]} />
          ))}
        </IntelligenceSection>
      ) : null}
      {movers.length > 0 ? (
        <IntelligenceSection title="Movers" count={movers.length}>
          {movers.map((item) => (
            <VerdictCard
              key={item.url + item.name}
              eyebrow={<span className={item.direction === "up" ? "text-status-success" : "text-status-danger"}>{item.direction === "up" ? "Up" : "Down"} · {item.tag}</span>}
              title={item.name}
              href={item.url}
              verdict={item.note}
            />
          ))}
        </IntelligenceSection>
      ) : null}
      {watchlist.length > 0 ? (
        <IntelligenceSection title="Watchlist" count={watchlist.length}>
          {watchlist.map((item) => (
            <VerdictCard key={item.url + item.name} eyebrow={item.tag} title={item.name} href={item.url} verdict={item.note} />
          ))}
        </IntelligenceSection>
      ) : null}
    </div>
  );
}

// ---------- Recommendations ----------

function RecommendationsView({
  companyId,
  kind,
  items,
}: {
  companyId: string;
  kind: IntelligenceRecommendationKind;
  items: IntelligenceRecommendation[];
}) {
  const queryClient = useQueryClient();
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });
  // GSAM ideas land in the GS Agentic Manager platform project when there is one.
  const platformProjectId =
    projectsQuery.data?.find((project) => /agentic manager|\bgsam\b/i.test(project.name))?.id ?? null;
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.intelligence.recommendations(companyId) });
  const onError = (err: unknown) => setError(err instanceof ApiError ? err.message : "Something went wrong");
  const decide = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "accepted" | "dismissed" | "new" }) => intelligenceApi.decide(id, status),
    onSuccess: refresh,
    onError,
  });
  const createTask = useMutation({
    mutationFn: (id: string) => intelligenceApi.createTask(id, kind === "gsam_feature" ? platformProjectId : null),
    onSuccess: refresh,
    onError,
  });
  const rows = items.filter((item) => item.kind === kind);
  const order = { new: 0, accepted: 1, dismissed: 2 } as const;
  rows.sort((x, y) => order[x.status] - order[y.status]);
  const title = kind === "gsam_feature" ? "GSAM feature ideas" : "Skill recommendations";
  return (
    <div className="space-y-3">
      {error ? <p role="alert" className="text-sm text-status-danger">{error}</p> : null}
      <IntelligenceSection
        title={title}
        count={rows.length}
        action={kind === "skill" ? <Link to="/skills" className="text-xs text-muted-foreground hover:text-foreground hover:underline underline-offset-4">Open Skills</Link> : null}
      >
        {rows.length === 0 ? (
          <div className="md:col-span-2 xl:col-span-3">
            <Empty title={`No ${kind === "gsam_feature" ? "GSAM feature ideas" : "skill recommendations"} yet`} message={WHEN.ideas} />
          </div>
        ) : (
          rows.map((item) => (
            <VerdictCard
              key={item.id}
              eyebrow={`${EFFORT_LABEL[item.effort]} · ${humanise(item.status)}${item.reportDate ? ` · ${formatCalendarDay(item.reportDate)}` : ""}`}
              title={item.title}
              verdict={item.why}
              meta={item.sourceUrl ? <SourceLink href={item.sourceUrl}>Source</SourceLink> : null}
              footer={
                <>
                  {item.issueIdentifier ? (
                    <Link to={`/issues/${item.issueIdentifier}`} className="text-sm font-medium hover:underline underline-offset-4">
                      Task {item.issueIdentifier}
                    </Link>
                  ) : (
                    <Button size="sm" onClick={() => createTask.mutate(item.id)} disabled={createTask.isPending}>
                      Create task
                    </Button>
                  )}
                  {item.status !== "accepted" && !item.issueId ? (
                    <Button size="sm" variant="outline" onClick={() => decide.mutate({ id: item.id, status: "accepted" })} disabled={decide.isPending}>
                      Accept
                    </Button>
                  ) : null}
                  {item.status !== "dismissed" && !item.issueId ? (
                    <Button size="sm" variant="ghost" onClick={() => decide.mutate({ id: item.id, status: "dismissed" })} disabled={decide.isPending}>
                      Dismiss
                    </Button>
                  ) : null}
                </>
              }
            />
          ))
        )}
      </IntelligenceSection>
    </div>
  );
}

function ArchiveView({ reports, onOpen }: { reports: IntelligenceReportSummary[]; onOpen: (date: string, tab: Tab) => void }) {
  if (reports.length === 0) return <Empty title="No reports yet" message={`Every Daily Pulse and AI briefing is kept here. ${WHEN.briefing}`} />;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {reports.map((report) => (
        <li key={report.id}>
          <button
            type="button"
            onClick={() => onOpen(report.reportDate, report.kind === "daily_pulse" ? "today" : "news")}
            className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="font-mono text-xs text-muted-foreground">{report.reportDate}</span>
            <span className="text-xs text-muted-foreground">{report.kind === "daily_pulse" ? "Daily Pulse" : "AI briefing"}{report.status === "draft" ? " (draft)" : ""}</span>
            <span className="min-w-0 flex-1 text-sm">{report.headline ?? "Untitled"}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---------- Page ----------

export function Intelligence() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: Tab = TABS.some(([id]) => id === tabParam) ? (tabParam as Tab) : "overview";
  const date = searchParams.get("date");
  const reportDate = date ?? "latest";

  useEffect(() => {
    setBreadcrumbs([{ label: "Intelligence" }]);
  }, [setBreadcrumbs]);

  const setParams = (next: { tab?: Tab; date?: string | null }) => {
    const params = new URLSearchParams(searchParams);
    if (next.tab) params.set("tab", next.tab);
    if (next.date !== undefined) {
      if (next.date) params.set("date", next.date);
      else params.delete("date");
    }
    setSearchParams(params, { replace: true });
  };

  const settingsQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const on = settingsQuery.data?.enableIntelligence === true && !!selectedCompanyId;
  const companyId = selectedCompanyId ?? "";

  const pulseQuery = useQuery({
    queryKey: queryKeys.intelligence.report(companyId, reportDate, "daily_pulse"),
    queryFn: () => reportOrNull(companyId, reportDate, "daily_pulse"),
    enabled: on,
  });
  const briefingQuery = useQuery({
    queryKey: queryKeys.intelligence.report(companyId, reportDate, "ai_briefing"),
    queryFn: () => reportOrNull(companyId, reportDate, "ai_briefing"),
    enabled: on,
  });
  const boardsQuery = useQuery({
    queryKey: queryKeys.intelligence.boards(companyId, date),
    queryFn: () => intelligenceApi.boards(companyId, date),
    enabled: on,
  });
  const historyQuery = useQuery({
    queryKey: queryKeys.intelligence.boardHistory(companyId, date),
    queryFn: () => intelligenceApi.boardHistory(companyId, date),
    enabled: on,
  });
  const recommendationsQuery = useQuery({
    queryKey: queryKeys.intelligence.recommendations(companyId),
    queryFn: () => intelligenceApi.recommendations(companyId),
    enabled: on,
  });
  const archiveQuery = useQuery({
    queryKey: queryKeys.intelligence.reports(companyId),
    queryFn: () => intelligenceApi.reports(companyId),
    enabled: on,
  });

  const frontier = useMemo(
    () => boardsQuery.data?.boards.find((view) => view.board === "frontier_models"),
    [boardsQuery.data],
  );
  // Sparklines are a nice-to-have: a failed history read leaves them out rather than failing the page.
  const series = useMemo(
    () => new Map((historyQuery.data?.history ?? []).map((history) => [history.board, seriesFor(history)])),
    [historyQuery.data],
  );

  if (!selectedCompanyId) return <EmptyState icon={Radar} message="Select an organization to see its intelligence." />;
  if (settingsQuery.isLoading) return <PageSkeleton variant="dashboard" />;
  if (!on) {
    return (
      <EmptyState
        icon={Lock}
        title="Intelligence is switched off"
        message="An instance admin can switch it on under Settings, Experimental."
      />
    );
  }
  const firstError = [pulseQuery, briefingQuery, boardsQuery, recommendationsQuery, archiveQuery].find((query) => query.error);
  if (firstError) return <ErrorState error={firstError.error} onRetry={() => firstError.refetch()} retrying={firstError.isFetching} />;

  const pulse = pulseQuery.data?.kind === "daily_pulse" ? pulseQuery.data : null;
  const briefing = briefingQuery.data?.kind === "ai_briefing" ? briefingQuery.data : null;
  const boards = boardsQuery.data?.boards ?? [];
  const recommendations = recommendationsQuery.data?.recommendations ?? [];
  const loading = (query: { isLoading: boolean }) => (query.isLoading ? <PageSkeleton variant="dashboard" /> : null);

  return (
    <div className="w-full max-w-7xl space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-bold">Intelligence</h1>
          <p className="text-sm text-muted-foreground">
            The Daily Pulse and the AI leaderboards, written by your intelligence agent from real sources.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="date"
            aria-label="Show a past day"
            className="w-auto"
            value={date ?? ""}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(event) => setParams({ date: event.target.value || null })}
          />
          {date ? (
            <Button variant="ghost" size="sm" onClick={() => setParams({ date: null })}>
              Latest
            </Button>
          ) : null}
        </div>
      </header>

      <Tabs value={tab} onValueChange={(value) => setParams({ tab: value as Tab })}>
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList variant="line" className="justify-start">
            {TABS.map(([id, label]) => (
              <TabsTrigger key={id} value={id} className="flex-none">
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="overview" className="mt-4">
          {loading(boardsQuery) ??
            loading(briefingQuery) ?? (
              <OverviewView
                boards={boards}
                briefing={briefing?.sections ?? null}
                systemsSeries={series.get("ai_systems")}
                onOpen={(next) => setParams({ tab: next })}
              />
            )}
        </TabsContent>

        <TabsContent value="today" className="mt-4">
          {loading(pulseQuery) ??
            (pulse ? (
              <TodayView sections={pulse.sections} headline={pulse.headline} date={pulse.reportDate} />
            ) : (
              <Empty
                title={date ? "No Daily Pulse for this day" : "No Daily Pulse yet"}
                message={date ? "Lodestone did not publish a Daily Pulse on this day. Try another day, or the Archive." : `${WHEN.pulse} It shows here as soon as it lands.`}
                action={date ? "Show latest" : undefined}
                onAction={date ? () => setParams({ date: null }) : undefined}
              />
            ))}
        </TabsContent>

        <TabsContent value="boards" className="mt-4 space-y-6">
          {loading(boardsQuery) ??
            (boards.length > 0 ? (
              boards.map((view) => <BoardSection key={view.board} view={view} series={series.get(view.board)} />)
            ) : (
              <Empty
                title="No leaderboard snapshots yet"
                message="Lodestone, the Intelligence Analyst agent, writes a snapshot of each board with its morning run. Movement arrows appear once there is a week of history."
              />
            ))}
        </TabsContent>

        <TabsContent value="compare" className="mt-4">
          {loading(boardsQuery) ?? <CompareView view={frontier} />}
        </TabsContent>

        <TabsContent value="radar" className="mt-4">
          {loading(briefingQuery) ??
            (briefing ? <RadarView sections={briefing.sections} /> : <Empty title="No briefing yet" message={`Radar comes from the AI briefing. ${WHEN.briefing}`} />)}
        </TabsContent>

        <TabsContent value="news" className="mt-4">
          {loading(briefingQuery) ??
            (briefing ? <NewsView sections={briefing.sections} /> : <Empty title="No briefing yet" message={`${WHEN.briefing} News lands here as soon as it is written.`} />)}
        </TabsContent>

        <TabsContent value="gsam" className="mt-4">
          {loading(recommendationsQuery) ?? <RecommendationsView companyId={companyId} kind="gsam_feature" items={recommendations} />}
        </TabsContent>

        <TabsContent value="skills" className="mt-4">
          {loading(recommendationsQuery) ?? <RecommendationsView companyId={companyId} kind="skill" items={recommendations} />}
        </TabsContent>

        <TabsContent value="archive" className="mt-4">
          {loading(archiveQuery) ??
            <ArchiveView reports={archiveQuery.data?.reports ?? []} onOpen={(day, next) => setParams({ date: day, tab: next })} />}
        </TabsContent>
      </Tabs>
    </div>
  );
}
