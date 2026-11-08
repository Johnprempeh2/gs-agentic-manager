import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck } from "lucide-react";
import type { WebsiteReviewApproveResult } from "@greatstone/shared";
import { websiteModuleApi } from "../../api/website";
import { useConfirm } from "../../context/ConfirmContext";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorState, errorStateMessage } from "../ErrorState";
import { useCanPublishWebsite } from "./WebsiteSiteConnection";

// Bulk approve (GRE-4078): every page and entry in review, in one list. A person
// with Publish rights on the site approves them all, or the ones they tick, after
// one confirm that shows the count. Approving never publishes.

type Item = { key: string; kind: "page" | "entry"; id: string; title: string; detail: string };

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** "20 pages and 79 entries": the confirm and the result say what was counted. */
export function reviewCountText(pages: number, entries: number) {
  const parts = [pages ? plural(pages, "page", "pages") : null, entries ? plural(entries, "entry", "entries") : null].filter(Boolean);
  return parts.length ? parts.join(" and ") : "nothing";
}

function resultText(result: WebsiteReviewApproveResult) {
  const approved = reviewCountText(result.approvedPageIds.length, result.approvedEntryIds.length);
  const head = `Approved ${approved}. They go live when you Deploy.`;
  return result.skipped.length ? `${head} ${plural(result.skipped.length, "item was", "items were")} not approved.` : head;
}

export function WebsiteReviewQueue({ companyId, siteId }: { companyId: string; siteId: string }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { canPublish } = useCanPublishWebsite(companyId, siteId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<WebsiteReviewApproveResult | null>(null);
  const reviewQuery = useQuery({
    queryKey: queryKeys.website.review(companyId, siteId),
    queryFn: () => websiteModuleApi.review(companyId, siteId),
  });

  const items: Item[] = [
    ...(reviewQuery.data?.pages ?? []).map((page) => ({ key: `page:${page.id}`, kind: "page" as const, id: page.id, title: page.title, detail: page.slug })),
    ...(reviewQuery.data?.entries ?? []).map((entry) => ({ key: `entry:${entry.id}`, kind: "entry" as const, id: entry.id, title: entry.entryKey, detail: entry.collection })),
  ];
  const chosen = items.filter((item) => selected.has(item.key));

  const approve = useMutation({
    mutationFn: (only: Item[] | null) =>
      websiteModuleApi.approveReview(
        companyId,
        siteId,
        only
          ? { pageIds: only.filter((item) => item.kind === "page").map((item) => item.id), entryIds: only.filter((item) => item.kind === "entry").map((item) => item.id) }
          : {},
      ),
    onSuccess: (answer) => {
      setResult(answer);
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: queryKeys.website.review(companyId, siteId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.website.home(companyId, siteId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.website.pages(companyId, siteId) });
      void queryClient.invalidateQueries({ queryKey: ["website-entries", companyId, siteId] });
    },
  });

  if (reviewQuery.error) return <ErrorState error={reviewQuery.error} onRetry={() => void reviewQuery.refetch()} compact />;
  if (!reviewQuery.data) return null;
  if (items.length === 0 && !result) return null;

  const target = chosen.length ? chosen : items;
  const pageCount = target.filter((item) => item.kind === "page").length;
  const entryCount = target.length - pageCount;

  const onApprove = async () => {
    const ok = await confirm({
      title: chosen.length ? `Approve ${plural(target.length, "selected item", "selected items")}?` : `Approve all ${plural(target.length, "item", "items")} in review?`,
      description: `${reviewCountText(pageCount, entryCount)} become approved, each in your name. Nothing goes live until someone selects Publish.`,
      confirmLabel: `Approve ${target.length}`,
    });
    if (ok) approve.mutate(chosen.length ? chosen : null);
  };

  const toggle = (key: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <section className="space-y-3" aria-labelledby="website-review-title" data-testid="website-review-queue">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 id="website-review-title" className="text-lg font-semibold">In review</h2>
          <p className="text-xs text-muted-foreground">
            {items.length
              ? `${reviewCountText(items.filter((item) => item.kind === "page").length, items.filter((item) => item.kind === "entry").length)} waiting for approval.`
              : "Nothing is waiting for approval."}
            {canPublish ? null : " A person with Publish rights on this site approves them."}
          </p>
        </div>
        {canPublish && items.length ? (
          <Button type="button" size="sm" onClick={() => void onApprove()} disabled={approve.isPending} data-testid="website-review-approve">
            <CheckCheck />
            {approve.isPending ? "Approving" : chosen.length ? `Approve ${chosen.length} selected` : "Approve all in review"}
          </Button>
        ) : null}
      </div>
      {result ? (
        <div role="status" className="space-y-1 text-sm">
          <p className="text-status-success">{resultText(result)}</p>
          {result.skipped.length ? (
            <ul className="list-disc pl-5 text-xs text-muted-foreground">
              {result.skipped.map((item) => <li key={`${item.kind}:${item.id}`}>{item.title}: {item.reason}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
      {approve.error ? <p role="alert" className="text-sm text-status-danger">{errorStateMessage(approve.error)}</p> : null}
      {items.length ? (
        <ul className="max-h-96 divide-y divide-border overflow-y-auto rounded-xl border border-border">
          {items.map((item) => (
            <li key={item.key} className="flex items-center gap-3 px-3 py-2">
              {canPublish ? (
                <Checkbox
                  checked={selected.has(item.key)}
                  onCheckedChange={(value) => toggle(item.key, value === true)}
                  aria-label={`Select ${item.title}`}
                />
              ) : null}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{item.title}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{item.detail}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{item.kind === "page" ? "Page" : "Entry"}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
