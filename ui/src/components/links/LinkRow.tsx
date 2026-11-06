import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Check, Copy, ExternalLink, Link2 } from "lucide-react";
import { LINK_TYPES, type LinkItem, type LinkRef, type LinkType } from "@greatstone/shared";
import { Link } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { linksApi } from "../../api/links";
import { useOptionalToastActions } from "../../context/ToastContext";
import { createIssueDetailPath } from "../../lib/issueDetailBreadcrumb";
import { LINK_STATUS_LABELS, LINK_TYPE_LABELS, linkClientLabel, shortLinkUrl } from "../../lib/links-register";
import { queryKeys } from "../../lib/queryKeys";
import { useCopyAction } from "../../lib/use-copy-action";
import { cn, formatDate } from "../../lib/utils";

function formatDay(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? formatDate(date) : null;
}

/** Spacing, not separator characters, so a wrapped line on a phone always starts with content. */
function Meta({ parts }: { parts: Array<React.ReactNode | null | false> }) {
  const shown = parts.filter(Boolean);
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      {shown.map((part, index) => (
        <span key={index}>{part}</span>
      ))}
    </p>
  );
}

/**
 * One link: the title opens the site in a new tab, the second line shows the
 * address, and the meta line links back to the task it came from.
 */
export function LinkRow({
  link,
  companyId,
  showClient = false,
}: {
  link: LinkItem;
  companyId: string;
  showClient?: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useOptionalToastActions();
  const copy = useCopyAction();
  const archived = link.status === "archived";
  const toggleArchive = useMutation({
    mutationFn: () => (archived ? linksApi.update(companyId, link.id, { status: "live" }) : linksApi.archive(companyId, link.id)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.links.all(companyId) }),
    onError: (error) =>
      toast?.pushToast({
        title: archived ? "Could not restore the link" : "Could not archive the link",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      }),
  });
  const addedBy = link.addedBy ? link.addedBy.name ?? (link.addedBy.type === "agent" ? "An agent" : "Board") : null;
  const project = link.project?.name ?? link.projectName;
  const client = showClient ? linkClientLabel(link) : null;

  return (
    <li className="flex items-start gap-3 py-3 text-sm" data-testid="link-row">
      <Link2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 truncate font-medium text-foreground hover:underline"
            title={link.title}
          >
            {link.title}
          </a>
          <Badge variant="outline" className="shrink-0">{LINK_TYPE_LABELS[link.type]}</Badge>
          {link.status !== "live" ? (
            <Badge
              variant={link.status === "broken" ? "destructive" : "secondary"}
              className="shrink-0"
            >
              {LINK_STATUS_LABELS[link.status]}
            </Badge>
          ) : null}
        </div>
        <a
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-0.5 block truncate text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          {shortLinkUrl(link.url)}
        </a>
        <Meta
          parts={[
            client ? `Client: ${client}` : null,
            project ? `Project: ${project}` : null,
            link.sourceIssue ? (
              <Link
                to={createIssueDetailPath(link.sourceIssue.identifier ?? link.sourceIssue.id)}
                className="text-foreground hover:underline"
                title={link.sourceIssue.title}
              >
                {link.sourceIssue.identifier ?? "Task"}
              </Link>
            ) : null,
            formatDay(link.deployedAt ?? link.createdAt),
            addedBy ? `Added by ${addedBy}` : null,
          ]}
        />
        {link.notes ? <p className="mt-1 text-xs text-muted-foreground">{link.notes}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="text-muted-foreground"
          aria-label={copy.copied ? "Copied" : `Copy the address of ${link.title}`}
          title="Copy the address"
          onClick={() => void copy.copy(link.url)}
        >
          {copy.copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
        <Button
          asChild
          size="icon-sm"
          variant="ghost"
          className="hidden text-muted-foreground sm:inline-flex"
        >
          <a href={link.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${link.title}`} title="Open in a new tab">
            <ExternalLink className="size-4" />
          </a>
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className={cn("text-muted-foreground", !archived && "hover:text-destructive")}
          aria-label={archived ? `Restore ${link.title}` : `Archive ${link.title}`}
          title={archived ? "Restore" : "Archive"}
          disabled={toggleArchive.isPending}
          onClick={() => toggleArchive.mutate()}
        >
          {archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
        </Button>
      </div>
    </li>
  );
}

/**
 * Add a link by hand. Deliverables and previews arrive on their own; this is
 * for anything else that was shared (a Notion page, a portal). The same
 * address again updates the stored link.
 */
export function AddLinkDialog({
  companyId,
  open,
  onOpenChange,
  clientCaseId,
  clients = [],
  projects = [],
}: {
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fixed client (the client page); otherwise the user may pick one. */
  clientCaseId?: string;
  clients?: LinkRef[];
  projects?: LinkRef[];
}) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [type, setType] = useState<LinkType>("other");
  const [client, setClient] = useState("");
  const [project, setProject] = useState("");
  const [notes, setNotes] = useState("");

  const save = useMutation({
    mutationFn: () =>
      linksApi.create(companyId, {
        url: url.trim(),
        title: title.trim(),
        type,
        ...(clientCaseId || client ? { clientCaseId: clientCaseId ?? client } : {}),
        ...(project ? { projectId: project } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.links.all(companyId) });
      setUrl("");
      setTitle("");
      setType("other");
      setClient("");
      setProject("");
      setNotes("");
      onOpenChange(false);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!url.trim() || !title.trim()) return;
    save.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Add a link</DialogTitle>
            <DialogDescription>
              Deliverables and previews are added for you. Add anything else you share here.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="link-url">Address</Label>
            <Input id="link-url" type="url" inputMode="url" placeholder="https://" value={url} onChange={(event) => setUrl(event.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="link-title">Title</Label>
            <Input id="link-title" placeholder="Acme proposal site" value={title} onChange={(event) => setTitle(event.target.value)} required />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="link-type">Type</Label>
              <NativeSelect id="link-type" value={type} onChange={(event) => setType(event.target.value as LinkType)}>
                {LINK_TYPES.map((value) => (
                  <option key={value} value={value}>{LINK_TYPE_LABELS[value]}</option>
                ))}
              </NativeSelect>
            </div>
            {projects.length > 0 ? (
              <div className="space-y-1.5">
                <Label htmlFor="link-project">Project</Label>
                <NativeSelect id="link-project" value={project} onChange={(event) => setProject(event.target.value)}>
                  <option value="">None</option>
                  {projects.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
            {!clientCaseId && clients.length > 0 ? (
              <div className="space-y-1.5">
                <Label htmlFor="link-client">Client</Label>
                <NativeSelect id="link-client" value={client} onChange={(event) => setClient(event.target.value)}>
                  <option value="">From the project, or none</option>
                  {clients.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="link-notes">Notes</Label>
            <Textarea id="link-notes" rows={2} placeholder="Who it was sent to, the password hint, ..." value={notes} onChange={(event) => setNotes(event.target.value)} />
          </div>
          {save.error ? (
            <p className="text-sm text-destructive" role="alert">
              {save.error instanceof Error ? save.error.message : "Could not save the link."}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={save.isPending || !url.trim() || !title.trim()}>
              {save.isPending ? "Saving..." : "Add link"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
