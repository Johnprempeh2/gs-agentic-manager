import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CrmSyncCaseSource } from "@greatstone/shared";
import { pipelinesApi } from "../api/pipelines";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";

const PROVIDER_LABELS: Record<string, string> = { pipedrive: "Pipedrive" };

function providerLabel(providerKey: string) {
  return PROVIDER_LABELS[providerKey] ?? providerKey;
}

function clockTime(value: string) {
  return new Date(value).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

type Notice = { tone: "warning" | "danger"; text: string };

/** The one thing a person should know about this source right now, if anything. */
export function crmSyncNotice(source: CrmSyncCaseSource): Notice | null {
  const provider = providerLabel(source.providerKey);
  if (source.rateLimitedUntil) {
    return {
      tone: "warning",
      text: `${provider} is limiting requests. Sync retries at ${clockTime(source.rateLimitedUntil)}.`,
    };
  }
  if (source.bindingStatus === "error") {
    return { tone: "danger", text: source.lastErrorMessage ?? `Sync with ${provider} stopped. Check the connection.` };
  }
  if (source.bindingStatus === "paused") return { tone: "warning", text: `Sync with ${provider} is paused.` };
  if (source.lastEvent?.action === "failed") {
    return { tone: "danger", text: source.lastEvent.errorMessage ?? "The last sync of this case failed." };
  }
  if (source.lastEvent?.action === "conflict") {
    return { tone: "warning", text: `A field changed in both places. Choose which value to keep.` };
  }
  if (source.lastErrorMessage) return { tone: "warning", text: source.lastErrorMessage };
  return null;
}

function SourceRow({ source }: { source: CrmSyncCaseSource }) {
  const notice = crmSyncNotice(source);
  return (
    <li className="space-y-1.5 py-2 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="min-w-0 text-foreground [overflow-wrap:anywhere]">
          {providerLabel(source.providerKey)}
          {source.externalContainerLabel ? (
            <span className="text-muted-foreground"> · {source.externalContainerLabel}</span>
          ) : null}
          <span className="text-muted-foreground"> · deal {source.externalId}</span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {source.lastSyncedAt ? `Synced ${relativeTime(source.lastSyncedAt)}` : "Not synced yet"}
        </span>
      </div>
      {notice ? (
        <p
          role="status"
          className={cn(
            "rounded-sm border px-2 py-1 text-xs",
            notice.tone === "warning" && "border-status-warning/40 bg-status-warning-soft text-status-warning-foreground",
            notice.tone === "danger" && "border-status-danger/40 bg-status-danger-soft text-status-danger-foreground",
          )}
        >
          {notice.text}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Where a case's data comes from in a CRM, and whether that sync is healthy
 * (GRE-1100). Renders nothing for a case with no CRM link.
 */
export function PipelineCaseCrmSync({
  caseId,
  wrap,
}: {
  caseId: string;
  wrap: (children: ReactNode) => ReactNode;
}) {
  const query = useQuery({
    queryKey: queryKeys.pipelines.caseCrmSync(caseId),
    queryFn: () => pipelinesApi.getCaseCrmSyncStatus(caseId),
    refetchInterval: 60_000,
  });
  if (query.isLoading) return null;
  if (query.isError) {
    return wrap(<p className="py-3 text-sm text-muted-foreground">Could not load the CRM sync status. Reload the page to try again.</p>);
  }
  const sources = query.data?.sources ?? [];
  if (sources.length === 0) return null;
  return wrap(
    <ul className="divide-y divide-border">
      {sources.map((source) => <SourceRow key={source.bindingId} source={source} />)}
    </ul>,
  );
}
