import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FileText, KeyRound, Lock, Plus, Trash2 } from "lucide-react";
import {
  WEBSITE_PORTAL_DOCUMENT_ACTIONS,
  WEBSITE_PORTAL_DOCUMENT_KINDS,
  websitePortalDocumentCreateSchema,
  websitePortalDocumentEditSchema,
  type WebsitePortalDocumentAction,
  type WebsitePortalDocumentKind,
  type WebsitePortalDocumentStatus,
  type WebsitePortalDocumentStep,
  type WebsiteProperty,
} from "@greatstone/shared";
import { ApiError } from "@/api/client";
import { websiteModuleApi } from "@/api/website";
import { websiteDataBridgeApi } from "@/api/website-data-bridge";
import { websitePortalDocumentsApi } from "@/api/website-portal-documents";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmButton, PeopleOnlyNote } from "@/components/commerce/CommerceWriteParts";
import { useCommerceCustomers } from "@/hooks/useCommerceSite";
import { useCommercePerson } from "@/hooks/useCommerceWrite";
import { text } from "@/lib/commerce";
import { BRIDGE_KEY_SETTINGS_PATH, isDefiniteAnswer, newIdempotencyKey } from "@/lib/commerce-write";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";
import { EmptyState } from "../EmptyState";
import { ErrorState } from "../ErrorState";
import { PageSkeleton } from "../PageSkeleton";
import { useWebsiteSite } from "./WebsiteSiteConnection";

// Portal documents (GRE-4084, GRE-4079 step 2c): the client portal's engagement packs, NDAs, terms and the rest, read
// through the admin bridge and written on the step 2b routes. Anyone with Edit rights drafts, edits, submits and
// returns a document to draft. Approve and publish, and withdraw, show only to a signed-in person with Publish rights;
// the website still checks that the person is a registered portal approver.

export const PORTAL_KIND_LABEL: Record<WebsitePortalDocumentKind, string> = {
  engagement_pack: "Engagement pack", nda: "NDA", gita: "GITA", terms: "Terms", pre_read: "Pre-read",
  north_star: "North Star", investigation_plan: "Investigation plan", gdxp: "GDXP",
};
const ACTION_LABEL: Record<WebsitePortalDocumentAction, string> = {
  none: "No action, read only", accept: "Client accepts", agree_in_principle: "Client agrees in principle",
};
const STATUS_LABEL: Record<WebsitePortalDocumentStatus, string> = {
  draft: "Draft", pending_approval: "Waiting for approval", published: "Published", withdrawn: "Withdrawn", superseded: "Replaced",
};

const CARD = "rounded-xl border border-border bg-card";
const PILL = "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium";
const NOTICE = "flex gap-3 rounded-lg border p-3 text-sm";

const STATUS_PILL: Record<WebsitePortalDocumentStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  pending_approval: "bg-status-warning-soft text-status-warning-foreground",
  published: "bg-status-success-soft text-status-success-foreground",
  withdrawn: "bg-muted text-muted-foreground",
  superseded: "bg-muted text-muted-foreground",
};

/** One document row as the read key returns it. `body` may be absent: it stays on the site for the read key. */
export interface PortalDocumentRow {
  id: string;
  customerId: string;
  kind: WebsitePortalDocumentKind;
  version: number;
  title: string;
  summary: string | null;
  status: WebsitePortalDocumentStatus;
  action: WebsitePortalDocumentAction;
  confirmationText: string | null;
  signatoryEmail: string | null;
  sections: SectionDraft[] | null;
  contentSha256: string | null;
  rowVersion: number | null;
  createdByKind: "agent" | "staff" | null;
  updatedAt: string | null;
}

interface SectionDraft { id: string; title: string; html: string }

const STATUSES = new Set<string>(Object.keys(STATUS_LABEL));

function sectionsOf(body: unknown): SectionDraft[] | null {
  const sections = body && typeof body === "object" ? (body as { sections?: unknown }).sections : undefined;
  if (!Array.isArray(sections)) return null;
  return sections.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    return [{ id: text(row.id) ?? "", title: typeof row.title === "string" ? row.title : "", html: typeof row.html === "string" ? row.html : "" }];
  });
}

