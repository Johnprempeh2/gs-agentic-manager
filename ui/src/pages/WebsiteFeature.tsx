import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Construction, FileText, ListChecks } from "lucide-react";
import {
  WEBSITE_FEATURE_ICONS,
  type UpdateWebsiteFeature,
  type WebsiteFeatureDetail,
  type WebsiteFeatureIcon,
  type WebsitePageStatus,
} from "@greatstone/shared";
import { websiteFeaturesApi } from "../api/website-features";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { Link, useParams, useSearchParams } from "@/lib/router";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Tabs } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { useCanPublishWebsite } from "../components/website/WebsiteSiteConnection";
import { When } from "../components/website/WebsiteHub";
import { activityActor, activityVerb } from "../components/website/WebsiteHome";
import { HealthDot, FeatureIcon, taskLine } from "../components/website/features/WebsiteFeatureCards";
import { parseCollections, parseLines } from "../components/website/features/feature-settings";
import { releaseDate, releaseTime } from "../components/website/WebsiteReleases";
import { WebsiteEnquiries } from "../components/website/WebsiteEnquiries";
import { ProjectTreeView } from "./ProjectTree";

// One website feature's page (GRE-2325): Overview (its pages, tasks and recent
// changes), Admin (the screens later phases move here) and Settings (owner,
// lead agent, project, routes, on/off).

type FeatureTab = "overview" | "admin" | "settings";
const FEATURE_TABS: { value: FeatureTab; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "admin", label: "Admin" },
  { value: "settings", label: "Settings" },
];

const PAGE_STATUS_COPY: Record<WebsitePageStatus, { label: string; tone: string }> = {
  planned: { label: "Planned", tone: "bg-status-neutral-soft text-status-neutral-foreground" },
  draft: { label: "Draft", tone: "bg-status-pending-soft text-status-pending-foreground" },
  review: { label: "In review", tone: "bg-status-review-soft text-status-review-foreground" },
  approved: { label: "Approved", tone: "bg-status-info-soft text-status-info-foreground" },
  published: { label: "Live", tone: "bg-status-success-soft text-status-success-foreground" },
};

function Section({ title, icon: Icon, children, testId }: { title: string; icon: typeof FileText; children: ReactNode; testId: string }) {
  return (
    <section className="min-w-0 space-y-3" data-testid={testId}>
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        {title}
      </h2>
      {children}
    </section>
  );
}

