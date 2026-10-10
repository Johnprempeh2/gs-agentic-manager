import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GoalWhyRequest } from "@greatstone/shared";
import { strategyBoardApi } from "@/api/strategyBoard";
import { useToastActions } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type Names = { users: ReadonlyMap<string, { label: string }>; agents: ReadonlyMap<string, { name: string }> };

function personName(userId: string | null, agentId: string | null, names: Names): string {
  if (userId) return names.users.get(userId)?.label ?? "A person";
  if (agentId) return names.agents.get(agentId)?.name ?? "An agent";
  return "Someone";
}

function AnswerForm({ request, companyId }: { request: GoalWhyRequest; companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [answer, setAnswer] = useState("");
  const send = useMutation({
    mutationFn: () => strategyBoardApi.answerWhy(request.id, answer.trim()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.strategyBoard.whyRequests(request.goalId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.strategyBoard.summary(companyId) });
      pushToast({ title: "Answer logged on the KPI", tone: "success" });
    },
    onError: (err: Error) => pushToast({ title: "Answer not saved", body: err.message, tone: "error" }),
  });
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (answer.trim()) send.mutate();
      }}
    >
      <Textarea
        aria-label="Your answer"
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        placeholder="What happened, and what will you do about it?"
        rows={3}
      />
      <Button size="sm" type="submit" disabled={!answer.trim() || send.isPending}>{send.isPending ? "Saving…" : "Answer"}</Button>
    </form>
  );
}

/**
 * "Why?" requests on a KPI (GRE-1135): the board's questions and the owner's
 * answers, newest first. Shown only while the board control panel is on.
 * Board members (viewers) read them; the owner answers here.
 */
export function GoalWhyRequests({
  goalId,
  companyId,
  names,
  mayAnswer,
}: {
  goalId: string;
  companyId: string;
  names: Names;
  /** False for board members, who ask but do not answer. The server checks who may answer. */
  mayAnswer: boolean;
}) {
  const { data: requests, isLoading, error } = useQuery({
    queryKey: queryKeys.strategyBoard.whyRequests(goalId),
    queryFn: () => strategyBoardApi.listWhyRequests(goalId),
  });
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading questions…</p>;
  if (error) return <p className="text-sm text-status-danger">Could not load the board's questions: {(error as Error).message}</p>;
  if (!requests || requests.length === 0) {
    return <p className="text-sm text-muted-foreground">The board has not asked about this KPI.</p>;
  }
  return (
    <ul className="space-y-3">
      {requests.map((request) => (
        <li key={request.id} className="space-y-2 rounded-lg border border-border p-3" data-status={request.status}>
          <p className="text-xs text-muted-foreground">
            {personName(request.askedByUserId, null, names)} asked {formatDateTime(request.createdAt)}
          </p>
          <p className="text-sm">{request.question}</p>
          {request.status === "answered" ? (
            <blockquote className="border-l-2 border-border pl-3">
              <p className="whitespace-pre-wrap text-sm">{request.answer}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {personName(request.answeredByUserId, request.answeredByAgentId, names)}, {request.answeredAt ? formatDateTime(request.answeredAt) : ""}
              </p>
            </blockquote>
          ) : mayAnswer ? (
            <AnswerForm request={request} companyId={companyId} />
          ) : (
            <p className="text-xs text-muted-foreground">
              Waiting for {personName(request.ownerUserId, request.ownerAgentId, names)} to answer.
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