export function portalDocumentRow(record: Record<string, unknown>): PortalDocumentRow | null {
  const id = text(record.id);
  const status = text(record.status);
  if (!id || !status || !STATUSES.has(status)) return null;
  const kind = text(record.kind) as WebsitePortalDocumentKind | null;
  const action = text(record.action) as WebsitePortalDocumentAction | null;
  const rowVersion = Number(record.row_version);
  const sha = text(record.content_sha256);
  return {
    id,
    customerId: text(record.customer_id) ?? "",
    kind: kind && kind in PORTAL_KIND_LABEL ? kind : "terms",
    version: Number(record.version) || 1,
    title: text(record.title) ?? "Untitled document",
    summary: text(record.summary),
    status: status as WebsitePortalDocumentStatus,
    action: action && action in ACTION_LABEL ? action : "none",
    confirmationText: text(record.confirmation_text),
    signatoryEmail: text(record.signatory_email),
    sections: sectionsOf(record.body),
    contentSha256: sha && /^[0-9a-f]{64}$/.test(sha) ? sha : null,
    rowVersion: Number.isInteger(rowVersion) && rowVersion >= 0 ? rowVersion : null,
    createdByKind: record.created_by_kind === "agent" || record.created_by_kind === "staff" ? record.created_by_kind : null,
    updatedAt: text(record.updated_at),
  };
}

type Operation = "create" | "edit" | WebsitePortalDocumentStep;

/** What the site's answer means, in words. The site sends a code only for most refusals. */
export function portalDocumentMessage(error: unknown, operation: Operation | null): {
  tone: "warning" | "muted" | "danger"; title?: string; message: string; keyLink?: boolean;
} {
  const message = error instanceof Error && error.message.trim() ? error.message : "The change did not go through. Try again.";
  if (!(error instanceof ApiError)) return { tone: "danger", message };
  const body = error.body && typeof error.body === "object" ? (error.body as Record<string, unknown>) : {};
  const details = body.details && typeof body.details === "object" ? (body.details as Record<string, unknown>) : {};
  const code = text(body.code) ?? text(details.code);
  if (error.status === 409 && code === "capability_not_configured") {
    return { tone: "warning", title: "No write key yet", keyLink: true,
      message: "GSAM cannot write portal documents on the website until a person makes its write key. Nothing was sent to the site." };
  }
  if (error.status === 403 && (code === "website_portal_people_only" || code === "website_publish_agent_refused")) {
    return { tone: "muted", message };
  }
  if (error.status === 403 && code === "website_bridge_denied" && operation === "approve-and-publish") {
    return { tone: "muted", title: "Not a portal approver",
      message: "The website does not link your GSAM sign-in to a portal approver, so it did not publish the document. The link "
        + "is added by hand on the website's database." };
  }
  if (error.status === 409 && code === "website_bridge_conflict") {
    return { tone: "warning", title: "Nothing changed",
      message: "The document changed on the website since this list was read. The list is fresh now: check it and try again." };
  }
  return { tone: "danger", message };
}

function ChangeError({ error, operation }: { error: unknown; operation: Operation | null }) {
  if (!error) return null;
  const answer = portalDocumentMessage(error, operation);
  const Icon = answer.keyLink ? KeyRound : answer.tone === "muted" ? Lock : AlertTriangle;
  return (
    <div
      role="alert"
      data-testid="portal-documents-error"
      className={cn(NOTICE,
        answer.tone === "warning" && "border-status-warning/40 bg-status-warning-soft text-status-warning-foreground",
        answer.tone === "muted" && "border-border bg-muted text-foreground",
        answer.tone === "danger" && "border-destructive/40 bg-destructive/10 text-foreground")}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", answer.tone === "danger" && "text-destructive")} aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        {answer.title ? <p className="font-medium">{answer.title}</p> : null}
        <p className="break-words">{answer.message}</p>
        {answer.keyLink ? (
          <Link to={BRIDGE_KEY_SETTINGS_PATH} className="inline-flex font-medium underline underline-offset-4">
            Open the bridge key settings
          </Link>
        ) : null}
      </div>
    </div>
  );
}

type Change =
  | { operation: "create"; input: Parameters<typeof websitePortalDocumentsApi.create>[2] }
  | { operation: "edit"; documentId: string; input: Parameters<typeof websitePortalDocumentsApi.edit>[3] }
  | { operation: WebsitePortalDocumentStep; documentId: string; input: Parameters<typeof websitePortalDocumentsApi.step>[4] };

/**
 * One write at a time. A retry of the same change (after a network error or a 5xx) reuses its Idempotency-Key, so
 * the site writes it once. Every success, and a conflict, refreshes this site's portal document reads.
 */
