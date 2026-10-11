import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Link2, Package, Paperclip, Plus, X } from "lucide-react";
import type {
  ClientEvidenceCandidate,
  ClientEvidenceItem,
  ClientFileSourceIssue,
  Deliverable,
} from "@greatstone/shared";
import { pipelinesApi } from "../api/pipelines";
import { useToastActions } from "../context/ToastContext";
import { Link } from "@/lib/router";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { queryKeys } from "../lib/queryKeys";
import { formatDate } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

function formatDay(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? formatDate(date) : value;
}

function issuePath(issue: { id: string; identifier: string | null }) {
  return createIssueDetailPath(issue.identifier ?? issue.id);
}

/** In-app link for an evidence item; links to outside sites open in a new tab. */
function evidenceHref(item: ClientEvidenceItem) {
  if (item.kind === "document" && item.sourceIssue) {
    return `${issuePath(item.sourceIssue)}${item.documentKey ? `#document-${encodeURIComponent(item.documentKey)}` : ""}`;
  }
  return item.openPath;
}

function KindIcon({ kind }: { kind: ClientEvidenceItem["kind"] | "deliverable" }) {
  const className = "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground";
  if (kind === "link") return <Link2 className={className} aria-hidden="true" />;
  if (kind === "document") return <FileText className={className} aria-hidden="true" />;
  if (kind === "deliverable") return <Package className={className} aria-hidden="true" />;
  return <Paperclip className={className} aria-hidden="true" />;
}

function SourceTask({ issue }: { issue: ClientFileSourceIssue | { id: string; identifier: string | null; title: string } | null }) {
  if (!issue) return null;
  return (
    <Link to={issuePath(issue)} className="text-foreground hover:underline" title={issue.title}>
      {issue.identifier ?? "Task"}
    </Link>
  );
}

function Meta({ parts }: { parts: ReactNode[] }) {
  const shown = parts.filter(Boolean);
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
      {shown.map((part, index) => (
        <span key={index} className="inline-flex items-center gap-1.5">
          {index > 0 ? <span aria-hidden="true">·</span> : null}
          {part}
        </span>
      ))}
    </p>
  );
}

function ItemTitle({ href, external, title }: { href: string; external: boolean; title: string }) {
  const className = "block truncate font-medium text-foreground hover:underline";
  if (href.startsWith("/api/") || external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className} title={title}>
        {title}
      </a>
    );
  }
  return (
    <Link to={href} className={className} title={title}>
      {title}
    </Link>
  );
}

