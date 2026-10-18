import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@greatstone/shared";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { useConfirm } from "@/context/ConfirmContext";
import { useToastActions } from "../context/ToastContext";
import { InlineBanner } from "./InlineBanner";
import { Button } from "@/components/ui/button";
import { agentsRunningEmptyTimers, withEmptyTimerSkip } from "../lib/quiet-timer";

const DISMISS_KEY = "gsam:empty-timer-banner-dismissed";

function readDismissed(companyId: string): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === companyId;
  } catch {
    return false;
  }
}

/**
 * On Agents: "3 agents wake on a timer even when nothing has changed". One click
 * turns on "Skip timer runs when nothing has changed" for all of them, which
 * saves the usage those empty runs cost. Each agent's settings page can turn it
 * off again.
 */
export function EmptyTimerRunsBanner({ companyId, agents }: { companyId: string; agents: readonly Agent[] }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { pushToast } = useToastActions();
  const [dismissed, setDismissed] = useState(() => readDismissed(companyId));
  const targets = agentsRunningEmptyTimers(agents);

  const apply = useMutation({
    mutationFn: async (list: readonly Agent[]) => {
      let done = 0;
      for (const agent of list) {
        await agentsApi.update(agent.id, { runtimeConfig: withEmptyTimerSkip(agent) }, companyId);
        done += 1;
      }
      return done;
    },
    onSuccess: (done) => {
      pushToast({ tone: "success", title: `${done} ${done === 1 ? "agent now skips" : "agents now skip"} needless check-ins` });
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "Could not change every agent", body: error instanceof Error ? error.message : undefined });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    },
  });

  if (dismissed || targets.length === 0) return null;
  const names = targets.map((agent) => agent.name);
  const shown = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");

  return (
    <InlineBanner
      tone="info"
      compact
      title={`${targets.length} ${targets.length === 1 ? "agent wakes" : "agents wake"} on a timer even when nothing has changed`}
      actions={
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={apply.isPending}
            onClick={async () => {
              const ok = await confirm({
                title: `Stop needless check-ins for ${targets.length} ${targets.length === 1 ? "agent" : "agents"}?`,
                description: `${shown} will still wake for new tasks, comments and changes. Check-ins with nothing new are skipped. You can turn this off on each agent's settings.`,
                confirmLabel: "Skip needless check-ins",
              });
              if (ok) apply.mutate(targets);
            }}
          >
            {apply.isPending ? "Saving" : "Skip needless check-ins"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              try {
                window.localStorage.setItem(DISMISS_KEY, companyId);
              } catch {
                // Hiding is a convenience; it still hides for this visit.
              }
              setDismissed(true);
            }}
          >
            Not now
          </Button>
        </div>
      }
    >
      {shown}. Those runs use your plan and do nothing. Skip them and the agents still wake for new work.
    </InlineBanner>
  );
}
