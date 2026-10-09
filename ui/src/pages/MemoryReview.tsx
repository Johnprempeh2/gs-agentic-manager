import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox, Lock, PowerOff, SearchX, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError } from "../api/client";
import type {
  MemoryReviewQueue,
  MemoryReviewQueueItem,
  MemoryStewardAction,
  MemoryStewardActionInput,
} from "@greatstone/shared";
import { memoryReviewApi, type MemoryReviewFilters } from "../api/memoryReview";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import {
  actionErrorText,
  activeFilterCount,
  cardTitle,
  hasReviewFilters,
  mergeTargets,
  readReviewFilters,
  sortQueue,
  stewardActionHint,
  stewardActionLabel,
} from "../lib/memory-review";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { PageSkeleton } from "../components/PageSkeleton";
import { MemoryPageHeader } from "../components/memory/MemoryPageHeader";
import {
  MemoryAgeBadge,
  MemoryCardPane,
  MemoryConflictTag,
  MemoryPersonLabel,
  MemoryReviewRow,
} from "../components/memory/MemoryReviewCard";
import { MemoryStewardsSection } from "../components/memory/MemoryStewardsSection";
import { APPROVED_MEANING, scopeKindLabel } from "../components/memory/memoryLabels";
import { isMemoryDisabled } from "./Memory";

const ALL = "all";

