import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightLeft, Building2, CalendarClock, FileText, History, Mail, Pencil, Phone, Sparkles, Star, StickyNote } from "lucide-react";
import {
  ORGANISATION_STATUS_LABELS,
  type CrmFile,
  type CrmRecordField,
  type CrmTimelineEntry,
  type OrganisationContact,
  type OrganisationHistoryCase,
  type OrganisationHistoryStageChange,
} from "@greatstone/shared";
import { organisationsApi } from "@/api/organisations";
import { EmptyState } from "@/components/EmptyState";
import { OrganisationCommerce } from "@/components/OrganisationCommerce";
import { OrganisationCrmInfo } from "@/components/OrganisationCrmFields";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { organisationAskContext } from "@/lib/ask-everest";
import { openAskEverest } from "@/lib/ask-everest-events";
import { Link, useParams } from "@/lib/router";
import { formatBytes } from "@/lib/issue-output";
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
 * Company page for one organisation (GRE-1480): company info, country owner,
 * contacts and engagement history (pipeline cases with stage changes, linked
 * projects and tasks, last contact date).
 */
export function OrganisationPage() {
  const { organisationId = "" } = useParams<{ organisationId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [editing, setEditing] = useState(false);
  const companyId = selectedCompanyId ?? "";

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

  const name = detail.data?.name;
  useEffect(() => {
    setBreadcrumbs([{ label: "Organisations", href: "/organisations" }, { label: name ?? "Organisation" }]);
  }, [setBreadcrumbs, name]);

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

      <OrganisationCommerce companyId={companyId} organisation={organisation} />

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

      {history.data?.timeline?.length ? (
        <section aria-label="Activities and notes" className="space-y-2">
          <h2 className="text-sm font-semibold">Activities and notes</h2>
          <ul className="divide-y divide-border rounded-md border border-border">
            {history.data.timeline.map((entry) => <TimelineRow key={entry.id} entry={entry} />)}
          </ul>
        </section>
      ) : null}

      {history.data?.files?.length ? (
        <section aria-label="Files" className="space-y-2">
          <h2 className="text-sm font-semibold">Files</h2>
          <ul className="divide-y divide-border rounded-md border border-border">
            {history.data.files.map((file) => <FileRow key={file.id} file={file} />)}
          </ul>
        </section>
      ) : null}

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

const TIMELINE_ICONS = { activity: CalendarClock, note: StickyNote, call: Phone, email: Mail, stage_change: ArrowRightLeft, field_change: Pencil } as const;

function timelineTitle(entry: CrmTimelineEntry) {
  if (entry.subject) return entry.subject;
  if (entry.kind === "note") return "Note";
  if (entry.kind === "call") return "Call";
  if (entry.kind === "email") return "Email";
  if (entry.kind === "stage_change") return "Stage change";
  if (entry.kind === "field_change") return "Field change";
  return entry.activityType ? entry.activityType.charAt(0).toUpperCase() + entry.activityType.slice(1) : "Activity";
}

function timelineMeta(entry: CrmTimelineEntry) {
  const parts: string[] = [];
  if (entry.occurredAt) parts.push(formatDateTime(entry.occurredAt));
  if (entry.kind === "activity") {
    if (entry.activityType) parts.push(entry.activityType);
    parts.push(entry.done ? "Done" : "Planned");
  }
  if (entry.durationMinutes) parts.push(`${entry.durationMinutes} min`);
  if (entry.kind === "email") {
    const from = Array.isArray(entry.details.from) ? entry.details.from.join(", ") : "";
    const to = Array.isArray(entry.details.to) ? entry.details.to.join(", ") : "";
    if (from) parts.push(`from ${from}`);
    if (to) parts.push(`to ${to}`);
  }
  if (entry.ownerName) parts.push(entry.ownerName);
  if (entry.contactName) parts.push(`with ${entry.contactName}`);
  return parts.join(" · ");
}

/** One imported activity, note or call. */
function TimelineRow({ entry }: { entry: CrmTimelineEntry }) {
  const Icon = TIMELINE_ICONS[entry.kind] ?? CalendarClock;
  return (
    <li className="flex gap-2 px-3 py-2 text-sm">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">{timelineTitle(entry)}</span>
          {entry.caseId && entry.caseTitle ? <span className="text-xs text-muted-foreground">{entry.caseTitle}</span> : null}
        </div>
        <p className="text-xs text-muted-foreground">{timelineMeta(entry)}</p>
        {entry.body ? <p className="whitespace-pre-wrap break-words text-muted-foreground">{entry.body}</p> : null}
      </div>
    </li>
  );
}

/** One file imported from a CRM: opens the copy in GSAM, or the CRM's link when it was not copied. */
function FileRow({ file }: { file: CrmFile }) {
  const href = file.contentPath ?? file.remoteUrl;
  const meta = [
    file.addedAt ? formatDate(file.addedAt) : null,
    file.byteSize ? formatBytes(file.byteSize) : null,
    file.ownerName,
    file.contactName ? `on ${file.contactName}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <li className="flex gap-2 px-3 py-2 text-sm">
      <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          {href ? (
            <a href={href} target="_blank" rel="noreferrer" className="font-medium underline-offset-2 hover:underline">{file.name}</a>
          ) : (
            <span className="font-medium">{file.name}</span>
          )}
          {file.caseId && file.caseTitle ? <span className="text-xs text-muted-foreground">{file.caseTitle}</span> : null}
        </div>
        {meta ? <p className="text-xs text-muted-foreground">{meta}</p> : null}
        {file.notCopied ? <p className="text-xs text-muted-foreground">Not copied into GSAM: {file.notCopied}</p> : null}
        {file.description ? <p className="whitespace-pre-wrap break-words text-muted-foreground">{file.description}</p> : null}
      </div>
    </li>
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
