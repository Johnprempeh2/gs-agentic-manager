import { useId } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { HIGGSFIELD_PLAN_LABEL, type HiggsfieldPlanStatus } from "@greatstone/shared";
import { imagesApi } from "@/api/images";
import { NativeSelect } from "@/components/ui/native-select";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { queryKeys } from "@/lib/queryKeys";
import { formatNumber } from "@/lib/utils";

interface StudioPlanBarProps {
  companyId: string;
  plan: HiggsfieldPlanStatus;
  /** The API key service, when it can be picked instead of the plan. */
  alsoAvailable: { providerLabel: string } | null | undefined;
  usingPlan: boolean;
  onUsingPlanChange: (usingPlan: boolean) => void;
  /** Credits the current settings would take, from Higgsfield's price check. */
  cost: number | null;
  onError: (error: unknown) => void;
}

const credits = (value: number) => `${formatNumber(value, { maximumFractionDigits: 2 })} ${value === 1 ? "credit" : "credits"}`;

/**
 * The Higgsfield plan line in the studio: which service runs, credits left,
 * what this will cost, and whether agents may spend the plan.
 */
export function StudioPlanBar({ companyId, plan, alsoAvailable, usingPlan, onUsingPlanChange, cost, onError }: StudioPlanBarProps) {
  const queryClient = useQueryClient();
  const selectId = useId();
  const agentsId = useId();
  const empty = plan.credits !== null && plan.credits <= 0;
  const agents = useMutation({
    mutationFn: (agentsMaySpend: boolean) => imagesApi.setPlanSettings(companyId, { agentsMaySpend }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.images.status(companyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.videos.status(companyId) });
    },
    onError,
  });

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground" data-testid="studio-plan-bar">
      {alsoAvailable ? (
        <span className="flex items-center gap-2">
          <label htmlFor={selectId}>Service</label>
          <NativeSelect
            id={selectId}
            value={usingPlan ? "plan" : "key"}
            onChange={(event) => onUsingPlanChange(event.target.value === "plan")}
            className="h-8 w-auto text-xs"
            data-testid="studio-provider"
          >
            <option value="plan">{HIGGSFIELD_PLAN_LABEL}</option>
            <option value="key">{alsoAvailable.providerLabel} (API key)</option>
          </NativeSelect>
        </span>
      ) : null}
      {usingPlan ? (
        <>
          <span data-testid="plan-credits" className="font-medium text-foreground">
            {plan.credits === null ? "Plan credits unknown" : `${credits(plan.credits)} left`}
            {plan.planType ? <span className="font-normal text-muted-foreground"> on the {plan.planType} plan</span> : null}
          </span>
          {cost !== null && !empty ? <span data-testid="plan-cost">This uses {credits(cost)}</span> : null}
          {empty ? (
            <a href={plan.planUrl} target="_blank" rel="noreferrer" className="font-medium text-destructive underline" data-testid="plan-empty">
              Out of credits. Top up or upgrade your Higgsfield plan
            </a>
          ) : plan.lowCredits ? (
            <a href={plan.planUrl} target="_blank" rel="noreferrer" className="font-medium text-status-warning-foreground underline" data-testid="plan-low">
              Running low. Top up your plan
            </a>
          ) : null}
        </>
      ) : null}
      <span className="flex items-center gap-2 sm:ml-auto">
        <ToggleSwitch
          id={agentsId}
          checked={plan.agentsMaySpend}
          onCheckedChange={(next) => agents.mutate(next)}
          disabled={agents.isPending}
          data-testid="plan-agents"
        />
        <label htmlFor={agentsId}>Agents may use the plan</label>
      </span>
    </div>
  );
}