function useDocumentChange(companyId: string, siteId: string, onSuccess?: () => void) {
  const queryClient = useQueryClient();
  const pending = useRef<{ signature: string; key: string } | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.website.data(companyId, siteId, "portal-documents") });
  const mutation = useMutation({
    mutationFn: (change: Change) => {
      setOperation(change.operation);
      const signature = JSON.stringify(change);
      if (pending.current?.signature !== signature) pending.current = { signature, key: newIdempotencyKey() };
      const key = pending.current.key;
      if (change.operation === "create") return websitePortalDocumentsApi.create(companyId, siteId, change.input, key);
      if (change.operation === "edit") return websitePortalDocumentsApi.edit(companyId, siteId, change.documentId, change.input, key);
      return websitePortalDocumentsApi.step(companyId, siteId, change.documentId, change.operation, change.input, key);
    },
    onSuccess: () => {
      pending.current = null;
      void refresh();
      onSuccess?.();
    },
    onError: (error) => {
      if (isDefiniteAnswer(error)) pending.current = null;
      if (error instanceof ApiError && error.status === 409) void refresh();
    },
  });
  return { ...mutation, operation };
}

// ---- the editor ----

interface Draft {
  customerId: string;
  kind: WebsitePortalDocumentKind;
  title: string;
  summary: string;
  action: WebsitePortalDocumentAction;
  confirmationText: string;
  signatoryEmail: string;
  sections: SectionDraft[];
}

function draftOf(row: PortalDocumentRow | null, customerId: string): Draft {
  return {
    customerId: row?.customerId ?? customerId,
    kind: row?.kind ?? "engagement_pack",
    title: row?.title ?? "",
    summary: row?.summary ?? "",
    action: row?.action ?? "none",
    confirmationText: row?.confirmationText ?? "",
    signatoryEmail: row?.signatoryEmail ?? "",
    sections: row?.sections ?? [],
  };
}

function nextSectionId(sections: SectionDraft[]) {
  const used = new Set(sections.map((section) => section.id));
  let n = sections.length + 1;
  while (used.has(`section-${n}`)) n += 1;
  return `section-${n}`;
}

