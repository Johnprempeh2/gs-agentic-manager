import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PipelineCaseDetail, PipelineStage } from "../api/pipelines";
import { pipelinesApi } from "../api/pipelines";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

// Won and Lost on a DevTools client (evening run, 16 Oct), as Pipedrive has on
// every deal: the case moves to the pipeline's Won or Lost stage and the deal
// fields record the outcome, the date and, for a loss, the reason.

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function outcomeStage(stages: PipelineStage[], outcome: "won" | "lost") {
  const kind = outcome === "won" ? "done" : "cancelled";
  return stages.find((stage) => stage.key === outcome) ?? stages.find((stage) => stage.kind === kind) ?? null;
}

export function DevtoolsDealOutcome({ detail, stages }: { detail: PipelineCaseDetail; stages: PipelineStage[] }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [losing, setLosing] = useState(false);
  const [reason, setReason] = useState("");
  const wonStage = outcomeStage(stages, "won");
  const lostStage = outcomeStage(stages, "lost");
  const current = detail.case.stageId;
  const closed = (wonStage && current === wonStage.id) || (lostStage && current === lostStage.id);

  const record = useMutation({
    mutationFn: async (outcome: "won" | "lost") => {
      const stage = outcome === "won" ? wonStage : lostStage;
      if (!stage) throw new Error(`This pipeline has no ${outcome === "won" ? "Won" : "Lost"} stage`);
      if (detail.case.version == null) throw new Error("Reload the page and try again");
      await pipelinesApi.transitionCase(detail.case.id, {
        toStageKey: stage.key,
        expectedVersion: detail.case.version,
        reason: outcome === "won" ? "Marked won on the client page." : `Marked lost on the client page${reason.trim() ? `: ${reason.trim()}` : "."}`,
        force: true,
      });
      const fields: Record<string, unknown> = { ...(detail.case.fields ?? {}) };
      fields.dealStatus = outcome === "won" ? "Won" : "Lost";
      if (outcome === "won") fields.wonOn = today();
      else {
        fields.lostOn = today();
        if (reason.trim()) fields.lostReason = reason.trim();
      }
      await pipelinesApi.updateCase(detail.case.id, { fields });
    },
    onSuccess: async (_result, outcome) => {
      setLosing(false);
      setReason("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseDetail(detail.case.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.cases(detail.case.pipelineId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseEvents(detail.case.id) }),
      ]);
      pushToast({ title: outcome === "won" ? "Marked won" : "Marked lost", tone: "success" });
    },
    onError: (error) => pushToast({ title: error instanceof Error ? error.message : "Could not record the outcome", tone: "error" }),
  });

  if (closed || (!wonStage && !lostStage)) return null;

  return (
    <div className="space-y-2 py-3" data-testid="deal-outcome">
      {losing ? (
        <div className="space-y-2">
          <label htmlFor="deal-lost-reason" className="text-sm font-medium">Why was it lost? (optional)</label>
          <Textarea id="deal-lost-reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={2} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => { setLosing(false); setReason(""); }}>Cancel</Button>
            <Button type="button" variant="destructive" size="sm" disabled={record.isPending} onClick={() => record.mutate("lost")}>
              {record.isPending ? "Saving…" : "Mark lost"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {wonStage ? (
            <Button type="button" size="sm" disabled={record.isPending} onClick={() => record.mutate("won")}>
              {record.isPending ? "Saving…" : "Won"}
            </Button>
          ) : null}
          {lostStage ? (
            <Button type="button" size="sm" variant="outline" disabled={record.isPending} onClick={() => setLosing(true)}>
              Lost
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
