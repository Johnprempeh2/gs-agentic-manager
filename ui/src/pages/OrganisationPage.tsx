import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, History, Mail, Pencil, Phone, Sparkles, Star } from "lucide-react";
import {
  ORGANISATION_STATUS_LABELS,
  type CrmRecordField,
  type OrganisationContact,
  type OrganisationDetail,
  type OrganisationHistory,
  type OrganisationHistoryCase,
  type OrganisationHistoryStageChange,
} from "@greatstone/shared";
import { organisationsApi } from "@/api/organisations";
import { EmptyState } from "@/components/EmptyState";
import { OrganisationCrmInfo } from "@/components/OrganisationCrmFields";
import {
  ActivityPanel,
  BillingPanel,
  ClientViewPanel,
  CommercePanel,
  DeepDivePanel,
  DeliverablesPanel,
  DiscoveryPanel,
  DocumentsPanel,
  EngagementSummary,
  InterviewsPanel,
  useClientShared,
  useEngagementCase,
} from "@/components/OrganisationHub";
import { PageTabBar } from "@/components/PageTabBar";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { Tabs } from "@/components/ui/tabs";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { organisationAskContext } from "@/lib/ask-everest";
import { openAskEverest } from "@/lib/ask-everest-events";
import { ORGANISATION_HUB_TABS, engagementCaseId, organisationHubTab, type OrganisationHubTab } from "@/lib/organisation-hub";
import { Link, useParams, useSearchParams } from "@/lib/router";
import { formatDate, formatDateTime } from "@/lib/utils";
import { ORGANISATION_STATUS_BADGE, OrganisationDialogContent } from "./Organisations";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

function stageChangeText(change: OrganisationHistoryStageChange) {
  const move = `${change.fromStageName ?? "Unknown stage"} → ${change.toStageName ?? "Unknown stage"}`;
  const who = change.actorType === "agent"
    ? change.actorAgentName ?? "an agent"
    : change.actorType === "user" ? "a person" : "the system";
  return `${move}${change.forced ? " (moved by force)" : ""} by ${who}`;
}

/**
 * Company page for one organisation (GRE-1480), and the per-client hub
 * (GRE-2614): one tab for each thing collected from or delivered to the
 * client, each read from and linked to the record that owns it.
 */
