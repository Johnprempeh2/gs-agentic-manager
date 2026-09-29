import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Issue } from "@greatstone/shared";
import { issuesApi } from "@/api/issues";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import {
  registerBlockedDependentsHandler,
  type BlockedDependentsDecision,
  type BlockedDependentsRequest,
} from "@/lib/blocked-dependents-handoff";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusIcon } from "./StatusIcon";

const MOVE_TARGET_SEARCH_LIMIT = 20;
const CLOSED_STATUSES = new Set(["done", "cancelled"]);

interface PendingRequest extends BlockedDependentsRequest {
  resolve: (decision: BlockedDependentsDecision | null) => void;
}

/**
 * GRE-235: mounted once in the layout. When a cancel is refused because the
 * task still blocks open tasks, lists them and lets the person move them to
 * another task or remove the blocker. Closing the dialog changes nothing.
 */
export function BlockedDependentsDialogHost() {
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const pendingRef = useRef<PendingRequest | null>(null);

  useEffect(() => {
    const unregister = registerBlockedDependentsHandler(
      (request) =>
        new Promise<BlockedDependentsDecision | null>((resolve) => {
          pendingRef.current?.resolve(null);
          const next = { ...request, resolve };
          pendingRef.current = next;
          setPending(next);
        }),
    );
    return () => {
      unregister();
      pendingRef.current?.resolve(null);
      pendingRef.current = null;
    };
  }, []);

  const finish = (decision: BlockedDependentsDecision | null) => {
    pendingRef.current?.resolve(decision);
    pendingRef.current = null;
    setPending(null);
  };

  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && finish(null)}>
      {pending ? (
        <BlockedDependentsDialogContent
          key={pending.issueId}
          request={pending}
          onDecide={finish}
        />
      ) : null}
    </Dialog>
  );
}

function issueLabel(issue: { identifier: string | null; id: string }) {
  return issue.identifier ?? issue.id.slice(0, 8);
}

function BlockedDependentsDialogContent({
  request,
  onDecide,
}: {
  request: BlockedDependentsRequest;
  onDecide: (decision: BlockedDependentsDecision | null) => void;
}) {
  const { selectedCompanyId } = useCompany();
  const [mode, setMode] = useState<"choose" | "move">("choose");
  const [search, setSearch] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);
  const query = search.trim();
  const count = request.dependents.length;

  const { data: candidates, isFetching } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.issues.search(selectedCompanyId, query, undefined, MOVE_TARGET_SEARCH_LIMIT)
      : ["issues", "blocked-dependents-move", query],
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        ...(query ? { q: query } : {}),
        limit: MOVE_TARGET_SEARCH_LIMIT,
      }),
    enabled: !!selectedCompanyId && mode === "move",
  });

  const excluded = new Set([request.issueId, ...request.dependents.map((d) => d.id)]);
  const targets = (candidates ?? []).filter(
    (issue: Issue) =>
      !excluded.has(issue.id) &&
      !(issue.identifier && excluded.has(issue.identifier)) &&
      !CLOSED_STATUSES.has(issue.status),
  );

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>
          {count === 1 ? "This task blocks another task" : `This task blocks ${count} other tasks`}
        </DialogTitle>
        <DialogDescription>
          A cancelled task never finishes, so these tasks would wait forever. Move them to wait on
          another task, or remove this blocker from them.
        </DialogDescription>
      </DialogHeader>

      <ul aria-label="Blocked tasks" className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2">
        {request.dependents.map((dependent) => (
          <li key={dependent.id} className="flex min-w-0 items-center gap-2 text-sm">
            <StatusIcon status={dependent.status} size="sm" />
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{issueLabel(dependent)}</span>
            <span className="truncate">{dependent.title}</span>
          </li>
        ))}
      </ul>

      {mode === "move" ? (
        <div className="space-y-2">
          <Input
            autoFocus
            aria-label="Search tasks to wait on"
            placeholder="Search tasks to wait on"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setTargetId(null);
            }}
          />
          <ul aria-label="Tasks to wait on" className="max-h-48 space-y-1 overflow-y-auto">
            {targets.length === 0 ? (
              <li className="px-2 py-1 text-sm text-muted-foreground">
                {isFetching ? "Searching…" : "No open tasks found."}
              </li>
            ) : (
              targets.map((issue) => (
                <li key={issue.id}>
                  <button
                    type="button"
                    aria-pressed={targetId === issue.id}
                    onClick={() => setTargetId(issue.id)}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      targetId === issue.id && "bg-accent",
                    )}
                  >
                    <StatusIcon status={issue.status} size="sm" />
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{issueLabel(issue)}</span>
                    <span className="truncate">{issue.title}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}

      <DialogFooter>
        <Button variant="ghost" onClick={() => onDecide(null)}>
          Cancel
        </Button>
        {mode === "move" ? (
          <>
            <Button variant="outline" onClick={() => setMode("choose")}>
              Back
            </Button>
            <Button
              disabled={!targetId}
              onClick={() => targetId && onDecide({ action: "move", issueId: targetId })}
            >
              Move and cancel task
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={() => onDecide({ action: "remove" })}>
              Remove blocker
            </Button>
            <Button onClick={() => setMode("move")}>Move to another task</Button>
          </>
        )}
      </DialogFooter>
    </DialogContent>
  );
}
