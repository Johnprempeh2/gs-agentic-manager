import { AlertTriangle } from "lucide-react";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../../api/client";
import { issuesApi } from "../../api/issues";
import { activityApi, type RunForIssue } from "../../api/activity";
import { queryKeys } from "../../lib/queryKeys";
import { keepPreviousDataForSameQueryTail } from "../../lib/query-placeholder-data";
import { visibleRunCostUsd, formatTokens, formatDurationMs, cn, relativeTime } from "../../lib/utils";
import { ApprovalCard } from "../../components/ApprovalCard";
import { IssueContinuationHandoff } from "../../components/IssueContinuationHandoff";
import type { MarkdownExternalReferenceMap } from "../../components/MarkdownBody";
import { IssueReferenceActivitySummary } from "../../components/IssueReferenceActivitySummary";
import { IssueFieldChangeReceipt } from "../../components/IssueFieldChangeReceipt";
import { IssueWriteDenialNotice } from "../../components/IssueWriteDenialNotice";
import { issueWriteDenialForActivity } from "../../lib/issue-write-denial-activity";
import { IssueScheduledRetryCard } from "../../components/IssueScheduledRetryCard";
import { IssueRunLedger } from "../../components/IssueRunLedger";
import { IssueTreeApiEquivalent } from "../../components/IssueTreeApiEquivalent";
import { formatIssueActivityAction } from "@/lib/activity-format";
import {
  successfulRunHandoffActivityTone,
  SUCCESSFUL_RUN_HANDOFF_REQUIRED_ACTION,
  SUCCESSFUL_RUN_HANDOFF_ESCALATED_ACTION,
} from "../../lib/successful-run-handoff";
import {
  type Issue,
  type Agent,
  type ActivityEvent,
  ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
} from "@greatstone/shared";
import { asRecord, usageNumber } from "./helpers";
import { IssueSectionSkeleton } from "./IssueDetailLoading";
import { ActorIdentity } from "./IssueAttribution";

type IssueDetailActivityTabProps = {
  issue: Issue;
  issueId: string;
  companyId: string;
  issueStatus: Issue["status"];
  childIssues: Issue[];
  agentMap: Map<string, Agent>;
  hasLiveRuns: boolean;
  currentUserId: string | null;
  userProfileMap: Map<
    string,
    import("../../lib/company-members").CompanyUserProfile
  >;
  pendingApprovalAction: {
    approvalId: string;
    action: "approve" | "reject";
  } | null;
  onApprovalAction: (approvalId: string, action: "approve" | "reject") => void;
  handoffFocusSignal?: number;
  externalReferences?: MarkdownExternalReferenceMap;
};

