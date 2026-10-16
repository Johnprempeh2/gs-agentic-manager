import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IssueDocumentLink } from "@greatstone/shared";
import { Link2, X } from "lucide-react";
import { Link } from "@/lib/router";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { issueUrl } from "../lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/** Plain label for the version a linked document is on, and the approved one. */
export function describeLinkedDocumentVersion(link: Pick<
  IssueDocumentLink,
  "latestRevisionNumber" | "approvedRevisionNumber"
>) {
  const latest = `Version ${link.latestRevisionNumber}`;
  if (link.approvedRevisionNumber == null) return `${latest}, not approved yet`;
  if (link.approvedRevisionNumber === link.latestRevisionNumber) return `${latest}, approved`;
  return `${latest}, approved version is ${link.approvedRevisionNumber}`;
}

/**
 * Documents this task reads from other tasks. Each one is the live document
 * on its own task, not a copy, so everyone sees the same latest version.
 */
export function IssueLinkedDocuments({
  issueId,
  canRemoveLinks = false,
}: {
  issueId: string;
  canRemoveLinks?: boolean;
}) {
  const queryClient = useQueryClient();
  const { data: links, error } = useQuery({
    queryKey: queryKeys.issues.documentLinks(issueId),
    queryFn: () => issuesApi.listDocumentLinks(issueId),
  });
  const removeLink = useMutation({
    mutationFn: (linkId: string) => issuesApi.deleteDocumentLink(issueId, linkId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.documentLinks(issueId) });
    },
  });

  if (error) {
    return <p className="text-xs text-destructive">Could not load shared documents.</p>;
  }
  if (!links || links.length === 0) return null;

  return (
    <section aria-label="Shared documents" className="space-y-2">
      <h4 className="text-xs font-medium text-muted-foreground">Shared from other tasks</h4>
      <ul className="space-y-2">
        {links.map((link) => {
          const sourceLabel = link.sourceIssueIdentifier ?? link.sourceIssueTitle;
          const documentHref = `${issueUrl({ id: link.sourceIssueId, identifier: link.sourceIssueIdentifier })}#document-${link.key}`;
          return (
            <li
              key={link.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2 text-sm"
            >
              <Link2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              <Link to={documentHref} className="font-medium hover:underline">
                {link.title || link.key}
              </Link>
              <span className="text-xs text-muted-foreground">from {sourceLabel}</span>
              <Badge variant="secondary">{describeLinkedDocumentVersion(link)}</Badge>
              {canRemoveLinks ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="ml-auto text-muted-foreground"
                  title="Remove link"
                  aria-label={`Remove link to ${link.title || link.key}`}
                  onClick={() => removeLink.mutate(link.id)}
                  disabled={removeLink.isPending}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {removeLink.error ? (
        <p className="text-xs text-destructive">Could not remove the link. Try again.</p>
      ) : null}
    </section>
  );
}