function EvidenceRow({ item, busy, onRemove }: { item: ClientEvidenceItem; busy: boolean; onRemove: () => void }) {
  const addedBy = item.addedBy ? item.addedBy.name ?? (item.addedBy.type === "agent" ? "An agent" : "Board") : null;
  return (
    <li className="flex items-start gap-2 py-2 text-sm">
      <KindIcon kind={item.kind} />
      <div className="min-w-0 flex-1">
        <ItemTitle href={evidenceHref(item)} external={item.kind === "link"} title={item.title} />
        <Meta
          parts={[
            item.typeLabel,
            formatDay(item.createdAt),
            addedBy ? `Added by ${addedBy}` : null,
            item.sourceIssue ? <SourceTask issue={item.sourceIssue} /> : null,
          ]}
        />
        {item.note ? <p className="mt-1 text-xs text-muted-foreground">{item.note}</p> : null}
      </div>
      <button
        type="button"
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        aria-label={`Remove ${item.title} from evidence`}
        disabled={busy}
        onClick={onRemove}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

function LinkForm({ pending, onSubmit }: { pending: boolean; onSubmit: (input: { title: string; url: string }) => void }) {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const valid = title.trim().length > 0 && /^https?:\/\/\S+$/i.test(url.trim());
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    onSubmit({ title: title.trim(), url: url.trim() });
  };
  return (
    <form className="grid gap-2 sm:grid-cols-2" onSubmit={submit}>
      <Input aria-label="Link name" placeholder="Name, e.g. Notion brief" value={title} onChange={(event) => setTitle(event.target.value)} />
      <Input aria-label="Link address" placeholder="https://..." type="url" value={url} onChange={(event) => setUrl(event.target.value)} />
      <div className="sm:col-span-2">
        <Button type="submit" size="sm" disabled={pending || !valid}>
          {pending ? "Adding..." : "Add link"}
        </Button>
      </div>
    </form>
  );
}

function AddEvidencePanel({
  caseId,
  pending,
  onAdd,
  onClose,
}: {
  caseId: string;
  pending: boolean;
  onAdd: (candidate: ClientEvidenceCandidate | { title: string; url: string }) => void;
  onClose: () => void;
}) {
  const candidates = useQuery({
    queryKey: queryKeys.pipelines.caseEvidenceCandidates(caseId),
    queryFn: () => pipelinesApi.listCaseEvidenceCandidates(caseId),
  });
  const rows = candidates.data?.candidates ?? [];
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">Files and documents on this client's tasks</p>
        {candidates.isLoading ? (
          <p className="py-2 text-sm text-muted-foreground">Loading files...</p>
        ) : candidates.error ? (
          <p className="py-2 text-sm text-destructive">Could not load the files on this client's tasks.</p>
        ) : rows.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            No more files on this client's tasks. Link a task or a project to the client to see its files here.
          </p>
        ) : (
          <ul className="max-h-64 divide-y divide-border overflow-y-auto">
            {rows.map((candidate) => (
              <li key={candidate.attachmentId ?? candidate.documentId} className="flex items-start gap-2 py-2 text-sm">
                <KindIcon kind={candidate.kind} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-foreground" title={candidate.title}>{candidate.title}</p>
                  <Meta parts={[candidate.typeLabel, formatDay(candidate.createdAt), <SourceTask issue={candidate.sourceIssue} />]} />
                </div>
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => onAdd(candidate)}>
                  Add
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">Or add a link</p>
        <LinkForm pending={pending} onSubmit={onAdd} />
      </div>
      <Button type="button" size="sm" variant="ghost" onClick={onClose} disabled={pending}>
        Done
      </Button>
    </div>
  );
}

function useCaseFiles(caseId: string) {
  return useQuery({
    queryKey: queryKeys.pipelines.caseFiles(caseId),
    queryFn: () => pipelinesApi.getCaseFiles(caseId),
  });
}

/** The client's own material: files and documents from its tasks, and links (GRE-1311). */
export function PipelineCaseEvidence({ caseId }: { caseId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [adding, setAdding] = useState(false);
  const files = useCaseFiles(caseId);

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseFiles(caseId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseEvidenceCandidates(caseId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseEvents(caseId) }),
    ]);

  const addEvidence = useMutation({
    mutationFn: (input: ClientEvidenceCandidate | { title: string; url: string }) => {
      if ("url" in input) return pipelinesApi.addCaseEvidence(caseId, { kind: "link", title: input.title, url: input.url });
      if (input.kind === "attachment" && input.attachmentId) {
        return pipelinesApi.addCaseEvidence(caseId, { kind: "attachment", attachmentId: input.attachmentId });
      }
      return pipelinesApi.addCaseEvidence(caseId, { kind: "document", documentId: input.documentId! });
    },
    onSuccess: invalidate,
    onError: () => pushToast({ title: "Could not add to evidence", body: "It may already be in the list.", tone: "error" }),
  });
  const removeEvidence = useMutation({
    mutationFn: (evidenceId: string) => pipelinesApi.removeCaseEvidence(caseId, evidenceId),
    onSuccess: invalidate,
    onError: () => pushToast({ title: "Could not remove the item", tone: "error" }),
  });

  if (files.isLoading) return <p className="py-3 text-sm text-muted-foreground">Loading evidence...</p>;
  if (files.error) return <p className="py-3 text-sm text-destructive">Could not load evidence.</p>;

  const rows = files.data?.evidence ?? [];
  const busy = addEvidence.isPending || removeEvidence.isPending;
  return (
    <div className="space-y-3 py-3">
      {rows.length > 0 ? (
        <ul className="divide-y divide-border">
          {rows.map((item) => (
            <EvidenceRow key={item.id} item={item} busy={busy} onRemove={() => removeEvidence.mutate(item.id)} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No evidence yet. Add the client's files, documents and links here.</p>
      )}
      {adding ? (
        <AddEvidencePanel
          caseId={caseId}
          pending={addEvidence.isPending}
          onAdd={(input) => addEvidence.mutate(input)}
          onClose={() => setAdding(false)}
        />
      ) : (
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setAdding(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add evidence
        </Button>
      )}
    </div>
  );
}

function DeliverableRow({ item }: { item: Deliverable }) {
  return (
    <li className="flex items-start gap-2 py-2 text-sm">
      <KindIcon kind="deliverable" />
      <div className="min-w-0 flex-1">
        <ItemTitle href={item.openPath} external={false} title={item.title} />
        <Meta
          parts={[
            item.kind.charAt(0).toUpperCase() + item.kind.slice(1),
            formatDay(item.createdAt),
            item.createdByAgent ? `Added by ${item.createdByAgent.name}` : null,
            <SourceTask issue={item.issue} />,
          ]}
        />
      </div>
    </li>
  );
}

/** What we made for the client: deliverables on its linked tasks and project tasks (GRE-1311). */
export function PipelineCaseDeliverables({ caseId }: { caseId: string }) {
  const files = useCaseFiles(caseId);
  if (files.isLoading) return <p className="py-3 text-sm text-muted-foreground">Loading deliverables...</p>;
  if (files.error) return <p className="py-3 text-sm text-destructive">Could not load deliverables.</p>;
  const rows = files.data?.deliverables ?? [];
  if (rows.length === 0) {
    return (
      <p className="py-3 text-sm text-muted-foreground">
        No deliverables yet. Deliverables registered on this client's tasks and projects show here.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {rows.map((item) => (
        <DeliverableRow key={item.id} item={item} />
      ))}
    </ul>
  );
}