function ReviewFilterBar({
  filters,
  facets,
  onChange,
}: {
  filters: MemoryReviewFilters;
  facets: MemoryReviewQueue["facets"] | undefined;
  onChange: (next: MemoryReviewFilters) => void;
}) {
  const [open, setOpen] = useState(false);
  const pick = (key: keyof MemoryReviewFilters) => (value: string) =>
    onChange({ ...filters, [key]: value === ALL ? undefined : value });
  const active = activeFilterCount(filters);
  return (
    <div className="space-y-2">
      {/* Phone: one button, so the proposal starts on the first screen (GRE-1095). */}
      <Button
        variant="outline"
        size="sm"
        className="sm:hidden"
        aria-expanded={open}
        aria-controls="memory-review-filters"
        onClick={() => setOpen((value) => !value)}
      >
        <SlidersHorizontal aria-hidden="true" />
        {active > 0 ? `Filters (${active})` : "Filters"}
      </Button>
      <div
        id="memory-review-filters"
        className={cn("flex-wrap items-center gap-2 sm:flex", open ? "flex" : "hidden")}
        role="search"
        aria-label="Filter the review queue"
      >
        <Select value={filters.scopeId ?? ALL} onValueChange={pick("scopeId")}>
          <SelectTrigger className="h-9 w-full sm:w-48" aria-label="Scope">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All scopes</SelectItem>
            {(facets?.scopes ?? []).map((scope) => (
              <SelectItem key={scope.id} value={scope.id}>{scope.name} ({scope.count})</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.person ?? ALL} onValueChange={pick("person")}>
          <SelectTrigger className="h-9 w-full sm:w-44" aria-label="Person">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Everyone</SelectItem>
            {(facets?.people ?? []).map((person) => (
              <SelectItem key={`${person.type}:${person.id}`} value={`${person.type}:${person.id}`}>
                {person.name} ({person.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.app ?? ALL} onValueChange={pick("app")}>
          <SelectTrigger className="h-9 w-full sm:w-40" aria-label="App">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All apps</SelectItem>
            {(facets?.apps ?? []).map((app) => (
              <SelectItem key={app.app} value={app.app}>{app.app} ({app.count})</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.age ?? ALL} onValueChange={pick("age")}>
          <SelectTrigger className="h-9 w-full sm:w-40" aria-label="Age">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any age</SelectItem>
            <SelectItem value="fresh">Under 7 days</SelectItem>
            <SelectItem value="overdue">Over 7 days</SelectItem>
            <SelectItem value="expired">Expired (30+ days)</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filters.conflict ?? ALL} onValueChange={pick("conflict")}>
          <SelectTrigger className="h-9 w-full sm:w-44" aria-label="Conflict">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any conflict state</SelectItem>
            <SelectItem value="true">Conflict only</SelectItem>
            <SelectItem value="false">No conflict</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/** One dialog for every action: each needs a reason; edit adds the new text, merge a target. */
function StewardActionDialog({
  item,
  action,
  queue,
  companyId,
  onClose,
}: {
  item: MemoryReviewQueueItem;
  action: MemoryStewardAction;
  queue: MemoryReviewQueueItem[];
  companyId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [title, setTitle] = useState(item.proposal.title ?? "");
  const [content, setContent] = useState(item.proposal.content ?? "");
  const targets = useMemo(() => mergeTargets(item, queue), [item, queue]);
  const [intoRecordId, setIntoRecordId] = useState(targets[0]?.id ?? "");

  const submit = useMutation({
    mutationFn: () => {
      const base = { expectedVersion: item.proposal.version, reason: reason.trim() };
      let body: MemoryStewardActionInput;
      if (action === "edit_and_confirm") body = { action, ...base, title: title.trim() || null, content: content.trim() };
      else if (action === "merge") body = { action, ...base, intoRecordId };
      else body = { action, ...base };
      return memoryReviewApi.act(companyId, item.proposal.id, body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.memoryReview.all(companyId) });
      onClose();
    },
  });

  const ready =
    reason.trim().length > 0 &&
    (action !== "edit_and_confirm" || content.trim().length > 0) &&
    (action !== "merge" || intoRecordId.length > 0);

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{stewardActionLabel[action]}: {cardTitle(item.proposal)}</DialogTitle>
          <DialogDescription>{stewardActionHint[action]}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !submit.isPending) submit.mutate();
          }}
        >
          {action === "edit_and_confirm" ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="steward-edit-title">Title</Label>
                <Input id="steward-edit-title" value={title} onChange={(event) => setTitle(event.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="steward-edit-content">Card text</Label>
                <Textarea id="steward-edit-content" rows={5} value={content} onChange={(event) => setContent(event.target.value)} />
              </div>
            </>
          ) : null}
          {action === "merge" ? (
            <div className="space-y-1.5">
              <Label htmlFor="steward-merge-target">Merge into</Label>
              {targets.length === 0 ? (
                <p className="text-sm text-muted-foreground">No other card in this scope to merge into.</p>
              ) : (
                <Select value={intoRecordId} onValueChange={setIntoRecordId}>
                  <SelectTrigger id="steward-merge-target" className="h-9 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {targets.map((target) => (
                      <SelectItem key={target.id} value={target.id}>{target.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="steward-reason">Reason</Label>
            <Textarea
              id="steward-reason"
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why, in one line. Kept in the card history."
            />
          </div>
          {submit.error ? <p role="alert" className="text-sm text-destructive">{actionErrorText(submit.error)}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button
              type="submit"
              variant={action === "reject" ? "destructive" : "default"}
              disabled={!ready || submit.isPending}
            >
              {submit.isPending ? "Saving…" : stewardActionLabel[action]}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReviewDetail({
  item,
  onAction,
}: {
  item: MemoryReviewQueueItem;
  onAction: (action: MemoryStewardAction) => void;
}) {
  const { proposal } = item;
  return (
    <article className="min-w-0 space-y-3" aria-label="Proposal under review">
      <div className="space-y-1.5">
        <h2 className="text-base font-semibold break-words">{cardTitle(proposal)}</h2>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="text-muted-foreground">Proposed by</span>
          <MemoryPersonLabel actor={item.proposer} />
          {item.editedBy ? (
            <>
              <span className="text-muted-foreground">· edited by</span>
              <MemoryPersonLabel actor={item.editedBy} />
            </>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>{item.scope.name} · {scopeKindLabel[item.scope.kind]}</span>
          <MemoryAgeBadge item={item} />
          {item.conflictIds.length > 0 ? <MemoryConflictTag /> : null}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <MemoryCardPane
          heading="Confirmed now"
          tone="current"
          record={item.current}
          emptyText="Nothing confirmed yet. This proposal adds a new card."
        />
        <MemoryCardPane heading="Proposed" tone="proposed" record={proposal} />
      </div>

      {item.conflictIds.length > 0 ? (
        <p className="rounded-md bg-status-alert-soft px-3 py-2 text-sm text-status-alert-foreground">
          This proposal conflicts with a confirmed card. Settle the conflict, or edit, merge or reject the proposal.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => onAction("confirm")} disabled={!item.allowed.confirm}>Confirm</Button>
        <Button variant="outline" onClick={() => onAction("edit_and_confirm")} disabled={!item.allowed.edit_and_confirm}>
          {stewardActionLabel.edit_and_confirm}
        </Button>
        <Button variant="outline" onClick={() => onAction("merge")} disabled={!item.allowed.merge}>Merge</Button>
        <Button variant="outline" onClick={() => onAction("reject")} disabled={!item.allowed.reject}>Reject</Button>
      </div>
      {item.blockedReason ? (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {item.blockedReason}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{APPROVED_MEANING}</p>
    </article>
  );
}

export function MemoryReview() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readReviewFilters(params), [params]);
  const selectedId = params.get("card");
  const view = params.get("view") === "stewards" ? "stewards" : "queue";
  const [pendingAction, setPendingAction] = useState<MemoryStewardAction | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Memory", href: "/memory" }, { label: "Review" }]);
  }, [setBreadcrumbs]);

  const updateParams = useCallback(
    (patch: Record<string, string | undefined>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(patch)) {
            if (value) next.set(key, value);
            else next.delete(key);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const queue = useQuery({
    queryKey: queryKeys.memoryReview.queue(selectedCompanyId ?? "", { ...filters }),
    queryFn: () => memoryReviewApi.queue(selectedCompanyId!, filters),
    enabled: !!selectedCompanyId,
    placeholderData: (previous) => previous,
    retry: (count, error) => !(error instanceof ApiError && (error.status === 403 || isMemoryDisabled(error))) && count < 2,
  });

  const items = useMemo(() => sortQueue(queue.data?.items ?? []), [queue.data]);
  const selected = items.find((item) => item.proposal.id === selectedId) ?? items[0] ?? null;

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select an organization first.</p>;
  }

  const header = <MemoryPageHeader tab="review" />;

  if (queue.error instanceof ApiError && queue.error.status === 403) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState icon={Lock} message="Only stewards and the owner can review memory." description="Ask the owner to name you steward for a scope." />
      </div>
    );
  }
  if (isMemoryDisabled(queue.error)) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState icon={PowerOff} message="Memory is turned off for this organization." description="A board admin can turn it on in organization settings." />
      </div>
    );
  }

  const setFilters = (next: MemoryReviewFilters) =>
    updateParams({ scope: next.scopeId, person: next.person, app: next.app, age: next.age, conflict: next.conflict, card: undefined });
  const overdue = items.filter((item) => item.ageFlag === "overdue").length;

  return (
    <div className="space-y-4">
      {header}
      {/* Review is the daily task; steward setup is rare, so it has its own view (GRE-1095). */}
      <Tabs value={view} onValueChange={(value) => updateParams({ view: value === "stewards" ? value : undefined, card: undefined })}>
        <TabsList variant="line" className="justify-start" aria-label="Review view">
          <TabsTrigger value="queue">Queue</TabsTrigger>
          <TabsTrigger value="stewards">Stewards</TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="mt-2 space-y-4">
          <ReviewFilterBar filters={filters} facets={queue.data?.facets} onChange={setFilters} />

          {queue.isLoading ? (
            <PageSkeleton variant="list" />
          ) : queue.error && !queue.data ? (
            <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />
          ) : items.length === 0 ? (
            hasReviewFilters(filters) ? (
              <EmptyState
                icon={SearchX}
                message="No proposals match these filters."
                action="Clear filters"
                onAction={() => setFilters({})}
                hideActionIcon
              />
            ) : (
              <EmptyState icon={Inbox} message="Nothing waiting for review." description="New proposals in your scopes appear here." />
            )
          ) : (
            <div className="grid gap-4 lg:grid-cols-(--gtc-memory-review)">
              <section className="min-w-0 self-start overflow-hidden rounded-lg border border-border bg-card" aria-label="Review queue">
                <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
                  {items.length} waiting{overdue > 0 ? ` · ${overdue} over 7 days` : ""}
                </div>
                <ul className="max-h-48 divide-y divide-border overflow-y-auto lg:max-h-(--sz-memory-list-max)">
                  {items.map((item) => (
                    <MemoryReviewRow
                      key={item.proposal.id}
                      item={item}
                      selected={item.proposal.id === selected?.proposal.id}
                      onSelect={() => updateParams({ card: item.proposal.id })}
                    />
                  ))}
                </ul>
              </section>
              {selected ? <ReviewDetail item={selected} onAction={setPendingAction} /> : null}
            </div>
          )}
        </TabsContent>

        <TabsContent value="stewards" className="mt-2">
          <MemoryStewardsSection companyId={selectedCompanyId} />
        </TabsContent>
      </Tabs>

      {selected && pendingAction ? (
        <StewardActionDialog
          key={`${selected.proposal.id}:${pendingAction}`}
          item={selected}
          action={pendingAction}
          queue={items}
          companyId={selectedCompanyId}
          onClose={() => setPendingAction(null)}
        />
      ) : null}
    </div>
  );
}
