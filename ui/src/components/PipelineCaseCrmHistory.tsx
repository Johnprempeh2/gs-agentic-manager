import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightLeft, CalendarClock, FileText, Mail, Pencil, Phone, StickyNote } from "lucide-react";
import type { CrmFile, CrmTimelineEntry } from "@greatstone/shared";
import { pipelinesApi } from "../api/pipelines";
import { formatBytes } from "../lib/issue-output";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDate, formatDateTime } from "../lib/utils";
import { Button } from "./ui/button";

// A client's whole CRM history on its case page (evening run, 16 Oct): the
// activities, notes, calls, emails and stage changes the Pipedrive import filed
// on the deal, and the deal's files, so nobody has to open Pipedrive to see
// what happened with a client. Hidden when the case has none.

// Kinds are plain strings here so a kind the import adds later still renders
// (with the activity icon and no filter of its own) instead of breaking the page.
type Kind = string;

const KIND_ICONS: Partial<Record<Kind, typeof CalendarClock>> = {
  activity: CalendarClock,
  note: StickyNote,
  call: Phone,
  email: Mail,
  stage_change: ArrowRightLeft,
  field_change: Pencil,
};

const KIND_FILTERS: Array<{ kind: Kind; label: string }> = [
  { kind: "activity", label: "Activities" },
  { kind: "note", label: "Notes" },
  { kind: "call", label: "Calls" },
  { kind: "email", label: "Emails" },
  { kind: "stage_change", label: "Stage changes" },
  { kind: "field_change", label: "Field changes" },
];

/** How many entries show before "Show all". */
const FIRST_PAGE = 25;

export function crmSourceName(source: string | undefined) {
  if (source === "pipedrive") return "Pipedrive";
  if (source === "hubspot") return "HubSpot";
  return "your CRM";
}

export function timelineTitle(entry: CrmTimelineEntry) {
  if (entry.subject) return entry.subject;
  if ((entry.kind as string) === "field_change") return "Field change";
  if (entry.kind === "note") return "Note";
  if (entry.kind === "call") return "Call";
  if (entry.kind === "email") return "Email";
  if (entry.kind === "stage_change") return "Stage change";
  return entry.activityType ? entry.activityType.charAt(0).toUpperCase() + entry.activityType.slice(1) : "Activity";
}

function names(value: unknown) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item).join(", ") : "";
}

export function timelineMeta(entry: CrmTimelineEntry) {
  const parts: string[] = [];
  if (entry.occurredAt) parts.push(formatDateTime(entry.occurredAt));
  if (entry.kind === "activity") {
    if (entry.activityType) parts.push(entry.activityType);
    parts.push(entry.done ? "Done" : "Planned");
  }
  if (entry.durationMinutes) parts.push(`${entry.durationMinutes} min`);
  if (entry.kind === "call" && typeof entry.details.outcome === "string" && entry.details.outcome) parts.push(entry.details.outcome);
  if (entry.kind === "email") {
    const from = names(entry.details.from);
    const to = names(entry.details.to);
    if (from) parts.push(`from ${from}`);
    if (to) parts.push(`to ${to}`);
  }
  if (entry.ownerName) parts.push(entry.ownerName);
  if (entry.contactName) parts.push(`with ${entry.contactName}`);
  return parts.join(" · ");
}

function TimelineRow({ entry }: { entry: CrmTimelineEntry }) {
  const Icon = KIND_ICONS[entry.kind] ?? CalendarClock;
  const [open, setOpen] = useState(false);
  const long = (entry.body?.length ?? 0) > 400;
  return (
    <li className="flex gap-2 py-2 text-sm" data-kind={entry.kind}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-medium break-words">{timelineTitle(entry)}</p>
        <p className="text-xs text-muted-foreground">{timelineMeta(entry)}</p>
        {entry.body ? (
          <p className={cn("whitespace-pre-wrap break-words text-muted-foreground", long && !open && "line-clamp-4")}>{entry.body}</p>
        ) : null}
        {long ? (
          <button type="button" className="text-xs text-foreground underline underline-offset-2" onClick={() => setOpen((value) => !value)}>
            {open ? "Show less" : "Show the rest"}
          </button>
        ) : null}
      </div>
    </li>
  );
}

