import { useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  formatEvidenceSource,
  type DocumentEvidenceBulletCheck,
  type DocumentEvidenceFlagCategory,
  type DocumentEvidenceView,
} from "@greatstone/shared";
import { ChevronRight, Link2 } from "lucide-react";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

/**
 * Evidence trail under an issue document (GRE-1146): each bullet's source
 * links and labels, and the automatic check, for the human reviewer at R2.
 * Agents write the links through the API; this panel is read-only.
 */

const CATEGORY: Record<DocumentEvidenceFlagCategory, { label: string; color: string }> = {
  no_source: { label: "No source", color: "var(--status-danger)" },
  label_missing: { label: "Label missing", color: "var(--status-warning)" },
  judgement: { label: "Judgement", color: "var(--status-info)" },
  ok: { label: "Sourced", color: "var(--status-success)" },
};

const CHIP = "status-chip inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium";

function chipStyle(color: string): CSSProperties {
  return { "--sc": color } as CSSProperties;
}

/** "0 no source, 1 label missing, 5 judgement of 27 bullets. Pass (4% under 20%)." */
export function evidenceCheckSummary(check: DocumentEvidenceView["check"]): string {
  const { totals } = check;
  const rate = Math.round(check.flagRate * 100);
  const mark = Math.round(check.passMark * 100);
  return (
    `${totals.noSource} no source, ${totals.labelMissing} label missing, ${totals.judgement} judgement ` +
    `of ${totals.bullets} bullet${totals.bullets === 1 ? "" : "s"}. ` +
    (check.pass ? `Pass (${rate}% under ${mark}%).` : `Not yet (${rate}% flagged, must be under ${mark}%).`)
  );
}

export function DocumentEvidencePanel({ view, defaultOpen = false }: { view: DocumentEvidenceView; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const checks = new Map<string, DocumentEvidenceBulletCheck>(view.check.bullets.map((bullet) => [bullet.bulletId, bullet]));
  const seen = new Set<string>();
  const bullets = view.bullets.filter((bullet) => {
    if (seen.has(bullet.bulletId)) return false;
    seen.add(bullet.bulletId);
    return true;
  });

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border border-border" data-testid="document-evidence">
      <CollapsibleTrigger className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-sm">
        <ChevronRight className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-90")} aria-hidden />
        <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-medium">Evidence</span>
        <span className="basis-full pl-12 text-xs text-muted-foreground">{evidenceCheckSummary(view.check)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="divide-y divide-border border-t border-border">
          {bullets.map((bullet) => {
            const check = checks.get(bullet.bulletId);
            const category = CATEGORY[check?.category ?? "no_source"];
            return (
              <li key={bullet.bulletId} className="space-y-1 px-3 py-2 text-sm" data-bullet={bullet.bulletId}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-semibold">{bullet.bulletId}</span>
                  <span className={CHIP} style={chipStyle(category.color)}>{category.label}</span>
                  {bullet.link?.inference ? <span className={CHIP} style={chipStyle("var(--status-task-icon-backlog)")}>Inference</span> : null}
                  {bullet.link?.judgement ? <span className={CHIP} style={chipStyle("var(--status-task-icon-backlog)")}>Suggested, judgement</span> : null}
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" title={bullet.text}>{bullet.text}</span>
                </div>
                {bullet.link && bullet.link.sources.length > 0 ? (
                  <ul className="space-y-0.5 pl-1 text-xs">
                    {bullet.link.sources.map((source, index) => (
                      <li key={`${source.sourceId}-${index}`} className="break-words">
                        {source.locator && /^https?:\/\//.test(source.locator) ? (
                          <a href={source.locator} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                            {formatEvidenceSource(source)}
                          </a>
                        ) : (
                          formatEvidenceSource(source)
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {check && check.category !== "ok" && check.category !== "judgement" ? (
                  <ul className="pl-1 text-xs text-muted-foreground">
                    {check.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
        {view.orphanedLinks.length > 0 ? (
          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            Links for bullets no longer in the document: {view.orphanedLinks.map((link) => link.bulletId).join(", ")}.
          </p>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Shows nothing until an agent or person has linked a source to a bullet in this document. */
export function IssueDocumentEvidence({ issueId, documentKey, revisionNumber }: {
  issueId: string;
  documentKey: string;
  revisionNumber: number;
}) {
  const query = useQuery({
    queryKey: [...queryKeys.issues.documentEvidence(issueId, documentKey), revisionNumber],
    queryFn: () => issuesApi.getDocumentEvidence(issueId, documentKey),
  });
  const view = query.data;
  // A document that is being created or was just deleted has no evidence yet: not an error worth showing.
  if (query.isError && !(query.error instanceof ApiError && query.error.status === 404)) {
    return <p className="px-1 text-xs text-destructive">Could not load the evidence for this document. Reload the page to try again.</p>;
  }
  if (!view) return null;
  const hasLinks = view.bullets.some((bullet) => bullet.link) || view.orphanedLinks.length > 0;
  if (!hasLinks) return null;
  return <DocumentEvidencePanel view={view} />;
}
