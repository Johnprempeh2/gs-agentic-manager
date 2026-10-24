import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Construction, FileText, ListChecks } from "lucide-react";
import {
  GREATSTONE_STARTING_MODULES,
  WEBSITE_MODULE_ADMIN_SCREENS,
  WEBSITE_MODULE_ICONS,
  type UpdateWebsiteModule,
  type WebsiteModuleDetail,
  type WebsiteModuleIcon,
  type WebsitePageStatus,
} from "@greatstone/shared";
import { websiteModulesApi } from "../api/website-modules";
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
import { HealthDot, ModuleIcon, taskLine } from "../components/website/modules/WebsiteModuleCards";
import { parseCollections, parseLines } from "../components/website/modules/module-settings";
import { releaseDate, releaseTime } from "../components/website/WebsiteReleases";
import { WebsiteEnquiries } from "../components/website/WebsiteEnquiries";
import { ProjectTreeView } from "./ProjectTree";

// One website module's page (GRE-2325): Overview (its pages, tasks and recent
// changes), Admin (the screens later phases move here) and Settings (owner,
// lead agent, project, routes, on/off).

type ModuleTab = "overview" | "admin" | "settings";
const MODULE_TABS: { value: ModuleTab; label: string }[] = [
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

function Overview({ detail }: { detail: WebsiteModuleDetail }) {
  const { module } = detail;
  return (
    <div className="space-y-8">
      <div className="grid gap-8 lg:grid-cols-2">
        <Section title="Pages in this module" icon={FileText} testId="website-module-pages">
          {detail.pages.length === 0 ? (
            <p className="text-sm text-muted-foreground">No page of the site sits under this module's routes yet.</p>
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
        <Section title="Recent changes" icon={ListChecks} testId="website-module-changes">
          {detail.recentChanges.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet. Saves, approvals and releases of this module's pages show here.</p>
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
      <Section title="Tasks" icon={ListChecks} testId="website-module-tasks">
        {module.projectId ? (
          <div className="flex min-h-96 flex-col">
            <ProjectTreeView projectRef={module.projectId} embedded />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Link a project under Settings to see this module's tasks here.</p>
        )}
      </Section>
    </div>
  );
}

function Admin({ companyId, detail, onOpenSettings }: { companyId: string; detail: WebsiteModuleDetail; onOpenSettings: () => void }) {
  const screens = WEBSITE_MODULE_ADMIN_SCREENS[detail.module.key] ?? [];
  const [chosen, setChosen] = useState(screens[0]?.name ?? "");
  if (!detail.module.enabled) {
    return (
      <EmptyState
        icon={Construction}
        title="This module is off"
        message="Its screens are hidden. Its pages, entries and tasks are kept. Switch it on under Settings to see them."
        action="Open Settings"
        onAction={onOpenSettings}
        hideActionIcon
      />
    );
  }
  if (screens.length === 0) {
    return <EmptyState icon={Construction} title="No admin screens yet" message="Screens for this module show here once a task builds them." />;
  }
  const screen = screens.find((entry) => entry.name === chosen) ?? screens[0]!;
  const enquiryScreen = detail.module.key === "front-door" && screen.name === "Enquiries";
  return (
    <div className="space-y-4" data-testid="website-module-admin">
      <Tabs value={screen.name} onValueChange={setChosen}>
        <PageTabBar items={screens.map((entry) => ({ value: entry.name, label: entry.name }))} value={screen.name} onValueChange={setChosen} align="start" ariaLabel="Admin screens" />
      </Tabs>
      {enquiryScreen ? <WebsiteEnquiries companyId={companyId} siteId={detail.module.siteId} /> : <div className="gs-glass-card flex flex-col items-center gap-2 rounded-xl border px-6 py-10 text-center">
        <Construction className="size-5 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm font-medium">{screen.name} moves here</p>
        <p className="max-w-md text-xs text-muted-foreground">
          This screen still lives where it is today. It moves into this module in{" "}
          <Link to={`/issues/${screen.issue}`} className="whitespace-nowrap font-medium text-foreground underline underline-offset-2">{screen.issue}</Link>.
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

function Settings({ companyId, detail, canChange }: { companyId: string; detail: WebsiteModuleDetail; canChange: boolean }) {
  const { module } = detail;
  const queryClient = useQueryClient();
  const membersQuery = useQuery({
    queryKey: queryKeys.access.companyMembers(companyId),
    queryFn: () => accessApi.listMembers(companyId),
    enabled: canChange,
    retry: false,
  });
  const agentsQuery = useQuery({ queryKey: queryKeys.agents.list(companyId), queryFn: () => agentsApi.list(companyId) });
  const projectsQuery = useQuery({ queryKey: queryKeys.projects.list(companyId), queryFn: () => projectsApi.list(companyId) });

  const [name, setName] = useState(module.name);
  const [purpose, setPurpose] = useState(module.purpose);
  const [icon, setIcon] = useState<WebsiteModuleIcon>(module.icon);
  const [ownerUserId, setOwnerUserId] = useState(module.ownerUserId ?? "");
  const [leadAgentId, setLeadAgentId] = useState(module.leadAgentId ?? "");
  const [projectId, setProjectId] = useState(module.projectId ?? "");
  const [routes, setRoutes] = useState(module.routePrefixes.join("\n"));
  const [collections, setCollections] = useState(module.collections.join(", "));
  const [enabled, setEnabled] = useState(module.enabled);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: (patch: UpdateWebsiteModule) => websiteModulesApi.update(companyId, module.siteId, module.id, patch),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: queryKeys.website.modules(companyId, module.siteId) });
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
  const agents = (agentsQuery.data ?? []).filter((agent) => agent.status !== "terminated" || agent.id === module.leadAgentId);
  const suggested = GREATSTONE_STARTING_MODULES.find((entry) => entry.key === module.key)?.suggestedOwner;
  const disabled = !canChange || save.isPending;

  return (
    <form
      className="max-w-2xl space-y-6"
      data-testid="website-module-settings"
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
          <p id="module-enabled-label" className="text-sm font-medium">Module is {enabled ? "on" : "off"}</p>
          <p className="text-xs text-muted-foreground">Off hides this module's screens. It never deletes its pages, entries or tasks.</p>
        </div>
        <ToggleSwitch checked={enabled} onCheckedChange={setEnabled} disabled={disabled} aria-labelledby="module-enabled-label" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="module-name" label="Name">
          <Input id="module-name" value={name} onChange={(event) => setName(event.target.value)} disabled={disabled} required maxLength={80} />
        </Field>
        <Field id="module-icon" label="Icon">
          <NativeSelect id="module-icon" value={icon} onChange={(event) => setIcon(event.target.value as WebsiteModuleIcon)} disabled={disabled}>
            {WEBSITE_MODULE_ICONS.map((entry) => <option key={entry} value={entry}>{entry.replace(/-/g, " ")}</option>)}
          </NativeSelect>
        </Field>
      </div>
      <Field id="module-purpose" label="Purpose" help="One or two sentences: what this part of the site is for.">
        <Textarea id="module-purpose" value={purpose} onChange={(event) => setPurpose(event.target.value)} disabled={disabled} maxLength={280} rows={2} aria-describedby="module-purpose-help" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="module-owner" label="Owner (optional)" help={suggested && !module.ownerUserId ? `Suggested owner: ${suggested}.` : "The person who answers for this module."}>
          <NativeSelect id="module-owner" value={ownerUserId} onChange={(event) => setOwnerUserId(event.target.value)} disabled={disabled} aria-describedby="module-owner-help">
            <option value="">No owner</option>
            {module.ownerUserId && !people.some((member) => member.principalId === module.ownerUserId) ? (
              <option value={module.ownerUserId}>{detail.ownerName ?? "Current owner"}</option>
            ) : null}
            {people.map((member) => (
              <option key={member.principalId} value={member.principalId}>{member.user?.name ?? member.user?.email ?? member.principalId}</option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="module-lead" label="Lead agent (optional)">
          <NativeSelect id="module-lead" value={leadAgentId} onChange={(event) => setLeadAgentId(event.target.value)} disabled={disabled}>
            <option value="">No lead agent</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </NativeSelect>
        </Field>
      </div>
      <Field id="module-project" label="Project (optional)" help="Its tasks show on the Overview and count on the module's card.">
        <NativeSelect id="module-project" value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={disabled} aria-describedby="module-project-help">
          <option value="">No project</option>
          {(projectsQuery.data ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </NativeSelect>
      </Field>
      <Field id="module-routes" label="Routes" help="One path per line, like /dev-tools or /portal/:client/deep-dive. A page belongs to the module with the longest matching route.">
        <Textarea id="module-routes" value={routes} onChange={(event) => setRoutes(event.target.value)} disabled={disabled} rows={5} className="font-mono text-xs" aria-describedby="module-routes-help" />
      </Field>
      <Field id="module-collections" label="Collections" help="Collection keys, separated by commas, like product, vendor.">
        <Input id="module-collections" value={collections} onChange={(event) => setCollections(event.target.value)} disabled={disabled} className="font-mono text-xs" aria-describedby="module-collections-help" />
      </Field>
      {save.error ? <ErrorState error={save.error} compact /> : null}
      <div className="flex items-center justify-end gap-3">
        {saved && !save.isPending ? <p className="text-sm text-muted-foreground" role="status">Saved</p> : null}
        <Button type="submit" disabled={disabled || !name.trim()}>{save.isPending ? "Saving" : "Save settings"}</Button>
      </div>
    </form>
  );
}

export function WebsiteModulePage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { siteId = "", moduleId = "" } = useParams<{ siteId: string; moduleId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tab");
  const tab: ModuleTab = MODULE_TABS.some((entry) => entry.value === requested) ? (requested as ModuleTab) : "overview";
  const companyId = selectedCompanyId ?? "";
  const { canPublish } = useCanPublishWebsite(companyId, siteId, !!companyId && !!siteId);

  const detailQuery = useQuery({
    queryKey: queryKeys.website.module(companyId, siteId, moduleId),
    queryFn: () => websiteModulesApi.detail(companyId, siteId, moduleId),
    enabled: !!companyId && !!siteId && !!moduleId,
  });
  const detail = detailQuery.data;

  useEffect(() => {
    setBreadcrumbs([{ label: "Website", href: "/website" }, { label: detail?.module.name ?? "Module" }]);
  }, [setBreadcrumbs, detail?.module.name]);

  const openTab = (next: ModuleTab) => {
    const params = new URLSearchParams(searchParams);
    if (next === "overview") params.delete("tab");
    else params.set("tab", next);
    setSearchParams(params, { replace: true });
  };

  if (!selectedCompanyId) return <EmptyState icon={FileText} message="Choose an organisation to view its website." />;
  if (detailQuery.isLoading) return <PageSkeleton variant="dashboard" />;
  if (detailQuery.error || !detail) {
    return <ErrorState error={detailQuery.error ?? new Error("This module was not found.")} onRetry={() => detailQuery.refetch()} retrying={detailQuery.isFetching} />;
  }

  const { module } = detail;
  const tasks = taskLine(detail);
  const people = [detail.ownerName ? `Owner: ${detail.ownerName}` : null, detail.leadAgentName ? `Lead agent: ${detail.leadAgentName}` : null].filter(Boolean);

  return (
    <div className="w-full max-w-7xl space-y-6" data-testid="website-module-page">
      <Link to="/website" className="inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Website Home
      </Link>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
            <ModuleIcon icon={module.icon} className="size-5 text-foreground" />
          </span>
          <div className="min-w-0 space-y-1">
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-bold">
              {module.name}
              {module.enabled ? null : (
                <span className="rounded-full bg-status-neutral-soft px-2 py-0.5 text-xs font-medium text-status-neutral-foreground">Off</span>
              )}
            </h1>
            {module.purpose ? <p className="max-w-2xl text-sm text-muted-foreground">{module.purpose}</p> : null}
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
        <Tabs value={tab} onValueChange={(value) => openTab(value as ModuleTab)} className="mb-4">
          <PageTabBar items={MODULE_TABS} value={tab} onValueChange={(value) => openTab(value as ModuleTab)} align="start" ariaLabel="Module section" />
        </Tabs>
        {tab === "overview" ? <Overview detail={detail} /> : null}
        {tab === "admin" ? <Admin companyId={companyId} detail={detail} onOpenSettings={() => openTab("settings")} /> : null}
        {tab === "settings" ? <Settings key={module.id} companyId={companyId} detail={detail} canChange={canPublish} /> : null}
      </div>
    </div>
  );
}

export default WebsiteModulePage;