function FileRow({ file }: { file: CrmFile }) {
  const href = file.contentPath ?? file.remoteUrl;
  const meta = [
    file.addedAt ? formatDate(file.addedAt) : null,
    file.byteSize ? formatBytes(file.byteSize) : null,
    file.ownerName,
    file.contactName ? `on ${file.contactName}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <li className="flex gap-2 py-2 text-sm">
      <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-0.5">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="font-medium break-words underline-offset-2 hover:underline">{file.name}</a>
        ) : (
          <span className="font-medium break-words">{file.name}</span>
        )}
        {meta ? <p className="text-xs text-muted-foreground">{meta}</p> : null}
        {file.notCopied ? <p className="text-xs text-muted-foreground">Not copied into GSAM: {file.notCopied}</p> : null}
        {file.description ? <p className="whitespace-pre-wrap break-words text-muted-foreground">{file.description}</p> : null}
      </div>
    </li>
  );
}

export function PipelineCaseCrmHistory({
  caseId,
  wrap,
}: {
  caseId: string;
  /** Wraps the section with its heading; gets the title naming the CRM. */
  wrap: (title: string, children: ReactNode) => ReactNode;
}) {
  const history = useQuery({
    queryKey: queryKeys.pipelines.caseCrmHistory(caseId),
    queryFn: () => pipelinesApi.getCaseCrmHistory(caseId),
  });
  const [filter, setFilter] = useState<Kind | "all">("all");
  const [showAll, setShowAll] = useState(false);

  if (history.isLoading) return null;
  if (history.error) {
    return wrap(
      "History from your CRM",
      <p className="py-3 text-sm text-destructive" role="alert">
        Could not load the history from your CRM. {history.error instanceof Error ? history.error.message : ""}
      </p>,
    );
  }
  const data = history.data;
  if (!data || (data.timeline.length === 0 && data.files.length === 0)) return null;

  const source = crmSourceName(data.timeline[0]?.source ?? data.files[0]?.source);
  const counts = new Map<Kind, number>();
  for (const entry of data.timeline) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  const filters = KIND_FILTERS.filter(({ kind }) => counts.has(kind));
  const entries = filter === "all" ? data.timeline : data.timeline.filter((entry) => entry.kind === filter);
  const shown = showAll ? entries : entries.slice(0, FIRST_PAGE);

  return wrap(
    `History from ${source}`,
    <div className="space-y-4" data-testid="case-crm-history">
      {data.timeline.length > 0 ? (
        <div className="space-y-2">
          {filters.length > 1 ? (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
              <Button
                type="button"
                size="sm"
                variant={filter === "all" ? "secondary" : "ghost"}
                aria-pressed={filter === "all"}
                onClick={() => { setFilter("all"); setShowAll(false); }}
              >
                All ({data.timeline.length})
              </Button>
              {filters.map(({ kind, label }) => (
                <Button
                  key={kind}
                  type="button"
                  size="sm"
                  variant={filter === kind ? "secondary" : "ghost"}
                  aria-pressed={filter === kind}
                  onClick={() => { setFilter(kind); setShowAll(false); }}
                >
                  {label} ({counts.get(kind)})
                </Button>
              ))}
            </div>
          ) : null}
          <ul className="divide-y divide-border" aria-label={`History from ${source}`}>
            {shown.map((entry) => <TimelineRow key={entry.id} entry={entry} />)}
          </ul>
          {entries.length > shown.length ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setShowAll(true)}>
              Show all {entries.length}
            </Button>
          ) : null}
          {data.truncated && (showAll || entries.length <= FIRST_PAGE) ? (
            <p className="text-xs text-muted-foreground">Showing the newest {data.timeline.length}. Older entries are on the organisation page.</p>
          ) : null}
        </div>
      ) : null}
      {data.files.length > 0 ? (
        <div className="space-y-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Files from {source}</h3>
          <ul className="divide-y divide-border" aria-label={`Files from ${source}`}>
            {data.files.map((file) => <FileRow key={file.id} file={file} />)}
          </ul>
        </div>
      ) : null}
    </div>,
  );
}