function Overview({ detail }: { detail: WebsiteFeatureDetail }) {
  const { feature } = detail;
  return (
    <div className="space-y-8">
      <div className="grid gap-8 lg:grid-cols-2">
        <Section title="Pages in this feature" icon={FileText} testId="website-feature-pages">
          {detail.pages.length === 0 ? (
            <p className="text-sm text-muted-foreground">No page of the site sits under this feature's routes yet.</p>
          ) : (
            <ul className="gs-glass-card divide-y divide-border rounded-xl border">
              {detail.pages.map((page) => (
                <li key={page.id} className="flex min-w-0 items-center gap-3 px-4 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{page.title}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">{page.slug}</span>
                  </span>
                  <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", PAGE_STATUS_COPY[page.status].tone)}>
                    {PAGE_STATUS_COPY[page.status].label}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Recent changes" icon={ListChecks} testId="website-feature-changes">
          {detail.recentChanges.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet. Saves, approvals and releases of this feature's pages show here.</p>
          ) : (
            <ol className="gs-glass-card divide-y divide-border rounded-xl border">
              {detail.recentChanges.map((event) => (
                <li key={event.id} className="flex min-w-0 items-baseline gap-3 px-4 py-2.5 text-sm">
                  <p className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{activityActor(event)}</span>{" "}
                    <span className="text-muted-foreground">{activityVerb(event.action)}</span>
                    {event.subject ? <> <span className="font-medium">{event.subject}</span></> : null}
                  </p>
                  <span className="shrink-0 text-xs text-muted-foreground"><When at={event.createdAt} /></span>
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>
      <Section title="Tasks" icon={ListChecks} testId="website-feature-tasks">
        {feature.projectId ? (
          <div className="flex min-h-96 flex-col">
            <ProjectTreeView projectRef={feature.projectId} embedded />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Link a project under Settings to see this feature's tasks here.</p>
        )}
      </Section>
    </div>
  );
}

function Admin({ companyId, detail, onOpenSettings }: { companyId: string; detail: WebsiteFeatureDetail; onOpenSettings: () => void }) {
  const screens = detail.feature.adminScreens;
  const [chosen, setChosen] = useState(screens[0]?.name ?? "");
  if (!detail.feature.enabled) {
    return (
      <EmptyState
        icon={Construction}
        title="This feature is off"
        message="Its screens are hidden. Its pages, entries and tasks are kept. Switch it on under Settings to see them."
        action="Open Settings"
        onAction={onOpenSettings}
        hideActionIcon
      />
    );
  }
  if (screens.length === 0) {
    return <EmptyState icon={Construction} title="No admin screens yet" message="Screens for this feature show here once a task builds them." />;
  }
  const screen = screens.find((entry) => entry.name === chosen) ?? screens[0]!;
  const enquiryScreen = screen.name === "Enquiries";
  return (
    <div className="space-y-4" data-testid="website-feature-admin">
      <Tabs value={screen.name} onValueChange={setChosen}>
        <PageTabBar items={screens.map((entry) => ({ value: entry.name, label: entry.name }))} value={screen.name} onValueChange={setChosen} align="start" ariaLabel="Admin screens" />
      </Tabs>
      {enquiryScreen ? <WebsiteEnquiries companyId={companyId} siteId={detail.feature.siteId} /> : <div className="gs-glass-card flex flex-col items-center gap-2 rounded-xl border px-6 py-10 text-center">
        <Construction className="size-5 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm font-medium">{screen.name} moves here</p>
        <p className="max-w-md text-xs text-muted-foreground">
          This screen still lives where it is today.{" "}
          {screen.issue ? (
            <>
              It moves into this feature in{" "}
              <Link to={`/issues/${screen.issue}`} className="whitespace-nowrap font-medium text-foreground underline underline-offset-2">{screen.issue}</Link>.
            </>
          ) : "It moves into this feature in a later task."}
        </p>
      </div>}
    </div>
  );
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

function Settings({ companyId, detail, canChange }: { companyId: string; detail: WebsiteFeatureDetail; canChange: boolean }) {
  const { feature } = detail;
  const queryClient = useQueryClient();
  const membersQuery = useQuery({
    queryKey: queryKeys.access.companyMembers(companyId),
    queryFn: () => accessApi.listMembers(companyId),
    enabled: canChange,
    retry: false,
  });
  const agentsQuery = useQuery({ queryKey: queryKeys.agents.list(companyId), queryFn: () => agentsApi.list(companyId) });
  const projectsQuery = useQuery({ queryKey: queryKeys.projects.list(companyId), queryFn: () => projectsApi.list(companyId) });

  const [name, setName] = useState(feature.name);
  const [purpose, setPurpose] = useState(feature.purpose);
  const [icon, setIcon] = useState<WebsiteFeatureIcon>(feature.icon);
  const [ownerUserId, setOwnerUserId] = useState(feature.ownerUserId ?? "");
  const [leadAgentId, setLeadAgentId] = useState(feature.leadAgentId ?? "");
  const [projectId, setProjectId] = useState(feature.projectId ?? "");
  const [routes, setRoutes] = useState(feature.routePrefixes.join("\n"));
  const [collections, setCollections] = useState(feature.collections.join(", "));
  const [enabled, setEnabled] = useState(feature.enabled);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: (patch: UpdateWebsiteFeature) => websiteFeaturesApi.update(companyId, feature.siteId, feature.id, patch),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: queryKeys.website.features(companyId, feature.siteId) });
    },
  });
  const submit = () => {
    setSaved(false);
    save.mutate({
      name: name.trim(),
      purpose: purpose.trim(),
      icon,
      ownerUserId: ownerUserId || null,
      leadAgentId: leadAgentId || null,
      projectId: projectId || null,
      routePrefixes: parseLines(routes),
      collections: parseCollections(collections),
      enabled,
    });
  };

  const people = (membersQuery.data?.members ?? []).filter((member) => member.status === "active" && member.user);
  const agents = (agentsQuery.data ?? []).filter((agent) => agent.status !== "terminated" || agent.id === feature.leadAgentId);
  const suggested = feature.suggestedOwner;
  const disabled = !canChange || save.isPending;

  return (
    <form
      className="max-w-2xl space-y-6"
      data-testid="website-feature-settings"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {canChange ? null : (
        <p className="rounded-lg border border-status-info/30 bg-status-info/10 px-4 py-3 text-sm">
          You can see these settings. A person with Publish rights on the website changes them.
        </p>
      )}
      <div className="flex items-start justify-between gap-4 rounded-xl border border-border p-4">
        <div className="min-w-0 space-y-1">
          <p id="feature-enabled-label" className="text-sm font-medium">Feature is {enabled ? "on" : "off"}</p>
          <p className="text-xs text-muted-foreground">Off hides this feature's screens. It never deletes its pages, entries or tasks.</p>
        </div>
        <ToggleSwitch checked={enabled} onCheckedChange={setEnabled} disabled={disabled} aria-labelledby="feature-enabled-label" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="feature-name" label="Name">
          <Input id="feature-name" value={name} onChange={(event) => setName(event.target.value)} disabled={disabled} required maxLength={80} />
        </Field>
        <Field id="feature-icon" label="Icon">
          <NativeSelect id="feature-icon" value={icon} onChange={(event) => setIcon(event.target.value as WebsiteFeatureIcon)} disabled={disabled}>
            {WEBSITE_FEATURE_ICONS.map((entry) => <option key={entry} value={entry}>{entry.replace(/-/g, " ")}</option>)}
          </NativeSelect>
        </Field>
      </div>
      <Field id="feature-purpose" label="Purpose" help="One or two sentences: what this part of the site is for.">
        <Textarea id="feature-purpose" value={purpose} onChange={(event) => setPurpose(event.target.value)} disabled={disabled} maxLength={280} rows={2} aria-describedby="feature-purpose-help" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="feature-owner" label="Owner (optional)" help={suggested && !feature.ownerUserId ? `Suggested owner: ${suggested}.` : "The person who answers for this feature."}>
          <NativeSelect id="feature-owner" value={ownerUserId} onChange={(event) => setOwnerUserId(event.target.value)} disabled={disabled} aria-describedby="feature-owner-help">
            <option value="">No owner</option>
            {feature.ownerUserId && !people.some((member) => member.principalId === feature.ownerUserId) ? (
              <option value={feature.ownerUserId}>{detail.ownerName ?? "Current owner"}</option>
            ) : null}
            {people.map((member) => (
              <option key={member.principalId} value={member.principalId}>{member.user?.name ?? member.user?.email ?? member.principalId}</option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="feature-lead" label="Lead agent (optional)">
          <NativeSelect id="feature-lead" value={leadAgentId} onChange={(event) => setLeadAgentId(event.target.value)} disabled={disabled}>
            <option value="">No lead agent</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </NativeSelect>
        </Field>
      </div>
      <Field id="feature-project" label="Project (optional)" help="Its tasks show on the Overview and count on the feature's card.">
        <NativeSelect id="feature-project" value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={disabled} aria-describedby="feature-project-help">
          <option value="">No project</option>
          {(projectsQuery.data ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </NativeSelect>
      </Field>
      <Field id="feature-routes" label="Routes" help="One path per line, like /dev-tools or /portal/:client/deep-dive. A page belongs to the feature with the longest matching route.">
        <Textarea id="feature-routes" value={routes} onChange={(event) => setRoutes(event.target.value)} disabled={disabled} rows={5} className="font-mono text-xs" aria-describedby="feature-routes-help" />
      </Field>
      <Field id="feature-collections" label="Collections" help="Collection keys, separated by commas, like product, vendor.">
        <Input id="feature-collections" value={collections} onChange={(event) => setCollections(event.target.value)} disabled={disabled} className="font-mono text-xs" aria-describedby="feature-collections-help" />
      </Field>
      {save.error ? <ErrorState error={save.error} compact /> : null}
      <div className="flex items-center justify-end gap-3">
        {saved && !save.isPending ? <p className="text-sm text-muted-foreground" role="status">Saved</p> : null}
        <Button type="submit" disabled={disabled || !name.trim()}>{save.isPending ? "Saving" : "Save settings"}</Button>
      </div>
    </form>
  );
}

export function WebsiteFeaturePage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { siteId = "", featureId = "" } = useParams<{ siteId: string; featureId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tab");
  const tab: FeatureTab = FEATURE_TABS.some((entry) => entry.value === requested) ? (requested as FeatureTab) : "overview";
  const companyId = selectedCompanyId ?? "";
  const { canPublish } = useCanPublishWebsite(companyId, siteId, !!companyId && !!siteId);

  const detailQuery = useQuery({
    queryKey: queryKeys.website.feature(companyId, siteId, featureId),
    queryFn: () => websiteFeaturesApi.detail(companyId, siteId, featureId),
    enabled: !!companyId && !!siteId && !!featureId,
  });
  const detail = detailQuery.data;

  useEffect(() => {
    setBreadcrumbs([{ label: "Website", href: "/website" }, { label: detail?.feature.name ?? "Feature" }]);
  }, [setBreadcrumbs, detail?.feature.name]);

  const openTab = (next: FeatureTab) => {
    const params = new URLSearchParams(searchParams);
    if (next === "overview") params.delete("tab");
    else params.set("tab", next);
    setSearchParams(params, { replace: true });
  };

  if (!selectedCompanyId) return <EmptyState icon={FileText} message="Choose an organisation to view its website." />;
  if (detailQuery.isLoading) return <PageSkeleton variant="dashboard" />;
  if (detailQuery.error || !detail) {
    return <ErrorState error={detailQuery.error ?? new Error("This feature was not found.")} onRetry={() => detailQuery.refetch()} retrying={detailQuery.isFetching} />;
  }

  const { feature } = detail;
  const tasks = taskLine(detail);
  const people = [detail.ownerName ? `Owner: ${detail.ownerName}` : null, detail.leadAgentName ? `Lead agent: ${detail.leadAgentName}` : null].filter(Boolean);

  return (
    <div className="w-full max-w-7xl space-y-6" data-testid="website-feature-page">
      <Link to="/website" className="inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Website Home
      </Link>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
            <FeatureIcon icon={feature.icon} className="size-5 text-foreground" />
          </span>
          <div className="min-w-0 space-y-1">
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-bold">
              {feature.name}
              {feature.enabled ? null : (
                <span className="rounded-full bg-status-neutral-soft px-2 py-0.5 text-xs font-medium text-status-neutral-foreground">Off</span>
              )}
            </h1>
            {feature.purpose ? <p className="max-w-2xl text-sm text-muted-foreground">{feature.purpose}</p> : null}
            {people.length ? <p className="text-xs text-muted-foreground">{people.join(" · ")}</p> : null}
          </div>
        </div>
        <dl className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-2 text-xs sm:text-right">
          <div>
            <dt className="text-muted-foreground">Health</dt>
            <dd className="mt-0.5 flex sm:justify-end"><HealthDot health={detail.health} showLabel /></dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Tasks</dt>
            <dd className={cn("mt-0.5 font-medium", tasks.needsPerson > 0 && "text-status-warning-foreground")}>{tasks.text}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Last release</dt>
            <dd className="mt-0.5 font-medium">
              {detail.lastRelease ? (
                <>Release {detail.lastRelease.number}, <time dateTime={detail.lastRelease.at} title={releaseDate(detail.lastRelease.at)}>{releaseTime(detail.lastRelease.at)}</time></>
              ) : "None yet"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Pages</dt>
            <dd className="mt-0.5 font-medium tabular-nums">{detail.pageCount}</dd>
          </div>
        </dl>
      </header>
      <p className="sr-only">{detail.health.reason}</p>
      <div>
        <Tabs value={tab} onValueChange={(value) => openTab(value as FeatureTab)} className="mb-4">
          <PageTabBar items={FEATURE_TABS} value={tab} onValueChange={(value) => openTab(value as FeatureTab)} align="start" ariaLabel="Feature section" />
        </Tabs>
        {tab === "overview" ? <Overview detail={detail} /> : null}
        {tab === "admin" ? <Admin companyId={companyId} detail={detail} onOpenSettings={() => openTab("settings")} /> : null}
        {tab === "settings" ? <Settings key={feature.id} companyId={companyId} detail={detail} canChange={canPublish} /> : null}
      </div>
    </div>
  );
}

export default WebsiteFeaturePage;
