import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  Globe,
  Lock,
  MousePointerClick,
  Search,
  Target,
  TrendingUp,
  Users,
} from "lucide-react";
import type {
  WebsiteDateRange,
  WebsiteGa4Report,
  WebsiteProperty,
  WebsitePullError,
  WebsitePullStatus,
  WebsiteReport,
  WebsiteSearchConsoleReport,
} from "@greatstone/shared";
import { websiteApi, isWebsiteNotEntitled } from "../api/website";
import { instanceSettingsApi } from "../api/instanceSettings";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { ErrorState, errorStateMessage } from "../components/ErrorState";
import { MetricCard } from "../components/MetricCard";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { useSearchParams } from "@/lib/router";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";

/* ---- Formatting ---- */

const numberFormat = new Intl.NumberFormat("en-GB");
const percentFormat = new Intl.NumberFormat("en-GB", { style: "percent", maximumFractionDigits: 1 });

export function formatCount(value: number): string {
  return numberFormat.format(Math.round(value));
}

export function formatPosition(value: number): string {
  return value.toFixed(1);
}

/** `YYYY-MM-DD` read as a calendar day, so the label never shifts with the time zone. */
function dayLabel(day: string, withYear = false): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year!, (month ?? 1) - 1, date ?? 1)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}

export function formatRange(range: WebsiteDateRange): string {
  return `${dayLabel(range.startDate)} – ${dayLabel(range.endDate, true)}`;
}

const ERROR_SOURCE_LABELS: Record<WebsitePullError["source"], string> = {
  auth: "Google sign-in",
  ga4: "Google Analytics",
  search_console: "Search Console",
};

const PULL_STATUS: Record<WebsitePullStatus, { label: string; className: string }> = {
  running: { label: "Pulling now", className: "bg-status-running-soft text-status-running-foreground" },
  succeeded: { label: "Pulled", className: "bg-status-success-soft text-status-success-foreground" },
  partial: { label: "Partly pulled", className: "bg-status-warning/15 text-status-warning-foreground" },
  failed: { label: "Pull failed", className: "bg-status-danger-soft text-status-danger-foreground" },
};

/* ---- Building blocks ---- */

