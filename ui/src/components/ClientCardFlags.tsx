import { Badge } from "@/components/ui/badge";
import {
  getClientCardFlags,
  getDealNextStepFlag,
  NO_CONTACT_FLAG_DAYS,
  STUCK_STAGE_FLAG_DAYS,
  type ClientCardFlagInput,
} from "@/lib/client-card-flags";

function formatDays(days: number) {
  return days === 1 ? "1 day" : `${days} days`;
}

/** Badges for a client card on the pipeline board; renders nothing when no flag is due. */
export function ClientCardFlags({ caseItem, now }: { caseItem: ClientCardFlagInput; now?: Date }) {
  const { noContactDays, stuckStageDays } = getClientCardFlags(caseItem, now);
  const nextStep = getDealNextStepFlag(caseItem, now);
  return (
    <>
      {noContactDays != null ? (
        <Badge
          variant="outline"
          title={`No contact logged for ${NO_CONTACT_FLAG_DAYS} days or more`}
          className="border-status-danger/40 bg-status-danger-soft text-(length:--text-nano) text-status-danger-foreground"
        >
          No contact {formatDays(noContactDays)}
        </Badge>
      ) : null}
      {stuckStageDays != null ? (
        <Badge
          variant="outline"
          title={`No stage move for ${STUCK_STAGE_FLAG_DAYS} days or more`}
          className="border-status-warning/40 bg-status-warning-soft text-(length:--text-nano) text-status-warning-foreground"
        >
          Same stage {formatDays(stuckStageDays)}
        </Badge>
      ) : null}
      {nextStep ? (
        <Badge
          variant="outline"
          title={nextStep.kind === "none" ? "Open deal with no next activity scheduled" : "The next activity on this deal is past its date"}
          className="border-status-danger/40 bg-status-danger-soft text-(length:--text-nano) text-status-danger-foreground"
        >
          {nextStep.kind === "none" ? "No next step" : `Next step overdue ${formatDays(nextStep.days)}`}
        </Badge>
      ) : null}
    </>
  );
}