export function IssueDetailActivityTab({
  issue,
  issueId,
  companyId,
  issueStatus,
  childIssues,
  agentMap,
  hasLiveRuns,
  currentUserId,
  userProfileMap,
  pendingApprovalAction,
  onApprovalAction,
  handoffFocusSignal = 0,
  externalReferences,
}: IssueDetailActivityTabProps) {
  const { data: activity, isLoading: activityLoading } = useQuery({
    queryKey: queryKeys.issues.activity(issueId),
    queryFn: () => activityApi.forIssue(issueId),
    placeholderData: keepPreviousDataForSameQueryTail<ActivityEvent[]>(issueId),
  });
  const { data: linkedRuns, isLoading: linkedRunsLoading } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
    placeholderData: keepPreviousDataForSameQueryTail<RunForIssue[]>(issueId),
  });
  const { data: linkedApprovals } = useQuery({
    queryKey: queryKeys.issues.approvals(issueId),
    queryFn: () => issuesApi.listApprovals(issueId),
    placeholderData:
      keepPreviousDataForSameQueryTail<
        Awaited<ReturnType<typeof issuesApi.listApprovals>>
      >(issueId),
  });
  const { data: continuationHandoff } = useQuery({
    queryKey: queryKeys.issues.document(
      issueId,
      ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    ),
    queryFn: async () => {
      try {
        return await issuesApi.getDocument(
          issueId,
          ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    retry: false,
    placeholderData: keepPreviousDataForSameQueryTail<Awaited<
      ReturnType<typeof issuesApi.getDocument>
    > | null>(issueId),
  });
  const { data: issueTreeCostSummary } = useQuery({
    queryKey: queryKeys.issues.costSummary(issueId),
    queryFn: () => issuesApi.getCostSummary(issueId),
    placeholderData:
      keepPreviousDataForSameQueryTail<
        Awaited<ReturnType<typeof issuesApi.getCostSummary>>
      >(issueId),
  });
  const initialLoading =
    (activityLoading && activity === undefined) ||
    (linkedRunsLoading && linkedRuns === undefined);
  const issueCostSummary = useMemo(() => {
    let input = 0;
    let output = 0;
    let cached = 0;
    let cost = 0;
    let runtimeMs = 0;
    let runCount = 0;
    let hasCost = false;
    let hasTokens = false;
    const nowMs = Date.now();

    for (const run of linkedRuns ?? []) {
      const usage = asRecord(run.usageJson);
      const result = asRecord(run.resultJson);
      const runInput = usageNumber(usage, "inputTokens", "input_tokens");
      const runOutput = usageNumber(usage, "outputTokens", "output_tokens");
      const runCached = usageNumber(
        usage,
        "cachedInputTokens",
        "cached_input_tokens",
        "cache_read_input_tokens",
      );
      const runCost = visibleRunCostUsd(usage, result);
      if (runCost > 0) hasCost = true;
      if (runInput + runOutput + runCached > 0) hasTokens = true;
      input += runInput;
      output += runOutput;
      cached += runCached;
      cost += runCost;

      if (run.startedAt) {
        const startMs = new Date(run.startedAt).getTime();
        const endMs = run.finishedAt
          ? new Date(run.finishedAt).getTime()
          : nowMs;
        if (
          Number.isFinite(startMs) &&
          Number.isFinite(endMs) &&
          endMs >= startMs
        ) {
          runtimeMs += endMs - startMs;
          runCount += 1;
        }
      }
    }

    return {
      input,
      output,
      cached,
      cost,
      totalTokens: input + output,
      hasCost,
      hasTokens,
      runtimeMs,
      runCount,
      hasRuntime: runtimeMs > 0,
    };
  }, [linkedRuns]);
  const issueTreeCostTokens =
    (issueTreeCostSummary?.inputTokens ?? 0) +
    (issueTreeCostSummary?.outputTokens ?? 0);
  const hasIssueTreeCost =
    !!issueTreeCostSummary &&
    (issueTreeCostSummary.costCents > 0 ||
      issueTreeCostTokens > 0 ||
      issueTreeCostSummary.cachedInputTokens > 0 ||
      issueTreeCostSummary.runtimeMs > 0 ||
      issueTreeCostSummary.issueCount > 1);
  const shouldShowCostSummary =
    (linkedRuns && linkedRuns.length > 0) || hasIssueTreeCost;

  if (initialLoading) {
    return <IssueSectionSkeleton titleWidth="w-20" rows={4} />;
  }

  return (
    <>
      {shouldShowCostSummary && (
        <div className="mb-3 px-3 py-2 rounded-lg border border-border">
          <div className="text-sm font-medium text-muted-foreground mb-1">
            Cost Summary
          </div>
          {!issueCostSummary.hasCost &&
          !issueCostSummary.hasTokens &&
          !hasIssueTreeCost ? (
            <div className="text-xs text-muted-foreground">
              No cost data yet.
            </div>
          ) : (
            <div className="space-y-1 text-xs text-muted-foreground tabular-nums">
              <div className="flex flex-wrap gap-3">
                <span className="font-medium text-foreground">This task</span>
                {issueCostSummary.hasCost ? (
                  <span className="font-medium text-foreground">
                    ${issueCostSummary.cost.toFixed(4)}
                  </span>
                ) : null}
                {issueCostSummary.hasTokens ? (
                  <span>
                    Tokens {formatTokens(issueCostSummary.totalTokens)}
                    {issueCostSummary.cached > 0
                      ? ` (in ${formatTokens(issueCostSummary.input)}, out ${formatTokens(issueCostSummary.output)}, cached ${formatTokens(issueCostSummary.cached)})`
                      : ` (in ${formatTokens(issueCostSummary.input)}, out ${formatTokens(issueCostSummary.output)})`}
                  </span>
                ) : null}
                {issueCostSummary.hasRuntime ? (
                  <span>
                    Runtime {formatDurationMs(issueCostSummary.runtimeMs)}
                    {` (${issueCostSummary.runCount} run${issueCostSummary.runCount === 1 ? "" : "s"})`}
                  </span>
                ) : null}
                {!issueCostSummary.hasCost &&
                !issueCostSummary.hasTokens &&
                !issueCostSummary.hasRuntime ? (
                  <span>No direct cost data.</span>
                ) : null}
              </div>
              {hasIssueTreeCost && issueTreeCostSummary ? (
                <div className="flex flex-wrap gap-3">
                  <span className="font-medium text-foreground">
                    Including sub-tasks{" "}
                    {(issueTreeCostSummary.costCents / 100).toLocaleString(
                      undefined,
                      {
                        style: "currency",
                        currency: "USD",
                        minimumFractionDigits: 4,
                        maximumFractionDigits: 4,
                      },
                    )}
                  </span>
                  <span>
                    Tokens {formatTokens(issueTreeCostTokens)}
                    {issueTreeCostSummary.cachedInputTokens > 0
                      ? ` (in ${formatTokens(issueTreeCostSummary.inputTokens)}, out ${formatTokens(issueTreeCostSummary.outputTokens)}, cached ${formatTokens(issueTreeCostSummary.cachedInputTokens)})`
                      : ` (in ${formatTokens(issueTreeCostSummary.inputTokens)}, out ${formatTokens(issueTreeCostSummary.outputTokens)})`}
                  </span>
                  {issueTreeCostSummary.runCount > 0 ? (
                    <span>
                      Runtime {formatDurationMs(issueTreeCostSummary.runtimeMs)}
                      {` (${issueTreeCostSummary.runCount} run${issueTreeCostSummary.runCount === 1 ? "" : "s"})`}
                    </span>
                  ) : null}
                  <span>
                    {issueTreeCostSummary.issueCount} task
                    {issueTreeCostSummary.issueCount === 1 ? "" : "s"}
                  </span>
                </div>
              ) : null}
              {hasIssueTreeCost && issueTreeCostSummary ? (
                <IssueTreeApiEquivalent summary={issueTreeCostSummary} />
              ) : null}
            </div>
          )}
        </div>
      )}
      <div className="mb-3">
        <IssueRunLedger
          issueId={issueId}
          companyId={companyId}
          issueStatus={issueStatus}
          childIssues={childIssues}
          agentMap={agentMap}
          hasLiveRuns={hasLiveRuns}
          activityEvents={activity ?? []}
          resolveUserLabel={(userId) =>
            userProfileMap.get(userId)?.label ?? null
          }
          renderActivityEvent={(evt) => {
            const tone = successfulRunHandoffActivityTone(evt.action);
            const isHandoffWarning =
              evt.action === SUCCESSFUL_RUN_HANDOFF_REQUIRED_ACTION ||
              evt.action === SUCCESSFUL_RUN_HANDOFF_ESCALATED_ACTION;
            return (
              <div
                className={cn(
                  "space-y-1.5 rounded-lg border px-3 py-2 text-xs",
                  tone.className,
                )}
              >
                <div className="flex items-center gap-1.5">
                  {isHandoffWarning ? (
                    <AlertTriangle
                      className={cn("h-3.5 w-3.5 shrink-0", tone.iconClassName)}
                    />
                  ) : null}
                  <ActorIdentity
                    evt={evt}
                    agentMap={agentMap}
                    userProfileMap={userProfileMap}
                  />
                  <span>
                    {formatIssueActivityAction(evt.action, evt.details, {
                      agentMap,
                      userProfileMap,
                      currentUserId,
                    })}
                  </span>
                  <span className="ml-auto shrink-0">
                    {relativeTime(evt.createdAt)}
                  </span>
                </div>
                <IssueReferenceActivitySummary event={evt} />
                {/* Field-level who/what/why receipt for agent and board edits alike. */}
                <IssueFieldChangeReceipt
                  event={evt}
                  resolveAgentLabel={(agentId) =>
                    agentMap.get(agentId)?.name ?? null
                  }
                  resolveUserLabel={(userId) =>
                    userProfileMap.get(userId)?.label ?? null
                  }
                />
                {/* A refused write explains itself here, not just in the API error. */}
                {(() => {
                  const denial = issueWriteDenialForActivity(
                    evt.action,
                    evt.details,
                    {
                      actorLabel: evt.agentId
                        ? (agentMap.get(evt.agentId)?.name ?? null)
                        : null,
                      responsibleUserName: evt.responsibleUserId
                        ? (userProfileMap.get(evt.responsibleUserId)?.label ??
                          null)
                        : null,
                    },
                  );
                  return denial ? (
                    <IssueWriteDenialNotice
                      code={denial.code}
                      context={denial.context}
                    />
                  ) : null;
                })()}
              </div>
            );
          }}
        />
      </div>
      <IssueContinuationHandoff
        document={continuationHandoff}
        focusSignal={handoffFocusSignal}
        externalReferences={externalReferences}
      />
      {linkedApprovals && linkedApprovals.length > 0 && (
        <div className="mb-3 space-y-3">
          {linkedApprovals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              requesterAgent={
                approval.requestedByAgentId
                  ? (agentMap.get(approval.requestedByAgentId) ?? null)
                  : null
              }
              onApprove={() => onApprovalAction(approval.id, "approve")}
              onReject={() => onApprovalAction(approval.id, "reject")}
              detailLink={`/approvals/${approval.id}`}
              isPending={pendingApprovalAction?.approvalId === approval.id}
              pendingAction={
                pendingApprovalAction?.approvalId === approval.id
                  ? pendingApprovalAction.action
                  : null
              }
            />
          ))}
        </div>
      )}
      <IssueScheduledRetryCard
        issueId={issue.id}
        scheduledRetry={issue.scheduledRetry ?? null}
      />
      {/* Waiting-monitor state shows in the banner above the tabs (the composer strip on the chat tab). */}
    </>
  );
}