function Section({ id, title, subtitle, children }: { id: string; title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="space-y-4" aria-labelledby={id}>
      <div className="space-y-0.5">
        <h2 id={id} className="text-lg font-semibold">{title}</h2>
        {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Panel({ title, subtitle, children, className }: { title: string; subtitle?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("gs-glass-card min-w-0 rounded-xl border p-4 space-y-3", className)}>
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
      </div>
      {children}
    </div>
  );
}

interface Column<T> {
  label: string;
  /** Numeric columns align right and use tabular figures. */
  numeric?: boolean;
  /** Hidden below the `sm` breakpoint so phone widths do not scroll sideways. */
  hideOnPhone?: boolean;
  render: (row: T) => ReactNode;
}

function DataTable<T>({ rows, columns, rowKey, empty, label }: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  empty: string;
  label: string;
}) {
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <table className="w-full table-fixed text-xs" aria-label={label}>
      <thead>
        <tr className="border-b border-border text-muted-foreground">
          {columns.map((column, index) => (
            <th
              key={column.label}
              scope="col"
              className={cn(
                "py-1.5 font-medium",
                index === 0 ? "w-auto pr-2 text-left" : "w-20 pl-2 text-right",
                column.hideOnPhone && "hidden sm:table-cell",
              )}
            >
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)} className="border-b border-border/60 last:border-0">
            {columns.map((column, index) => (
              <td
                key={column.label}
                className={cn(
                  "py-2 align-top",
                  index === 0 ? "min-w-0 pr-2" : "pl-2 text-right",
                  column.numeric && "tabular-nums",
                  column.hideOnPhone && "hidden sm:table-cell",
                )}
              >
                {column.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TrendBars({ points, label }: { points: { date: string; value: number }[]; label: string }) {
  if (points.length === 0) return <p className="text-xs text-muted-foreground">No daily data in this pull.</p>;
  const max = Math.max(...points.map((point) => point.value), 1);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return (
    <div>
      <div
        role="img"
        aria-label={`${label}, ${dayLabel(first.date)} to ${dayLabel(last.date)}: from ${formatCount(first.value)} to ${formatCount(last.value)} a day`}
        className="flex h-28 items-end gap-px sm:gap-(--sz-3px)"
      >
        {points.map((point) => (
          <div key={point.date} className="flex h-full flex-1 flex-col justify-end" title={`${dayLabel(point.date)}: ${formatCount(point.value)}`}>
            {point.value > 0 ? (
              <div className="rounded-t-sm bg-chart-1" style={{ height: `${(point.value / max) * 100}%`, minHeight: 2 }} />
            ) : (
              <div className="rounded-sm bg-muted/30" style={{ height: 2 }} />
            )}
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-xs text-subtle-foreground">
        <span>{dayLabel(first.date)}</span>
        <span>{dayLabel(last.date)}</span>
      </div>
    </div>
  );
}

function PulledAt({ at }: { at: string | null }) {
  if (!at) return null;
  return <span title={formatDateTime(at)}>Pulled {relativeTime(at)}</span>;
}

/* ---- Sections ---- */

function Ga4Section({ report }: { report: WebsiteGa4Report | null }) {
  return (
    <Section
      id="website-ga4"
      title="Visitors"
      subtitle={report ? `Google Analytics 4 · ${formatRange(report.range)}` : "Google Analytics 4"}
    >
      {!report ? (
        <p className="text-sm text-muted-foreground">No Google Analytics data yet. It shows after the next pull that reaches Google Analytics.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <MetricCard icon={Users} value={formatCount(report.totals.visitors)} label="Visitors" />
            <MetricCard icon={TrendingUp} value={formatCount(report.totals.sessions)} label="Sessions" />
            <MetricCard icon={Eye} value={formatCount(report.totals.pageViews)} label="Page views" />
            <MetricCard icon={Target} value={formatCount(report.totals.conversions)} label="Conversions" />
          </div>
          <Panel title="Visitors per day">
            <TrendBars
              label="Visitors per day"
              points={report.dailyTrend.map((point) => ({ date: point.date, value: point.visitors }))}
            />
          </Panel>
          <div className="grid gap-3 lg:grid-cols-2">
            <Panel title="Where visitors come from">
              <DataTable
                label="Traffic sources"
                rows={report.sources}
                rowKey={(row) => `${row.source}/${row.medium}`}
                empty="No traffic sources in this pull."
                columns={[
                  {
                    label: "Source / medium",
                    render: (row) => (
                      <span className="block truncate" title={`${row.source} / ${row.medium}`}>
                        {row.source} <span className="text-muted-foreground">/ {row.medium}</span>
                      </span>
                    ),
                  },
                  { label: "Sessions", numeric: true, render: (row) => formatCount(row.sessions) },
                  { label: "Visitors", numeric: true, hideOnPhone: true, render: (row) => formatCount(row.visitors) },
                ]}
              />
            </Panel>
            <Panel title="Top pages">
              <DataTable
                label="Top pages"
                rows={report.topPages}
                rowKey={(row) => row.path}
                empty="No page views in this pull."
                columns={[
                  {
                    label: "Page",
                    render: (row) => (
                      <span className="block min-w-0">
                        <span className="block truncate font-medium" title={row.title}>{row.title || row.path}</span>
                        <span className="block truncate font-mono text-muted-foreground" title={row.path}>{row.path}</span>
                      </span>
                    ),
                  },
                  { label: "Views", numeric: true, render: (row) => formatCount(row.views) },
                  { label: "Visitors", numeric: true, hideOnPhone: true, render: (row) => formatCount(row.visitors) },
                ]}
              />
            </Panel>
          </div>
          <Panel title="Conversions" subtitle="Key events counted by Google Analytics.">
            <DataTable
              label="Conversions"
              rows={report.conversions}
              rowKey={(row) => row.eventName}
              empty="No conversions recorded in this period."
              columns={[
                { label: "Event", render: (row) => <span className="block truncate font-mono">{row.eventName}</span> },
                { label: "Count", numeric: true, render: (row) => formatCount(row.count) },
              ]}
            />
          </Panel>
        </>
      )}
    </Section>
  );
}

function SearchConsoleSection({ report }: { report: WebsiteSearchConsoleReport | null }) {
  return (
    <Section
      id="website-search-console"
      title="Search"
      subtitle={report ? `Google Search Console · ${formatRange(report.range)}` : "Google Search Console"}
    >
      {!report ? (
        <p className="text-sm text-muted-foreground">No Search Console data yet. It shows after the next pull that reaches Search Console.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <MetricCard icon={MousePointerClick} value={formatCount(report.totals.clicks)} label="Clicks" />
            <MetricCard icon={Eye} value={formatCount(report.totals.impressions)} label="Impressions" />
            <MetricCard icon={TrendingUp} value={formatPosition(report.totals.averagePosition)} label="Average position" />
            <MetricCard icon={Target} value={percentFormat.format(report.totals.ctr)} label="Click-through rate" />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <Panel title="Top search queries">
              <DataTable
                label="Search queries"
                rows={report.queries}
                rowKey={(row) => row.query}
                empty="No search queries in this pull."
                columns={[
                  { label: "Query", render: (row) => <span className="block truncate" title={row.query}>{row.query}</span> },
                  { label: "Clicks", numeric: true, render: (row) => formatCount(row.clicks) },
                  { label: "Impressions", numeric: true, hideOnPhone: true, render: (row) => formatCount(row.impressions) },
                  { label: "Position", numeric: true, render: (row) => formatPosition(row.position) },
                ]}
              />
            </Panel>
            <Panel
              title="Pages not indexed"
              subtitle={`${report.pagesNotIndexed.length} of ${report.pagesInspected} checked pages are not in Google's index.`}
            >
              {report.pagesNotIndexed.length === 0 ? (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5 text-status-success" aria-hidden="true" />
                  Every checked page is indexed.
                </p>
              ) : (
                <ul className="divide-y divide-border/60" aria-label="Pages not indexed">
                  {report.pagesNotIndexed.map((page) => (
                    <li key={page.url} className="min-w-0 py-2 text-xs">
                      <p className="truncate font-mono" title={page.url}>{page.url}</p>
                      <p className="text-muted-foreground">
                        {page.coverageState ?? page.verdict}
                        {page.lastCrawlTime ? ` · last crawled ${relativeTime(page.lastCrawlTime)}` : " · not crawled yet"}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </>
      )}
    </Section>
  );
}

/* ---- Pull status and Google connection ---- */

function PullStatusBar({ report }: { report: WebsiteReport }) {
  const { property, lastPull } = report;
  const status = lastPull ? PULL_STATUS[lastPull.status] : null;
  const pulledAt = lastPull?.finishedAt ?? lastPull?.startedAt ?? property.lastPullAt;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="website-pull-status">
      {status ? (
        <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 font-medium", status.className)}>
          {status.label}
        </span>
      ) : null}
      <span>
        Last pull:{" "}
        {pulledAt ? (
          <time dateTime={pulledAt} title={formatDateTime(pulledAt)} className="text-foreground">
            {relativeTime(pulledAt)}
          </time>
        ) : (
          <span className="text-foreground">never</span>
        )}
      </span>
      {property.nextPullDueAt ? <span>Next pull: {formatDateTime(property.nextPullDueAt)}</span> : null}
    </div>
  );
}

function PullErrors({ errors }: { errors: WebsitePullError[] }) {
  if (errors.length === 0) return null;
  return (
    <div role="alert" className="rounded-lg border border-status-danger/30 bg-status-danger-soft px-4 py-3">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-danger" aria-hidden="true" />
        <div className="min-w-0 space-y-1 text-sm">
          <p className="font-medium text-status-danger-foreground">The last pull had a problem</p>
          <ul className="space-y-0.5 text-status-danger-foreground">
            {errors.map((error, index) => (
              <li key={`${error.source}-${index}`} className="break-words">
                <span className="font-medium">{ERROR_SOURCE_LABELS[error.source] ?? error.source}:</span> {error.message}
              </li>
            ))}
          </ul>
          <p className="text-xs text-status-danger-foreground/80">Data below is from the last pull that worked.</p>
        </div>
      </div>
    </div>
  );
}

/** `?websiteGoogle=connected|error&reason=...`, set by the Google callback. */
function useGoogleReturnNotice() {
  const [searchParams, setSearchParams] = useSearchParams();
  const result = searchParams.get("websiteGoogle");
  const reason = searchParams.get("reason");
  const [notice] = useState(() => (result === "connected" || result === "error" ? { result, reason } : null));
  useEffect(() => {
    if (!result) return;
    const next = new URLSearchParams(searchParams);
    next.delete("websiteGoogle");
    next.delete("reason");
    setSearchParams(next, { replace: true });
  }, [result, searchParams, setSearchParams]);
  return notice;
}

function GoogleReturnNotice({ notice }: { notice: { result: string; reason: string | null } | null }) {
  if (!notice) return null;
  if (notice.result === "connected") {
    return (
      <div role="status" className="rounded-lg border border-status-success/30 bg-status-success-soft px-4 py-3 text-sm text-status-success-foreground">
        Google is connected. The first pull starts shortly.
      </div>
    );
  }
  return (
    <div role="alert" className="rounded-lg border border-status-danger/30 bg-status-danger-soft px-4 py-3 text-sm text-status-danger-foreground">
      Google sign-in did not finish{notice.reason ? ` (${notice.reason.replace(/_/g, " ")})` : ""}. Try again.
    </div>
  );
}

function ConnectGoogle({
  companyId,
  property,
  signInAvailable,
}: {
  companyId: string;
  property: WebsiteProperty;
  signInAvailable: boolean;
}) {
  const connect = useMutation({
    mutationFn: () => websiteApi.connectGoogle(companyId, property.id),
    onSuccess: ({ authorizationUrl }) => window.location.assign(authorizationUrl),
  });
  if (property.connectionStatus === "connected") return null;
  if (!signInAvailable) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Lock className="h-3.5 w-3.5" aria-hidden="true" />
        Google sign-in is not set up on this instance.
      </p>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <Button onClick={() => connect.mutate()} disabled={connect.isPending}>
        {property.connectionStatus === "needs_reconnect" ? "Reconnect Google" : "Connect Google"}
      </Button>
      {connect.isError ? (
        <p role="alert" className="max-w-xs text-xs text-status-danger">{errorStateMessage(connect.error)}</p>
      ) : null}
    </div>
  );
}

/* ---- Page ---- */

function NotEntitled() {
  return (
    <EmptyState
      icon={Lock}
      title="The Website view is switched off"
      message="This instance does not include the Website view. An instance admin can switch it on under Settings → Experimental."
    />
  );
}

function PropertyReport({ companyId, property, signInAvailable, notice }: {
  companyId: string;
  property: WebsiteProperty;
  signInAvailable: boolean;
  notice: { result: string; reason: string | null } | null;
}) {
  const reportQuery = useQuery({
    queryKey: queryKeys.website.report(companyId, property.id),
    queryFn: () => websiteApi.report(companyId, property.id),
  });

  const header = (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <h1 className="text-xl font-bold">Website</h1>
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{property.name}</span>{" "}
          <span className="break-all font-mono text-xs">{property.siteUrl}</span>
        </p>
        {reportQuery.data ? <PullStatusBar report={reportQuery.data} /> : null}
      </div>
      <ConnectGoogle companyId={companyId} property={property} signInAvailable={signInAvailable} />
    </header>
  );

  if (reportQuery.isLoading) {
    return <div className="w-full max-w-7xl space-y-6">{header}<PageSkeleton variant="dashboard" /></div>;
  }
  if (reportQuery.error) {
    if (isWebsiteNotEntitled(reportQuery.error)) return <NotEntitled />;
    return (
      <div className="w-full max-w-7xl space-y-6">
        {header}
        <ErrorState error={reportQuery.error} onRetry={() => reportQuery.refetch()} retrying={reportQuery.isFetching} />
      </div>
    );
  }

  const report = reportQuery.data!;
  const hasData = report.ga4 !== null || report.searchConsole !== null;
  const errors = report.lastPull?.errors ?? [];

  return (
    <div className="w-full max-w-7xl space-y-6">
      {header}
      <GoogleReturnNotice notice={notice} />
      {property.connectionStatus === "needs_reconnect" ? (
        <div role="alert" className="rounded-lg border border-status-warning/30 bg-status-warning/10 px-4 py-3 text-sm">
          Google access has expired. Reconnect Google so the daily pull can run again.
        </div>
      ) : null}
      <PullErrors errors={errors} />
      {hasData ? (
        <div className="space-y-10">
          <Ga4Section report={report.ga4} />
          <SearchConsoleSection report={report.searchConsole} />
          <p className="text-xs text-subtle-foreground">
            Read-only. <PulledAt at={report.ga4PulledAt ?? report.searchConsolePulledAt} />. The page shows the stored daily pull, not live Google data.
          </p>
        </div>
      ) : property.connectionStatus === "connected" ? (
        <EmptyState
          icon={Globe}
          title="Waiting for the first pull"
          message={
            property.nextPullDueAt
              ? `Google is connected. The first pull is due ${formatDateTime(property.nextPullDueAt)}; visitor and search data show here after it.`
              : "Google is connected. Visitor and search data show here after the first daily pull."
          }
        />
      ) : (
        <EmptyState
          icon={Globe}
          title="Connect Google to see your website data"
          message="Sign in with Google once. GSAM then pulls Google Analytics and Search Console every day, with read-only access."
        />
      )}
    </div>
  );
}

export function Website() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const notice = useGoogleReturnNotice();
  const [propertyId, setPropertyId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Website" }]);
  }, [setBreadcrumbs]);

  const settingsQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const switchedOn = settingsQuery.data?.enableWebsiteView === true;

  const overviewQuery = useQuery({
    queryKey: queryKeys.website.overview(selectedCompanyId ?? ""),
    queryFn: () => websiteApi.overview(selectedCompanyId!),
    enabled: !!selectedCompanyId && switchedOn,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Globe} message="Select an organization to view its website." />;
  }
  if (settingsQuery.isLoading) return <PageSkeleton variant="dashboard" />;
  if (!switchedOn || isWebsiteNotEntitled(overviewQuery.error)) return <NotEntitled />;
  if (overviewQuery.isLoading) return <PageSkeleton variant="dashboard" />;
  if (overviewQuery.error) {
    return <ErrorState error={overviewQuery.error} onRetry={() => overviewQuery.refetch()} retrying={overviewQuery.isFetching} />;
  }

  const { properties, googleSignInAvailable } = overviewQuery.data!;
  if (properties.length === 0) {
    return (
      <div className="w-full max-w-7xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-xl font-bold">Website</h1>
          <p className="text-sm text-muted-foreground">Visitors and search results for your website, from Google.</p>
        </header>
        <EmptyState
          icon={Search}
          title="No website is set up yet"
          message="Once your website is added to this company, its Google Analytics and Search Console reports show here."
        />
      </div>
    );
  }

  const selected = properties.find((property) => property.id === propertyId) ?? properties[0]!;
  return (
    <div className="space-y-4">
      {properties.length > 1 ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Website">
          {properties.map((property) => {
            const active = property.id === selected.id;
            return (
              <button
                key={property.id}
                type="button"
                aria-pressed={active}
                onClick={() => setPropertyId(property.id)}
                className={cn(
                  "inline-flex h-8 max-w-full items-center rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "border-foreground/20 bg-accent text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <span className="truncate">{property.name}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <PropertyReport
        key={selected.id}
        companyId={selectedCompanyId}
        property={selected}
        signInAvailable={googleSignInAvailable}
        notice={notice}
      />
    </div>
  );
}