export function OrganisationPage() {
  const { organisationId = "" } = useParams<{ organisationId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();
  const [editing, setEditing] = useState(false);
  const companyId = selectedCompanyId ?? "";
  const tab = organisationHubTab(searchParams.get("tab"));

  const detail = useQuery({
    queryKey: queryKeys.organisations.detail(companyId, organisationId),
    queryFn: () => organisationsApi.get(companyId, organisationId),
    enabled: Boolean(selectedCompanyId && organisationId),
  });
  const history = useQuery({
    queryKey: queryKeys.organisations.history(companyId, organisationId),
    queryFn: () => organisationsApi.history(companyId, organisationId),
    enabled: Boolean(selectedCompanyId && organisationId),
  });
  const cases = history.data?.cases ?? [];
  const caseIds = cases.map((item) => item.id);
  const caseId = engagementCaseId(cases, searchParams.get("case"));
  const engagement = useEngagementCase(caseId);
  const { shared } = useClientShared(companyId, engagement.isClient ? caseId : null);

  const name = detail.data?.name;
  useEffect(() => {
    setBreadcrumbs([{ label: "Organisations", href: "/organisations" }, { label: name ?? "Organisation" }]);
  }, [setBreadcrumbs, name]);

  const setParam = (key: "tab" | "case", value: string | null) => {
    const params = new URLSearchParams(searchParams);
    if (value) params.set(key, value);
    else params.delete(key);
    setSearchParams(params, { replace: true });
  };
  const openTab = (next: OrganisationHubTab) => setParam("tab", next === "overview" ? null : next);

  if (detail.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading organisation…</p>;
  }
  if (detail.error || !detail.data) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-destructive" role="alert">
          Could not load this organisation. {detail.error ? errorText(detail.error) : "It may have been removed."}
        </p>
        <Link to="/organisations" className="text-sm font-medium hover:underline">Back to Organisations</Link>
      </div>
    );
  }

  const organisation = detail.data;
  const contacts = organisation.contacts.filter((contact) => !contact.archivedAt);
  const clientCaseId = engagement.isClient ? caseId : null;

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Building2 className="h-5 w-5 text-muted-foreground" />
            <h1 className="min-w-0 break-words text-lg font-semibold">{organisation.name}</h1>
            <Badge variant={ORGANISATION_STATUS_BADGE[organisation.status]}>
              {ORGANISATION_STATUS_LABELS[organisation.status]}
            </Badge>
            {organisation.archivedAt ? <Badge variant="outline">Archived</Badge> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            data-testid="organisation-ask"
            onClick={() => openAskEverest("", organisationAskContext({
              name: organisation.name,
              industry: organisation.industry,
              country: organisation.country,
              statusLabel: ORGANISATION_STATUS_LABELS[organisation.status],
              contacts,
              deals: history.data?.cases ?? [],
              history: history.data?.timeline ?? [],
            }))}
          >
            <Sparkles />
            Ask Everest
          </Button>
          <Button variant="outline" onClick={() => setEditing(true)}>
            <Pencil />
            Edit
          </Button>
        </div>
      </div>

      {cases.length > 1 && caseId ? (
        <label className="flex max-w-md flex-col gap-1 text-xs font-medium text-muted-foreground">
          Engagement shown
          <NativeSelect
            aria-label="Engagement shown"
            value={caseId}
            onChange={(event) => setParam("case", event.target.value)}
            className="h-9 text-sm text-foreground"
          >
            {cases.map((item) => (
              <option key={item.id} value={item.id}>{item.title} · {item.pipelineName} · {item.stageName}</option>
            ))}
          </NativeSelect>
        </label>
      ) : null}

      <div>
        <Tabs value={tab} onValueChange={(value) => openTab(value as OrganisationHubTab)} className="mb-4">
          <PageTabBar items={ORGANISATION_HUB_TABS} value={tab} onValueChange={(value) => openTab(value as OrganisationHubTab)} align="start" ariaLabel="Client section" />
        </Tabs>
        <div className="flex flex-col gap-6" data-testid={`organisation-tab-${tab}`}>
          {tab === "overview" ? (
            <>
              {engagement.detail ? (
                <EngagementSummary companyId={companyId} caseIds={caseIds} detail={engagement.detail} isClient={engagement.isClient} />
              ) : null}
              <OverviewDetails organisation={organisation} companyId={companyId} contacts={contacts} history={history} />
            </>
          ) : null}
          {tab === "discovery" ? <DiscoveryPanel detail={engagement.detail} history={history.data} /> : null}
          {tab === "interviews" ? <InterviewsPanel /> : null}
          {tab === "deep-dive" ? <DeepDivePanel companyId={companyId} caseIds={caseIds} shared={shared} /> : null}
          {tab === "documents" ? (
            <DocumentsPanel caseId={clientCaseId} organisationId={organisation.id} history={history.data} shared={shared} />
          ) : null}
          {tab === "deliverables" ? <DeliverablesPanel caseId={clientCaseId} companyId={companyId} /> : null}
          {tab === "commerce" ? <CommercePanel companyId={companyId} organisation={organisation} /> : null}
          {tab === "billing" ? <BillingPanel /> : null}
          {tab === "activity" ? <ActivityPanel detail={engagement.detail} history={history.data} /> : null}
          {tab === "client-view" ? <ClientViewPanel companyId={companyId} caseId={clientCaseId} /> : null}
        </div>
      </div>

      <Dialog open={editing} onOpenChange={setEditing}>
        {editing && selectedCompanyId ? (
          <OrganisationDialogContent
            companyId={selectedCompanyId}
            organisation={organisation}
            onDone={() => setEditing(false)}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

/** Company info, contacts and the engagement history: the Overview tab below the engagement. */
function OverviewDetails({
  organisation,
  companyId,
  contacts,
  history,
}: {
  organisation: OrganisationDetail;
  companyId: string;
  contacts: OrganisationContact[];
  history: { data?: OrganisationHistory; isLoading: boolean; error: unknown };
}) {
  const info: Array<[string, ReactNode]> = [
    ["Country owner", organisation.countryOwner ?? "Not set"],
    ["Country", organisation.country ?? "Not set"],
    ["Industry", organisation.industry ?? "Not set"],
    [
      "Website",
      organisation.website ? (
        <a
          href={/^https?:\/\//i.test(organisation.website) ? organisation.website : `https://${organisation.website}`}
          target="_blank"
          rel="noreferrer"
          className="break-all hover:underline"
        >
          {organisation.website}
        </a>
      ) : "Not set",
    ],
    [
      "Last contact",
      history.isLoading ? "Loading…" : history.data?.lastContactAt ? formatDate(history.data.lastContactAt) : "No contact yet",
    ],
  ];

  return (
    <>
      <section aria-label="Company info" className="rounded-lg border border-border p-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {info.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-0.5">{value}</dd>
            </div>
          ))}
        </dl>
        <OrganisationCrmInfo companyId={companyId} organisation={organisation} />
        {organisation.notes ? (
          <p className="mt-3 whitespace-pre-wrap border-t border-border pt-3 text-sm">{organisation.notes}</p>
        ) : null}
        {organisation.crmFields?.length ? (
          <div className="mt-3 border-t border-border pt-3">
            <h2 className="mb-2 text-xs font-medium text-muted-foreground">{importedFieldsHeading(organisation.source)}</h2>
            <CrmFieldList fields={organisation.crmFields} />
          </div>
        ) : null}
      </section>

      <section aria-label="Contacts" className="space-y-2">
        <h2 className="text-sm font-semibold">Contacts</h2>
        {contacts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No contacts yet. Use Edit to add one.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {contacts.map((contact) => <ContactRow key={contact.id} contact={contact} />)}
          </ul>
        )}
      </section>

      <section aria-label="Engagement history" className="space-y-2">
        <h2 className="text-sm font-semibold">Engagement history</h2>
        {history.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading history…</p>
        ) : history.error ? (
          <p className="text-sm text-destructive" role="alert">Could not load the history. {errorText(history.error)}</p>
        ) : !history.data || history.data.cases.length === 0 ? (
          <EmptyState
            icon={History}
            message="No pipeline items for this organisation yet."
            description="Items you add on a pipeline for this organisation show here with their stage changes, projects and tasks."
          />
        ) : (
          <ul className="space-y-3">
            {history.data.cases.map((item) => <HistoryCase key={item.id} item={item} />)}
          </ul>
        )}
      </section>
    </>
  );
}

