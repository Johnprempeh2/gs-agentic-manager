import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { ErrorState } from "@/components/ErrorState";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LifeBuoy, PaperclipIcon, Pencil, Plus } from "lucide-react";
import {
  FLEET_SUPPORT_ATTACHMENT_MAX_BYTES,
  FLEET_SUPPORT_ATTACHMENTS_PER_TICKET,
  FLEET_SUPPORT_CONTENT_TYPES,
  FLEET_SUPPORT_SUMMARY_MAX,
  FLEET_SUPPORT_TITLE_MAX,
  fleetSupportPriority,
  type ClientSupportStatus,
  type FleetSupportContentType,
  type FleetSupportKind,
  type FleetSupportPriority,
} from "@greatstone/shared/fleet-support";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { clientSupportApi, type ClientSupportTicket } from "@/api/clientSupport";
import { issuesApi } from "@/api/issues";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToastActions } from "@/context/ToastContext";
import { formatBytes } from "@/lib/issue-output";
import { queryKeys } from "@/lib/queryKeys";
import { formatDateTime, relativeTime } from "@/lib/utils";

/**
 * "Get help" (GRE-1425, server in GRE-1084). A board user of a client
 * instance opens a ticket with Greatstone, edits its words, and picks files to
 * send. The host script carries tickets to the hub and brings back our status,
 * owner, SLA times and replies. Board users only: the server refuses agents.
 *
 * Wording follows GRE-1354: support is platform support only; a quality review
 * is optional and separate; an upgrade request approves no purchase or spend.
 */

type ChipTone = "done" | "blocked" | "todo" | "backlog" | "in_progress";

const STATUS_CHIP: Record<ClientSupportStatus, { tone: ChipTone; label: string }> = {
  queued: { tone: "backlog", label: "Not sent yet" },
  open: { tone: "todo", label: "Open" },
  in_progress: { tone: "in_progress", label: "In progress" },
  resolved: { tone: "done", label: "Resolved" },
  closed: { tone: "backlog", label: "Closed" },
};

const KIND_OPTIONS: Array<{ value: FleetSupportKind; label: string; help: string }> = [
  {
    value: "support",
    label: "Platform support",
    help: "A fault or question about the platform itself. Not help with running your business.",
  },
  {
    value: "quality-review",
    label: "Quality review",
    help: "Optional and separate from platform support. Greatstone reviews the quality of your setup.",
  },
  {
    value: "upgrade",
    label: "Upgrade request",
    help: "This does not approve a purchase or any spend. A person at Greatstone contacts you to agree it.",
  },
];

export const KIND_LABEL: Record<FleetSupportKind, string> = {
  support: "Platform support",
  "quality-review": "Quality review",
  upgrade: "Upgrade request",
};

const CLOSED_STATUSES: ClientSupportStatus[] = ["resolved", "closed"];

/** Some browsers give CSV or text files no type, or an Excel type; fall back to the extension. */
const EXTENSION_TYPES: Record<string, FleetSupportContentType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  csv: "text/csv",
};

export function supportFileType(file: { name: string; type: string }): FleetSupportContentType | null {
  if ((FLEET_SUPPORT_CONTENT_TYPES as readonly string[]).includes(file.type)) return file.type as FleetSupportContentType;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TYPES[extension] ?? null;
}

/** The reason a file cannot be added, or null when it can. */
export function supportFileProblem(file: { name: string; type: string; size: number }, filesOnTicket: number) {
  if (filesOnTicket >= FLEET_SUPPORT_ATTACHMENTS_PER_TICKET)
    return `A ticket can have ${FLEET_SUPPORT_ATTACHMENTS_PER_TICKET} files at most.`;
  if (!supportFileType(file)) return "Use a PNG, JPEG, GIF, WebP, PDF, text or CSV file.";
  if (file.size === 0) return "This file is empty.";
  if (file.size > FLEET_SUPPORT_ATTACHMENT_MAX_BYTES)
    return `A file can be ${FLEET_SUPPORT_ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB at most.`;
  return null;
}

function readBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read"));
    reader.readAsDataURL(file);
  });
}

function errorMessage(error: unknown) {
  if (error instanceof ApiError && error.status === 409) return "This ticket is closed. Open a new ticket.";
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

function Chip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return (
    <span
      className="status-chip inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap"
      style={{ "--sc": `var(--status-task-${tone})` } as CSSProperties}
    >
      {children}
    </span>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

type FormState = { kind: FleetSupportKind; title: string; summary: string; priority: FleetSupportPriority; linkedIssue: string };

const EMPTY_FORM: FormState = { kind: "support", title: "", summary: "", priority: "P3", linkedIssue: "" };

/** One dialog for both: a new ticket (all fields) or an edit (title and summary only). */
function TicketDialog({
  companyId,
  ticket,
  open,
  onOpenChange,
}: {
  companyId: string;
  ticket: ClientSupportTicket | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const issuePrefix = useCompany().selectedCompany?.issuePrefix;
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const editing = ticket !== null;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(ticket ? { ...EMPTY_FORM, kind: ticket.kind, title: ticket.title, summary: ticket.summary } : EMPTY_FORM);
  }, [open, ticket]);

  const save = useMutation({
    mutationFn: async () => {
      if (ticket) return clientSupportApi.edit(companyId, ticket.id, { title: form.title, summary: form.summary });
      let linkedIssueId: string | null = null;
      const reference = form.linkedIssue.trim();
      if (reference) {
        const issue = await issuesApi.get(reference).catch(() => null);
        if (!issue || issue.companyId !== companyId) throw new Error(`No issue ${reference} in this company.`);
        linkedIssueId = issue.id;
      }
      return clientSupportApi.create(companyId, {
        kind: form.kind,
        title: form.title,
        summary: form.summary,
        priority: fleetSupportPriority(form.kind, form.priority),
        linkedIssueId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.clientSupport.tickets(companyId) });
      pushToast({ title: editing ? "Ticket updated" : "Ticket opened", tone: "success" });
      onOpenChange(false);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.title.trim()) {
      setError("Give the ticket a title.");
      return;
    }
    save.mutate();
  };

  const kindHelp = KIND_OPTIONS.find((option) => option.value === form.kind)?.help;
  const fixedP3 = form.kind !== "support";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent scrollBody className="max-h-(--sz-85vh)">
        <form onSubmit={onSubmit} className="grid gap-4" data-testid="get-help-form">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit ticket" : "Open a ticket"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "Your changes go to Greatstone on the next sync."
                : "Greatstone gets the title, summary, kind and priority. Nothing else leaves this instance."}
            </DialogDescription>
          </DialogHeader>

          {!editing ? (
            <div className="grid gap-1.5">
              <Label htmlFor="get-help-kind">Kind</Label>
              <NativeSelect
                id="get-help-kind"
                value={form.kind}
                onChange={(event) => setForm({ ...form, kind: event.target.value as FleetSupportKind })}
              >
                {KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>
              <p className="text-xs text-muted-foreground" data-testid="get-help-kind-help">
                {kindHelp}
              </p>
            </div>
          ) : null}

          <div className="grid gap-1.5">
            <Label htmlFor="get-help-title">Title</Label>
            <Input
              id="get-help-title"
              value={form.title}
              maxLength={FLEET_SUPPORT_TITLE_MAX}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="get-help-summary">Summary</Label>
            <Textarea
              id="get-help-summary"
              rows={5}
              value={form.summary}
              maxLength={FLEET_SUPPORT_SUMMARY_MAX}
              onChange={(event) => setForm({ ...form, summary: event.target.value })}
              placeholder="What happened, and what you expected."
            />
          </div>

          {!editing ? (
            <>
              {fixedP3 ? (
                <div className="grid gap-1.5" data-testid="get-help-fixed-priority">
                  <span className="text-sm font-medium">Priority</span>
                  <p className="text-sm">P3</p>
                  <p className="text-xs text-muted-foreground">Quality reviews and upgrade requests are always P3.</p>
                </div>
              ) : (
                <div className="grid gap-1.5">
                  <Label htmlFor="get-help-priority">Priority</Label>
                  <NativeSelect
                    id="get-help-priority"
                    value={form.priority}
                    onChange={(event) => setForm({ ...form, priority: event.target.value as FleetSupportPriority })}
                  >
                    <option value="P1">P1: the platform is down or unusable</option>
                    <option value="P2">P2: a main feature does not work</option>
                    <option value="P3">P3: a question or small fault</option>
                  </NativeSelect>
                </div>
              )}

              <div className="grid gap-1.5">
                <Label htmlFor="get-help-issue">Linked issue (optional)</Label>
                <Input
                  id="get-help-issue"
                  value={form.linkedIssue}
                  placeholder={`For example ${issuePrefix ?? "ABC"}-12`}
                  onChange={(event) => setForm({ ...form, linkedIssue: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  The linked issue stays in this instance. Greatstone does not see it.
                </p>
              </div>
            </>
          ) : null}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : editing ? "Save" : "Open ticket"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddFileButton({ companyId, ticket }: { companyId: string; ticket: ClientSupportTicket }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: async (file: File) =>
      clientSupportApi.attach(companyId, ticket.id, {
        name: file.name,
        contentType: supportFileType(file)!,
        contentBase64: await readBase64(file),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.clientSupport.tickets(companyId) });
      pushToast({ title: "File added", tone: "success" });
    },
    onError: (err) => setProblem(errorMessage(err)),
  });

  const full = ticket.attachments.length >= FLEET_SUPPORT_ATTACHMENTS_PER_TICKET;

  return (
    <div className="space-y-1">
      <input
        ref={input}
        type="file"
        className="sr-only"
        aria-label={`Add a file to ${ticket.title}`}
        accept={[...FLEET_SUPPORT_CONTENT_TYPES, ".csv", ".txt"].join(",")}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          const reason = supportFileProblem(file, ticket.attachments.length);
          setProblem(reason);
          if (!reason) upload.mutate(file);
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={full || upload.isPending}
        onClick={() => input.current?.click()}
      >
        <PaperclipIcon />
        {upload.isPending ? "Adding…" : "Add file"}
      </Button>
      {problem ? (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

function TicketCard({
  companyId,
  ticket,
  onEdit,
}: {
  companyId: string;
  ticket: ClientSupportTicket;
  onEdit: (ticket: ClientSupportTicket) => void;
}) {
  const chip = STATUS_CHIP[ticket.status] ?? { tone: "backlog" as const, label: ticket.status };
  const closed = CLOSED_STATUSES.includes(ticket.status);
  return (
    <li className="space-y-3 p-4" data-testid={`get-help-ticket-${ticket.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-sm font-semibold break-words">{ticket.title}</h2>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Chip tone={chip.tone}>{chip.label}</Chip>
            <span>{KIND_LABEL[ticket.kind] ?? ticket.kind}</span>
            <span>{ticket.priority}</span>
            <span>Opened {relativeTime(ticket.createdAt)}</span>
          </div>
        </div>
        {closed ? null : (
          <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => onEdit(ticket)}>
            <Pencil />
            Edit
          </Button>
        )}
      </div>

      {ticket.refusedReason ? (
        <p className="text-xs text-muted-foreground">
          Greatstone could not take this ticket yet. It goes on a later sync.
        </p>
      ) : null}

      {ticket.summary ? <p className="text-sm whitespace-pre-wrap break-words">{ticket.summary}</p> : null}

      <dl className="grid grid-cols-(--gtc-10) gap-x-3 gap-y-1.5 border-t border-border pt-3">
        <Detail label="Greatstone ticket">
          {ticket.hubTicketId ? <span className="font-mono text-xs">{ticket.hubTicketId}</span> : <Muted>Not sent yet</Muted>}
        </Detail>
        <Detail label="Owner">{ticket.hubOwner ?? <Muted>Not assigned yet</Muted>}</Detail>
        <Detail label="First reply due">
          {ticket.firstResponseDueAt ? formatDateTime(ticket.firstResponseDueAt) : <Muted>Not set yet</Muted>}
        </Detail>
        <Detail label="First reply">
          {ticket.firstResponseAt ? formatDateTime(ticket.firstResponseAt) : <Muted>No reply yet</Muted>}
        </Detail>
      </dl>

      {ticket.replies.length > 0 ? (
        <section className="space-y-2 border-t border-border pt-3" aria-label="Replies from Greatstone">
          <h3 className="text-xs font-medium text-muted-foreground">Replies from Greatstone</h3>
          <ul className="space-y-2">
            {ticket.replies.map((reply) => (
              <li key={reply.id} className="rounded-md border border-border bg-muted/40 p-3">
                <div className="text-xs text-muted-foreground">{formatDateTime(reply.sentAt)}</div>
                <p className="mt-1 text-sm whitespace-pre-wrap break-words">{reply.body}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-2 border-t border-border pt-3" aria-label="Files">
        <h3 className="text-xs font-medium text-muted-foreground">
          Files ({ticket.attachments.length} of {FLEET_SUPPORT_ATTACHMENTS_PER_TICKET})
        </h3>
        {ticket.attachments.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {ticket.attachments.map((file) => (
              <li key={file.id} className="flex flex-wrap items-baseline gap-x-2">
                <span className="min-w-0 break-all">{file.name}</span>
                <Muted>
                  <span className="text-xs">
                    {formatBytes(file.byteSize)}, {file.sentAt ? "sent to Greatstone" : "not sent yet"}
                  </span>
                </Muted>
              </li>
            ))}
          </ul>
        ) : null}
        {closed ? null : <AddFileButton companyId={companyId} ticket={ticket} />}
      </section>
    </li>
  );
}

export function GetHelp() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId } = useCompany();
  const [dialog, setDialog] = useState<{ open: boolean; ticket: ClientSupportTicket | null }>({ open: false, ticket: null });

  useEffect(() => {
    setBreadcrumbs([{ label: "Settings", href: "/company/settings" }, { label: "Get help" }]);
  }, [setBreadcrumbs]);

  const boardAccess = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  const isBoardUser = Boolean(boardAccess.data?.userId);

  const tickets = useQuery({
    queryKey: queryKeys.clientSupport.tickets(selectedCompanyId ?? "__none__"),
    queryFn: () => clientSupportApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && isBoardUser,
    refetchInterval: 60_000,
  });

  if (boardAccess.isLoading || (isBoardUser && tickets.isLoading)) return <PageSkeleton variant="list" />;

  if (!isBoardUser || !selectedCompanyId) {
    return <EmptyState icon={LifeBuoy} title="Get help is for board members" message="Sign in as a board member to open a ticket." />;
  }

  if (tickets.error || !tickets.data) {
    return (
      <ErrorState
        className="mx-auto max-w-3xl"
        error={tickets.error}
        title="Your tickets could not be loaded"
        onRetry={() => void tickets.refetch()}
        retrying={tickets.isFetching}
      />
    );
  }

  const openNew = () => setDialog({ open: true, ticket: null });

  return (
    <div className="mx-auto max-w-3xl space-y-4" data-testid="get-help-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Get help</h1>
          <p className="text-sm text-muted-foreground">
            Ask Greatstone for platform support, an optional quality review, or an upgrade. Only what you type and the
            files you pick go to Greatstone.
          </p>
        </div>
        <Button type="button" onClick={openNew}>
          <Plus />
          Open a ticket
        </Button>
      </div>

      {tickets.data.length === 0 ? (
        <EmptyState icon={LifeBuoy} title="No tickets yet" message="Open a ticket and Greatstone replies here." />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border" data-testid="get-help-tickets">
          {tickets.data.map((ticket) => (
            <TicketCard
              key={ticket.id}
              companyId={selectedCompanyId}
              ticket={ticket}
              onEdit={(t) => setDialog({ open: true, ticket: t })}
            />
          ))}
        </ul>
      )}

      <TicketDialog
        companyId={selectedCompanyId}
        ticket={dialog.ticket}
        open={dialog.open}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
      />
    </div>
  );
}