function Field({ label, help, children }: { label: string; help?: string; children: (id: string, helpId?: string) => ReactNode }) {
  const id = useId();
  const helpId = help ? `${id}-help` : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1 text-sm">
      <label htmlFor={id} className="font-medium">{label}</label>
      {children(id, helpId)}
      {help ? <p id={helpId} className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}

function issueText(issues: { path: PropertyKey[]; message: string }[]) {
  const issue = issues[0];
  if (!issue) return null;
  const path = issue.path.map(String).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

function DocumentEditor({ companyId, siteId, row, clients, defaultCustomerId, onClose }: {
  companyId: string;
  siteId: string;
  row: PortalDocumentRow | null;
  clients: { id: string; name: string }[];
  defaultCustomerId: string;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(row, defaultCustomerId));
  // The read key does not return a document's sections. On an edit, sections are sent only when the person adds or
  // changes them here, so a draft made in the studio keeps its sections unless someone means to replace them.
  const [sectionsTouched, setSectionsTouched] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const change = useDocumentChange(companyId, siteId, onClose);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const setSections = (sections: SectionDraft[]) => { setSectionsTouched(true); set("sections", sections); };
  const sectionsKnown = row === null || row.sections !== null;

  const save = (event: FormEvent) => {
    event.preventDefault();
    const fields = {
      title: draft.title.trim(),
      summary: draft.summary.trim() || null,
      action: draft.action,
      confirmationText: draft.action === "none" ? null : draft.confirmationText.trim() || null,
      signatoryEmail: draft.signatoryEmail.trim() || null,
    };
    const body = { sections: draft.sections.map((section) => ({ ...section, title: section.title.trim() })) };
    if (!row) {
      const parsed = websitePortalDocumentCreateSchema.safeParse({ customerId: draft.customerId, kind: draft.kind, ...fields, body });
      if (!parsed.success) return setProblem(issueText(parsed.error.issues));
      setProblem(null);
      return change.mutate({ operation: "create", input: parsed.data });
    }
    if (row.rowVersion === null) return setProblem("The website did not send this document's version. Refresh the list and try again.");
    const parsed = websitePortalDocumentEditSchema.safeParse({
      expectedRowVersion: row.rowVersion, ...fields, ...(sectionsTouched ? { body } : {}),
    });
    if (!parsed.success) return setProblem(issueText(parsed.error.issues));
    setProblem(null);
    change.mutate({ operation: "edit", documentId: row.id, input: parsed.data });
  };

  const clientName = clients.find((client) => client.id === draft.customerId)?.name;
  return (
    <form onSubmit={save} noValidate className={cn(CARD, "space-y-5 p-4 sm:p-6")} data-testid="portal-document-editor"
      aria-label={row ? `Edit ${row.title}` : "New portal document"}>
      <div className="space-y-1">
        <h3 className="text-base font-semibold">{row ? "Edit draft" : "New draft"}</h3>
        <p className="text-sm text-muted-foreground">
          {row
            ? `${PORTAL_KIND_LABEL[row.kind]} for ${clientName ?? "this client"}, version ${row.version}. Only a draft changes.`
            : "The draft stays on the website until someone submits it and a portal approver publishes it."}
        </p>
      </div>
      <ChangeError error={change.error} operation={change.operation} />
      <div className="grid gap-4 sm:grid-cols-2">
        {row ? null : (
          <>
            <Field label="Client company">
              {(id) => (
                <NativeSelect id={id} value={draft.customerId} onChange={(event) => set("customerId", event.target.value)}>
                  <option value="">Pick a client company</option>
                  {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
                </NativeSelect>
              )}
            </Field>
            <Field label="Kind">
              {(id) => (
                <NativeSelect id={id} value={draft.kind} onChange={(event) => set("kind", event.target.value as WebsitePortalDocumentKind)}>
                  {WEBSITE_PORTAL_DOCUMENT_KINDS.map((kind) => <option key={kind} value={kind}>{PORTAL_KIND_LABEL[kind]}</option>)}
                </NativeSelect>
              )}
            </Field>
          </>
        )}
        <div className="sm:col-span-2">
          <Field label="Title">
            {(id) => <Input id={id} value={draft.title} maxLength={200} onChange={(event) => set("title", event.target.value)} />}
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Summary (optional)" help="One or two lines the client sees above the document.">
            {(id, helpId) => (
              <Textarea id={id} aria-describedby={helpId} value={draft.summary} maxLength={2000} rows={2}
                onChange={(event) => set("summary", event.target.value)} />
            )}
          </Field>
        </div>
        <Field label="What the client does">
          {(id) => (
            <NativeSelect id={id} value={draft.action} onChange={(event) => set("action", event.target.value as WebsitePortalDocumentAction)}>
              {WEBSITE_PORTAL_DOCUMENT_ACTIONS.map((action) => <option key={action} value={action}>{ACTION_LABEL[action]}</option>)}
            </NativeSelect>
          )}
        </Field>
        <Field label="Signatory email (optional)">
          {(id) => (
            <Input id={id} type="email" value={draft.signatoryEmail} maxLength={320}
              onChange={(event) => set("signatoryEmail", event.target.value)} />
          )}
        </Field>
        {draft.action === "none" ? null : (
          <div className="sm:col-span-2">
            <Field label="Confirmation text" help="What the client confirms when they click. Needed before you submit.">
              {(id, helpId) => (
                <Textarea id={id} aria-describedby={helpId} value={draft.confirmationText} maxLength={1000} rows={2}
                  onChange={(event) => set("confirmationText", event.target.value)} />
              )}
            </Field>
          </div>
        )}
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Sections</legend>
        <p className="text-xs text-muted-foreground">
          {sectionsKnown
            ? "Each section is a heading and its text in simple HTML: p, h2 to h6, lists, strong, em, links to https:// or mailto:."
            : "This document's sections are kept on the website. Add sections here only to replace all of them."}
        </p>
        {draft.sections.map((section, index) => (
          <div key={index} className="space-y-2 rounded-lg border border-border p-3" data-testid="portal-document-section">
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Field label={`Section ${index + 1} heading`}>
                  {(id) => (
                    <Input id={id} value={section.title} maxLength={200}
                      onChange={(event) => setSections(draft.sections.map((entry, i) => (i === index ? { ...entry, title: event.target.value } : entry)))} />
                  )}
                </Field>
              </div>
              <Button type="button" size="icon" variant="ghost" aria-label={`Remove section ${index + 1}`}
                onClick={() => setSections(draft.sections.filter((_, i) => i !== index))}>
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            </div>
            <Field label={`Section ${index + 1} text (HTML)`}>
              {(id) => (
                <Textarea id={id} value={section.html} rows={4} className="font-mono text-xs md:text-xs"
                  onChange={(event) => setSections(draft.sections.map((entry, i) => (i === index ? { ...entry, html: event.target.value } : entry)))} />
              )}
            </Field>
          </div>
        ))}
        <Button type="button" size="sm" variant="outline" disabled={draft.sections.length >= 60}
          onClick={() => setSections([...draft.sections, { id: nextSectionId(draft.sections), title: "", html: "" }])}>
          <Plus className="size-4" aria-hidden="true" />
          Add a section
        </Button>
      </fieldset>

      {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={change.isPending}>
          {change.isPending ? "Saving" : row ? "Save draft" : "Create draft"}
        </Button>
      </div>
    </form>
  );
}

// ---- the list ----

function DocumentActions({ row, canEdit, canApprove, disabled, onEdit, onStep }: {
  row: PortalDocumentRow;
  canEdit: boolean;
  canApprove: boolean;
  disabled: boolean;
  onEdit: () => void;
  onStep: (step: WebsitePortalDocumentStep) => void;
}) {
  const noVersion = row.rowVersion === null;
  if (row.status === "draft" && canEdit) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={disabled || noVersion} onClick={onEdit}>Edit</Button>
        <ConfirmButton
          label="Submit"
          title={`Submit "${row.title}" for approval?`}
          description="The website freezes the content. A portal approver then publishes it, or someone returns it to draft to change it."
          confirmLabel="Submit for approval"
          disabled={disabled || noVersion}
          onConfirm={() => onStep("submit")}
        />
      </div>
    );
  }
  if (row.status === "pending_approval") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {canEdit ? (
          <ConfirmButton
            label="Return to draft"
            variant="ghost"
            title={`Return "${row.title}" to draft?`}
            description="It leaves the approval queue so it can be changed. It must be submitted again before anyone publishes it."
            confirmLabel="Return to draft"
            disabled={disabled || noVersion}
            onConfirm={() => onStep("return-to-draft")}
          />
        ) : null}
        {canApprove ? (
          <ConfirmButton
            label="Approve and publish"
            variant="default"
            testId="portal-document-approve"
            title={`Approve and publish "${row.title}"?`}
            description={(
              <>
                The client sees this version in the portal now, in your name.
                {row.version > 1 ? " The version before it is replaced." : ""}
                {row.contentSha256 ? <span className="mt-2 block font-mono text-xs">Fingerprint {row.contentSha256.slice(0, 12)}</span> : null}
              </>
            )}
            confirmLabel="Approve and publish"
            disabled={disabled || !row.contentSha256}
            onConfirm={() => onStep("approve-and-publish")}
          />
        ) : null}
      </div>
    );
  }
  if (row.status === "published" && canApprove) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <ConfirmButton
          label="Withdraw"
          title={`Withdraw "${row.title}"?`}
          description="The client no longer sees it in the portal. To change a published document, start a new version instead."
          confirmLabel="Withdraw"
          destructive
          disabled={disabled || noVersion}
          onConfirm={() => onStep("withdraw")}
        />
      </div>
    );
  }
  return null;
}