function importedFieldsHeading(source: string) {
  return source === "pipedrive" ? "From Pipedrive" : source === "hubspot" ? "From HubSpot" : "More details";
}

function crmFieldText(value: CrmRecordField["value"]) {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/** Fields imported from a CRM under the CRM's own names, in the CRM's order. */
export function CrmFieldList({ fields }: { fields: CrmRecordField[] }) {
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
      {fields.map((field) => (
        <div key={field.key} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{field.label}</dt>
          <dd className="mt-0.5 whitespace-pre-wrap break-words">{crmFieldText(field.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function ContactRow({ contact }: { contact: OrganisationContact }) {
  return (
    <li className="px-3 py-2 text-sm">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-w-0 items-center gap-1.5 sm:w-1/3">
          {contact.isKeyContact ? <Star className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Key contact" /> : null}
          <span className="truncate font-medium">{contact.name}</span>
          {contact.role ? <span className="truncate text-muted-foreground">({contact.role})</span> : null}
        </div>
        <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
          {contact.email ? (
            <a href={`mailto:${contact.email}`} className="flex min-w-0 items-center gap-1 hover:text-foreground">
              <Mail className="h-3.5 w-3.5 shrink-0" />
              <span className="break-all">{contact.email}</span>
            </a>
          ) : null}
          {contact.phone ? (
            <a href={`tel:${contact.phone}`} className="flex items-center gap-1 hover:text-foreground">
              <Phone className="h-3.5 w-3.5 shrink-0" />
              {contact.phone}
            </a>
          ) : null}
          {!contact.email && !contact.phone ? <span>No contact details</span> : null}
        </div>
      </div>
      {contact.crmFields?.length ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            {importedFieldsHeading(contact.source)} ({contact.crmFields.length})
          </summary>
          <div className="mt-2">
            <CrmFieldList fields={contact.crmFields} />
          </div>
        </details>
      ) : null}
    </li>
  );
}

const NDA_LABEL: Record<NonNullable<OrganisationHistoryCase["ndaStatus"]>, string> = {
  required: "required",
  accepted: "accepted",
  suspended: "suspended",
};
const ENGAGEMENT_LABEL: Record<NonNullable<OrganisationHistoryCase["engagementStatus"]>, string> = {
  not_sent: "not sent",
  sent: "sent",
  accepted: "accepted",
};

function HistoryCase({ item }: { item: OrganisationHistoryCase }) {
  const status = item.terminalKind === "done" ? "Done" : item.terminalKind === "cancelled" ? "Cancelled" : "Open";
  return (
    <li className="rounded-lg border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to={`/pipelines/${item.pipelineId}/items/${item.id}`} className="min-w-0 break-words font-medium hover:underline">
          {item.title}
        </Link>
        <Badge variant="outline">{status}</Badge>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {item.pipelineName} · Stage: {item.stageName} · Added {formatDate(item.createdAt)}
      </p>
      {item.ndaStatus || item.engagementStatus ? (
        <p className="mt-0.5 text-xs text-muted-foreground" data-testid="organisation-case-agreements">
          {item.ndaStatus ? `NDA: ${NDA_LABEL[item.ndaStatus]}` : null}
          {item.ndaStatus && item.engagementStatus ? " · " : null}
          {item.engagementStatus ? `Engagement pack: ${ENGAGEMENT_LABEL[item.engagementStatus]}` : null}
        </p>
      ) : null}

      {item.people?.length ? (
        <p className="mt-0.5 text-xs text-muted-foreground" data-testid="organisation-case-people">
          People: {item.people.map((person) => (person.role ? `${person.name} (${person.role})` : person.name)).join(", ")}
        </p>
      ) : null}
      {item.details?.length ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Details ({item.details.length})
          </summary>
          <div className="mt-2">
            <CrmFieldList fields={item.details} />
          </div>
        </details>
      ) : null}

      {item.stageChanges.length > 0 ? (
        <div className="mt-2">
          <h3 className="text-xs font-medium text-muted-foreground">Stage changes</h3>
          <ol className="mt-1 space-y-0.5">
            {item.stageChanges.map((change) => (
              <li key={change.id} className="flex flex-col sm:flex-row sm:gap-2">
                <span className="shrink-0 text-xs text-muted-foreground sm:w-40">{formatDateTime(change.at)}</span>
                <span>{stageChangeText(change)}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {item.projects.length > 0 ? (
        <div className="mt-2">
          <h3 className="text-xs font-medium text-muted-foreground">Projects</h3>
          <ul className="mt-1 space-y-1">
            {item.projects.map((project) => (
              <li key={project.id} className="flex items-center justify-between gap-2">
                <Link to={`/projects/${project.id}`} className="min-w-0 truncate hover:underline">{project.name}</Link>
                <StatusBadge status={project.status} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {item.tasks.length > 0 ? (
        <div className="mt-2">
          <h3 className="text-xs font-medium text-muted-foreground">Tasks</h3>
          <ul className="mt-1 space-y-1">
            {item.tasks.map((task) => (
              <li key={task.id} className="flex items-center justify-between gap-2">
                <Link to={`/issues/${task.identifier ?? task.id}`} className="min-w-0 truncate hover:underline">
                  {task.identifier ? `${task.identifier} ` : ""}{task.title}
                </Link>
                <StatusBadge status={task.status} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}
