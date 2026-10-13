import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Loader2, Maximize2, Minimize2, X } from "lucide-react";
import { issuesApi } from "../api/issues";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";
import { MarkdownBody } from "./MarkdownBody";
import { Button } from "./ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./ui/sheet";

export interface IssueDocumentRef {
  issueId: string;
  key: string;
  /** The revision the card asks about; the latest when absent. */
  revisionId?: string | null;
  label: string;
  /** The task page, for "Open in task". */
  taskHref?: string | null;
}

/**
 * Reads an issue document (a plan, an investigation plan) right where the
 * decision is made (Ben, 13 Oct: the plan link on a Decisions card looked like
 * a tag and opened a narrow panel he then had to find and widen). Opens wide,
 * with a labelled Full width and Close, and the exact revision the card asks
 * about.
 */
export function IssueDocumentSheet({
  open,
  onOpenChange,
  document,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: IssueDocumentRef;
}) {
  const [full, setFull] = useState(false);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        data-testid="issue-document-sheet"
        className={cn("w-full gap-0 p-0", full ? "sm:max-w-none" : "sm:max-w-3xl")}
      >
        <SheetHeader className="flex-row items-start justify-between gap-3 border-b border-border">
          <div className="min-w-0">
            <SheetTitle className="text-base">{document.label}</SheetTitle>
            <SheetDescription>The document this decision is about.</SheetDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" variant="outline" size="sm" onClick={() => setFull((value) => !value)} className="hidden sm:inline-flex">
              {full ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
              {full ? "Narrow" : "Full width"}
            </Button>
            {document.taskHref ? (
              <Button asChild variant="outline" size="sm">
                <Link to={document.taskHref} disableIssueQuicklook onClick={() => onOpenChange(false)}>
                  <ExternalLink aria-hidden="true" />
                  Open in task
                </Link>
              </Button>
            ) : null}
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              <X aria-hidden="true" />
              Close
            </Button>
          </div>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {open ? <IssueDocumentBody document={document} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function IssueDocumentBody({ document }: { document: IssueDocumentRef }) {
  const { issueId, key, revisionId } = document;
  const { data, isLoading, error } = useQuery({
    queryKey: ["issues", "documents", issueId, key, revisionId ?? "latest"],
    queryFn: async () => {
      if (revisionId) {
        const revisions = await issuesApi.listDocumentRevisions(issueId, key);
        const revision = revisions.find((entry) => entry.id === revisionId);
        if (revision) return revision.body;
      }
      return (await issuesApi.getDocument(issueId, key)).body;
    },
  });
  if (isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading the document...
      </p>
    );
  }
  if (error || data === undefined) {
    return <p className="text-sm text-destructive">Could not load the document. Try Open in task.</p>;
  }
  return <MarkdownBody className="mx-auto max-w-3xl text-sm leading-7">{data}</MarkdownBody>;
}
