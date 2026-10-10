import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue } from "@greatstone/shared";
import { agentsApi } from "@/api/agents";
import { strategyBoardApi } from "@/api/strategyBoard";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { ErrorState } from "@/components/ErrorState";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useParams } from "@/lib/router";
import { TaskDetailSurface } from "./IssueDetail";

/**
 * A board member asks one of their agents about the plan (GRE-1186). The
 * normal agent chat surface, in Ask mode only: the board member can send
 * messages, and nothing else. Only agents set for them open here.
 */
export function BoardAgentChat() {
  const { agentId = "" } = useParams<{ agentId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const client = useQueryClient();
  const companyId = selectedCompanyId!;

  const boardAgents = useQuery({
    queryKey: queryKeys.strategyBoard.agents(companyId),
    queryFn: () => strategyBoardApi.agents(companyId),
    enabled: !!selectedCompanyId,
  });
  const allowed = boardAgents.data?.find((agent) => agent.id === agentId) ?? null;
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!selectedCompanyId && !!allowed,
  });
  const agent = allowed ? agents.data?.find((item) => item.id === allowed.id) : undefined;
  const chatKey = queryKeys.strategyBoard.chat(companyId, agentId);
  const chat = useQuery({
    queryKey: chatKey,
    queryFn: () => strategyBoardApi.getChat(companyId, agentId),
    enabled: !!selectedCompanyId && !!allowed,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Board", href: "/strategy-board" }, { label: allowed ? `Ask ${allowed.name}` : "Ask the board agent" }]);
  }, [allowed, setBreadcrumbs]);

  const creating = useRef<Promise<Issue> | null>(null);
  useEffect(() => {
    creating.current = null;
  }, [companyId, agentId]);
  const ensureIssue = useCallback(async () => {
    if (chat.data) return chat.data;
    const promise = (creating.current ??= strategyBoardApi.openChat(companyId, agentId));
    try {
      const issue = await promise;
      client.setQueryData(queryKeys.issues.detail(issue.id), issue);
      client.setQueryData(chatKey, issue);
      return issue;
    } catch (error) {
      creating.current = null;
      throw error;
    }
  }, [chat.data, companyId, agentId, client, chatKey]);

  if (boardAgents.isPending || (allowed && (agents.isPending || chat.isPending))) {
    return <p className="text-sm text-muted-foreground">Loading conversation…</p>;
  }
  if (boardAgents.error || agents.error || chat.error) {
    return <ErrorState error={boardAgents.error ?? agents.error ?? chat.error} onRetry={() => void boardAgents.refetch()} />;
  }
  if (!allowed || !agent) {
    return (
      <div className="mx-auto max-w-xl space-y-2 py-8 text-sm">
        <p className="font-medium">You cannot ask this agent.</p>
        <p className="text-muted-foreground">
          A company owner chooses which agents each board member can ask.{" "}
          <Link to="/strategy-board" className="font-medium text-foreground underline underline-offset-4">
            Back to the board
          </Link>
        </p>
      </div>
    );
  }
  return (
    <TaskDetailSurface
      key={`board:${agent.id}`}
      conversation={{ agent, issue: chat.data ?? null, ensureIssue, questionsOnly: true }}
    />
  );
}