function useWebsiteRights(companyId: string, siteId: string) {
  const query = useQuery({
    queryKey: queryKeys.website.access(companyId, siteId),
    queryFn: () => websiteModuleApi.access(companyId, siteId),
    retry: false,
  });
  return { canEdit: query.data?.edit ?? false, canPublish: query.data?.publish ?? false };
}

export function WebsitePortalDocuments({ companyId, siteId }: { companyId: string; siteId: string }) {
  const isPerson = useCommercePerson();
  const { canEdit, canPublish } = useWebsiteRights(companyId, siteId);
  const canApprove = isPerson && canPublish;
  const [customerId, setCustomerId] = useState("");
  const [editing, setEditing] = useState<PortalDocumentRow | "new" | null>(null);
  const customers = useCommerceCustomers(companyId, siteId);
  const clients = (customers.data ?? [])
    .map((row) => ({ id: text(row.id) ?? "", name: text(row.name) ?? text(row.domain) ?? "Unnamed company" }))
    .filter((row) => row.id)
    .sort((a, b) => a.name.localeCompare(b.name));
  const clientName = new Map(clients.map((client) => [client.id, client.name]));
  const documents = useQuery({
    queryKey: queryKeys.website.data(companyId, siteId, "portal-documents", customerId || "all"),
    queryFn: () => websiteDataBridgeApi.list(companyId, siteId, "portal-documents", { limit: 100, ...(customerId ? { customer: customerId } : {}) }),
  });
  const change = useDocumentChange(companyId, siteId);
  const rows = (documents.data?.items ?? []).flatMap((record) => {
    const row = portalDocumentRow(record as Record<string, unknown>);
    return row ? [row] : [];
  });

  const step = (row: PortalDocumentRow, next: WebsitePortalDocumentStep) => {
    if (next === "approve-and-publish") {
      if (!row.contentSha256) return;
      return change.mutate({ operation: next, documentId: row.id, input: { expectedContentSha256: row.contentSha256 } });
    }
    if (row.rowVersion === null) return;
    change.mutate({ operation: next, documentId: row.id, input: { expectedRowVersion: row.rowVersion } });
  };

  return (
    <div className="space-y-6" data-testid="website-portal-documents">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-lg font-semibold">Portal documents</h2>
          <p className="text-sm text-muted-foreground">
            Engagement packs, NDAs, terms and the rest that each client reads in the portal.
          </p>
          {canApprove ? null : (
            <PeopleOnlyNote>
              {isPerson
                ? "A person with Publish rights for this site approves and publishes, or withdraws, a document."
                : "Agents draft and submit. A portal approver publishes, in GSAM."}
            </PeopleOnlyNote>
          )}
        </div>
        {canEdit && editing === null ? (
          <Button type="button" onClick={() => setEditing("new")} disabled={!customers.data || clients.length === 0} data-tour="website-documents-new">
            <Plus className="size-4" aria-hidden="true" />
            New draft
          </Button>
        ) : null}
      </div>

      {editing !== null ? (
        <DocumentEditor
          key={editing === "new" ? "new" : editing.id}
          companyId={companyId}
          siteId={siteId}
          row={editing === "new" ? null : editing}
          clients={clients}
          defaultCustomerId={customerId}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {clients.length ? (
        <label className="flex max-w-sm flex-col gap-1 text-sm" data-tour="website-documents-client">
          <span className="font-medium">Client company</span>
          <NativeSelect value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
            <option value="">All clients</option>
            {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
          </NativeSelect>
        </label>
      ) : null}

      <ChangeError error={change.error} operation={change.operation} />
      {documents.isLoading ? <PageSkeleton variant="list" /> : null}
      {documents.error ? <ErrorState error={documents.error} onRetry={() => void documents.refetch()} retrying={documents.isFetching} /> : null}
      {documents.data && rows.length === 0 ? (
        <EmptyState icon={FileText} message={customerId ? "This client has no portal documents yet." : "The website has no portal documents yet."} />
      ) : null}
      {rows.length ? (
        <ul className={cn(CARD, "divide-y divide-border")} aria-label="Portal documents">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4" data-testid="portal-document-row">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
                  <span className="min-w-0 break-words">{row.title}</span>
                  <span className={cn(PILL, STATUS_PILL[row.status])}>{STATUS_LABEL[row.status]}</span>
                </p>
                <p className="break-words text-xs text-muted-foreground">
                  {[
                    clientName.get(row.customerId) ?? "Unknown client",
                    PORTAL_KIND_LABEL[row.kind],
                    `Version ${row.version}`,
                    row.createdByKind === "agent" ? "Drafted by an agent" : row.createdByKind === "staff" ? "Drafted by staff" : null,
                  ].filter(Boolean).join(" · ")}
                  {row.updatedAt ? (
                    <span title={formatDateTime(row.updatedAt)}>{` · Changed ${relativeTime(row.updatedAt)}`}</span>
                  ) : null}
                </p>
              </div>
              <DocumentActions
                row={row}
                canEdit={canEdit}
                canApprove={canApprove}
                disabled={change.isPending || editing !== null}
                onEdit={() => setEditing(row)}
                onStep={(next) => step(row, next)}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function WebsitePortalDocumentsTab({ companyId, property }: { companyId: string; property: WebsiteProperty }) {
  const { site, isLoading, error } = useWebsiteSite(companyId, property.id);
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <PageSkeleton variant="list" />;
  if (!site) {
    return (
      <EmptyState
        icon={FileText}
        title="Connect the site first"
        message="Portal documents are read from and written to the connected site. Connect a site under Releases."
      />
    );
  }
  return <WebsitePortalDocuments companyId={companyId} siteId={site.id} />;
}
