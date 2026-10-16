import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import type { MemoryConnectionActivity as Activity, MemoryRecordStatus } from "@greatstone/shared";
import { formatDateTime } from "@/lib/utils";
import { memoryGraphApi } from "../../api/memoryGraph";
import { queryKeys } from "../../lib/queryKeys";
import { memoryStatusMeta } from "./memoryLabels";

const OPERATION_LABEL: Record<string, string> = {
  recall: "Searched memory",
  contribute: "Suggested an entry",
  get: "Opened an entry",
  scopes_list: "Looked up where memory lives",
  link: "Linked two entries",
};

export function operationLabel(operation: string, outcome: string) {
  const label = OPERATION_LABEL[operation] ?? operation.replace(/_/g, " ");
  return outcome === "denied" ? `${label} (refused)` : label;
}

/** The latest successful call, which is what "it works" means. */
export function firstWorkingCall(activity: Activity | undefined) {
  return activity?.operations.find((operation) => operation.outcome !== "denied") ?? null;
}

function useActivity(companyId: string, agentId: string, poll: boolean) {
  return useQuery({
    queryKey: queryKeys.memoryGraph.connectionActivity(companyId, agentId),
    queryFn: () => memoryGraphApi.connectionActivity(companyId, agentId),
    refetchInterval: (query) => (poll && !firstWorkingCall(query.state.data) ? 5_000 : false),
  });
}

/** Waits for the app's first call after setup, then says it works. */
export function MemoryConnectionCheck({ companyId, agentId, appLabel }: { companyId: string; agentId: string; appLabel: string }) {
  const activity = useActivity(companyId, agentId, true);
  const working = firstWorkingCall(activity.data);
  if (working) {
    return (
      <p className="flex items-center gap-2 text-sm" role="status">
        <CheckCircle2 className="size-4 shrink-0" />
        It works. {appLabel}: {operationLabel(working.operation, working.outcome).toLowerCase()} at {formatDateTime(working.createdAt)}.
      </p>
    );
  }
  return (
    <div className="space-y-1 text-sm" role="status">
      <p className="flex items-center gap-2">
        <Loader2 className="size-4 shrink-0 motion-safe:animate-spin" />
        Waiting for {appLabel} to use memory.
      </p>
      <p className="text-xs text-muted-foreground">
        To check, ask it: "Search GSAM memory for what we know about our pricing." This page updates on its own.
      </p>
    </div>
  );
}

/** What a connected app has done: its recent calls and the entries it suggested. */
export function MemoryConnectionHistory({ companyId, agentId }: { companyId: string; agentId: string }) {
  const activity = useActivity(companyId, agentId, false);
  if (activity.isLoading) return <p className="text-xs text-muted-foreground">Loading...</p>;
  if (activity.error) return <p className="text-xs text-destructive">Could not load what it has done.</p>;
  const data = activity.data!;
  if (data.operations.length === 0 && data.contributions.length === 0) {
    return <p className="text-xs text-muted-foreground">It has not used memory yet.</p>;
  }
  return (
    <div className="grid gap-3 text-xs sm:grid-cols-2">
      <div className="space-y-1">
        <p className="font-medium">Recent calls</p>
        <ul className="space-y-0.5 text-muted-foreground">
          {data.operations.map((operation) => (
            <li key={operation.id}>
              {formatDateTime(operation.createdAt)}: {operationLabel(operation.operation, operation.outcome)}
            </li>
          ))}
        </ul>
      </div>
      <div className="space-y-1">
        <p className="font-medium">Entries it suggested</p>
        {data.contributions.length === 0 ? (
          <p className="text-muted-foreground">None yet.</p>
        ) : (
          <ul className="space-y-0.5 text-muted-foreground">
            {data.contributions.map((record) => (
              <li key={record.id}>
                {record.title ?? "Untitled entry"} ({(memoryStatusMeta[record.status as MemoryRecordStatus]?.label ?? record.status).toLowerCase()})
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
